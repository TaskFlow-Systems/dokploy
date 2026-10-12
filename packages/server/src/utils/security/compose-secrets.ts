import {
	type Document,
	isAlias,
	isMap,
	isScalar,
	isSeq,
	type Node,
	parseDocument,
	type Scalar,
	visit,
	type YAMLMap,
} from "yaml";
import {
	isSecretLookingName,
	isVariableReference,
	REDACTED_SECRET_VALUE,
} from "./redaction";
import {
	collectSecretValue,
	findSecretTokens,
	hasUnrestorablePlaceholder,
	type KnownSecretMatcher,
	replaceSecretTokens,
	scrubSecretText,
	secretTokenFor,
} from "./secret-scrub";

/**
 * A compose file is the one text an agent has to read whole and send back
 * edited, so its secrets are hidden by position rather than by guessing: every
 * literal value in an `environment` or build `args` block and every inline
 * secret or config body is replaced, whatever the variable is called. Each
 * hidden value becomes a token, and a file sent back with its tokens gets the
 * values put back.
 */

type SecretReplacement = (secret: string) => string;
type Edit = { start: number; end: number; text: string };
type SlotKind = "value" | "assignment";

const PLAIN_SAFE = /^[A-Za-z0-9_./:@=,+-]+$/;

const isHidden = (value: string) => value.includes(REDACTED_SECRET_VALUE);

const isLiteral = (value: string) =>
	value !== "" && !isVariableReference(value) && !isHidden(value);

const resolveNode = (document: Document, node: unknown): Node | undefined => {
	if (isAlias(node)) {
		return node.resolve(document);
	}
	return node === null || node === undefined ? undefined : (node as Node);
};

// A key may come from a merged anchor (`<<: *defaults`), so each map is looked
// up together with everything merged into it.
const findInMap = (
	document: Document,
	map: YAMLMap,
	key: string,
	seen = new Set<unknown>(),
): Node[] => {
	if (seen.has(map)) {
		return [];
	}
	seen.add(map);
	const found: Node[] = [];
	for (const pair of map.items) {
		const name = isScalar(pair.key) ? pair.key.value : undefined;
		if (name === key) {
			const value = resolveNode(document, pair.value);
			if (value) {
				found.push(value);
			}
		} else if (name === "<<") {
			const merged = resolveNode(document, pair.value);
			const sources = isSeq(merged) ? merged.items : [merged];
			for (const source of sources) {
				const target = resolveNode(document, source);
				if (isMap(target)) {
					found.push(...findInMap(document, target, key, seen));
				}
			}
		}
	}
	return found;
};

const collectVariableBlock = (
	document: Document,
	block: Node | undefined,
	slots: Map<Scalar, SlotKind>,
	seen = new Set<unknown>(),
) => {
	if (!block || seen.has(block)) {
		return;
	}
	seen.add(block);
	if (isMap(block)) {
		for (const pair of block.items) {
			if (isScalar(pair.key) && pair.key.value === "<<") {
				const merged = resolveNode(document, pair.value);
				for (const source of isSeq(merged) ? merged.items : [merged]) {
					collectVariableBlock(
						document,
						resolveNode(document, source),
						slots,
						seen,
					);
				}
				continue;
			}
			const value = resolveNode(document, pair.value);
			if (isScalar(value)) {
				slots.set(value, "value");
			}
		}
	} else if (isSeq(block)) {
		for (const item of block.items) {
			const value = resolveNode(document, item);
			if (isScalar(value)) {
				slots.set(value, "assignment");
			}
		}
	}
};

const collectSlots = (document: Document) => {
	const slots = new Map<Scalar, SlotKind>();
	const root = document.contents;
	if (!isMap(root)) {
		return slots;
	}

	for (const services of findInMap(document, root, "services")) {
		if (!isMap(services)) {
			continue;
		}
		for (const pair of services.items) {
			const service = resolveNode(document, pair.value);
			if (!isMap(service)) {
				continue;
			}
			for (const block of findInMap(document, service, "environment")) {
				collectVariableBlock(document, block, slots);
			}
			for (const build of findInMap(document, service, "build")) {
				if (isMap(build)) {
					for (const block of findInMap(document, build, "args")) {
						collectVariableBlock(document, block, slots);
					}
				}
			}
		}
	}

	for (const section of ["secrets", "configs"]) {
		for (const entries of findInMap(document, root, section)) {
			if (!isMap(entries)) {
				continue;
			}
			for (const pair of entries.items) {
				const entry = resolveNode(document, pair.value);
				if (!isMap(entry)) {
					continue;
				}
				for (const content of findInMap(document, entry, "content")) {
					if (isScalar(content)) {
						slots.set(content, "value");
					}
				}
			}
		}
	}

	return slots;
};

const formatScalar = (node: Scalar, text: string) => {
	if (node.type === "PLAIN" && PLAIN_SAFE.test(text)) {
		return text;
	}
	const quoted = JSON.stringify(text);
	// A block scalar ends with its line break, a quoted one does not.
	return node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED"
		? `${quoted}\n`
		: quoted;
};

const applyEdits = (text: string, edits: Edit[]) => {
	let result = text;
	for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
		result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
	}
	return result;
};

const parseCompose = (text: string) => {
	const document = parseDocument(text, { merge: false, uniqueKeys: false });
	return document.errors.length > 0 ? null : document;
};

type ScalarVisit = {
	node: Scalar;
	position: "key" | "value" | "item";
	parentKey: string | null;
};

const visitScalars = (
	document: Document,
	visitor: (scalar: ScalarVisit & { range: [number, number] }) => void,
) => {
	const ranges: [number, number][] = [];
	visit(document, {
		Scalar(key, node, path) {
			if (!node.range) {
				return;
			}
			const range: [number, number] = [node.range[0], node.range[1]];
			ranges.push(range);
			const parent = path[path.length - 1];
			const pairKey =
				key === "value" && parent && "key" in parent && isScalar(parent.key)
					? String(parent.key.value)
					: null;
			visitor({
				node,
				range,
				position: key === "key" ? "key" : key === "value" ? "value" : "item",
				parentKey: pairKey,
			});
		},
	});
	return ranges;
};

// Whatever lies outside the scalars is structure and comments, so a `#` there
// always starts a comment.
const commentRanges = (text: string, scalarRanges: [number, number][]) => {
	const comments: [number, number][] = [];
	const boundaries: [number, number][] = [
		...[...scalarRanges].sort((a, b) => a[0] - b[0]),
		[text.length, text.length],
	];
	let cursor = 0;
	for (const [start, end] of boundaries) {
		if (start > cursor) {
			const gap = text.slice(cursor, start);
			for (const match of gap.matchAll(/#[^\n]*/g)) {
				comments.push([
					cursor + match.index,
					cursor + match.index + match[0].length,
				]);
			}
		}
		cursor = Math.max(cursor, end);
	}
	return comments;
};

const hideScalar = (
	{ node, position, parentKey }: ScalarVisit,
	slot: SlotKind | undefined,
	matcher: KnownSecretMatcher,
	replacement: SecretReplacement,
): string | null => {
	const value = node.value;
	if (value === null || value === undefined || typeof value === "boolean") {
		return null;
	}
	const text = String(value);

	if (slot === "assignment") {
		const separator = text.indexOf("=");
		const literal = separator === -1 ? "" : text.slice(separator + 1);
		return isLiteral(literal)
			? `${text.slice(0, separator + 1)}${replacement(literal)}`
			: null;
	}
	if (
		slot === "value" ||
		(position === "value" &&
			parentKey !== null &&
			isSecretLookingName(parentKey))
	) {
		return isLiteral(text) ? replacement(text) : null;
	}
	if (typeof value !== "string") {
		return null;
	}
	const scrubbed = scrubSecretText(text, matcher, replacement);
	return scrubbed === text ? null : scrubbed;
};

export const hideComposeSecrets = (
	text: string,
	matcher: KnownSecretMatcher,
	replacement: SecretReplacement = secretTokenFor,
) => {
	if (text.trim() === "") {
		return text;
	}
	const document = parseCompose(text);
	// A file that does not parse has no positions to go by, and what cannot be
	// placed cannot be shown.
	if (!document) {
		return REDACTED_SECRET_VALUE;
	}

	const slots = collectSlots(document);
	const edits: Edit[] = [];
	const scalarRanges = visitScalars(document, (scalar) => {
		const hidden = hideScalar(
			scalar,
			slots.get(scalar.node),
			matcher,
			replacement,
		);
		if (hidden !== null) {
			edits.push({
				start: scalar.range[0],
				end: scalar.range[1],
				text: formatScalar(scalar.node, hidden),
			});
		}
	});
	for (const [start, end] of commentRanges(text, scalarRanges)) {
		const comment = text.slice(start, end);
		const scrubbed = scrubSecretText(comment, matcher, replacement);
		if (scrubbed !== comment) {
			edits.push({ start, end, text: scrubbed });
		}
	}
	return applyEdits(text, edits);
};

// A secret written into the compose file itself is as real as one stored in
// env, so it joins the values scrubbed out of logs and other text.
export const collectComposeSecretValues = (
	text: string | null | undefined,
): string[] => {
	const document = text?.trim() ? parseCompose(text) : null;
	if (!document) {
		return [];
	}
	const slots = collectSlots(document);
	const values: string[] = [];
	visitScalars(document, ({ node, parentKey }) => {
		const slot = slots.get(node);
		if (!slot || node.value === null || node.value === undefined) {
			return;
		}
		const text = String(node.value);
		const separator = text.indexOf("=");
		if (slot === "value") {
			values.push(...collectSecretValue(parentKey ?? "", text));
		} else if (separator !== -1) {
			values.push(
				...collectSecretValue(
					text.slice(0, separator),
					text.slice(separator + 1),
				),
			);
		}
	});
	return values;
};

export class SecretRestoreError extends Error {}

const countTokens = (text: string) => {
	const counts = new Map<string, number>();
	for (const token of findSecretTokens(text)) {
		counts.set(token, (counts.get(token) ?? 0) + 1);
	}
	return counts;
};

// A value may only come back where it is hidden again. Otherwise moving a
// token next to `image:` would turn the secret into readable text on the next
// read.
const assertStillHidden = (submitted: string, rehidden: string) => {
	const visible = countTokens(rehidden);
	for (const [token, count] of countTokens(submitted)) {
		if ((visible.get(token) ?? 0) < count) {
			throw new SecretRestoreError(
				"A hidden value was moved to a place where it would become readable. Keep tokens inside environment variables, build args or the line they came from",
			);
		}
	}
};

const buildVault = (
	hide: (replacement: SecretReplacement) => string,
): Map<string, string> => {
	const vault = new Map<string, string>();
	hide((secret) => {
		const token = secretTokenFor(secret);
		vault.set(token, secret);
		return token;
	});
	return vault;
};

const resolveToken = (vault: Map<string, string>) => (token: string) => {
	const value = vault.get(token);
	if (value === undefined) {
		throw new SecretRestoreError(
			"The text contains a token that does not belong to the stored version. Read it again and keep its tokens unchanged",
		);
	}
	return value;
};

const assertRestorable = (submitted: string) => {
	if (hasUnrestorablePlaceholder(submitted)) {
		throw new SecretRestoreError(
			"The text contains a redacted placeholder without a token, so the hidden value cannot be put back. Replace it with a variable reference or a new value",
		);
	}
};

/**
 * Puts the stored values back where a compose file sent by an API key carries
 * their tokens.
 */
export const restoreComposeSecrets = (
	submitted: string,
	stored: string | null | undefined,
	matcher: KnownSecretMatcher,
) => {
	assertRestorable(submitted);
	if (findSecretTokens(submitted).length === 0) {
		return submitted;
	}
	const document = parseCompose(submitted);
	if (!document) {
		throw new SecretRestoreError(
			"The compose file is not valid YAML, so its hidden values cannot be put back",
		);
	}

	const resolve = resolveToken(
		buildVault((replacement) =>
			hideComposeSecrets(stored ?? "", matcher, replacement),
		),
	);
	const edits: Edit[] = [];
	const scalarRanges = visitScalars(document, ({ node, range }) => {
		if (
			typeof node.value === "string" &&
			findSecretTokens(node.value).length > 0
		) {
			edits.push({
				start: range[0],
				end: range[1],
				text: formatScalar(node, replaceSecretTokens(node.value, resolve)),
			});
		}
	});
	for (const [start, end] of commentRanges(submitted, scalarRanges)) {
		const comment = submitted.slice(start, end);
		if (findSecretTokens(comment).length > 0) {
			edits.push({ start, end, text: replaceSecretTokens(comment, resolve) });
		}
	}

	const restored = applyEdits(submitted, edits);
	if (findSecretTokens(restored).length > 0) {
		throw new SecretRestoreError(
			"A token stands where a value cannot be placed. Keep tokens inside values",
		);
	}
	assertStillHidden(submitted, hideComposeSecrets(restored, matcher));
	return restored;
};

/**
 * The same for a file whose format is not known (a mounted config file): the
 * value goes back exactly where its token stands.
 */
export const restoreTextSecrets = (
	submitted: string,
	stored: string | null | undefined,
	matcher: KnownSecretMatcher,
) => {
	assertRestorable(submitted);
	if (findSecretTokens(submitted).length === 0) {
		return submitted;
	}
	const resolve = resolveToken(
		buildVault((replacement) =>
			scrubSecretText(stored ?? "", matcher, replacement),
		),
	);
	const restored = replaceSecretTokens(submitted, resolve);
	assertStillHidden(
		submitted,
		scrubSecretText(restored, matcher, secretTokenFor),
	);
	return restored;
};

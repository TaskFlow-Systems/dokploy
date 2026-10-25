import {
	type EnvEntry,
	isEncodedDataFragment,
	isSecretEnvName,
	normalizeEnvText,
	parseEnvValues,
	scanEnvEntries,
} from "./env-upsert";

export type EnvLayoutHiddenKind = "comment" | "overridden" | "unreadable";

export type EnvLayoutItem =
	| { type: "variable"; name: string }
	| { type: "comment"; ref: string; text: string }
	| {
			type: "hidden";
			ref: string;
			kind: EnvLayoutHiddenKind;
			variable?: string;
	  }
	| { type: "blank" };

export type EnvLayoutInputItem =
	| { type: "variable"; name: string }
	| { type: "comment"; ref?: string; text?: string }
	| { type: "hidden"; ref: string }
	| { type: "blank" };

export type EnvLayoutResult = {
	env: string;
	changed: boolean;
	layout: EnvLayoutItem[];
};

type EnvLayout = {
	items: EnvLayoutItem[];
	variables: Map<string, string>;
	comments: Map<string, { line: string; text: string }>;
	hidden: Map<string, string>;
	earlierAssignments: Map<string, string>;
};

type LineOwner = { entry: EnvEntry; first: number; last: number };

const COMMENT_LINE_REGEX = /^\s*#[^\S\n]?(.*)$/;
const BLANK_LINE_REGEX = /^\s*$/;
const COMMENTED_ASSIGNMENT_REGEX = /^\s*(?:export\s+)?([\w.-]+)\s*=/;
const COMMENTED_COLON_ASSIGNMENT_REGEX =
	/^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*:\s+\S/;
const URL_CREDENTIALS_REGEX = /[a-z][\w+.-]*:\/\/[^\s/@]+@/i;
const PEM_MARKER_REGEX = /-----(?:BEGIN|END)\b/;
const BEARER_REGEX = /\bbearer\s+\S/i;
const SECRET_WORD_VALUE_REGEX =
	/(?:pass(?:word|wd)?|pwd|secret|token|key|credential|пароль|токен|ключ|секрет)\S*\s*[:=]\s*\S/iu;
const WORD_EDGE_PUNCTUATION_REGEX = /^[("'`<[{]+|[)"'`>\]},.;:!?]+$/g;

const unsafeLayout = () =>
	new Error(
		"The env text has a line structure that cannot be shown or rearranged safely",
	);

const formatComment = (text: string) => (text === "" ? "#" : `# ${text}`);

const looksLikeSecretWord = (word: string) => {
	const bare = word.replace(WORD_EDGE_PUNCTUATION_REGEX, "");
	return (
		bare.length >= 40 ||
		(bare.length >= 16 && /[A-Za-z]/.test(bare) && /\d/.test(bare))
	);
};

// Comments are shown so that sections and notes can be kept or rearranged,
// but people also park old values in them. Text that could hold a value is
// withheld: a commented-out assignment, credentials in a URL, a key block,
// a token-like word or a secret word followed by a value.
const describeComment = (
	text: string,
): { hidden: false } | { hidden: true; variable?: string } => {
	const assignment = COMMENTED_ASSIGNMENT_REGEX.exec(text);
	if (assignment) {
		return { hidden: true, variable: assignment[1] };
	}
	const colonAssignment = COMMENTED_COLON_ASSIGNMENT_REGEX.exec(text);
	if (
		colonAssignment?.[1] &&
		(colonAssignment[1].includes("_") || isSecretEnvName(colonAssignment[1]))
	) {
		return { hidden: true, variable: colonAssignment[1] };
	}
	if (
		URL_CREDENTIALS_REGEX.test(text) ||
		PEM_MARKER_REGEX.test(text) ||
		BEARER_REGEX.test(text) ||
		SECRET_WORD_VALUE_REGEX.test(text) ||
		text.split(/\s+/).some(looksLikeSecretWord)
	) {
		return { hidden: true };
	}
	return { hidden: false };
};

const splitEnvBody = (currentEnv: string | null | undefined) => {
	const original = normalizeEnvText(currentEnv);
	const trailingNewline = original.endsWith("\n");
	return {
		original,
		body: trailingNewline ? original.slice(0, -1) : original,
		trailingNewline,
	};
};

const mapEntriesToLines = (body: string, lines: string[]) => {
	const lineByOffset = new Map<number, number>();
	let offset = 0;
	lines.forEach((line, index) => {
		lineByOffset.set(offset, index);
		offset += line.length + 1;
	});

	const owners: (LineOwner | undefined)[] = new Array(lines.length);
	for (const entry of scanEnvEntries(body)) {
		const first = lineByOffset.get(entry.lineStart);
		const endsText = entry.lineEnd >= body.length;
		const next = endsText ? lines.length : lineByOffset.get(entry.lineEnd + 1);
		// dotenv also ends a line at U+2028 and U+2029. An assignment that starts
		// or ends at one of them shares a physical line with other text, and
		// moving that line would move the other text with it.
		if (
			first === undefined ||
			next === undefined ||
			(!endsText && body[entry.lineEnd] !== "\n")
		) {
			throw unsafeLayout();
		}
		const owner = { entry, first, last: next - 1 };
		for (let index = first; index < next; index++) {
			if (owners[index]) {
				throw unsafeLayout();
			}
			owners[index] = owner;
		}
	}
	return owners;
};

const scanEnvLayout = (body: string): EnvLayout => {
	const lines = body.length > 0 ? body.split("\n") : [];
	const owners = mapEntriesToLines(body, lines);
	const values = parseEnvValues(body);
	const isListed = (name: string) =>
		values.has(name) && !isEncodedDataFragment(name);
	const isUnreadable = (index: number) => {
		const owner = owners[index];
		if (owner) {
			return !isListed(owner.entry.name);
		}
		const line = lines[index] ?? "";
		return !BLANK_LINE_REGEX.test(line) && !COMMENT_LINE_REGEX.test(line);
	};
	const takeUnreadable = (from: number) => {
		let index = from;
		while (index < lines.length && isUnreadable(index)) {
			index++;
		}
		return index;
	};

	type Segment =
		| { kind: "variable"; name: string; text: string }
		| { kind: "comment"; line: string; text: string }
		| {
				kind: "hidden";
				hiddenKind: EnvLayoutHiddenKind;
				text: string;
				variable?: string;
		  }
		| { kind: "blank" };
	const segments: Segment[] = [];
	let index = 0;
	while (index < lines.length) {
		const owner = owners[index];
		const line = lines[index] ?? "";
		if (owner && isListed(owner.entry.name)) {
			// Lines dotenv cannot read right after an assignment are most often the
			// rest of an unquoted value, such as a pasted key block, so they move
			// with that variable.
			const end = takeUnreadable(owner.last + 1);
			segments.push({
				kind: "variable",
				name: owner.entry.name,
				text: lines.slice(index, end).join("\n"),
			});
			index = end;
			continue;
		}
		if (isUnreadable(index)) {
			const end = takeUnreadable(index);
			segments.push({
				kind: "hidden",
				hiddenKind: "unreadable",
				text: lines.slice(index, end).join("\n"),
			});
			index = end;
			continue;
		}
		const comment = COMMENT_LINE_REGEX.exec(line);
		if (comment) {
			const text = (comment[1] ?? "").trimEnd();
			const description = describeComment(text);
			segments.push(
				description.hidden
					? {
							kind: "hidden",
							hiddenKind: "comment",
							text: line,
							variable: description.variable,
						}
					: { kind: "comment", line, text },
			);
		} else {
			segments.push({ kind: "blank" });
		}
		index++;
	}

	const lastSegmentByName = new Map<string, Segment>();
	for (const segment of segments) {
		if (segment.kind === "variable") {
			lastSegmentByName.set(segment.name, segment);
		}
	}

	const layout: EnvLayout = {
		items: [],
		variables: new Map(),
		comments: new Map(),
		hidden: new Map(),
		earlierAssignments: new Map(),
	};
	for (const segment of segments) {
		if (segment.kind === "variable") {
			if (lastSegmentByName.get(segment.name) === segment) {
				layout.items.push({ type: "variable", name: segment.name });
				layout.variables.set(segment.name, segment.text);
				continue;
			}
			// An earlier assignment of a name that is assigned again has no effect
			// but still holds a value. It is shown as a hidden line, so a layout
			// sent back unchanged leaves the text as it is.
			const ref = `h${layout.hidden.size + 1}`;
			layout.items.push({
				type: "hidden",
				ref,
				kind: "overridden",
				variable: segment.name,
			});
			layout.hidden.set(ref, segment.text);
			layout.earlierAssignments.set(ref, segment.name);
		} else if (segment.kind === "comment") {
			const ref = `c${layout.comments.size + 1}`;
			layout.items.push({ type: "comment", ref, text: segment.text });
			layout.comments.set(ref, { line: segment.line, text: segment.text });
		} else if (segment.kind === "hidden") {
			const ref = `h${layout.hidden.size + 1}`;
			layout.items.push(
				segment.variable === undefined
					? { type: "hidden", ref, kind: segment.hiddenKind }
					: {
							type: "hidden",
							ref,
							kind: segment.hiddenKind,
							variable: segment.variable,
						},
			);
			layout.hidden.set(ref, segment.text);
		} else {
			layout.items.push({ type: "blank" });
		}
	}
	return layout;
};

export const readEnvLayout = (
	currentEnv: string | null | undefined,
): EnvLayoutItem[] => scanEnvLayout(splitEnvBody(currentEnv).body).items;

const listNames = (names: Iterable<string>) => [...names].join(", ");

export const applyEnvLayout = (
	currentEnv: string | null | undefined,
	layout: EnvLayoutInputItem[],
): EnvLayoutResult => {
	const { original, body, trailingNewline } = splitEnvBody(currentEnv);
	const current = scanEnvLayout(body);
	const unknownNames = new Set<string>();
	const repeatedNames = new Set<string>();
	const unknownRefs = new Set<string>();
	const repeatedRefs = new Set<string>();
	const lines: string[] = [];
	const refPositions = new Map<string, number>();
	const namePositions = new Map<string, number>();

	const placeRef = (ref: string, text: string | undefined) => {
		if (text === undefined) {
			unknownRefs.add(ref);
		} else if (refPositions.has(ref)) {
			repeatedRefs.add(ref);
		} else {
			refPositions.set(ref, lines.length);
			lines.push(text);
		}
	};

	for (const item of layout) {
		if (item.type === "variable") {
			const text = current.variables.get(item.name);
			if (text === undefined) {
				unknownNames.add(item.name);
			} else if (namePositions.has(item.name)) {
				repeatedNames.add(item.name);
			} else {
				namePositions.set(item.name, lines.length);
				lines.push(text);
			}
		} else if (item.type === "comment") {
			if (item.ref === undefined) {
				lines.push(formatComment(item.text ?? ""));
				continue;
			}
			const comment = current.comments.get(item.ref);
			placeRef(
				item.ref,
				comment &&
					(item.text === undefined || item.text === comment.text
						? comment.line
						: formatComment(item.text)),
			);
		} else if (item.type === "hidden") {
			placeRef(item.ref, current.hidden.get(item.ref));
		} else {
			lines.push("");
		}
	}

	const missingNames = [...current.variables.keys()].filter(
		(name) => !namePositions.has(name),
	);
	const missingHidden = [...current.hidden.keys()].filter(
		(ref) => !refPositions.has(ref),
	);
	const misplacedAssignments = [...current.earlierAssignments]
		.filter(
			([ref, name]) =>
				(refPositions.get(ref) ?? -1) >
				(namePositions.get(name) ?? Number.POSITIVE_INFINITY),
		)
		.map(([ref, name]) => `${ref} (${name})`);
	const problems = [
		unknownNames.size > 0 &&
			`The layout names variables that do not exist: ${listNames(unknownNames)}.`,
		repeatedNames.size > 0 &&
			`The layout places variables more than once: ${listNames(repeatedNames)}.`,
		missingNames.length > 0 &&
			`The layout leaves out variables: ${listNames(missingNames)}. Every variable has to be placed; delete one with remove instead.`,
		unknownRefs.size > 0 &&
			`The layout refers to lines that do not exist: ${listNames(unknownRefs)}.`,
		repeatedRefs.size > 0 &&
			`The layout places lines more than once: ${listNames(repeatedRefs)}.`,
		missingHidden.length > 0 &&
			`The layout leaves out hidden lines: ${listNames(missingHidden)}. Their text is not shown, so they can be moved but not dropped.`,
		misplacedAssignments.length > 0 &&
			`These hidden lines are earlier assignments of a variable and have to stay above it: ${listNames(misplacedAssignments)}.`,
	].filter((problem): problem is string => typeof problem === "string");
	if (problems.length > 0) {
		throw new Error(problems.join(" "));
	}

	const nextBody = lines.join("\n");
	const nextEnv =
		trailingNewline && nextBody.length > 0 ? `${nextBody}\n` : nextBody;

	// Moving whole lines keeps every value as long as dotenv splits the text the
	// same way; a quote that pairs up with a different line would not.
	const before = parseEnvValues(body);
	const after = parseEnvValues(nextEnv);
	const brokenNames = [...new Set([...before.keys(), ...after.keys()])].filter(
		(name) => before.get(name) !== after.get(name),
	);
	if (brokenNames.length > 0) {
		throw new Error(
			`Environment variables cannot be rearranged safely: ${listNames(brokenNames)}`,
		);
	}

	const changed = nextEnv !== original;
	return {
		env: changed ? nextEnv : (currentEnv ?? ""),
		changed,
		layout: changed ? readEnvLayout(nextEnv) : current.items,
	};
};

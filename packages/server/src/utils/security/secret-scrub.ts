import { createHmac } from "node:crypto";
import { parse } from "dotenv";
import { betterAuthSecret } from "../../lib/auth-secret";
import {
	isVariableReference,
	REDACTED_SECRET_VALUE,
	redactSensitiveText,
	SECRET_TOKEN_PATTERN,
} from "./redaction";

/**
 * Text that leaves the panel towards an AI (an API key response, a prompt for
 * the AI provider) is scrubbed of the secret values the panel stores and of
 * anything that looks like a credential.
 */

export type KnownSecretMatcher = {
	size: number;
	pattern: RegExp | null;
};

export const EMPTY_KNOWN_SECRET_MATCHER: KnownSecretMatcher = {
	size: 0,
	pattern: null,
};

const SECRET_ENV_NAME =
	/(?:^|_)(?:AUTH|CERT|CONNECTION_STRING|COOKIE|CREDENTIALS?|DSN|ENCRYPTION|JWT|KEYS?|LICENSE|MNEMONIC|PASS|PASSPHRASE|PASSWD|PASSWORD|PRIVATE|PW|PWD|SALT|SECRETS?|SEED|SESSION|SIGNATURE|TOKENS?|WEBHOOK)(?:$|_)/i;

const MIN_KNOWN_SECRET_LENGTH = 8;
const OPAQUE_VALUE = /^[A-Za-z0-9+/_=-]{32,}$/;
const URL_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/([^@\s/?#]+)@/i;

// A value only goes on the scrub list when replacing it everywhere cannot
// mangle ordinary output: dictionary-like words and plain numbers stay out.
const isDistinctiveValue = (value: string) =>
	value.length >= MIN_KNOWN_SECRET_LENGTH &&
	!/^[a-z]+$/.test(value) &&
	!/^\d+$/.test(value) &&
	!/\s/.test(value) &&
	!value.includes(REDACTED_SECRET_VALUE) &&
	!isVariableReference(value);

const userinfoSecrets = (value: string) => {
	const userinfo = URL_USERINFO.exec(value)?.[1];
	if (!userinfo) {
		return [];
	}
	const separator = userinfo.indexOf(":");
	const secret = separator === -1 ? userinfo : userinfo.slice(separator + 1);
	let decoded = secret;
	try {
		decoded = decodeURIComponent(secret);
	} catch {}
	return [...new Set([secret, decoded])];
};

export const collectSecretValue = (name: string, value: unknown): string[] => {
	if (typeof value !== "string") {
		return [];
	}
	const trimmed = value.trim();
	const candidates = userinfoSecrets(trimmed);
	if (
		SECRET_ENV_NAME.test(name) ||
		(OPAQUE_VALUE.test(trimmed) &&
			/[A-Za-z]/.test(trimmed) &&
			/\d/.test(trimmed))
	) {
		candidates.push(trimmed);
	}
	return candidates.filter(isDistinctiveValue);
};

export const collectEnvSecretValues = (
	envText: string | null | undefined,
): string[] => {
	if (!envText) {
		return [];
	}
	return Object.entries(parse(envText)).flatMap(([name, value]) =>
		collectSecretValue(name, value),
	);
};

const escapeRegExp = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type TrieNode = { children: Map<string, TrieNode>; terminal: boolean };

// One alternation per secret makes the regex engine try every secret at every
// position. A prefix tree keeps a scan of a large log proportional to its size
// however many secrets the panel stores, and prefers the longest secret.
const toTriePattern = (node: TrieNode): string => {
	const branches = [...node.children].map(
		([character, child]) => `${escapeRegExp(character)}${toTriePattern(child)}`,
	);
	if (branches.length === 0) {
		return "";
	}
	if (node.terminal) {
		return `(?:${branches.join("|")})?`;
	}
	return branches.length === 1 ? branches[0]! : `(?:${branches.join("|")})`;
};

const buildTriePattern = (values: Iterable<string>) => {
	const root: TrieNode = { children: new Map(), terminal: false };
	for (const value of values) {
		let node = root;
		for (const character of value) {
			let child = node.children.get(character);
			if (!child) {
				child = { children: new Map(), terminal: false };
				node.children.set(character, child);
			}
			node = child;
		}
		node.terminal = true;
	}
	root.terminal = false;
	return toTriePattern(root);
};

const MIN_ENCODED_FORM_LENGTH = 16;

// A secret printed in base64 or hex is still the secret. Base64 text depends on
// where the value starts inside the encoded data, so each of the three
// alignments is covered, without the characters that mix in neighbouring bytes.
const encodedForms = (value: string) => {
	const bytes = Buffer.from(value, "utf8");
	const hex = bytes.toString("hex");
	const forms = [hex, hex.toUpperCase()];
	for (let shift = 0; shift < 3; shift++) {
		const encoded = Buffer.concat([Buffer.alloc(shift), bytes])
			.toString("base64")
			.replace(/=+$/, "");
		const dangling = ((shift + bytes.length) * 8) % 6 === 0 ? 0 : 1;
		const core = encoded.slice([0, 2, 3][shift], encoded.length - dangling);
		forms.push(core, core.replace(/\+/g, "-").replace(/\//g, "_"));
	}
	return forms.filter((form) => form.length >= MIN_ENCODED_FORM_LENGTH);
};

export const buildKnownSecretMatcher = (
	values: Iterable<string>,
): KnownSecretMatcher => {
	const unique = [...new Set(values)].filter(isDistinctiveValue);
	if (unique.length === 0) {
		return EMPTY_KNOWN_SECRET_MATCHER;
	}
	return {
		size: unique.length,
		pattern: new RegExp(
			buildTriePattern([...unique, ...unique.flatMap(encodedForms)]),
			"g",
		),
	};
};

const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// A token is the placeholder plus an id of the hidden value. The id is keyed
// with a server secret, so it says nothing about the value, and it is the same
// each time the value is hidden, so a token read earlier still resolves.
export const secretTokenFor = (value: string) => {
	const digest = createHmac("sha256", betterAuthSecret)
		.update("secret-token-v1\0")
		.update(value)
		.digest();
	let id = "";
	for (let index = 0; index < 12; index++) {
		id += TOKEN_ALPHABET[digest[index]! & 31];
	}
	return `${REDACTED_SECRET_VALUE}${id}__`;
};

const SECRET_TOKEN = new RegExp(SECRET_TOKEN_PATTERN, "g");
const WHOLE_SECRET_TOKEN = new RegExp(`^${SECRET_TOKEN_PATTERN}$`);
// The token comes first: a token starts with the plain placeholder.
const ANY_PLACEHOLDER = new RegExp(
	`${SECRET_TOKEN_PATTERN}|${escapeRegExp(REDACTED_SECRET_VALUE)}|\\[REDACTED\\]`,
	"g",
);

export const findSecretTokens = (text: string) =>
	text.match(SECRET_TOKEN) ?? [];

// A plain placeholder carries no id, so the value behind it cannot be put back.
export const hasUnrestorablePlaceholder = (text: string) =>
	(text.match(ANY_PLACEHOLDER) ?? []).some(
		(placeholder) => !WHOLE_SECRET_TOKEN.test(placeholder),
	);

export const replaceSecretTokens = (
	text: string,
	resolve: (token: string) => string,
) => text.replace(SECRET_TOKEN, resolve);

const PRIVATE_KEY_BLOCK =
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

// A token starts where the run of token characters starts, so a line made of
// one long run is scanned once instead of once per prefix it contains.
const TOKEN_START = "(?<![A-Za-z0-9_-])";

const TOKEN_SHAPES = [
	"github_pat_[A-Za-z0-9_]{22,}",
	"glpat-[A-Za-z0-9_-]{20,}",
	"xox[abprs]-[A-Za-z0-9-]{10,}",
	"sk-[A-Za-z0-9_-]{20,}",
	"(?:AKIA|ASIA)[0-9A-Z]{16}\\b",
	"eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}",
].map((shape) => new RegExp(`${TOKEN_START}${shape}`, "g"));

// Some credential patterns scan to the end of the line, so one huge line (a
// minified bundle, a base64 dump) is scrubbed in pieces to keep the cost of a
// log read proportional to its size.
const MAX_SCRUB_PIECE_LENGTH = 4096;

const hasLongLine = (text: string) => {
	let lineStart = 0;
	while (lineStart <= text.length) {
		const lineEnd = text.indexOf("\n", lineStart);
		if (
			(lineEnd === -1 ? text.length : lineEnd) - lineStart >
			MAX_SCRUB_PIECE_LENGTH
		) {
			return true;
		}
		if (lineEnd === -1) {
			return false;
		}
		lineStart = lineEnd + 1;
	}
	return false;
};

const PIECE_DELIMITER = /[\s,;&|]/;

// Cutting after a delimiter keeps a `name=value` pair in one piece.
const pieceEnd = (line: string) => {
	for (
		let index = MAX_SCRUB_PIECE_LENGTH;
		index > MAX_SCRUB_PIECE_LENGTH / 2;
		index--
	) {
		if (PIECE_DELIMITER.test(line[index - 1]!)) {
			return index;
		}
	}
	return MAX_SCRUB_PIECE_LENGTH;
};

const splitLongLine = (line: string) => {
	const pieces: string[] = [];
	let rest = line;
	while (rest.length > MAX_SCRUB_PIECE_LENGTH) {
		const end = pieceEnd(rest);
		pieces.push(rest.slice(0, end));
		rest = rest.slice(end);
	}
	pieces.push(rest);
	return pieces;
};

type SecretReplacement = (secret: string) => string;

export type ScrubSecretTextOptions = {
	// With it every hidden value becomes whatever it returns for that value,
	// which is how restorable tokens are produced.
	replacement?: SecretReplacement;
	// The text is a config file, where `name value` lines are settings.
	file?: boolean;
};

const scrubCredentialPatterns = (
	text: string,
	{ replacement, file }: ScrubSecretTextOptions,
) => {
	const hide = replacement ?? (() => REDACTED_SECRET_VALUE);
	let scrubbed = text;
	for (const shape of TOKEN_SHAPES) {
		scrubbed = scrubbed.replace(shape, (secret) => hide(secret));
	}
	return redactSensitiveText(scrubbed, {
		broadKeys: true,
		keepVariableReferences: true,
		directives: file,
		replacement,
	});
};

export const scrubSecretText = (
	text: string,
	matcher: KnownSecretMatcher = EMPTY_KNOWN_SECRET_MATCHER,
	options: ScrubSecretTextOptions = {},
) => {
	if (text === "") {
		return text;
	}
	const hide = options.replacement ?? (() => REDACTED_SECRET_VALUE);
	const scrubbed = (
		matcher.pattern
			? text.replace(matcher.pattern, (secret) => hide(secret))
			: text
	).replace(PRIVATE_KEY_BLOCK, (secret) => hide(secret));
	if (!hasLongLine(scrubbed)) {
		return scrubCredentialPatterns(scrubbed, options);
	}
	return scrubbed
		.split("\n")
		.map((line) =>
			splitLongLine(line)
				.map((piece) => scrubCredentialPatterns(piece, options))
				.join(""),
		)
		.join("\n");
};

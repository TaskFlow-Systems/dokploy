import { parse } from "dotenv";
import {
	isVariableReference,
	REDACTED_SECRET_VALUE,
	redactSensitiveText,
} from "./redaction";

/**
 * What leaves the panel towards an AI (an API key response, a prompt for the
 * AI provider) never carries secret values: fields that hold secrets are
 * blanked, and every other string (logs, compose files, mounted files,
 * commands) is scrubbed of known secret values and of text that looks like a
 * credential.
 */

export type KnownSecretMatcher = {
	size: number;
	pattern: RegExp | null;
};

export const EMPTY_KNOWN_SECRET_MATCHER: KnownSecretMatcher = {
	size: 0,
	pattern: null,
};

const SENSITIVE_OUTPUT_KEY =
	/(?:env$|buildargs$|buildsecrets$|password|passwd|passphrase|secret|tokens?$|private_?key|api_?key$|access_?key|credential|authorization|^cookie$|dsn$|connection_?string|webhook_?url$|^dockerauth$|license_?key$|^userkey$|^headers$)/i;

// `secretName`, `apiKeyId` or `tokenType` describe a secret without holding it.
const DESCRIPTIVE_KEY_SUFFIX =
	/(?:Id|Ids|Name|Names|Path|Type|Count|At|Enabled|Status|Length|Prefix)$/;

// Identifiers and revisions are never secrets, and a caller that gets one back
// mangled can no longer address the resource or pass the revision on.
const IDENTITY_KEY = /(?:^id$|Id$|Ids$|^name$|Name$|^revision$|Revision$)/;

const SECRET_ENV_NAME =
	/(?:^|_)(?:AUTH|CERT|CONNECTION_STRING|COOKIE|CREDENTIALS?|DSN|ENCRYPTION|JWT|KEYS?|LICENSE|MNEMONIC|PASS|PASSPHRASE|PASSWD|PASSWORD|PRIVATE|PW|PWD|SALT|SECRETS?|SEED|SESSION|SIGNATURE|TOKENS?|WEBHOOK)(?:$|_)/i;

const MIN_KNOWN_SECRET_LENGTH = 8;
const OPAQUE_VALUE = /^[A-Za-z0-9+/_=-]{32,}$/;
const URL_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/([^@\s/?#]+)@/i;

export const isSensitiveOutputKey = (key: string) =>
	SENSITIVE_OUTPUT_KEY.test(key) && !DESCRIPTIVE_KEY_SUFFIX.test(key);

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

export const buildKnownSecretMatcher = (
	values: Iterable<string>,
): KnownSecretMatcher => {
	const unique = [...new Set(values)].filter(isDistinctiveValue);
	if (unique.length === 0) {
		return EMPTY_KNOWN_SECRET_MATCHER;
	}
	// Longest first, so a secret that contains another one is replaced whole.
	unique.sort((a, b) => b.length - a.length);
	return {
		size: unique.length,
		pattern: new RegExp(unique.map(escapeRegExp).join("|"), "g"),
	};
};

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

const scrubCredentialPatterns = (text: string) => {
	let scrubbed = text;
	for (const shape of TOKEN_SHAPES) {
		scrubbed = scrubbed.replace(shape, REDACTED_SECRET_VALUE);
	}
	return redactSensitiveText(scrubbed, {
		broadKeys: true,
		keepVariableReferences: true,
	});
};

export const scrubSecretText = (
	text: string,
	matcher: KnownSecretMatcher = EMPTY_KNOWN_SECRET_MATCHER,
) => {
	if (text === "") {
		return text;
	}
	const scrubbed = (
		matcher.pattern
			? text.replace(matcher.pattern, REDACTED_SECRET_VALUE)
			: text
	).replace(PRIVATE_KEY_BLOCK, REDACTED_SECRET_VALUE);
	if (!hasLongLine(scrubbed)) {
		return scrubCredentialPatterns(scrubbed);
	}
	return scrubbed
		.split("\n")
		.map((line) => splitLongLine(line).map(scrubCredentialPatterns).join(""))
		.join("\n");
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
};

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

// Under a secret-bearing key every value is blanked. The names in a list of
// assignments (a docker `Env` array) and the keys of a map stay readable.
const blankSecretValue = (value: unknown, listItem = false): unknown => {
	if (typeof value === "string") {
		if (value === "") {
			return value;
		}
		const assignment = listItem ? ENV_ASSIGNMENT.exec(value) : null;
		return assignment
			? `${assignment[1]}=${REDACTED_SECRET_VALUE}`
			: REDACTED_SECRET_VALUE;
	}
	if (Array.isArray(value)) {
		return value.map((item) => blankSecretValue(item, true));
	}
	if (isPlainObject(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, blankSecretValue(item)]),
		);
	}
	return value;
};

const scrubValue = (
	value: unknown,
	key: string | null,
	matcher: KnownSecretMatcher,
): unknown => {
	if (typeof value === "string") {
		return key !== null && IDENTITY_KEY.test(key)
			? value
			: scrubSecretText(value, matcher);
	}
	if (Array.isArray(value)) {
		return value.map((item) => scrubValue(item, key, matcher));
	}
	if (!isPlainObject(value)) {
		return value;
	}
	return Object.fromEntries(
		Object.entries(value).map(([childKey, child]) => [
			childKey,
			isSensitiveOutputKey(childKey)
				? blankSecretValue(child)
				: scrubValue(child, childKey, matcher),
		]),
	);
};

export const scrubSecretOutput = <T>(
	value: T,
	matcher: KnownSecretMatcher = EMPTY_KNOWN_SECRET_MATCHER,
): T => scrubValue(value, null, matcher) as T;

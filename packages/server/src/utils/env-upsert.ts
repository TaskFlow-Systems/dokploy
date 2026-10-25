import { createHmac } from "node:crypto";
import { parse } from "dotenv";
import { betterAuthSecret } from "../lib/auth-secret";

export type EnvUpsertAction = "created" | "updated" | "unchanged";

export type EnvUpsertVariableResult = {
	name: string;
	action: EnvUpsertAction;
	secret: boolean;
};

export type EnvUpsertResult = {
	env: string;
	changed: boolean;
	variables: EnvUpsertVariableResult[];
};

const REDACTED_SECRET_PLACEHOLDERS = [
	"__DOKPLOY_REDACTED_SECRET__",
	"[REDACTED]",
] as const;

export const assertNoRedactedSecretPlaceholders = (
	variables: Record<string, string>,
) => {
	const invalidNames = Object.entries(variables)
		.filter(([, value]) =>
			REDACTED_SECRET_PLACEHOLDERS.some((placeholder) =>
				value.includes(placeholder),
			),
		)
		.map(([name]) => name);

	if (invalidNames.length > 0) {
		throw new Error(
			`Environment variables contain redacted secret placeholders: ${invalidNames.join(", ")}`,
		);
	}
};

const ENV_ASSIGNMENT_REGEX =
	/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/;

const SECRET_NAME_REGEX =
	/(^|_)(AUTH|CREDENTIAL|KEY|PASS|PASSWORD|PRIVATE|SECRET|TOKEN|WEBHOOK)($|_)/i;

export const isSecretEnvName = (name: string) => SECRET_NAME_REGEX.test(name);

export const getApplicationEnvRevision = (
	applicationId: string,
	env: string | null | undefined,
) =>
	`env:${createHmac("sha256", betterAuthSecret)
		.update(applicationId)
		.update("\0")
		.update(env ?? "")
		.digest("base64url")
		.slice(0, 32)}`;

export const getComposeEnvRevision = (
	composeId: string,
	env: string | null | undefined,
) =>
	`compose-env-v1:${createHmac("sha256", betterAuthSecret)
		.update(String(Buffer.byteLength(composeId)))
		.update(":")
		.update(composeId)
		.update(String(Buffer.byteLength(env ?? "")))
		.update(":")
		.update(env ?? "")
		.digest("base64url")}`;

export const getEnvFieldRevision = (
	scope: string,
	id: string,
	field: string,
	env: string | null | undefined,
) => {
	const hmac = createHmac("sha256", betterAuthSecret);
	for (const part of [scope, id, field, env ?? ""]) {
		hmac
			.update(String(Buffer.byteLength(part)))
			.update(":")
			.update(part);
	}
	return `env-field-v1:${hmac.digest("base64url")}`;
};

const serializeEnvValue = (value: string) => {
	if (value === "") {
		return "";
	}

	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
		return value;
	}

	return `"${value
		.replace(/\\/g, "\\\\")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/"/g, '\\"')}"`;
};

const splitEnvLines = (env: string) => {
	const normalized = env.replace(/\r\n/g, "\n");
	const trailingNewline = normalized.endsWith("\n");
	const lines = normalized.length > 0 ? normalized.split("\n") : [];

	if (trailingNewline) {
		lines.pop();
	}

	return {
		lines,
		trailingNewline,
	};
};

export const upsertEnvVariables = (
	currentEnv: string | null | undefined,
	variables: Record<string, string>,
): EnvUpsertResult => {
	const env = currentEnv ?? "";
	const currentValues = parse(env);
	const { lines, trailingNewline } = splitEnvLines(env);
	const lastLineByName = new Map<string, number>();

	lines.forEach((line, index) => {
		const match = ENV_ASSIGNMENT_REGEX.exec(line);
		if (match) {
			lastLineByName.set(match[2]!, index);
		}
	});

	let changed = false;
	const variableResults: EnvUpsertVariableResult[] = [];

	for (const [name, value] of Object.entries(variables)) {
		const currentValue = currentValues[name];
		const action =
			currentValue === undefined
				? "created"
				: currentValue === value
					? "unchanged"
					: "updated";

		variableResults.push({
			name,
			action,
			secret: isSecretEnvName(name),
		});

		if (action === "unchanged") {
			continue;
		}

		changed = true;
		const serializedValue = serializeEnvValue(value);
		const existingLineIndex = lastLineByName.get(name);

		if (existingLineIndex !== undefined) {
			const match = ENV_ASSIGNMENT_REGEX.exec(lines[existingLineIndex]!);
			if (match) {
				lines[existingLineIndex] =
					`${match[1]!}${name}${match[3]!}${serializedValue}`;
			}
			continue;
		}

		lines.push(`${name}=${serializedValue}`);
	}

	const nextEnv = lines.join("\n");

	return {
		env: trailingNewline && nextEnv.length > 0 ? `${nextEnv}\n` : nextEnv,
		changed,
		variables: variableResults,
	};
};

export type EnvVariableKey = {
	name: string;
	secret: boolean;
	empty: boolean;
};

export type EnvChange =
	| { name: string; source: "set" | "copy"; value: string }
	// A null value previews a generated variable: the action is reported and the
	// text is left alone, so a dry run never has to create a secret.
	| { name: string; source: "generate"; value: string | null }
	| { name: string; source: "remove" };

export type EnvChangeAction =
	| "created"
	| "updated"
	| "unchanged"
	| "removed"
	| "missing";

export type EnvChangeVariableResult = {
	name: string;
	action: EnvChangeAction;
	source: EnvChange["source"];
	secret: boolean;
};

export type EnvChangeResult = {
	env: string;
	changed: boolean;
	variables: EnvChangeVariableResult[];
};

// dotenv's own line grammar with every part captured. Deploys read these fields
// through dotenv, so an edit has to cover exactly what dotenv treats as one
// assignment, including a quoted value that runs over several physical lines.
const ENV_ENTRY_REGEX =
	/^(\s*)((?:export\s+)?)([\w.-]+)(\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/gm;

export type EnvEntry = {
	name: string;
	lineStart: number;
	valueStart: number;
	valueEnd: number;
	lineEnd: number;
};

export const normalizeEnvText = (env: string | null | undefined) =>
	(env ?? "").replace(/\r\n?/g, "\n");

export const parseEnvValues = (text: string) =>
	new Map(Object.entries(parse(text)));

export const scanEnvEntries = (text: string): EnvEntry[] => {
	const lineBreak = /[\n\u2028\u2029]/g;

	return Array.from(text.matchAll(ENV_ENTRY_REGEX), (match) => {
		const [, lead = "", prefix = "", name = "", separator = "", rawValue = ""] =
			match;
		const start = match.index + lead.length;
		const indent = /[^\n\u2028\u2029]*$/.exec(lead)?.[0].length ?? 0;
		const separatorEnd = start + prefix.length + name.length + separator.length;
		const value = rawValue.trim();
		const valueStart = value
			? separatorEnd + rawValue.length - rawValue.trimStart().length
			: separatorEnd;
		const valueEnd = valueStart + value.length;
		lineBreak.lastIndex = valueEnd;

		return {
			name,
			lineStart: start - indent,
			valueStart,
			valueEnd,
			lineEnd: lineBreak.exec(text)?.index ?? text.length,
		};
	});
};

// dotenv only turns \n and \r back inside double quotes and never unescapes a
// quote or a backslash, so a value holding either one needs another form that
// dotenv reads back character for character.
const serializeExactEnvValue = (name: string, value: string) => {
	if (!/["\\]/.test(value)) {
		return serializeEnvValue(value);
	}

	const quotable = !value.endsWith("\\") && !value.includes("\r");
	for (const quote of ["'", "`"]) {
		if (quotable && !value.includes(quote)) {
			return `${quote}${value}${quote}`;
		}
	}
	if (quotable && !value.includes('"') && !/\\[nr]/.test(value)) {
		return `"${value}"`;
	}
	if (
		!/[#\r\n]/.test(value) &&
		value === value.trim() &&
		!/^['"`]/.test(value)
	) {
		return value;
	}

	throw new Error(
		`Environment variable value cannot be stored safely: ${name}`,
	);
};

// A key block pasted without quotes makes dotenv read its base64 lines that
// end in `=` as assignments. Such a "name" is a piece of the secret, so a name
// that looks like encoded data is left out of the listing.
export const isEncodedDataFragment = (name: string) =>
	name.length >= 20 &&
	!name.includes("_") &&
	/[a-z]/.test(name) &&
	/[A-Z]/.test(name) &&
	/\d/.test(name);

export const listEnvVariables = (
	currentEnv: string | null | undefined,
): EnvVariableKey[] => {
	const text = normalizeEnvText(currentEnv);
	const values = parseEnvValues(text);
	const names = new Set(scanEnvEntries(text).map((entry) => entry.name));

	return [...names]
		.filter((name) => values.has(name) && !isEncodedDataFragment(name))
		.map((name) => ({
			name,
			secret: isSecretEnvName(name),
			empty: values.get(name) === "",
		}));
};

export const getEnvVariableValue = (
	currentEnv: string | null | undefined,
	name: string,
) => parseEnvValues(normalizeEnvText(currentEnv)).get(name);

export const applyEnvChanges = (
	currentEnv: string | null | undefined,
	changes: EnvChange[],
): EnvChangeResult => {
	const original = normalizeEnvText(currentEnv);
	const trailingNewline = original.endsWith("\n");
	const body = trailingNewline ? original.slice(0, -1) : original;
	const currentValues = parseEnvValues(body);
	const entries = scanEnvEntries(body);
	const expectedValues = new Map(currentValues);
	const removedNames = new Set<string>();
	const replacements = new Map<EnvEntry, string>();
	const appendedLines: string[] = [];
	const variables: EnvChangeVariableResult[] = [];

	for (const change of changes) {
		const { name, source } = change;
		const exists = currentValues.has(name);
		const secret = isSecretEnvName(name);

		if (change.source === "remove") {
			variables.push({
				name,
				action: exists ? "removed" : "missing",
				source,
				secret,
			});
			if (exists) {
				removedNames.add(name);
				expectedValues.delete(name);
			}
			continue;
		}

		const action = !exists
			? "created"
			: change.source !== "generate" && currentValues.get(name) === change.value
				? "unchanged"
				: "updated";
		variables.push({ name, action, source, secret });

		if (action === "unchanged" || change.value === null) {
			continue;
		}

		expectedValues.set(name, change.value);
		const serializedValue = serializeExactEnvValue(name, change.value);
		const effectiveEntry = entries
			.filter((entry) => entry.name === name)
			.at(-1);
		if (effectiveEntry) {
			replacements.set(effectiveEntry, serializedValue);
		} else {
			appendedLines.push(`${name}=${serializedValue}`);
		}
	}

	const changed = variables.some(
		({ action }) => action !== "unchanged" && action !== "missing",
	);
	if (!changed) {
		return { env: currentEnv ?? "", changed, variables };
	}

	const parts: string[] = [];
	let cursor = 0;
	let removedLastLine = false;
	for (const entry of entries) {
		const replacement = replacements.get(entry);
		if (removedNames.has(entry.name)) {
			parts.push(body.slice(cursor, entry.lineStart));
			cursor = Math.min(entry.lineEnd + 1, body.length);
			removedLastLine = entry.lineEnd >= body.length;
		} else if (replacement !== undefined) {
			parts.push(body.slice(cursor, entry.valueStart), replacement);
			cursor = entry.valueEnd;
		}
	}
	parts.push(body.slice(cursor));

	let nextBody = parts.join("");
	if (removedLastLine && nextBody.endsWith("\n")) {
		nextBody = nextBody.slice(0, -1);
	}
	for (const line of appendedLines) {
		nextBody = nextBody.length > 0 ? `${nextBody}\n${line}` : line;
	}
	const nextEnv =
		trailingNewline && nextBody.length > 0 ? `${nextBody}\n` : nextBody;

	// The caller cannot read the values back, so the edited text has to parse to
	// exactly the intended variables before it is allowed to be stored.
	const nextValues = parseEnvValues(nextEnv);
	const brokenNames = [
		...new Set([...expectedValues.keys(), ...nextValues.keys()]),
	].filter((name) => expectedValues.get(name) !== nextValues.get(name));
	if (brokenNames.length > 0) {
		throw new Error(
			`Environment variables cannot be edited safely: ${brokenNames.join(", ")}`,
		);
	}

	return { env: nextEnv, changed, variables };
};

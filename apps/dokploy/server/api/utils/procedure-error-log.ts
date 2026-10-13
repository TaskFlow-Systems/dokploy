import { getKnownSecretMatcher } from "@dokploy/server/services/known-secrets";
import { redactSensitiveText } from "@dokploy/server/utils/security/redaction";
import {
	type KnownSecretMatcher,
	scrubSecretText,
} from "@dokploy/server/utils/security/secret-scrub";
import { TRPCError } from "@trpc/server";

const MESSAGE_LIMIT = 300;
const FRAME_LIMIT = 6;
const CAUSE_LIMIT = 4;
const REPEAT_WINDOW_MS = 30_000;

// drizzle appends the bound values of a failed query after this marker, and a
// value that is being saved right now is not a known secret yet.
const QUERY_PARAMS_MARKER = "\nparams:";

export type ProcedureFailure = {
	source: "openapi" | "trpc";
	path: string | undefined;
	type: string;
	error: unknown;
};

const chainOf = (error: unknown) => {
	const chain: Error[] = [];
	let current = error;
	while (
		current instanceof Error &&
		chain.length < CAUSE_LIMIT &&
		!chain.includes(current)
	) {
		chain.push(current);
		current = current.cause;
	}
	return chain;
};

const codeOf = (error: Error) => {
	const code = (error as { code?: unknown }).code;
	const text =
		typeof code === "string" || typeof code === "number" ? String(code) : "";
	return /^[\w.-]{1,40}$/.test(text) ? text : null;
};

const messageOf = (error: Error, matcher: KnownSecretMatcher) => {
	const text = error.message.split(QUERY_PARAMS_MARKER)[0] ?? "";
	const line = scrubSecretText(redactSensitiveText(text), matcher)
		.replace(/\s+/g, " ")
		.trim();
	return line.length > MESSAGE_LIMIT
		? `${line.slice(0, MESSAGE_LIMIT)}...`
		: line;
};

const framesOf = (error: Error) =>
	(error.stack ?? "")
		.split("\n")
		.filter((line) => /^\s+at /.test(line))
		.slice(0, FRAME_LIMIT)
		.map((line) => `    ${line.trim()}`);

// A 4xx answer is the caller's mistake and tells them so. Only a 500 hides
// its reason from the caller, so only that one has to reach the log.
export const isUnexpectedFailure = (error: unknown) =>
	!(error instanceof TRPCError) || error.code === "INTERNAL_SERVER_ERROR";

/**
 * One log entry for a procedure that failed with a 500: what was called and
 * the chain of errors behind it. Without the list of known secrets the texts
 * cannot be checked, so then only names, codes and the stack are printed.
 */
export const describeProcedureFailure = (
	failure: ProcedureFailure,
	matcher: KnownSecretMatcher | null,
) => {
	const chain = chainOf(failure.error);
	const lines = [
		`[api] ${failure.source} ${failure.path ?? "<no-path>"} (${failure.type}) failed`,
	];
	chain.forEach((error, index) => {
		const code = codeOf(error);
		const message = matcher
			? messageOf(error, matcher)
			: "(message withheld: the list of known secrets could not be loaded)";
		lines.push(
			`  ${index === 0 ? "" : "caused by "}${error.name}${code ? ` ${code}` : ""}: ${message}`,
		);
	});
	const root = chain[chain.length - 1];
	if (root) {
		lines.push(...framesOf(root));
	} else {
		lines.push(`  a non-error value was thrown (${typeof failure.error})`);
	}
	return lines.join("\n");
};

const lastLogged = new Map<string, { at: number; suppressed: number }>();

const repeatKey = (failure: ProcedureFailure) => {
	const chain = chainOf(failure.error);
	const root = chain[chain.length - 1];
	return `${failure.source} ${failure.path} ${root?.name} ${root ? codeOf(root) : ""}`;
};

/**
 * Writes an unexpected procedure failure to the server log. A failing
 * procedure that is polled would repeat the same entry every few seconds, so
 * repeats inside a short window are counted instead of printed.
 */
export const logProcedureFailure = async (
	failure: ProcedureFailure,
	now = Date.now(),
) => {
	if (!isUnexpectedFailure(failure.error)) {
		return;
	}
	const key = repeatKey(failure);
	const previous = lastLogged.get(key);
	if (previous && now - previous.at < REPEAT_WINDOW_MS) {
		previous.suppressed += 1;
		return;
	}
	lastLogged.set(key, { at: now, suppressed: 0 });
	const matcher = await getKnownSecretMatcher().catch(() => null);
	const repeats = previous?.suppressed
		? `\n  (${previous.suppressed} more of the same were not printed)`
		: "";
	console.error(`${describeProcedureFailure(failure, matcher)}${repeats}`);
};

export const resetProcedureFailureLog = () => lastLogged.clear();

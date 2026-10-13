export const TRAEFIK_CONTAINER_NAME = "dokploy-traefik";
export const TRAEFIK_LOG_LINE_LIMIT = 300;
export const TRAEFIK_LOG_WINDOW = "72h";
export const TRAEFIK_LOG_WINDOW_LABEL = "72 hours";
export const TRAEFIK_LOG_SERVER_TIMEOUT_SECONDS = 20;
export const TRAEFIK_LOG_NODE_TIMEOUT_MS =
	(TRAEFIK_LOG_SERVER_TIMEOUT_SECONDS + 5) * 1000;
export const TRAEFIK_LOG_CONTAINER_MISSING_EXIT_CODE = 4;

const LOG_RC_MARKER = "__DOKPLOY_LOG_RC=";
const ACME_GREP_PATTERN = "acme|certificate|letsencrypt|tls-alpn";

// --since and --tail together make docker scan the whole json-file log before
// it applies the tail, which never finishes on a large log. The filter runs on
// the server so only a few hundred lines travel over SSH. A pipeline's status
// is the last command's in sh, so the exit code of docker logs is printed as
// a marker line that passes the grep.
export const buildTraefikLogsCommand = () => {
	const name = TRAEFIK_CONTAINER_NAME;
	const reader = (logs: string) =>
		`{ $LIMIT ${logs} 2>&1; echo "${LOG_RC_MARKER}$?"; } | grep -iE '${ACME_GREP_PATTERN}|${LOG_RC_MARKER}' | tail -n ${TRAEFIK_LOG_LINE_LIMIT}`;
	return [
		`LIMIT=""; if command -v timeout >/dev/null 2>&1; then LIMIT="timeout ${TRAEFIK_LOG_SERVER_TIMEOUT_SECONDS}"; fi`,
		`if docker service inspect ${name} >/dev/null 2>&1; then`,
		reader(`docker service logs --since ${TRAEFIK_LOG_WINDOW} ${name}`),
		`elif docker inspect ${name} >/dev/null 2>&1; then`,
		reader(`docker logs --since ${TRAEFIK_LOG_WINDOW} ${name}`),
		"else",
		`exit ${TRAEFIK_LOG_CONTAINER_MISSING_EXIT_CODE}`,
		"fi",
	].join("\n");
};

export type TraefikLogReadResult =
	| { ok: true; output: string }
	| { ok: false; reason: string };

export const readTraefikLogOutput = (stdout: string): TraefikLogReadResult => {
	const lines = stdout.split("\n").filter((line) => line.length > 0);
	const marker = lines[lines.length - 1];
	if (!marker?.startsWith(LOG_RC_MARKER)) {
		return { ok: false, reason: "the log command did not finish" };
	}
	const code = Number(marker.slice(LOG_RC_MARKER.length));
	const output = lines.slice(0, -1).join("\n");
	if (code === 0) {
		return { ok: true, output };
	}
	return {
		ok: false,
		reason:
			code === 124
				? `docker logs did not finish within ${TRAEFIK_LOG_SERVER_TIMEOUT_SECONDS} s`
				: `docker logs exited with code ${code}`,
	};
};

const ACME_LINE = /acme|certificate|letsencrypt|tls-alpn/i;
// Traefik colours its console output when it runs with a TTY.
const ANSI_CODE = new RegExp(
	`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`,
	"g",
);

export const selectAcmeLogLines = (
	output: string,
	limit = TRAEFIK_LOG_LINE_LIMIT,
) =>
	output
		.split("\n")
		.map((line) => line.replace(ANSI_CODE, "").trimEnd())
		.filter((line) => line.length > 0 && ACME_LINE.test(line))
		.slice(-limit);

const LOG_TIMESTAMP =
	/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[\d.]*(?:Z|[+-]\d{2}:\d{2})/;
const CONSOLE_LEVELS: Record<string, string> = {
	TRC: "trace",
	DBG: "debug",
	INF: "info",
	WRN: "warn",
	ERR: "error",
	FTL: "fatal",
	PNC: "panic",
};
const CONSOLE_LEVEL = new RegExp(
	`${LOG_TIMESTAMP.source}\\s+(${Object.keys(CONSOLE_LEVELS).join("|")})\\b`,
);

// Traefik v3 writes "<time> ERR <message> key=value" by default; the
// level= and time= fields only exist in the logfmt and JSON formats.
export const readLogLevel = (line: string) => {
	const field = line.match(/\blevel"?[=:]\s*"?([a-z]+)/i)?.[1];
	if (field) {
		return field.toLowerCase();
	}
	const short = line.match(CONSOLE_LEVEL)?.[1];
	return short ? (CONSOLE_LEVELS[short] ?? null) : null;
};

export const readLogTime = (line: string) =>
	line.match(/\btime"?[=:]\s*"?([^"\s,}]+)/)?.[1] ??
	line.match(LOG_TIMESTAMP)?.[0] ??
	null;

export const isErrorLine = (line: string) => readLogLevel(line) === "error";

const KEY_TOKEN = /[A-Za-z_][\w.-]*=/g;
const HOST_CANDIDATE =
	/(?<![\w.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?![\w-])/gi;
const NOT_DOMAINS = new Set(["letsencrypt.acme", "letsencrypt.org"]);

// Field names such as ACME.domains= would otherwise read as hostnames.
const hostCandidates = (line: string) => {
	const hosts: string[] = [];
	for (const match of line.replace(KEY_TOKEN, " ").matchAll(HOST_CANDIDATE)) {
		const host = (match[1] ?? "").toLowerCase();
		if (!NOT_DOMAINS.has(host) && !host.endsWith(".letsencrypt.org")) {
			hosts.push(host);
		}
	}
	return hosts;
};

// Without a known host, a guess is only made on lines that say "domain", so
// file names and provider names in other messages do not become domains.
export const extractLogDomain = (
	line: string,
	knownHosts: ReadonlySet<string>,
) => {
	const candidates = hostCandidates(line);
	const known = candidates.find((host) => knownHosts.has(host));
	if (known) {
		return known;
	}
	return /domain/i.test(line) ? (candidates[0] ?? null) : null;
};

export const TRAEFIK_CONTAINER_NAME = "dokploy-traefik";
export const TRAEFIK_LOG_LINE_LIMIT = 300;

// Docker parses --since with Go durations, which have no day unit.
export const buildTraefikLogsCommand = () =>
	`docker logs --since 168h --tail 2000 ${TRAEFIK_CONTAINER_NAME} 2>&1`;

const ACME_LINE = /acme|certificate|letsencrypt|tls-alpn/i;

export const selectAcmeLogLines = (
	output: string,
	limit = TRAEFIK_LOG_LINE_LIMIT,
) =>
	output
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0 && ACME_LINE.test(line))
		.slice(-limit);

export const readLogLevel = (line: string) =>
	line.match(/\blevel"?[=:]\s*"?([a-z]+)/i)?.[1]?.toLowerCase() ?? null;

export const readLogTime = (line: string) =>
	line.match(/\btime"?[=:]\s*"?([^"\s,}]+)/)?.[1] ?? null;

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

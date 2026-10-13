import { shellQuote } from "./acme";

export type TraefikRoute = {
	host: string;
	containerName: string;
	composeProject: string | null;
	serviceName: string | null;
};

export type TraefikUses = {
	routes: TraefikRoute[];
	mentions: string[];
	patterns: string[];
};

export const DOCKER_LABELS_FAILED_EXIT_CODE = 5;

// The ids are captured first because the status of a pipeline is the status
// of its last command, so a failing docker ps would read as "no routes".
// Swarm services carry their router labels on the service, not on a task.
export const buildTraefikRoutesCommand = () =>
	[
		"ids=$(docker ps -q) || exit $?",
		"if [ -n \"$ids\" ]; then docker inspect --format '{{.Name}}|{{json .Config.Labels}}' $ids || exit $?; fi",
		"manager=$(docker info --format '{{.Swarm.ControlAvailable}}' 2>/dev/null)",
		'if [ "$manager" = true ]; then',
		"sids=$(docker service ls -q) || exit $?",
		"if [ -n \"$sids\" ]; then docker service inspect --format 'svc:{{.Spec.Name}}|{{json .Spec.Labels}}' $sids || exit $?; fi",
		"fi",
	].join("\n");

const MATCHER =
	/\b(HostSNIRegexp|HostRegexp|HostHeader|HostSNI|Host)\(((?:\s*(?:`[^`]*`|"[^"]*"|'[^']*')\s*,?)*)\s*\)/g;
const QUOTED_ARGUMENT = /`([^`]*)`|"([^"]*)"|'([^']*)'/g;
const RULE_LABEL = /^traefik\.(?:http|tcp)\.routers\..+\.rule$/;
const TLS_DOMAIN_LABEL =
	/^traefik\.(?:http|tcp)\.routers\..+\.tls\.domains\[\d+\]\.(main|sans)$/;

const normalizeHost = (value: string | undefined) =>
	(value ?? "").trim().replace(/\.$/, "").toLowerCase();

export type RuleMatchers = { hosts: string[]; patterns: string[] };

export const extractRuleMatchers = (rule: string): RuleMatchers => {
	const hosts = new Set<string>();
	const patterns = new Set<string>();
	for (const matcher of rule.matchAll(MATCHER)) {
		const regexp = (matcher[1] ?? "").endsWith("Regexp");
		for (const argument of (matcher[2] ?? "").matchAll(QUOTED_ARGUMENT)) {
			const value = argument[1] ?? argument[2] ?? argument[3] ?? "";
			if (regexp) {
				if (value.trim() !== "") {
					patterns.add(value);
				}
				continue;
			}
			const host = normalizeHost(value);
			if (host) {
				hosts.add(host);
			}
		}
	}
	return { hosts: [...hosts], patterns: [...patterns] };
};

export const extractRuleHosts = (rule: string) =>
	extractRuleMatchers(rule).hosts;

const parseLabels = (json: string): Record<string, string> => {
	try {
		const value: unknown = JSON.parse(json);
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return {};
		}
		return Object.fromEntries(
			Object.entries(value).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		);
	} catch {
		return {};
	}
};

const optionalLabel = (value: string | undefined) => value?.trim() || null;

// The output is one `name|labels-json` line per container, so the split must
// happen at the first `|`: rule values contain `||` for multi-host matchers.
export const parseTraefikUses = (output: string): TraefikUses => {
	const routes: TraefikRoute[] = [];
	const mentions = new Set<string>();
	const patterns = new Set<string>();
	for (const line of output.split("\n")) {
		const separator = line.indexOf("|");
		if (separator <= 0) {
			continue;
		}
		const rawName = line.slice(0, separator).trim().replace(/^\//, "");
		const isService = rawName.startsWith("svc:");
		const containerName = isService ? rawName.slice(4) : rawName;
		const labels = parseLabels(line.slice(separator + 1).trim());
		if (!containerName || labels["traefik.enable"] === "false") {
			continue;
		}
		const composeProject = optionalLabel(labels["com.docker.compose.project"]);
		const serviceName = optionalLabel(
			labels["com.docker.swarm.service.name"] ??
				labels["com.docker.stack.namespace"] ??
				(isService ? containerName : undefined),
		);
		const seen = new Set<string>();
		for (const [key, value] of Object.entries(labels)) {
			if (TLS_DOMAIN_LABEL.test(key)) {
				for (const name of value.split(",")) {
					const host = normalizeHost(name);
					if (host) {
						mentions.add(host);
					}
				}
				continue;
			}
			if (!RULE_LABEL.test(key)) {
				continue;
			}
			const matchers = extractRuleMatchers(value);
			for (const pattern of matchers.patterns) {
				patterns.add(pattern);
			}
			for (const host of matchers.hosts) {
				if (seen.has(host)) {
					continue;
				}
				seen.add(host);
				routes.push({ host, containerName, composeProject, serviceName });
			}
		}
	}
	return { routes, mentions: [...mentions], patterns: [...patterns] };
};

export const parseTraefikRoutes = (output: string): TraefikRoute[] =>
	parseTraefikUses(output).routes;

export type DynamicConfigUses = {
	hosts: { host: string; file: string }[];
	mentions: string[];
	patterns: string[];
	unreadable: boolean;
};

export const DYNAMIC_CONFIG_DIR_MISSING_EXIT_CODE = 3;

const BACKTICK = "`";
const MATCHER_ERE = `(HostSNIRegexp|HostRegexp|HostHeader|HostSNI|Host)\\(([[:space:]]*(${BACKTICK}[^${BACKTICK}]*${BACKTICK}|"[^"]*")[[:space:]]*,?)*[[:space:]]*\\)`;

// Only host names ever leave the server: the files can hold hashed
// passwords and keys, so each file is reduced by grep inside the shell. Lines
// are joined first because a rule can be folded over several YAML lines.
// Every host-looking word counts as a mention, which also covers
// tls.domains in YAML or TOML without parsing either; matchers give the rows.
export const buildDynamicHostsCommand = (
	dynamicDir: string,
	staticFile: string,
) => {
	const dir = shellQuote(dynamicDir);
	const staticPath = shellQuote(staticFile);
	return [
		`dir=${dir}`,
		`static=${staticPath}`,
		`[ -d "$dir" ] || exit ${DYNAMIC_CONFIG_DIR_MISSING_EXIT_CODE}`,
		"scan() {",
		'\tbase=$(basename "$1")',
		'\tif [ ! -r "$1" ]; then printf \'E\\t%s\\t\\n\' "$base"; return; fi',
		"\ttr 'A-Z\\n' 'a-z ' < \"$1\" | sed 's/[a-z0-9._%+-]*@[a-z0-9.-]*//g' | grep -oE '(\\*\\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,63}' | sort -u | while read -r word; do printf 'M\\t%s\\t%s\\n' \"$base\" \"$word\"; done",
		`\ttr '\\n' ' ' < "$1" | grep -oE '${MATCHER_ERE}' | while read -r matcher; do printf 'R\\t%s\\t%s\\n' "$base" "$matcher"; done`,
		"}",
		"find \"$dir\" -type f \\( -name '*.yml' -o -name '*.yaml' -o -name '*.toml' \\) | while read -r file; do scan \"$file\"; done",
		'[ ! -f "$static" ] || scan "$static"',
		"exit 0",
	].join("\n");
};

export const parseDynamicConfigUses = (output: string): DynamicConfigUses => {
	const hosts: DynamicConfigUses["hosts"] = [];
	const mentions = new Set<string>();
	const patterns = new Set<string>();
	const seen = new Set<string>();
	let unreadable = false;
	for (const line of output.split("\n")) {
		const [kind, file = "", ...rest] = line.split("\t");
		const value = rest.join("\t").trim();
		if (kind === "E") {
			unreadable = true;
		} else if (kind === "M" && value) {
			mentions.add(normalizeHost(value));
		} else if (kind === "R" && value) {
			const matchers = extractRuleMatchers(value);
			for (const pattern of matchers.patterns) {
				patterns.add(pattern);
			}
			for (const host of matchers.hosts) {
				const key = `${file}|${host}`;
				if (!seen.has(key)) {
					seen.add(key);
					hosts.push({ host, file });
				}
			}
		}
	}
	return {
		hosts,
		mentions: [...mentions],
		patterns: [...patterns],
		unreadable,
	};
};

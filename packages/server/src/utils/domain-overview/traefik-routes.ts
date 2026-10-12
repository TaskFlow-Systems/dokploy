export type TraefikRoute = {
	host: string;
	containerName: string;
	composeProject: string | null;
	serviceName: string | null;
};

export const buildTraefikRoutesCommand = () =>
	"docker ps -q | xargs -r docker inspect --format '{{.Name}}|{{json .Config.Labels}}'";

const HOST_MATCHER = /\bHost\(([^)]*)\)/g;
const QUOTED_ARGUMENT = /`([^`]*)`|"([^"]*)"|'([^']*)'/g;
const HTTP_RULE_LABEL = /^traefik\.http\.routers\..+\.rule$/;

const normalizeHost = (value: string | undefined) =>
	(value ?? "").trim().replace(/\.$/, "").toLowerCase();

export const extractRuleHosts = (rule: string) => {
	const hosts = new Set<string>();
	for (const matcher of rule.matchAll(HOST_MATCHER)) {
		for (const argument of (matcher[1] ?? "").matchAll(QUOTED_ARGUMENT)) {
			const host = normalizeHost(argument[1] ?? argument[2] ?? argument[3]);
			if (host) {
				hosts.add(host);
			}
		}
	}
	return [...hosts];
};

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
export const parseTraefikRoutes = (output: string): TraefikRoute[] => {
	const routes: TraefikRoute[] = [];
	for (const line of output.split("\n")) {
		const separator = line.indexOf("|");
		if (separator <= 0) {
			continue;
		}
		const containerName = line.slice(0, separator).trim().replace(/^\//, "");
		const labels = parseLabels(line.slice(separator + 1).trim());
		if (!containerName || labels["traefik.enable"] === "false") {
			continue;
		}
		const composeProject = optionalLabel(labels["com.docker.compose.project"]);
		const serviceName = optionalLabel(
			labels["com.docker.swarm.service.name"] ??
				labels["com.docker.stack.namespace"],
		);
		const seen = new Set<string>();
		for (const [key, rule] of Object.entries(labels)) {
			if (!HTTP_RULE_LABEL.test(key)) {
				continue;
			}
			for (const host of extractRuleHosts(rule)) {
				if (seen.has(host)) {
					continue;
				}
				seen.add(host);
				routes.push({ host, containerName, composeProject, serviceName });
			}
		}
	}
	return routes;
};

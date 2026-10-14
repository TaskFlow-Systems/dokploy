import { TRAEFIK_CONTAINER_NAME } from "./traefik-logs";

const CHALLENGE_MARKER = "DOKPLOY_RENEWAL_CHALLENGE";
const PORTS_MARKER = "DOKPLOY_RENEWAL_PORTS";

export type RenewalChallenge =
	| "tls"
	| "http"
	| "dns"
	| "none"
	| "missing"
	| "unreadable";

export type CertificateRenewalStatus = "ok" | "problem" | "unknown";

export type CertificateRenewalView = {
	status: CertificateRenewalStatus;
	challenge: RenewalChallenge;
	traefikFound: boolean;
	// Host ports Traefik publishes, as "443/tcp".
	publishedPorts: string[];
	problems: string[];
};

// Reads the configured port bindings rather than `docker port`, which shows
// nothing for a stopped container. The static config is checked the same way
// the TLS migration step does, so both agree on what counts as httpChallenge.
export const buildCertificateRenewalCommand = (staticConfig: string) => {
	const name = TRAEFIK_CONTAINER_NAME;
	return [
		`config='${staticConfig}'`,
		'if [ -f "$config" ] && [ -r "$config" ]; then',
		`	if grep -Eq '^[[:space:]]*httpChallenge:' "$config"; then echo "${CHALLENGE_MARKER} http"`,
		`	elif grep -Eq '^[[:space:]]*tlsChallenge:' "$config"; then echo "${CHALLENGE_MARKER} tls"`,
		`	elif grep -Eq '^[[:space:]]*dnsChallenge:' "$config"; then echo "${CHALLENGE_MARKER} dns"`,
		`	else echo "${CHALLENGE_MARKER} none"; fi`,
		'elif [ -e "$config" ]; then',
		`	echo "${CHALLENGE_MARKER} unreadable"`,
		"else",
		`	echo "${CHALLENGE_MARKER} missing"`,
		"fi",
		`if docker service inspect ${name} >/dev/null 2>&1; then`,
		`	echo "${PORTS_MARKER} $(docker service inspect -f '{{range .Endpoint.Spec.Ports}}{{.PublishedPort}}/{{.Protocol}} {{end}}' ${name} 2>/dev/null)"`,
		`elif docker inspect ${name} >/dev/null 2>&1; then`,
		`	echo "${PORTS_MARKER} $(docker inspect -f '{{range $port, $bindings := .HostConfig.PortBindings}}{{range $bindings}}{{.HostPort}}/{{$port}} {{end}}{{end}}' ${name} 2>/dev/null)"`,
		"fi",
	].join("\n");
};

const CHALLENGES: RenewalChallenge[] = [
	"tls",
	"http",
	"dns",
	"none",
	"missing",
	"unreadable",
];

// A container binding prints as "443/443/tcp" (host port, then the container
// port with its protocol); a swarm service prints as "443/tcp".
const normalizePort = (item: string) => {
	const parts = item.split("/");
	if (parts.length === 3) {
		return `${parts[0]}/${parts[2]}`;
	}
	return item;
};

export const parseCertificateRenewal = (
	stdout: string,
): CertificateRenewalView => {
	let challenge: RenewalChallenge = "unreadable";
	let traefikFound = false;
	const ports = new Set<string>();

	for (const line of stdout.split("\n")) {
		const [marker, ...rest] = line.trim().split(/\s+/);
		if (marker === CHALLENGE_MARKER) {
			const value = rest[0] as RenewalChallenge;
			if (CHALLENGES.includes(value)) {
				challenge = value;
			}
		} else if (marker === PORTS_MARKER) {
			traefikFound = true;
			for (const item of rest) {
				if (/^\d+(\/\d+)?\/[a-z]+$/.test(item)) {
					ports.add(normalizePort(item));
				}
			}
		}
	}

	const publishedPorts = [...ports].sort();
	const problems: string[] = [];
	if (challenge === "http") {
		problems.push(
			"traefik.yml uses httpChallenge, which needs port 80. Save the Traefik port mappings of this server once: the panel converts it to tlsChallenge and recreates Traefik.",
		);
	}
	if (publishedPorts.some((port) => port.startsWith("80/"))) {
		problems.push(
			"Traefik publishes port 80. Save the Traefik port mappings of this server once to recreate Traefik without it.",
		);
	}
	if (traefikFound && !publishedPorts.includes("443/tcp")) {
		problems.push(
			"Traefik does not publish 443/tcp, so certificates cannot be issued or renewed.",
		);
	}
	if (challenge === "none") {
		problems.push(
			"traefik.yml has no ACME challenge, so Traefik does not issue certificates.",
		);
	}

	let status: CertificateRenewalStatus = "ok";
	if (problems.length > 0) {
		status = "problem";
	} else if (
		!traefikFound ||
		challenge === "missing" ||
		challenge === "unreadable"
	) {
		status = "unknown";
	}

	return { status, challenge, traefikFound, publishedPorts, problems };
};

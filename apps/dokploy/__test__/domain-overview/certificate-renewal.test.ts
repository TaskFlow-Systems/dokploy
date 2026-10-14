import { execSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	buildCertificateRenewalCommand,
	parseCertificateRenewal,
} from "@dokploy/server/utils/domain-overview/certificate-renewal";
import { describe, expect, it } from "vitest";

const BASH = execSync("command -v bash", { encoding: "utf8" }).trim();

type Fake = {
	config?: string;
	kind: "service" | "container" | "none";
	ports?: string;
};

// Runs the check with a fake docker and a temporary traefik.yml.
const runCheck = ({ config, kind, ports = "" }: Fake) => {
	const dir = mkdtempSync(path.join(tmpdir(), "dokploy-renewal-"));
	try {
		const configPath = path.join(dir, "traefik.yml");
		if (config !== undefined) {
			writeFileSync(configPath, config);
		}
		const docker = path.join(dir, "docker");
		writeFileSync(
			docker,
			`#!/bin/sh
if [ "$1" = service ] && [ "$2" = inspect ]; then
	[ "$FAKE_KIND" = service ] || exit 1
	[ "$3" = -f ] && printf '%s' "$FAKE_PORTS"
	exit 0
fi
if [ "$1" = inspect ]; then
	[ "$FAKE_KIND" = container ] || exit 1
	[ "$2" = -f ] && printf '%s' "$FAKE_PORTS"
	exit 0
fi
exit 1
`,
		);
		chmodSync(docker, 0o755);
		const result = spawnSync(
			BASH,
			["-c", buildCertificateRenewalCommand(configPath)],
			{
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${dir}:${process.env.PATH}`,
					FAKE_KIND: kind,
					FAKE_PORTS: ports,
				},
			},
		);
		expect(result.status).toBe(0);
		return parseCertificateRenewal(result.stdout);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

const TLS_CONFIG = `certificatesResolvers:
  letsencrypt:
    acme:
      email: ops@example.com
      storage: /etc/dokploy/traefik/dynamic/acme.json
      tlsChallenge: {}
`;

const HTTP_CONFIG = `certificatesResolvers:
  letsencrypt:
    acme:
      httpChallenge:
        entryPoint: web
`;

describe("certificate renewal check", () => {
	it("reports a standalone Traefik on 443 with tlsChallenge as ok", () => {
		const renewal = runCheck({
			config: TLS_CONFIG,
			kind: "container",
			ports: "443/443/tcp 443/443/udp ",
		});

		expect(renewal).toEqual({
			status: "ok",
			challenge: "tls",
			traefikFound: true,
			publishedPorts: ["443/tcp", "443/udp"],
			problems: [],
		});
	});

	it("reads the published ports of a swarm service", () => {
		const renewal = runCheck({
			config: TLS_CONFIG,
			kind: "service",
			ports: "443/tcp 443/udp ",
		});

		expect(renewal.status).toBe("ok");
		expect(renewal.publishedPorts).toEqual(["443/tcp", "443/udp"]);
	});

	it("flags httpChallenge and a published port 80", () => {
		const renewal = runCheck({
			config: HTTP_CONFIG,
			kind: "container",
			ports: "80/80/tcp 443/443/tcp ",
		});

		expect(renewal.status).toBe("problem");
		expect(renewal.challenge).toBe("http");
		expect(renewal.problems.join("\n")).toContain("httpChallenge");
		expect(renewal.problems.join("\n")).toContain("publishes port 80");
	});

	it("flags a Traefik that does not publish 443/tcp", () => {
		const renewal = runCheck({
			config: TLS_CONFIG,
			kind: "container",
			ports: "8443/8443/tcp ",
		});

		expect(renewal.status).toBe("problem");
		expect(renewal.problems.join("\n")).toContain("443/tcp");
	});

	it("reports unknown when traefik.yml or Traefik is missing", () => {
		expect(
			runCheck({ kind: "container", ports: "443/443/tcp " }),
		).toMatchObject({ status: "unknown", challenge: "missing" });
		expect(runCheck({ config: TLS_CONFIG, kind: "none" })).toMatchObject({
			status: "unknown",
			traefikFound: false,
		});
	});

	it("does not treat a commented-out httpChallenge as in use", () => {
		const renewal = runCheck({
			config: `${TLS_CONFIG}      # httpChallenge:\n`,
			kind: "container",
			ports: "443/443/tcp ",
		});

		expect(renewal.challenge).toBe("tls");
	});

	it("ignores port bindings without a host port", () => {
		expect(
			parseCertificateRenewal(
				"DOKPLOY_RENEWAL_CHALLENGE tls\nDOKPLOY_RENEWAL_PORTS /80/tcp 443/443/tcp\n",
			).publishedPorts,
		).toEqual(["443/tcp"]);
	});
});

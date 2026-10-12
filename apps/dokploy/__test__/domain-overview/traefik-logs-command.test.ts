import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	buildTraefikLogsCommand,
	readTraefikLogOutput,
	TRAEFIK_LOG_WINDOW,
} from "@dokploy/server/utils/domain-overview/traefik-logs";
import {
	buildDynamicHostsCommand,
	parseDynamicHosts,
} from "@dokploy/server/utils/domain-overview/traefik-routes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("Traefik log command", () => {
	it("never combines --since with --tail", () => {
		const command = buildTraefikLogsCommand();

		expect(command).toContain(`--since ${TRAEFIK_LOG_WINDOW}`);
		expect(command).not.toMatch(/--tail/);
	});

	it("filters on the server and limits the lines that travel back", () => {
		const command = buildTraefikLogsCommand();

		expect(command).toMatch(/grep -iE 'acme\|certificate/);
		expect(command).toMatch(/tail -n 300/);
	});

	it("wraps docker logs in timeout so the process dies on the server", () => {
		expect(buildTraefikLogsCommand()).toMatch(/timeout 20/);
	});

	it("keeps the window short enough to be read quickly", () => {
		expect(TRAEFIK_LOG_WINDOW).toBe("72h");
	});
});

describe("Traefik log output", () => {
	it("returns the lines when docker logs succeeded", () => {
		expect(
			readTraefikLogOutput("level=error acme failed\n__DOKPLOY_LOG_RC=0\n"),
		).toEqual({ ok: true, output: "level=error acme failed" });
	});

	it("is not available when docker logs timed out", () => {
		const result = readTraefikLogOutput("line\n__DOKPLOY_LOG_RC=124\n");

		expect(result.ok).toBe(false);
	});

	it("is not available when the exit marker is missing", () => {
		expect(readTraefikLogOutput("level=error acme failed\n").ok).toBe(false);
		expect(readTraefikLogOutput("").ok).toBe(false);
	});

	it("is not available when docker logs failed", () => {
		const result = readTraefikLogOutput("__DOKPLOY_LOG_RC=1\n");

		expect(result).toMatchObject({ ok: false });
	});
});

describe("Traefik log command on a shell", () => {
	let dir: string;

	const run = (env: Record<string, string>) => {
		const result = spawnSync("/bin/sh", ["-c", buildTraefikLogsCommand()], {
			encoding: "utf8",
			env: { PATH: dir, ...env } as unknown as NodeJS.ProcessEnv,
		});
		return { status: result.status, stdout: result.stdout };
	};

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "logs-cmd-"));
		for (const tool of ["grep", "tail", "cat"]) {
			const found = spawnSync("sh", ["-c", `command -v ${tool}`], {
				encoding: "utf8",
			}).stdout.trim();
			symlinkSync(found, path.join(dir, tool));
		}
		mkdirSync(path.join(dir, "unused"));
		writeFileSync(
			path.join(dir, "docker"),
			`#!/bin/sh
case "$1" in
	service) exit 1 ;;
	inspect) [ "$FAKE_MISSING" = 1 ] && exit 1; exit 0 ;;
	logs)
		echo 'level=info msg="request served"'
		echo 'level=error msg="Unable to obtain ACME certificate for domains [a.example.com]"'
		exit "\${FAKE_DOCKER_RC:-0}" ;;
esac
`,
		);
		chmodSync(path.join(dir, "docker"), 0o755);
		writeFileSync(
			path.join(dir, "timeout"),
			'#!/bin/sh\n[ -z "$FAKE_TIMEOUT" ] || exit 124\nshift\nexec "$@"\n',
		);
		chmodSync(path.join(dir, "timeout"), 0o755);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps only certificate lines and reports success", () => {
		const { stdout } = run({});

		const parsed = readTraefikLogOutput(stdout);
		expect(parsed).toEqual({
			ok: true,
			output:
				'level=error msg="Unable to obtain ACME certificate for domains [a.example.com]"',
		});
	});

	it("reports a docker failure instead of an empty log", () => {
		const { stdout } = run({ FAKE_DOCKER_RC: "1" });

		expect(readTraefikLogOutput(stdout).ok).toBe(false);
	});

	it("reports a timeout instead of an empty log", () => {
		const { stdout } = run({ FAKE_TIMEOUT: "1" });

		expect(readTraefikLogOutput(stdout).ok).toBe(false);
	});

	it("exits with the missing-container code when there is no Traefik", () => {
		const { status } = run({ FAKE_MISSING: "1" });

		expect(status).toBe(4);
	});
});

describe("dynamic config hosts", () => {
	it("reads Host rules together with the file name", () => {
		const output = [
			"/etc/dokploy/traefik/dynamic/dokploy.yml:Host(`panel.example.com`)",
			"/etc/dokploy/traefik/dynamic/app.yml:Host(`a.example.com`)",
			"/etc/dokploy/traefik/dynamic/app.yml:Host(`a.example.com`)",
			"/etc/dokploy/traefik/dynamic/tcp.yml:HostSNI(`db.example.com`)",
		].join("\n");

		expect(parseDynamicHosts(output)).toEqual([
			{ host: "panel.example.com", file: "dokploy.yml" },
			{ host: "a.example.com", file: "app.yml" },
			{ host: "db.example.com", file: "tcp.yml" },
		]);
	});

	it("separates a failure from an empty answer", () => {
		const command = buildDynamicHostsCommand("/etc/dokploy/traefik/dynamic");

		expect(command).toContain("grep -rHoE");
		expect(command).toContain('[ "$status" -le 1 ] || exit "$status"');
	});

	it("finds the panel host in a real file and treats no match as empty", () => {
		const root = mkdtempSync(path.join(tmpdir(), "dyn-"));
		try {
			writeFileSync(
				path.join(root, "dokploy.yml"),
				"http:\n  routers:\n    dokploy-router-app:\n      rule: Host(`panel.example.com`)\n",
			);
			writeFileSync(
				path.join(root, "acme.json"),
				"Host(`ignored.example.com`)",
			);
			const found = spawnSync(
				"/bin/sh",
				["-c", buildDynamicHostsCommand(root)],
				{
					encoding: "utf8",
				},
			);
			expect(found.status).toBe(0);
			expect(parseDynamicHosts(found.stdout)).toEqual([
				{ host: "panel.example.com", file: "dokploy.yml" },
			]);

			rmSync(path.join(root, "dokploy.yml"));
			const empty = spawnSync(
				"/bin/sh",
				["-c", buildDynamicHostsCommand(root)],
				{
					encoding: "utf8",
				},
			);
			expect(empty.status).toBe(0);
			expect(parseDynamicHosts(empty.stdout)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

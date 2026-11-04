import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	buildTraefikGraceTimeoutStep,
	getDefaultServerTraefikConfig,
	getDefaultTraefikConfig,
	TRAEFIK_GRACE_TIMEOUT,
} from "@dokploy/server/setup/traefik-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

const grace = { lifeCycle: { graceTimeOut: TRAEFIK_GRACE_TIMEOUT } };

const INSTALLER = path.resolve(__dirname, "../../../../install-agenthits.sh");

describe("default Traefik configs", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each([
		["panel, production", "production"],
		["panel, development", "development"],
	])("sets the grace timeout on every entry point: %s", (_name, env) => {
		vi.stubEnv("NODE_ENV", env);
		const { entryPoints } = parse(getDefaultTraefikConfig());

		expect(entryPoints.web.transport).toEqual(grace);
		expect(entryPoints.websecure.transport).toEqual(grace);
	});

	it.each([
		["manager", true],
		["worker", false],
	])(
		"sets the grace timeout on every entry point: server, %s",
		(_name, swarm) => {
			const { entryPoints } = parse(getDefaultServerTraefikConfig(swarm));

			expect(entryPoints.web.transport).toEqual(grace);
			expect(entryPoints.websecure.transport).toEqual(grace);
		},
	);

	it("uses the same value in the installer's config", () => {
		const script = readFileSync(INSTALLER, "utf8");
		const heredoc = script.match(
			/cat >"\$TRAEFIK_CONFIG_FILE" <<'EOF'\n([\s\S]*?)\nEOF\n/,
		);
		const { entryPoints } = parse(heredoc?.[1] ?? "");

		expect(entryPoints.web.transport).toEqual(grace);
		expect(entryPoints.websecure.transport).toEqual(grace);
	});
});

describe("buildTraefikGraceTimeoutStep", () => {
	let dir = "";
	let configPath = "";

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "traefik-grace-"));
		configPath = path.join(dir, "traefik.yml");
	});

	afterEach(() => {
		chmodSync(dir, 0o755);
		rmSync(dir, { force: true, recursive: true });
	});

	const runStep = (content?: string) => {
		if (content !== undefined) {
			writeFileSync(configPath, content);
		}
		return spawnSync(
			"bash",
			[
				"-c",
				[
					"set -eu",
					'SUDO_CMD=""',
					buildTraefikGraceTimeoutStep(configPath),
				].join("\n"),
			],
			{ encoding: "utf8" },
		);
	};

	const backups = () =>
		readdirSync(dir).filter((name) => name.includes(".bak-grace-"));

	const readConfig = () => readFileSync(configPath, "utf8");

	const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

	const expectUnchanged = (content: string) => {
		const result = runStep(content);
		expect(result.status).toBe(0);
		expect(readConfig()).toBe(content);
		expect(backups()).toEqual([]);
		return result;
	};

	// The config a panel from before this setting wrote.
	const OLD_DEFAULT = lines(
		"providers:",
		"  docker:",
		"    exposedByDefault: false",
		"    network: dokploy-network",
		"entryPoints:",
		"  web:",
		"    address: :80",
		"  websecure:",
		"    address: :443",
		"    http3:",
		"      advertisedPort: 443",
		"    http:",
		"      tls:",
		"        certResolver: letsencrypt",
		"api:",
		"  insecure: true",
		"certificatesResolvers:",
		"  letsencrypt:",
		"    acme:",
		"      email: test@localhost.com",
		"      storage: /etc/dokploy/traefik/dynamic/acme.json",
		"      tlsChallenge: {}",
	);

	it("adds the timeout to every entry point and keeps the rest of the file", () => {
		const result = runStep(OLD_DEFAULT);

		expect(result.status).toBe(0);
		const before = parse(OLD_DEFAULT);
		const after = parse(readConfig());
		expect(after.entryPoints.web.transport).toEqual(grace);
		expect(after.entryPoints.websecure.transport).toEqual(grace);
		delete after.entryPoints.web.transport;
		delete after.entryPoints.websecure.transport;
		expect(after).toEqual(before);
	});

	it("only adds lines, so comments and layout stay", () => {
		const original = lines(
			"# Custom Traefik config",
			"entryPoints:",
			"    # plain http",
			"    web:",
			"        # keep this comment",
			"        address: :80 # and this one",
			"",
			"    websecure:",
			"        address: :443",
			"log:",
			"    level: DEBUG",
		);

		runStep(original);

		const added = readConfig().split("\n");
		const remaining = [...added];
		for (const line of original.split("\n")) {
			const at = remaining.indexOf(line);
			expect(at, line).toBeGreaterThanOrEqual(0);
			remaining.splice(at, 1);
		}
		expect(remaining).toEqual([
			"        transport:",
			"            lifeCycle:",
			`                graceTimeOut: ${TRAEFIK_GRACE_TIMEOUT}`,
			"        transport:",
			"            lifeCycle:",
			`                graceTimeOut: ${TRAEFIK_GRACE_TIMEOUT}`,
		]);
		expect(parse(readConfig()).entryPoints.web).toEqual({
			address: ":80",
			transport: grace,
		});
	});

	it("covers an entry point a user added for a TCP port", () => {
		runStep(
			lines(
				"entryPoints:",
				"  websecure:",
				"    address: :443",
				"  postgres:",
				"    address: :5432",
				'  "8443":',
				"    address: :8443",
			),
		);

		const { entryPoints } = parse(readConfig());
		expect(entryPoints.websecure.transport).toEqual(grace);
		expect(entryPoints.postgres.transport).toEqual(grace);
		expect(entryPoints["8443"].transport).toEqual(grace);
	});

	it("adds lifeCycle under an existing transport and keeps its timeouts", () => {
		runStep(
			lines(
				"entryPoints:",
				"  websecure:",
				"    address: :443",
				"    transport:",
				"      respondingTimeouts:",
				"        readTimeout: 600s",
			),
		);

		expect(parse(readConfig()).entryPoints.websecure.transport).toEqual({
			...grace,
			respondingTimeouts: { readTimeout: "600s" },
		});
	});

	it("leaves an entry point with its own lifeCycle alone and adds to the others", () => {
		runStep(
			lines(
				"entryPoints:",
				"  web:",
				"    address: :80",
				"  websecure:",
				"    address: :443",
				"    transport:",
				"      lifeCycle:",
				"        graceTimeOut: 30s",
			),
		);

		const { entryPoints } = parse(readConfig());
		expect(entryPoints.web.transport).toEqual(grace);
		expect(entryPoints.websecure.transport).toEqual({
			lifeCycle: { graceTimeOut: "30s" },
		});
	});

	it("reads keys the way Traefik does, ignoring case", () => {
		expectUnchanged(
			lines(
				"entrypoints:",
				"  websecure:",
				"    address: :443",
				"    Transport:",
				"      lifecycle:",
				"        gracetimeout: 30s",
			),
		);
	});

	it("has nothing to add to the configs the panel writes today", () => {
		expectUnchanged(getDefaultServerTraefikConfig());
		expectUnchanged(getDefaultServerTraefikConfig(false));
		expectUnchanged(getDefaultTraefikConfig());
	});

	it("does nothing on a second run", () => {
		runStep(OLD_DEFAULT);
		const first = readConfig();
		const firstBackups = backups();

		const result = runStep();

		expect(result.status).toBe(0);
		expect(readConfig()).toBe(first);
		expect(backups()).toEqual(firstBackups);
	});

	it("keeps a backup of the previous file", () => {
		const result = runStep(OLD_DEFAULT);

		expect(backups()).toHaveLength(1);
		expect(readFileSync(path.join(dir, backups()[0] ?? ""), "utf8")).toBe(
			OLD_DEFAULT,
		);
		expect(result.stdout).toContain(backups()[0]);
	});

	it("writes in place, because Traefik bind-mounts the file", () => {
		writeFileSync(configPath, OLD_DEFAULT);
		chmodSync(configPath, 0o640);
		const before = statSync(configPath);

		runStep();

		const after = statSync(configPath);
		expect(after.ino).toBe(before.ino);
		expect(after.mode).toBe(before.mode);
		expect(readConfig()).toContain("graceTimeOut");
	});

	it("handles Windows line endings", () => {
		runStep(
			"entryPoints:\r\n  web:\r\n    address: :80\r\nlog:\r\n  level: INFO\r\n",
		);

		const parsed = parse(readConfig());
		expect(parsed.entryPoints.web.transport).toEqual(grace);
		expect(parsed.log.level).toBe("INFO");
	});

	it("handles a file with no newline at the end", () => {
		runStep("entryPoints:\n  web:\n    address: :80");

		expect(parse(readConfig()).entryPoints.web).toEqual({
			address: ":80",
			transport: grace,
		});
	});

	it("does nothing, quietly, without a config or without entry points", () => {
		const missing = runStep();
		expect(missing.status).toBe(0);
		expect(missing.stderr).toBe("");
		expect(readdirSync(dir)).toEqual([]);

		const result = expectUnchanged(lines("providers:", "  docker: {}"));
		expect(result.stderr).toBe("");
	});

	it.each([
		["inline entry points", "entryPoints: {web: {address: ':80'}}\n"],
		["inline entry point", lines("entryPoints:", '  web: {address: ":80"}')],
		[
			"entry point with an anchor",
			lines("entryPoints:", "  web: &web", "    address: :80"),
		],
		[
			"merge key",
			lines("entryPoints:", "  web:", "    <<: *common", "    address: :80"),
		],
		[
			"inline transport",
			lines(
				"entryPoints:",
				"  web:",
				"    address: :80",
				"    transport: {lifeCycle: {graceTimeOut: 30s}}",
			),
		],
		[
			"empty entry point",
			lines("entryPoints:", "  web:", "  websecure:", "    address: :443"),
		],
		["no entry under the key", lines("entryPoints:", "log:", "  level: INFO")],
	])("warns and leaves the file unchanged: %s", (_name, content) => {
		const result = expectUnchanged(content);

		expect(result.stderr).toContain("left unchanged");
		expect(result.stderr).toContain(`graceTimeOut: ${TRAEFIK_GRACE_TIMEOUT}`);
	});

	const runWithShims = (...shims: string[]) =>
		spawnSync(
			"bash",
			[
				"-c",
				[
					"set -eu",
					...shims,
					'SUDO_CMD=""',
					buildTraefikGraceTimeoutStep(configPath),
					"echo after",
				].join("\n"),
			],
			{ encoding: "utf8" },
		);

	it("does not stop the caller when the file cannot be read", () => {
		writeFileSync(configPath, OLD_DEFAULT);

		const result = runWithShims("awk() { return 1; }");

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("after");
		expect(result.stderr).toContain("left unchanged");
		expect(readConfig()).toBe(OLD_DEFAULT);
	});

	it("restores the file and goes on when writing fails", () => {
		writeFileSync(configPath, OLD_DEFAULT);

		// A failed write that has already truncated the file.
		const result = runWithShims(`tee() { : > "${configPath}"; return 1; }`);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("after");
		expect(result.stderr).toContain("restored");
		expect(readConfig()).toBe(OLD_DEFAULT);
	});

	it("stops the caller when the file is damaged and cannot be restored", () => {
		writeFileSync(configPath, OLD_DEFAULT);
		const mark = path.join(dir, "cp-mark");

		const result = runWithShims(
			`tee() { : > "${configPath}"; return 1; }`,
			// The first cp makes the backup, the second one is the restore.
			`cp() { if [ -e "${mark}" ]; then return 1; fi; : > "${mark}"; command cp "$@"; }`,
		);

		expect(result.status).toBe(1);
		expect(result.stdout).not.toContain("after");
		expect(result.stderr).toContain("Restore it from the backup");
	});
});

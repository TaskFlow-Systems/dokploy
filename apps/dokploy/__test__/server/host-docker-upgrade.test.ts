import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PINNED_VERSIONS } from "@dokploy/server/setup/component-versions";
import {
	buildDockerUpgradeLauncherArgs,
	buildHostDockerUpgradeScript,
	DOCKER_UPGRADE_UNIT,
	readHostDockerUpgradeStatus,
	startHostDockerUpgrade,
} from "@dokploy/server/setup/host-docker-upgrade";
import { afterEach, describe, expect, it } from "vitest";
import { BASH, FAKE_TOOLS } from "./docker-script-fakes";

const PREVIOUS_ENGINE = "28.3.0";

const tempDirs: string[] = [];

const makeTempDir = () => {
	const dir = mkdtempSync(path.join(tmpdir(), "host-docker-upgrade-"));
	tempDirs.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

const DOCKER_LIST_NOBLE =
	"deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n";

const runHostScript = (env: Record<string, string> = {}) => {
	const dir = makeTempDir();
	const updates = path.join(dir, "host-updates");
	const sources = path.join(dir, "sources");
	const callLog = path.join(dir, "calls.log");
	mkdirSync(updates);
	mkdirSync(sources);
	writeFileSync(path.join(sources, "docker.list"), DOCKER_LIST_NOBLE);
	writeFileSync(
		path.join(dir, "os-release"),
		"ID=ubuntu\nVERSION_CODENAME=noble\n",
	);
	writeFileSync(path.join(dir, "engine"), `${PREVIOUS_ENGINE}\n`);
	writeFileSync(callLog, "");
	for (const [name, body] of Object.entries(FAKE_TOOLS)) {
		writeFileSync(path.join(dir, name), body);
		chmodSync(path.join(dir, name), 0o755);
	}
	const result = spawnSync(BASH, [], {
		input: buildHostDockerUpgradeScript(updates),
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${dir}:${process.env.PATH}`,
			CALL_LOG: callLog,
			FAKE_STATE: dir,
			FAKE_PREVIOUS_ENGINE: PREVIOUS_ENGINE,
			FAKE_TARGET_ENGINE: PINNED_VERSIONS.docker,
			FAKE_OLD_IMAGE: "traefik:v3.7.16",
			TMPDIR: dir,
			DOKPLOY_BACKUP_DIR: path.join(dir, "backups"),
			DOKPLOY_OS_RELEASE: path.join(dir, "os-release"),
			DOKPLOY_APT_SOURCES_DIR: sources,
			DOKPLOY_DOCKER_KEYRING: path.join(dir, "keyrings", "docker.asc"),
			DOKPLOY_DOCKER_VERIFY_TIMEOUT: "3",
			...env,
		},
	});
	const statusFile = path.join(updates, "docker-engine-upgrade.json");
	return {
		status: result.status,
		stdout: result.stdout,
		log: readFileSync(path.join(updates, "docker-engine-upgrade.log"), "utf8"),
		stored: existsSync(statusFile)
			? JSON.parse(readFileSync(statusFile, "utf8"))
			: null,
		calls: readFileSync(callLog, "utf8").split("\n").filter(Boolean),
		engine: readFileSync(path.join(dir, "engine"), "utf8").trim(),
	};
};

// Each test runs the generated script in a real shell.
describe("buildHostDockerUpgradeScript", { timeout: 60_000 }, () => {
	it("generates valid bash", () => {
		const result = spawnSync("bash", ["-n"], {
			input: buildHostDockerUpgradeScript(),
		});

		expect(result.status, result.stderr?.toString()).toBe(0);
	});

	it("upgrades Docker, waits for the panel, Postgres and Redis, and records success", () => {
		const run = runHostScript();

		expect(run.status, run.log).toBe(0);
		expect(run.stdout).toBe("");
		expect(run.engine).toBe(PINNED_VERSIONS.docker);
		expect(run.stored).toMatchObject({
			state: "succeeded",
			from: PREVIOUS_ENGINE,
			to: PINNED_VERSIONS.docker,
			exitCode: 0,
		});
		expect(run.stored.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(run.log).toContain(
			`Docker Engine upgrade started on the host at ${run.stored.startedAt}: ${PREVIOUS_ENGINE} -> ${PINNED_VERSIONS.docker}`,
		);
		expect(run.log).toContain("Docker Engine upgrade finished ✅");
		expect(run.calls).toContain(
			"docker info --format {{.Swarm.LocalNodeState}}",
		);
		expect(
			run.calls.some((call) =>
				call.startsWith("docker exec cid pg_isready -U dokploy -d dokploy"),
			),
		).toBe(true);
		expect(run.calls).toContain("docker exec cid redis-cli ping");
		expect(run.calls.some((call) => call.includes("--allow-downgrades"))).toBe(
			false,
		);
	});

	it("rolls Docker back and records the failure when the panel does not come back healthy", () => {
		const run = runHostScript({ FAKE_PANEL_HEALTH: "starting" });

		expect(run.status).not.toBe(0);
		expect(run.engine).toBe(PREVIOUS_ENGINE);
		expect(run.calls.some((call) => call.includes("--allow-downgrades"))).toBe(
			true,
		);
		expect(run.log).toContain(
			`Error: Docker ${PINNED_VERSIONS.docker} did not come up healthy after the install.`,
		);
		expect(run.log).toContain(
			`Not ready on Docker ${PINNED_VERSIONS.docker} after 3 seconds: the panel container is starting`,
		);
		expect(run.log).toContain(`Rolling Docker back to ${PREVIOUS_ENGINE}`);
		expect(run.stored).toMatchObject({
			state: "failed",
			from: PREVIOUS_ENGINE,
			exitCode: 1,
		});
	});

	it("accepts a panel container without a health check", () => {
		const run = runHostScript({ FAKE_PANEL_HEALTH: "none" });

		expect(run.status, run.log).toBe(0);
		expect(run.stored.state).toBe("succeeded");
	});

	it("fails without touching Docker when the pinned version is not in apt", () => {
		const run = runHostScript({ FAKE_NO_CANDIDATE: "1" });

		expect(run.status).not.toBe(0);
		expect(run.engine).toBe(PREVIOUS_ENGINE);
		expect(run.log).toContain("Error: Docker not upgraded:");
		expect(run.log).toContain("Nothing was changed.");
		expect(run.calls.some((call) => call.includes("--no-download"))).toBe(
			false,
		);
		expect(run.stored).toMatchObject({ state: "failed", exitCode: 1 });
	});
});

describe("buildDockerUpgradeLauncherArgs", () => {
	it("starts the script as a host systemd unit from a privileged one-off container", () => {
		const args = buildDockerUpgradeLauncherArgs(
			"ghcr.io/agenthits/dokploy:agenthits-dev@sha256:abc",
			"/etc/dokploy/host-updates",
		);
		const hostCommand = args.at(-1) ?? "";

		expect(args.slice(0, 9)).toEqual([
			"run",
			"--rm",
			"--pull=never",
			"--privileged",
			"--pid=host",
			"--network=host",
			"--user=0:0",
			"--label=com.dokploy.host-update=docker-engine",
			"--entrypoint=nsenter",
		]);
		expect(args).toContain(
			"ghcr.io/agenthits/dokploy:agenthits-dev@sha256:abc",
		);
		expect(args).toContain("--target=1");
		expect(hostCommand).toContain(
			`exec systemd-run --quiet --collect --unit=${DOCKER_UPGRADE_UNIT}`,
		);
		expect(hostCommand).toContain(
			"/bin/bash '/etc/dokploy/host-updates/docker-engine-upgrade.sh'",
		);
		expect(spawnSync("sh", ["-n"], { input: hostCommand }).status).toBe(0);
	});

	it("stops before anything runs when the host cannot see the script the panel wrote", () => {
		const dir = makeTempDir();
		const hostCommand =
			buildDockerUpgradeLauncherArgs("image", dir).at(-1) ?? "";

		const missingScript = spawnSync("sh", ["-c", hostCommand], {
			encoding: "utf8",
		});
		expect(missingScript.status).toBe(4);
		expect(missingScript.stderr).toContain("not mounted from the host");
	});
});

describe("startHostDockerUpgrade", () => {
	it("writes the script, a starting status and a fresh log, then launches with the panel image", async () => {
		const dir = path.join(makeTempDir(), "host-updates");
		const launches: string[][] = [];

		await startHostDockerUpgrade("29.8.2", {
			dir,
			readImage: async () => "panel-image:test",
			launch: async (args) => {
				launches.push(args);
			},
		});

		expect(launches).toHaveLength(1);
		expect(launches[0]).toContain("panel-image:test");
		expect(
			statSync(path.join(dir, "docker-engine-upgrade.sh")).mode & 0o777,
		).toBe(0o700);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		const status = await readHostDockerUpgradeStatus(dir);
		expect(status).toMatchObject({
			state: "starting",
			from: "29.8.2",
			to: PINNED_VERSIONS.docker,
			finishedAt: null,
			exitCode: null,
		});
		expect(status?.log).toContain(
			`Starting the Docker Engine upgrade to ${PINNED_VERSIONS.docker} from the panel`,
		);
	});

	it("records a failed start with the launcher's error and nothing changed", async () => {
		const dir = path.join(makeTempDir(), "host-updates");
		const failure = Object.assign(new Error("exit 3"), {
			stderr:
				"This host does not run systemd, so the upgrade cannot run outside Docker from the panel.\n",
		});

		await expect(
			startHostDockerUpgrade("29.8.2", {
				dir,
				readImage: async () => "panel-image:test",
				launch: async () => {
					throw failure;
				},
			}),
		).rejects.toThrow("This host does not run systemd");

		const status = await readHostDockerUpgradeStatus(dir);
		expect(status?.state).toBe("failed");
		expect(status?.finishedAt).not.toBeNull();
		expect(status?.log).toContain("Nothing was changed.");
	});
});

describe("readHostDockerUpgradeStatus", () => {
	const writeStatus = (dir: string, state: string) => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			path.join(dir, "docker-engine-upgrade.json"),
			JSON.stringify({
				state,
				from: "29.8.2",
				to: "29.9.2",
				startedAt: "2026-10-29T10:00:00Z",
				finishedAt: null,
				exitCode: null,
			}),
		);
		writeFileSync(path.join(dir, "docker-engine-upgrade.log"), "line\n");
	};

	it("returns null before the first run and for an unreadable status", async () => {
		const dir = makeTempDir();
		expect(await readHostDockerUpgradeStatus(dir)).toBeNull();

		writeFileSync(path.join(dir, "docker-engine-upgrade.json"), "{broken");
		expect(await readHostDockerUpgradeStatus(dir)).toBeNull();
	});

	it("reports a running upgrade that stopped writing for half an hour as interrupted", async () => {
		const dir = makeTempDir();
		writeStatus(dir, "running");
		const now = Date.now();

		expect((await readHostDockerUpgradeStatus(dir, now))?.state).toBe(
			"running",
		);

		const old = new Date(now - 31 * 60 * 1000);
		for (const name of [
			"docker-engine-upgrade.json",
			"docker-engine-upgrade.log",
		]) {
			utimesSync(path.join(dir, name), old, old);
		}
		expect((await readHostDockerUpgradeStatus(dir, now))?.state).toBe(
			"interrupted",
		);
	});

	it("keeps only the tail of a long log", async () => {
		const dir = makeTempDir();
		writeStatus(dir, "succeeded");
		writeFileSync(
			path.join(dir, "docker-engine-upgrade.log"),
			`${"x".repeat(70 * 1024)}last line\n`,
		);

		const status = await readHostDockerUpgradeStatus(dir);
		expect(status?.log.length).toBe(64 * 1024);
		expect(status?.log.endsWith("last line\n")).toBe(true);
	});
});

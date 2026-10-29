import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execAsync } = vi.hoisted(() => ({ execAsync: vi.fn() }));

vi.mock("@dokploy/server/db", () => ({
	db: {},
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync,
	execAsyncRemote: vi.fn(),
}));

const {
	cleanupOldDokployImages,
	getAgentHitsReloadCommand,
	getAgentHitsUpdateCommand,
	getDokployImageCleanupCommand,
	getDokployImageKeepCount,
	getDokployImageRepositories,
	getDokployImages,
	getOfficialUpdateCommand,
	reloadDockerResource,
} = await import("@dokploy/server/services/settings");
const { UPDATE_IMAGE_PULLED_MARKER } = await import(
	"@dokploy/server/services/web-server-update"
);

const PREVIOUS = `sha256:${"a".repeat(64)}`;
// Each case spawns sh; the 5s default times out on a CI runner under load.
const SPAWN_TEST_TIMEOUT_MS = 30_000;

describe("Dokploy image cleanup", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("DOKPLOY_KEEP_OLD_IMAGES", undefined);
		vi.stubEnv("DOKPLOY_PREVIOUS_IMAGE", undefined);
		vi.stubEnv("DOKPLOY_AGENTHITS_UPDATE_IMAGE", undefined);
		vi.stubEnv("DOKPLOY_AGENTHITS_UPDATE_TAG", undefined);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each([
		[undefined, null],
		["", null],
		["off", null],
		["0", 0],
		["1", 1],
		["5", 5],
		["6", null],
		["-1", null],
		["3.5", null],
		["abc", null],
	])("reads keep count %s as %s", (value, expected) => {
		vi.stubEnv("DOKPLOY_KEEP_OLD_IMAGES", value);
		expect(getDokployImageKeepCount()).toBe(expected);
	});

	it("ignores the old keep setting, whose 0 meant off", () => {
		vi.stubEnv("DOKPLOY_KEEP_IMAGES", "0");
		expect(getDokployImageKeepCount()).toBeNull();
	});

	it("targets the fork and official image repositories without tags", () => {
		expect(getDokployImageRepositories()).toEqual([
			"ghcr.io/agenthits/dokploy",
			"dokploy/dokploy",
		]);

		vi.stubEnv(
			"DOKPLOY_AGENTHITS_UPDATE_IMAGE",
			"registry.local:5000/team/dokploy:dev@sha256:abc",
		);
		expect(getDokployImageRepositories()).toEqual([
			"registry.local:5000/team/dokploy",
			"dokploy/dokploy",
		]);
	});

	it("keeps the newest images and only removes exited dokploy task containers", () => {
		const command = getDokployImageCleanupCommand(4, PREVIOUS);

		expect(command).toContain(
			"--filter reference\\=ghcr.io/agenthits/dokploy --filter reference\\=dokploy/dokploy",
		);
		expect(command).toContain("tail -n +5");
		expect(command).toContain("--filter status=exited");
		expect(command).toContain(
			"--filter label=com.docker.swarm.service.name=dokploy",
		);
		expect(command).not.toMatch(/\brm (-f|--force)\b/);
	});

	it("skips one more image when the previous build was not recorded", () => {
		expect(getDokployImageCleanupCommand(0, null)).toContain("tail -n +2");
		expect(getDokployImageCleanupCommand(0, PREVIOUS)).toContain("tail -n +1");
	});

	it.each([
		[1, "sha256:cur", ["sha256:old2", "sha256:old3"]],
		[0, "sha256:cur", ["sha256:old1", "sha256:old2", "sha256:old3"]],
		[0, null, ["sha256:old1", "sha256:old2", "sha256:old3"]],
		[3, "sha256:cur", []],
	])(
		"with keep %s and previous %s, removes %j and never the running or previous image",
		(keep, previous, expectedRemoved) => {
			const dir = mkdtempSync(join(tmpdir(), "dokploy-cleanup-"));
			const log = join(dir, "log");
			try {
				writeFileSync(
					join(dir, "docker"),
					`#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
	"image ls"*) printf 'sha256:new\nsha256:cur\nsha256:old1\nsha256:old2\nsha256:old3\n' ;;
	"ps -q"*) echo task1 ;;
	"inspect --format {{.Image}} task1") echo sha256:new ;;
	"image inspect --format {{.Created}} {{.Id}}"*) printf '2026-10-07T05 sha256:new\n2026-10-07T04 sha256:cur\n2026-10-07T03 sha256:old1\n2026-10-07T02 sha256:old2\n2026-10-07T01 sha256:old3\n' ;;
esac
`,
				);
				chmodSync(join(dir, "docker"), 0o755);
				writeFileSync(log, "");

				execFileSync(
					"sh",
					["-c", getDokployImageCleanupCommand(keep, previous)],
					{
						env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
					},
				);

				const removed = readFileSync(log, "utf8")
					.split("\n")
					.filter((line) => line.startsWith("image rm "))
					.map((line) => line.slice("image rm ".length));
				expect(removed).toEqual(expectedRemoved);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it("does nothing at startup when the cleanup is off", async () => {
		await cleanupOldDokployImages();
		expect(execAsync).not.toHaveBeenCalled();
	});

	it("runs the cleanup at startup when a keep count is set", async () => {
		vi.stubEnv("DOKPLOY_KEEP_OLD_IMAGES", "0");
		vi.stubEnv("DOKPLOY_PREVIOUS_IMAGE", PREVIOUS);
		execAsync.mockResolvedValue({ stdout: "", stderr: "" });

		await cleanupOldDokployImages();

		expect(execAsync).toHaveBeenCalledWith(
			getDokployImageCleanupCommand(0, PREVIOUS),
		);
	});

	it("does not trust a malformed previous image id", async () => {
		vi.stubEnv("DOKPLOY_KEEP_OLD_IMAGES", "1");
		vi.stubEnv("DOKPLOY_PREVIOUS_IMAGE", "sha256:abc; rm -rf /");
		execAsync.mockResolvedValue({ stdout: "", stderr: "" });

		await cleanupOldDokployImages();

		expect(execAsync).toHaveBeenCalledWith(
			getDokployImageCleanupCommand(1, null),
		);
	});

	it("does not throw when the cleanup fails", async () => {
		vi.stubEnv("DOKPLOY_KEEP_OLD_IMAGES", "3");
		execAsync.mockRejectedValue(new Error("docker unavailable"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(cleanupOldDokployImages()).resolves.toBeUndefined();
	});

	it("stores the keep count on the service only when it is given", () => {
		expect(getAgentHitsUpdateCommand("v0.30.6")).not.toContain(
			"DOKPLOY_KEEP_OLD_IMAGES",
		);
		expect(getAgentHitsUpdateCommand("v0.30.6", null, null, 0)).toContain(
			"--env-add DOKPLOY_KEEP_OLD_IMAGES\\=0 \\\n",
		);
		expect(getAgentHitsUpdateCommand("v0.30.6", null, null, null)).toContain(
			"--env-add DOKPLOY_KEEP_OLD_IMAGES\\=off",
		);
	});

	it("records the running image before replacing it", () => {
		for (const command of [
			getAgentHitsUpdateCommand("v0.30.6"),
			getOfficialUpdateCommand("v0.30.7"),
		]) {
			const recordAt = command.indexOf("previous_image=$(docker inspect");
			expect(recordAt).toBeGreaterThan(-1);
			expect(recordAt).toBeLessThan(command.indexOf("docker service update"));
			expect(command).toContain(
				'--env-add "DOKPLOY_PREVIOUS_IMAGE=$previous_image"',
			);
		}
	});
});

describe("Dokploy image list", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("DOKPLOY_AGENTHITS_UPDATE_IMAGE", undefined);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	const image = (id: string, createdAt: string, fork: string) =>
		JSON.stringify({
			id: `sha256:${id}`,
			createdAt,
			size: 4455354111,
			tags: [`ghcr.io/agenthits/dokploy:agenthits-dev-${id}`],
			config: {
				Env: [
					"PATH=/usr/bin|/bin",
					`DOKPLOY_FORK_VERSION=${fork}`,
					"DOKPLOY_OFFICIAL_VERSION=v0.30.6",
				],
			},
		});
	const container = (id: string, running: boolean, service: string) =>
		JSON.stringify({ image: `sha256:${id}`, running, service });

	it("reads versions, sizes and containers newest first", async () => {
		execAsync.mockImplementation(async (command: string) => {
			if (command.startsWith("docker image ls")) {
				return { stdout: "sha256:aaa\nsha256:bbb\nsha256:ccc\n", stderr: "" };
			}
			if (command.startsWith("docker image inspect")) {
				return {
					stdout: [
						image("aaa", "2026-10-07T10:26:35.154227243Z", "Fork_412+aaa"),
						image("ccc", "2026-10-07T08:50:17.72561574Z", "Fork_400+ccc"),
						image("bbb", "2026-10-07T09:30:23.012650643Z", "Fork_408+bbb"),
					].join("\n"),
					stderr: "",
				};
			}
			if (command.startsWith("docker system df")) {
				return {
					stdout: JSON.stringify({
						Images: [{ ID: "sha256:aaa", UniqueSize: "4.115GB" }],
					}),
					stderr: "",
				};
			}
			return {
				stdout: [
					container("aaa", true, "dokploy"),
					container("bbb", false, "dokploy"),
					container("bbb", false, "dokploy"),
					container("ccc", false, ""),
				].join("\n"),
				stderr: "",
			};
		});

		const images = await getDokployImages();

		expect(images.map((item) => item.forkVersion)).toEqual([
			"Fork_412+aaa",
			"Fork_408+bbb",
			"Fork_400+ccc",
		]);
		expect(images[0]).toMatchObject({
			isCurrent: true,
			uniqueSizeBytes: 4115000000,
			officialVersion: "v0.30.6",
		});
		expect(images[1]).toMatchObject({
			isCurrent: false,
			dokployTaskContainers: 2,
			otherContainers: 0,
			uniqueSizeBytes: null,
		});
		expect(images[2]).toMatchObject({ otherContainers: 1 });
	});

	it("returns nothing when there are no Dokploy images", async () => {
		execAsync.mockResolvedValue({ stdout: "", stderr: "" });
		await expect(getDokployImages()).resolves.toEqual([]);
		expect(execAsync).toHaveBeenCalledTimes(1);
	});
});

describe("Dokploy update commands", () => {
	beforeEach(() => {
		vi.stubEnv("DOKPLOY_AGENTHITS_UPDATE_IMAGE", undefined);
		vi.stubEnv("DOKPLOY_AGENTHITS_UPDATE_TAG", undefined);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	const expectPullBeforeUpdate = (command: string, pull: string) => {
		expect(command).toContain(`${pull} || exit 1`);
		expect(command.indexOf(pull)).toBeLessThan(
			command.indexOf("docker service update"),
		);

		const lines = command.split("\n");
		const markerLine = lines.findIndex((line) => line.startsWith("echo "));
		expect(lines[markerLine - 1]).toBe(`${pull} || exit 1`);
		expect(
			execFileSync("sh", ["-c", lines[markerLine] as string], {
				encoding: "utf8",
			}).trim(),
		).toBe(UPDATE_IMAGE_PULLED_MARKER);
	};

	it("pulls the AgentHits image while the old container still runs", () => {
		expectPullBeforeUpdate(
			getAgentHitsUpdateCommand("v0.30.6"),
			"docker pull ghcr.io/agenthits/dokploy\\:agenthits-dev",
		);
	});

	it("pulls the official image before updating the service", () => {
		const command = getOfficialUpdateCommand("v0.30.7", 3);

		expectPullBeforeUpdate(command, "docker pull dokploy/dokploy\\:v0.30.7");
		expect(command).toContain(
			"--image dokploy/dokploy\\:v0.30.7 --env-add DOKPLOY_KEEP_OLD_IMAGES\\=3 ",
		);
		expect(getOfficialUpdateCommand("v0.30.7")).not.toContain(
			"DOKPLOY_KEEP_OLD_IMAGES",
		);
	});

	it("stops the old task first and rolls back a failed panel update", () => {
		for (const command of [
			getAgentHitsUpdateCommand("v0.30.6"),
			getOfficialUpdateCommand("v0.30.7"),
		]) {
			expect(command).toContain("--update-order stop-first");
			expect(command).toContain("--update-failure-action rollback");
		}
	});

	it("includes untagged images that swarm pulled by digest", async () => {
		execAsync.mockResolvedValue({ stdout: "", stderr: "" });

		await getDokployImages();

		expect(execAsync.mock.calls[0]?.[0]).toMatch(/^docker image ls -a -q /);
		expect(getDokployImageCleanupCommand(3, null)).toContain(
			"docker image ls -a -q",
		);
	});
});

describe("Dokploy reload command", () => {
	const DIGEST = `ghcr.io/agenthits/dokploy@sha256:${"b".repeat(64)}`;

	const runReload = (env: Record<string, string>) => {
		const dir = mkdtempSync(join(tmpdir(), "dokploy-reload-"));
		const log = join(dir, "log");
		try {
			writeFileSync(
				join(dir, "docker"),
				`#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
	"ps -q"*) [ -n "$NO_TASK" ] || echo task1 ;;
	"inspect --format {{.Image}} task1") echo sha256:cur ;;
	"image inspect --format {{index .RepoDigests 0}} sha256:cur")
		if [ -n "$NO_DIGEST" ]; then echo "index out of range: 0" >&2; exit 1; fi
		echo "${DIGEST}" ;;
esac
`,
			);
			chmodSync(join(dir, "docker"), 0o755);
			writeFileSync(log, "");
			let status = 0;
			try {
				execFileSync("sh", ["-c", getAgentHitsReloadCommand()], {
					env: {
						...process.env,
						...env,
						PATH: `${dir}:${process.env.PATH}`,
					},
					stdio: "pipe",
				});
			} catch (error) {
				status = (error as { status: number }).status;
			}
			return { status, calls: readFileSync(log, "utf8").trim().split("\n") };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	it(
		"restarts the running build by digest without pulling",
		() => {
			const { status, calls } = runReload({});
			expect(status).toBe(0);
			expect(calls.some((call) => call.startsWith("pull"))).toBe(false);
			expect(calls.at(-1)).toBe(
				`service update --force --no-resolve-image --image ${DIGEST} --update-order stop-first --update-failure-action rollback dokploy`,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"falls back to the image id for a build without a registry digest",
		() => {
			const { status, calls } = runReload({ NO_DIGEST: "1" });
			expect(status).toBe(0);
			expect(calls.at(-1)).toContain("--image sha256:cur ");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"does not restart the panel when its running image is unknown",
		() => {
			const { status, calls } = runReload({ NO_TASK: "1" });
			expect(status).toBe(1);
			expect(calls.some((call) => call.startsWith("service update"))).toBe(
				false,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it("reloads an AgentHits panel without the update command", async () => {
		vi.stubEnv("DOKPLOY_UPDATE_SOURCE", "agenthits");
		execAsync.mockReset();
		execAsync
			.mockResolvedValueOnce({ stdout: "service\n", stderr: "" })
			.mockResolvedValueOnce({ stdout: "", stderr: "" });
		try {
			await reloadDockerResource("dokploy", undefined, "v0.30.6");

			expect(execAsync).toHaveBeenLastCalledWith(getAgentHitsReloadCommand());
			expect(execAsync.mock.lastCall?.[0]).not.toContain("docker pull");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

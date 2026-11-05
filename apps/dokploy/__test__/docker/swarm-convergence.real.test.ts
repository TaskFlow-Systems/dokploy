import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { docker } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import { deployLibsql } from "@dokploy/server/services/libsql";
import {
	buildLibsql,
	type LibsqlNested,
} from "@dokploy/server/utils/databases/libsql";
import { rebuildDatabase } from "@dokploy/server/utils/databases/rebuild";
import {
	buildRedis,
	type RedisNested,
} from "@dokploy/server/utils/databases/redis";
import { waitForSwarmServiceConvergence } from "@dokploy/server/utils/docker/utils";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

const REDIS_IMAGE = "redis:8-alpine";
const LIBSQL_IMAGE = "ghcr.io/tursodatabase/libsql-server:v0.24.32";
const REAL_TEST_TIMEOUT = 180_000;
// What a default spec gets from Swarm in an update, and from the wait otherwise.
const MONITOR_MS = 5_000;
const CRASH_LIMIT = { timeoutMs: 25_000 };
// Often enough to catch a task in the moment it runs, which is when a crash looks fine.
const CATCHES_EVERY_RUN = { ...CRASH_LIMIT, intervalMs: 50 };
// Under load Swarm reports an exit late, so a task that lives close to Monitor can
// look settled, and a restart loop gets several tries at that within the limit.
const CRASH_AFTER_S = 1;

// Same id as application.real.test.ts: the PR workflow removes services named
// real-<kind>-<id>* after a cancelled run, and Docker is shared by CI runners.
const CHECKOUT_ID = createHash("sha256")
	.update(process.cwd())
	.digest("hex")
	.slice(0, 8);
const RUN_ID = `${CHECKOUT_ID}-${Date.now()}`;
const NETWORK = `real-swarm-net-${RUN_ID}`;

const appNames: string[] = [];
const volumeNames: string[] = [];

const dockerCli = async (...args: string[]) => {
	const { stdout } = await execFileAsync("docker", args, {
		timeout: 120_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout.trim();
};

const newAppName = (kind: string) => {
	const appName = `real-swarm-${RUN_ID}-${kind}`;
	appNames.push(appName);
	return appName;
};

const environment = {
	environmentId: "env",
	projectId: "project",
	name: "production",
	env: "",
	project: {
		projectId: "project",
		organizationId: "org",
		name: "project",
		env: "",
	},
};

const redisFixture = (kind: string, overrides: Partial<RedisNested> = {}) => {
	const appName = newAppName(kind);
	return {
		redisId: `redis-${kind}`,
		name: appName,
		appName,
		dockerImage: REDIS_IMAGE,
		databasePassword: "stored-Passw0rd",
		serverId: null,
		env: null,
		command: null,
		args: null,
		externalPort: null,
		memoryLimit: null,
		memoryReservation: null,
		cpuLimit: null,
		cpuReservation: null,
		replicas: 1,
		networkSwarm: [{ Target: NETWORK }],
		mounts: [],
		environmentId: "env",
		environment,
		...overrides,
	} as unknown as RedisNested;
};

const libsqlFixture = (kind: string, overrides: Partial<LibsqlNested> = {}) => {
	const appName = newAppName(kind);
	return {
		libsqlId: `libsql-${kind}`,
		name: appName,
		appName,
		dockerImage: LIBSQL_IMAGE,
		databaseUser: "panel_user",
		databasePassword: "stored-Passw0rd",
		sqldNode: "primary",
		sqldPrimaryUrl: null,
		enableNamespaces: false,
		serverId: null,
		env: null,
		command: null,
		externalPort: null,
		externalGRPCPort: null,
		externalAdminPort: null,
		memoryLimit: null,
		memoryReservation: null,
		cpuLimit: null,
		cpuReservation: null,
		replicas: 1,
		networkSwarm: [{ Target: NETWORK }],
		mounts: [],
		environmentId: "env",
		environment,
		...overrides,
	} as unknown as LibsqlNested;
};

const shellScript = (script: string) => ({
	command: "/bin/sh",
	args: ["-c", script],
});

const inspect = (appName: string) => docker.getService(appName).inspect();

// A restart loop left running until afterAll slows every test after it.
const removeCrashing = (appName: string) => docker.getService(appName).remove();

const runningTasks = async (appName: string) =>
	(
		await docker.listTasks({
			filters: JSON.stringify({
				service: [appName],
				"desired-state": ["running"],
			}),
		})
	).filter((task) => task.Status?.State === "running");

const waitUntil = async (
	what: string,
	check: () => Promise<boolean>,
	timeoutMs = 90_000,
) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`Timed out waiting for ${what}`);
};

const waitForRollbackEnd = (appName: string) =>
	waitUntil(`the rollback of ${appName}`, async () => {
		const info = await inspect(appName);
		return (
			info.UpdateStatus?.State !== "rollback_started" &&
			(await runningTasks(appName)).length === 1
		);
	});

const recordStatuses = () => {
	const statuses: unknown[] = [];
	vi.mocked(db.update).mockImplementation((() => ({
		set: (values: { applicationStatus?: string }) => {
			statuses.push(values.applicationStatus);
			return {
				where: () => ({ returning: () => Promise.resolve([{}]) }),
			};
		},
	})) as never);
	return statuses;
};

const timedWait = async (appName: string) => {
	const startedAt = Date.now();
	await waitForSwarmServiceConvergence(appName);
	return Date.now() - startedAt;
};

// The test and Docker share a machine, so here these clocks can be compared.
const expectUpForMonitor = (task?: { Status?: { Timestamp?: string } }) => {
	const upMs = Date.now() - Date.parse(task?.Status?.Timestamp ?? "");
	expect(upMs).toBeGreaterThanOrEqual(MONITOR_MS - 500);
};

const expectOnNewSpec = async (appName: string, previousTaskId: string) => {
	const info = await inspect(appName);
	expect(info.UpdateStatus?.State).toBe("completed");
	const tasks = await runningTasks(appName);
	expect(tasks).toHaveLength(1);
	expect(tasks[0]?.ID).not.toBe(previousTaskId);
	expect(tasks[0]?.Spec?.ForceUpdate).toBe(info.Spec.TaskTemplate.ForceUpdate);
	return tasks[0]?.ID as string;
};

describe("waitForSwarmServiceConvergence on real Docker", () => {
	beforeAll(async () => {
		await dockerCli("pull", REDIS_IMAGE);
		await dockerCli("pull", LIBSQL_IMAGE);
		await dockerCli(
			"network",
			"create",
			"--driver",
			"overlay",
			"--attachable",
			NETWORK,
		);
	}, REAL_TEST_TIMEOUT);

	afterAll(async () => {
		for (const appName of appNames) {
			await docker
				.getService(appName)
				.remove()
				.catch(() => undefined);
		}
		// A task keeps its overlay endpoint for a moment after its service is gone.
		await waitUntil(
			"the test network to go",
			() =>
				dockerCli("network", "rm", NETWORK).then(
					() => true,
					() => false,
				),
			30_000,
		).catch(() => undefined);
		for (const volumeName of volumeNames) {
			await waitUntil(
				`the volume ${volumeName} to go`,
				() =>
					dockerCli("volume", "rm", volumeName).then(
						() => true,
						() => false,
					),
				30_000,
			).catch(() => undefined);
		}
	}, REAL_TEST_TIMEOUT);

	it(
		"returns for a fresh service once its task has stayed up as long as Swarm would watch it",
		async () => {
			const redis = redisFixture("fresh");
			await buildRedis(redis);
			await timedWait(redis.appName);

			const tasks = await runningTasks(redis.appName);
			expect(tasks).toHaveLength(1);
			expectUpForMonitor(tasks[0]);
			expect((await inspect(redis.appName)).UpdateStatus).toBeUndefined();
		},
		REAL_TEST_TIMEOUT,
	);

	it.each([
		[
			"a second after it starts",
			"late",
			`sleep ${CRASH_AFTER_S}; exit 3`,
			CRASH_LIMIT,
		],
		["soon after it starts", "soon", "sleep 0.3; exit 3", CATCHES_EVERY_RUN],
		["at once", "at-once", "exit 3", CATCHES_EVERY_RUN],
	])(
		"fails for a fresh service that crashes %s",
		async (_, kind, script, limit) => {
			const redis = redisFixture(`crash-${kind}`, shellScript(script));
			await buildRedis(redis);

			await expect(
				waitForSwarmServiceConvergence(redis.appName, null, limit),
			).rejects.toThrow(
				/did not converge within 25000ms: 0\/1 tasks stayed running for 5 s.*non-zero exit \(3\)/,
			);
			await removeCrashing(redis.appName);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"returns for a fresh service that fails once and then stays up",
		async () => {
			const volumeName = `real-swarm-${RUN_ID}-once`;
			volumeNames.push(volumeName);
			const redis = redisFixture("once", {
				...shellScript(
					"[ -f /marker/once ] || { touch /marker/once; exit 3; }; exec redis-server",
				),
				mounts: [{ type: "volume", volumeName, mountPath: "/marker" }] as never,
			});
			await buildRedis(redis);

			await timedWait(redis.appName);

			const tasks = await docker.listTasks({
				filters: JSON.stringify({ service: [redis.appName] }),
			});
			expect(
				tasks.filter((task) => task.Status?.Err?.includes("non-zero exit (3)")),
			).toHaveLength(1);
			const running = await runningTasks(redis.appName);
			expect(running).toHaveLength(1);
			expectUpForMonitor(running[0]);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"returns for a fresh service scaled to 0",
		async () => {
			const redis = redisFixture("fresh-zero", { replicas: 0 });
			await buildRedis(redis);

			expect(await timedWait(redis.appName)).toBeLessThan(10_000);
			expect(await runningTasks(redis.appName)).toHaveLength(0);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"returns for a service scaled down to 0 by a redeploy",
		async () => {
			const redis = redisFixture("scale-zero");
			await buildRedis(redis);
			await timedWait(redis.appName);

			await buildRedis({ ...redis, replicas: 0 });

			expect(await timedWait(redis.appName)).toBeLessThan(15_000);
			expect(await runningTasks(redis.appName)).toHaveLength(0);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"returns soon when an update changes nothing, and leaves the task alone",
		async () => {
			// buildLibsql is the one builder that does not bump ForceUpdate.
			const libsql = libsqlFixture("noop");
			await buildLibsql(libsql);
			await timedWait(libsql.appName);
			const [before] = await runningTasks(libsql.appName);

			await buildLibsql(libsql);

			expect(await timedWait(libsql.appName)).toBeLessThan(MONITOR_MS);
			expect((await inspect(libsql.appName)).UpdateStatus).toBeUndefined();
			const after = await runningTasks(libsql.appName);
			expect(after.map((task) => task.ID)).toEqual([before?.ID]);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"fails when an update changes nothing and the service keeps crashing",
		async () => {
			const libsql = libsqlFixture("noop-crash", {
				command: "sleep 1; exit 3",
			});
			await buildLibsql(libsql);
			await waitUntil("the first crash", async () => {
				const tasks = await docker.listTasks({
					filters: JSON.stringify({ service: [libsql.appName] }),
				});
				return tasks.some((task) => task.Status?.Err);
			});

			await buildLibsql(libsql);

			await expect(
				waitForSwarmServiceConvergence(libsql.appName, null, CATCHES_EVERY_RUN),
			).rejects.toThrow(/0\/1 tasks stayed running.*non-zero exit \(3\)/);
			expect((await inspect(libsql.appName)).UpdateStatus).toBeUndefined();
			await removeCrashing(libsql.appName);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"watches the new replica of a scale-up, and leaves the running one alone",
		async () => {
			const libsql = libsqlFixture("scale-up");
			await buildLibsql(libsql);
			await timedWait(libsql.appName);
			const [before] = await runningTasks(libsql.appName);

			await buildLibsql({ ...libsql, replicas: 2 });

			await timedWait(libsql.appName);

			const after = await runningTasks(libsql.appName);
			expect(after).toHaveLength(2);
			expect(after.map((task) => task.ID)).toContain(before?.ID);
			expectUpForMonitor(after.find((task) => task.ID !== before?.ID));
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"waits for the new task of each redeploy, not the old one or an earlier completed state",
		async () => {
			const redis = redisFixture("redeploy");
			await buildRedis(redis);
			await timedWait(redis.appName);
			const [first] = await runningTasks(redis.appName);

			await buildRedis(redis);
			await timedWait(redis.appName);
			const second = await expectOnNewSpec(redis.appName, first?.ID as string);

			await buildRedis(redis);
			await timedWait(redis.appName);
			await expectOnNewSpec(redis.appName, second);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"waits for the end of a start-first update, while the old task stays up",
		async () => {
			const redis = redisFixture("start-first", {
				updateConfigSwarm: {
					Parallelism: 1,
					Order: "start-first",
					FailureAction: "rollback",
				},
			});
			await buildRedis(redis);
			await timedWait(redis.appName);
			const [first] = await runningTasks(redis.appName);

			await buildRedis(redis);
			await timedWait(redis.appName);

			await expectOnNewSpec(redis.appName, first?.ID as string);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"fails when Swarm rolls the update back, and the next deploy starts clean",
		async () => {
			const redis = redisFixture("rollback");
			await buildRedis(redis);
			await timedWait(redis.appName);
			const goodArgs = (await inspect(redis.appName)).Spec.TaskTemplate
				.ContainerSpec.Args;

			await buildRedis({
				...redis,
				command: "/bin/sh",
				args: ["-c", "exit 3"],
			});
			const failure = await waitForSwarmServiceConvergence(redis.appName).then(
				() => null,
				(error: Error) => error,
			);

			expect(failure?.message).toMatch(/Swarm (rolled|is rolling) back/);
			expect(failure?.message).toContain("non-zero exit (3)");
			expect(failure?.message).toContain("previous configuration");
			const rolledBack = await inspect(redis.appName);
			expect(rolledBack.Spec.TaskTemplate.ContainerSpec.Args).toEqual(goodArgs);

			await waitForRollbackEnd(redis.appName);
			const [restored] = await runningTasks(redis.appName);
			await buildRedis(redis);
			await timedWait(redis.appName);
			await expectOnNewSpec(redis.appName, restored?.ID as string);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"does not report an earlier rollback when the next update changes nothing",
		async () => {
			const libsql = libsqlFixture("noop-after-rollback");
			await buildLibsql(libsql);
			await timedWait(libsql.appName);

			await buildLibsql({ ...libsql, command: "sqld --no-such-flag" });
			await expect(
				waitForSwarmServiceConvergence(libsql.appName),
			).rejects.toThrow(/Swarm (rolled|is rolling) back/);
			await waitForRollbackEnd(libsql.appName);

			await buildLibsql(libsql);
			await timedWait(libsql.appName);

			expect((await inspect(libsql.appName)).UpdateStatus).toBeUndefined();
			expect(await runningTasks(libsql.appName)).toHaveLength(1);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"fails on a rollback caused by a task that leaves no error behind",
		async () => {
			const redis = redisFixture("unhealthy");
			await buildRedis(redis);
			await timedWait(redis.appName);

			await buildRedis({
				...redis,
				healthCheckSwarm: {
					Test: ["CMD-SHELL", "exit 1"],
					Interval: 1_000_000_000,
					Timeout: 1_000_000_000,
					Retries: 2,
				},
			});

			await expect(
				waitForSwarmServiceConvergence(redis.appName),
			).rejects.toThrow(
				/Swarm (rolled|is rolling) back.*stopped or failed its health check/,
			);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"fails when the update pauses after a task failure",
		async () => {
			const redis = redisFixture("pause", {
				updateConfigSwarm: {
					Parallelism: 1,
					Order: "stop-first",
					FailureAction: "pause",
				},
			});
			await buildRedis(redis);
			await timedWait(redis.appName);

			await buildRedis({
				...redis,
				command: "/bin/sh",
				args: ["-c", "exit 3"],
			});

			await expect(
				waitForSwarmServiceConvergence(redis.appName),
			).rejects.toThrow(/Swarm paused the update.*non-zero exit \(3\)/);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"fails when FailureAction continue completes the update with its task restarting",
		async () => {
			const redis = redisFixture("continue", {
				updateConfigSwarm: {
					Parallelism: 1,
					Order: "stop-first",
					FailureAction: "continue",
				},
			});
			await buildRedis(redis);
			await timedWait(redis.appName);

			await buildRedis({ ...redis, ...shellScript("sleep 1; exit 3") });

			await expect(
				waitForSwarmServiceConvergence(redis.appName, null, { intervalMs: 50 }),
			).rejects.toThrow(/0\/1 tasks stayed running.*non-zero exit \(3\)/);
			expect((await inspect(redis.appName)).UpdateStatus?.State).toBe(
				"completed",
			);
			await removeCrashing(redis.appName);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"gives up on a stuck update and says that Swarm is still at it",
		async () => {
			const redis = redisFixture("stuck");
			await buildRedis(redis);
			await timedWait(redis.appName);

			await buildRedis({
				...redis,
				placementSwarm: {
					Constraints: ["node.labels.dokploy-test-no-such-label==1"],
				},
			});

			await expect(
				waitForSwarmServiceConvergence(redis.appName, null, {
					timeoutMs: 6_000,
				}),
			).rejects.toThrow(
				/did not converge within 6000ms.*still updating.*no suitable node/,
			);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"makes deployLibsql report a rolled-back update as a failed deployment",
		async () => {
			const libsql = libsqlFixture("deploy");
			const statuses = recordStatuses();
			const logs: string[] = [];
			vi.mocked(db.query.libsql.findFirst).mockResolvedValue(libsql as never);

			await deployLibsql(libsql.libsqlId, (line) => logs.push(line));
			expect(statuses).toEqual(["running", "done"]);
			expect(logs).toContain("Deployment completed successfully!");

			statuses.length = 0;
			logs.length = 0;
			vi.mocked(db.query.libsql.findFirst).mockResolvedValue({
				...libsql,
				command: "sqld --no-such-flag",
			} as never);

			await expect(
				deployLibsql(libsql.libsqlId, (line) => logs.push(line)),
			).rejects.toThrow(/Swarm (rolled|is rolling) back/);

			expect(statuses).toEqual(["running", "error"]);
			expect(logs).not.toContain("Deployment completed successfully!");
			expect(logs.join("\n")).toMatch(/Swarm (rolled|is rolling) back/);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"reports a Rebuild on the task of the new service, and fails it when that task crashes",
		async () => {
			const redis = redisFixture("rebuild");
			const statuses = recordStatuses();
			vi.mocked(db.query.redis.findFirst).mockResolvedValue(redis as never);
			await buildRedis(redis);
			await timedWait(redis.appName);
			const [before] = await runningTasks(redis.appName);

			await rebuildDatabase(redis.redisId, "redis", 0);

			expect(statuses).toEqual(["running", "done"]);
			const rebuilt = await inspect(redis.appName);
			expect(rebuilt.PreviousSpec).toBeUndefined();
			const after = await runningTasks(redis.appName);
			expect(after).toHaveLength(1);
			expect(after[0]?.ID).not.toBe(before?.ID);
			expectUpForMonitor(after[0]);

			statuses.length = 0;
			vi.mocked(db.query.redis.findFirst).mockResolvedValue({
				...redis,
				...shellScript(`sleep ${CRASH_AFTER_S}; exit 3`),
			} as never);

			await expect(rebuildDatabase(redis.redisId, "redis", 0)).rejects.toThrow(
				/did not converge within 45000ms: 0\/1 tasks stayed running for 5 s.*non-zero exit \(3\)/,
			);

			expect(statuses).toEqual(["running", "error"]);
			await removeCrashing(redis.appName);
		},
		REAL_TEST_TIMEOUT,
	);
});

import { docker } from "@dokploy/server/constants";
import { buildLibsql } from "@dokploy/server/utils/databases/libsql";
import { buildRedis } from "@dokploy/server/utils/databases/redis";
import { waitForSwarmServiceConvergence } from "@dokploy/server/utils/docker/utils";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	CATCHES_EVERY_RUN,
	CRASH_AFTER_S,
	CRASH_LIMIT,
	cleanUpRealSwarm,
	expectOnNewSpec,
	expectUpForMonitor,
	inspect,
	libsqlFixture,
	MONITOR_MS,
	REAL_TEST_TIMEOUT,
	RUN_ID,
	redisFixture,
	removeCrashing,
	runningTasks,
	setUpRealSwarm,
	shellScript,
	timedWait,
	volumeNames,
	waitUntil,
} from "./swarm-convergence-real";

// The authority lives in the panel's database, which these tests leave out.
vi.mock("@dokploy/server/services/libsql-grpc-ca", async () => {
	const { createLibsqlGrpcCa } = await import(
		"@dokploy/server/utils/databases/libsql-grpc-tls"
	);
	const ca = await createLibsqlGrpcCa("org");
	return { getLibsqlGrpcCa: async () => ca };
});

describe("waitForSwarmServiceConvergence on real Docker", () => {
	beforeAll(setUpRealSwarm, REAL_TEST_TIMEOUT);
	afterAll(cleanUpRealSwarm, REAL_TEST_TIMEOUT);

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
});

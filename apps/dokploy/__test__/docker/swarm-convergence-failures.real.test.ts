import { db } from "@dokploy/server/db";
import { deployLibsql } from "@dokploy/server/services/libsql";
import { buildLibsql } from "@dokploy/server/utils/databases/libsql";
import { rebuildDatabase } from "@dokploy/server/utils/databases/rebuild";
import { buildRedis } from "@dokploy/server/utils/databases/redis";
import { waitForSwarmServiceConvergence } from "@dokploy/server/utils/docker/utils";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	CRASH_AFTER_S,
	cleanUpRealSwarm,
	expectOnNewSpec,
	expectUpForMonitor,
	inspect,
	libsqlFixture,
	REAL_TEST_TIMEOUT,
	recordStatuses,
	redisFixture,
	removeCrashing,
	runningTasks,
	setUpRealSwarm,
	shellScript,
	timedWait,
	waitForRollbackEnd,
} from "./swarm-convergence-real";

// The authority lives in the panel's database, which these tests leave out.
vi.mock("@dokploy/server/services/libsql-grpc-ca", async () => {
	const { createLibsqlGrpcCa } = await import(
		"@dokploy/server/utils/databases/libsql-grpc-tls"
	);
	const ca = await createLibsqlGrpcCa("org");
	return { getLibsqlGrpcCa: async () => ca };
});

describe("waitForSwarmServiceConvergence on real Docker: failed updates and builders", () => {
	beforeAll(setUpRealSwarm, REAL_TEST_TIMEOUT);
	afterAll(cleanUpRealSwarm, REAL_TEST_TIMEOUT);

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

			await rebuildDatabase(redis.redisId, "redis");

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

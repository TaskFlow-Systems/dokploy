import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { docker } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import type { LibsqlNested } from "@dokploy/server/utils/databases/libsql";
import type { RedisNested } from "@dokploy/server/utils/databases/redis";
import { waitForSwarmServiceConvergence } from "@dokploy/server/utils/docker/utils";
import { expect, vi } from "vitest";

const execFileAsync = promisify(execFile);

const REDIS_IMAGE = "redis:8-alpine";
const LIBSQL_IMAGE = "ghcr.io/tursodatabase/libsql-server:v0.24.32";
export const REAL_TEST_TIMEOUT = 180_000;
// What a default spec gets from Swarm in an update, and from the wait otherwise.
export const MONITOR_MS = 5_000;
export const CRASH_LIMIT = { timeoutMs: 25_000 };
// Often enough to catch a task in the moment it runs, which is when a crash looks fine.
export const CATCHES_EVERY_RUN = { ...CRASH_LIMIT, intervalMs: 50 };
// Under load Swarm reports an exit late, so a task that lives close to Monitor can
// look settled, and a restart loop gets several tries at that within the limit.
export const CRASH_AFTER_S = 1;

// Same id as application.real.test.ts: the PR workflow removes services named
// real-<kind>-<id>* after a cancelled run, and Docker is shared by CI runners.
const CHECKOUT_ID = createHash("sha256")
	.update(process.cwd())
	.digest("hex")
	.slice(0, 8);
// Both swarm-convergence files load this module, often in the same millisecond on a
// machine with many workers, and each needs a network and services of its own.
export const RUN_ID = `${CHECKOUT_ID}-${Date.now()}-${randomBytes(3).toString("hex")}`;
const NETWORK = `real-swarm-net-${RUN_ID}`;

const appNames: string[] = [];
export const volumeNames: string[] = [];

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

export const redisFixture = (
	kind: string,
	overrides: Partial<RedisNested> = {},
) => {
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

export const libsqlFixture = (
	kind: string,
	overrides: Partial<LibsqlNested> = {},
) => {
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

export const shellScript = (script: string) => ({
	command: "/bin/sh",
	args: ["-c", script],
});

export const inspect = (appName: string) =>
	docker.getService(appName).inspect();

// A restart loop left running until afterAll slows every test after it.
export const removeCrashing = (appName: string) =>
	docker.getService(appName).remove();

export const runningTasks = async (appName: string) =>
	(
		await docker.listTasks({
			filters: JSON.stringify({
				service: [appName],
				"desired-state": ["running"],
			}),
		})
	).filter((task) => task.Status?.State === "running");

export const waitUntil = async (
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

export const waitForRollbackEnd = (appName: string) =>
	waitUntil(`the rollback of ${appName}`, async () => {
		const info = await inspect(appName);
		return (
			info.UpdateStatus?.State !== "rollback_started" &&
			(await runningTasks(appName)).length === 1
		);
	});

export const recordStatuses = () => {
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

export const timedWait = async (appName: string) => {
	const startedAt = Date.now();
	await waitForSwarmServiceConvergence(appName);
	return Date.now() - startedAt;
};

// The test and Docker share a machine, so here these clocks can be compared.
export const expectUpForMonitor = (task?: {
	Status?: { Timestamp?: string };
}) => {
	const upMs = Date.now() - Date.parse(task?.Status?.Timestamp ?? "");
	expect(upMs).toBeGreaterThanOrEqual(MONITOR_MS - 500);
};

export const expectOnNewSpec = async (
	appName: string,
	previousTaskId: string,
) => {
	const info = await inspect(appName);
	expect(info.UpdateStatus?.State).toBe("completed");
	const tasks = await runningTasks(appName);
	expect(tasks).toHaveLength(1);
	expect(tasks[0]?.ID).not.toBe(previousTaskId);
	expect(tasks[0]?.Spec?.ForceUpdate).toBe(info.Spec.TaskTemplate.ForceUpdate);
	return tasks[0]?.ID as string;
};

export const setUpRealSwarm = async () => {
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
};

export const cleanUpRealSwarm = async () => {
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
};

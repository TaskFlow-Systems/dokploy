import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	scheduleJob: vi.fn(),
	loggerError: vi.fn(),
	cleanupAll: vi.fn(),
	sendDockerCleanupNotifications: vi.fn(),
	getAllServers: vi.fn(),
	findMany: vi.fn(),
	findFirst: vi.fn(),
	findVolumeBackupById: vi.fn(),
	paths: vi.fn(),
	runPostgresBackup: vi.fn(),
	scheduleExists: vi.fn(),
}));

vi.mock("node-schedule", () => ({
	scheduleJob: mocks.scheduleJob,
	scheduledJobs: {},
}));
vi.mock("@dokploy/server/lib/logger", () => ({
	logger: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			member: { findFirst: mocks.findFirst },
			user: { findMany: mocks.findMany },
			backups: { findMany: vi.fn(async () => []) },
		},
	},
}));
vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: vi.fn(async () => ({ enableDockerCleanup: true })),
	updateWebServerSettings: vi.fn(),
}));
vi.mock("@dokploy/server/services/server", () => ({
	getAllServers: mocks.getAllServers,
}));
vi.mock("@dokploy/server/utils/access-log/handler", () => ({
	startLogCleanup: vi.fn(),
}));
vi.mock("@dokploy/server/utils/docker/utils", () => ({
	cleanupAll: mocks.cleanupAll,
}));
vi.mock("@dokploy/server/utils/notifications/docker-cleanup", () => ({
	sendDockerCleanupNotifications: mocks.sendDockerCleanupNotifications,
}));
vi.mock("@dokploy/server/wss/utils", () => ({
	getPublicIpWithFallback: vi.fn(async () => "203.0.113.1"),
}));
vi.mock("@dokploy/server/services/volume-backups", () => ({
	findVolumeBackupById: mocks.findVolumeBackupById,
}));
vi.mock("@dokploy/server/constants", async (importOriginal) => ({
	...(await importOriginal<object>()),
	paths: mocks.paths,
}));

import { initCronJobs } from "@dokploy/server/utils/backups";
import { initEnterpriseBackupCronJobs } from "@dokploy/server/utils/crons/enterprise";
import { guardScheduledRun } from "@dokploy/server/utils/crons/guard";
import { settleBackgroundNotifications } from "@dokploy/server/utils/notifications/background";
import { scheduleVolumeBackup } from "@dokploy/server/utils/volume-backups/utils";

type Callback = () => Promise<void>;
const callbackOf = (name: string) =>
	mocks.scheduleJob.mock.calls.find(
		(call) => call[0] === name,
	)?.[2] as Callback;

describe("scheduled jobs never reject", () => {
	const rejections: unknown[] = [];
	const onRejection = (reason: unknown) => rejections.push(reason);
	beforeEach(() => {
		vi.clearAllMocks();
		rejections.length = 0;
		process.on("unhandledRejection", onRejection);
	});
	afterEach(() => {
		process.off("unhandledRejection", onRejection);
	});

	const expectGuarded = async (callback: Callback, jobId: string) => {
		await expect(callback()).resolves.toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(rejections).toEqual([]);
		expect(mocks.loggerError).toHaveBeenCalledTimes(1);
		expect(mocks.loggerError.mock.calls[0]?.[0]).toMatchObject({ jobId });
	};

	it("the guard logs once and swallows, and passes a good run", async () => {
		await expectGuarded(
			guardScheduledRun("job-x", async () => {
				throw new Error("boom");
			}),
			"job-x",
		);
		mocks.loggerError.mockClear();
		await guardScheduledRun("job-y", async () => 1)();
		expect(mocks.loggerError).not.toHaveBeenCalled();
	});

	it("the panel's docker cleanup", async () => {
		mocks.getAllServers.mockResolvedValue([]);
		mocks.cleanupAll.mockRejectedValue(new Error("docker is gone"));
		await initCronJobs();

		await expectGuarded(callbackOf("docker-cleanup"), "docker-cleanup");
	});

	it("a remote server's docker cleanup", async () => {
		mocks.getAllServers.mockResolvedValue([
			{
				serverId: "srv-1",
				enableDockerCleanup: true,
				name: "s",
				organizationId: "org",
			},
		]);
		mocks.cleanupAll.mockRejectedValue(new Error("docker is gone"));
		await initCronJobs();

		await expectGuarded(callbackOf("srv-1"), "srv-1");
	});

	it("a remote server's docker cleanup finishes when its notification fails", async () => {
		mocks.getAllServers.mockResolvedValue([
			{
				serverId: "srv-1",
				enableDockerCleanup: true,
				name: "s",
				organizationId: "org",
			},
		]);
		mocks.cleanupAll.mockResolvedValue(undefined);
		mocks.sendDockerCleanupNotifications.mockRejectedValue(
			new Error("channel down"),
		);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		await initCronJobs();

		await expect(callbackOf("srv-1")()).resolves.toBeUndefined();
		await settleBackgroundNotifications();

		expect(rejections).toEqual([]);
		expect(mocks.loggerError).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(
			"Failed to send the docker cleanup notification:",
			expect.any(Error),
		);
		log.mockRestore();
	});

	it("the enterprise license check", async () => {
		mocks.findMany.mockRejectedValue(new Error("db down"));
		await initEnterpriseBackupCronJobs();

		await expectGuarded(callbackOf("enterprise-check"), "enterprise-check");
	});

	it("a volume backup", async () => {
		mocks.findVolumeBackupById
			.mockResolvedValueOnce({ cronExpression: "* * * * *" })
			.mockRejectedValueOnce(new Error("row is gone"));
		await scheduleVolumeBackup("vol-1");

		await expectGuarded(callbackOf("vol-1"), "vol-1");
	});
});

describe("every scheduled callback is guarded", () => {
	it("leaves no async callback given straight to scheduleJob", async () => {
		const root = path.resolve(__dirname, "../../../..");
		const offenders: string[] = [];
		for (const dir of ["packages/server/src", "apps/dokploy/server"]) {
			const files = await readdir(path.join(root, dir), { recursive: true });
			for (const file of files) {
				if (!/\.ts$/.test(file)) continue;
				const text = await readFile(path.join(root, dir, file), "utf8");
				// node-schedule's scheduleJob, called with an async arrow as its callback
				if (!text.includes('from "node-schedule"')) continue;
				if (/scheduleJob\(\s*[^,()]+,\s*[^,()]+,\s*async\s*\(/.test(text)) {
					offenders.push(path.join(dir, file));
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});

// Vitest runs on Node (the tests above); the panel's server runs on Bun, so the
// same scenario runs in a Bun process, with real node-schedule timers.
describe("scheduled job under Bun", () => {
	it("a guarded failing run raises no unhandled rejection, an unguarded one does", async () => {
		const fixture = path.join(__dirname, "scheduled-job-check.ts");
		const { stdout } = await promisify(execFile)("bun", [fixture], {
			timeout: 30_000,
			cwd: path.resolve(__dirname, ".."),
		});
		const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");

		expect(result.runtime).toBe("bun");
		expect(result.calls).toEqual({ guarded: 1, unguarded: 1 });
		expect(result.rejections).toEqual(["backup stage failed"]);
	}, 40_000);
});

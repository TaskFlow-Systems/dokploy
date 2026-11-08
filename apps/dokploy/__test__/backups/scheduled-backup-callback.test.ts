import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	scheduleJob: vi.fn(),
	runPostgresBackup: vi.fn(),
	keepLatestNBackups: vi.fn(),
	loggerError: vi.fn(),
}));

vi.mock("node-schedule", () => ({
	scheduleJob: mocks.scheduleJob,
	scheduledJobs: {},
}));
vi.mock("@dokploy/server/lib/logger", () => ({
	logger: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@dokploy/server/utils/backups/postgres", () => ({
	runPostgresBackup: mocks.runPostgresBackup,
}));
vi.mock("@dokploy/server/utils/backups", () => ({
	keepLatestNBackups: mocks.keepLatestNBackups,
}));
vi.mock("@dokploy/server/utils/backups/mysql", () => ({}));
vi.mock("@dokploy/server/utils/backups/mariadb", () => ({}));
vi.mock("@dokploy/server/utils/backups/mongo", () => ({}));
vi.mock("@dokploy/server/utils/backups/libsql", () => ({}));
vi.mock("@dokploy/server/utils/backups/compose", () => ({}));
vi.mock("@dokploy/server/utils/backups/web-server", () => ({}));

import { scheduleBackup } from "@dokploy/server/utils/backups/utils";

const backup = {
	backupId: "backup-1",
	schedule: "* * * * *",
	backupType: "database",
	databaseType: "postgres",
	postgres: { serverId: null },
	postgresId: "pg-1",
	mysqlId: null,
	mariadbId: null,
	mongoId: null,
	libsqlId: null,
	composeId: null,
} as never;

describe("scheduled backup callback", () => {
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

	it("logs a failing run and leaves no unhandled rejection", async () => {
		mocks.runPostgresBackup.mockRejectedValue(
			new Error("Remote command failed with exit code 1"),
		);
		scheduleBackup(backup);
		const callback = mocks.scheduleJob.mock
			.calls[0]?.[2] as () => Promise<void>;

		await expect(callback()).resolves.toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(rejections).toEqual([]);
		expect(mocks.keepLatestNBackups).not.toHaveBeenCalled();
		expect(mocks.loggerError).toHaveBeenCalledTimes(1);
		expect(mocks.loggerError.mock.calls[0]?.[0]).toMatchObject({
			jobId: "backup-1",
			error: "Remote command failed with exit code 1",
		});
	});

	it("still applies retention after a good run", async () => {
		mocks.runPostgresBackup.mockResolvedValue(undefined);
		scheduleBackup(backup);
		const callback = mocks.scheduleJob.mock
			.calls[0]?.[2] as () => Promise<void>;

		await callback();

		expect(mocks.keepLatestNBackups).toHaveBeenCalledTimes(1);
		expect(mocks.loggerError).not.toHaveBeenCalled();
	});
});

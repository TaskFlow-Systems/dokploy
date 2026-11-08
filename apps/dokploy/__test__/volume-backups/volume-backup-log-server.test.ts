import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsyncRemote: vi.fn(),
	findDeployments: vi.fn(),
	findVolumeBackupById: vi.fn(),
	insertReturning: vi.fn(),
	mkdir: vi.fn(),
	writeFile: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => {
	const insertChain = {
		returning: mocks.insertReturning,
		values: vi.fn(() => insertChain),
	};
	return {
		db: {
			insert: vi.fn(() => insertChain),
			query: { deployments: { findMany: mocks.findDeployments } },
		},
	};
});

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: mocks.execAsyncRemote,
	ExecError: class ExecError extends Error {},
}));

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: vi.fn(async (serverId: string) => ({ serverId })),
}));

vi.mock("@dokploy/server/services/volume-backups", () => ({
	findVolumeBackupById: mocks.findVolumeBackupById,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		promises: {
			...actual.promises,
			mkdir: mocks.mkdir,
			writeFile: mocks.writeFile,
		},
	};
});

const { createDeploymentVolumeBackup } = await import(
	"@dokploy/server/services/deployment"
);

const owners = [
	"application",
	"compose",
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"libsql",
] as const;

describe("createDeploymentVolumeBackup writes the log on the server of the service", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findDeployments.mockResolvedValue([]);
		mocks.insertReturning.mockResolvedValue([{ deploymentId: "d-1" }]);
	});

	it.each(owners)(
		"creates the log directory on the server of a %s",
		async (owner) => {
			mocks.findVolumeBackupById.mockResolvedValue({
				volumeBackupId: "vb-1",
				appName: "vb-app",
				[owner]: { serverId: "srv-1" },
			});

			await createDeploymentVolumeBackup({
				volumeBackupId: "vb-1",
				title: "Volume Backup",
				description: "Volume Backup",
			});

			expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
			expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
				"srv-1",
				expect.stringContaining("mkdir -p"),
			);
			expect(mocks.mkdir).not.toHaveBeenCalled();
			expect(mocks.writeFile).not.toHaveBeenCalled();
		},
	);

	it.each(owners)(
		"creates the log directory on the panel for a %s without a server",
		async (owner) => {
			mocks.findVolumeBackupById.mockResolvedValue({
				volumeBackupId: "vb-1",
				appName: "vb-app",
				[owner]: { serverId: null },
			});

			await createDeploymentVolumeBackup({
				volumeBackupId: "vb-1",
				title: "Volume Backup",
				description: "Volume Backup",
			});

			expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
			expect(mocks.mkdir).toHaveBeenCalledTimes(1);
			expect(mocks.writeFile).toHaveBeenCalledTimes(1);
		},
	);
});

import { ExecError } from "@dokploy/server/utils/process/ExecError";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	backupVolume: vi.fn(),
	createDeploymentVolumeBackup: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	findVolumeBackupById: vi.fn(),
	sendVolumeBackupNotifications: vi.fn(),
	updateDeploymentStatus: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({ db: {} }));

vi.mock("@dokploy/server/services/volume-backups", () => ({
	findVolumeBackupById: mocks.findVolumeBackupById,
}));

vi.mock("@dokploy/server/services/destination", () => ({
	findDestinationById: vi.fn(),
	findDestinationByIdForOrganization: vi.fn(async () => ({})),
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	createDeploymentVolumeBackup: mocks.createDeploymentVolumeBackup,
	updateDeploymentStatus: mocks.updateDeploymentStatus,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
	ExecError: class ExecError extends Error {},
}));

vi.mock("@dokploy/server/utils/notifications/volume-backup", () => ({
	sendVolumeBackupNotifications: mocks.sendVolumeBackupNotifications,
}));

vi.mock("@dokploy/server/utils/volume-backups/backup", () => ({
	backupVolume: mocks.backupVolume,
	getVolumeServiceAppName: vi.fn(),
	resolveVolumeBackupServerId: vi.fn(() => undefined),
}));

const { runVolumeBackup } = await import(
	"@dokploy/server/utils/volume-backups/utils"
);

describe("runVolumeBackup", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findVolumeBackupById.mockResolvedValue({
			volumeBackupId: "vb-1",
			appName: "vb-app",
			name: "data",
			volumeName: "app_data",
			serviceType: "application",
			destinationId: "dest-a",
			application: {
				serverId: null,
				environment: { project: { name: "p", organizationId: "org-a" } },
			},
		});
		mocks.createDeploymentVolumeBackup.mockResolvedValue({
			deploymentId: "d-1",
			logPath: "/tmp/vb.log",
		});
	});

	it("marks the deployment, notifies and then rethrows a failed run", async () => {
		mocks.backupVolume.mockResolvedValue("true");
		mocks.execAsync.mockRejectedValueOnce(new Error("NoSuchBucket"));

		await expect(runVolumeBackup("vb-1")).rejects.toThrow("NoSuchBucket");

		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("d-1", "error");
		expect(mocks.sendVolumeBackupNotifications).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "error",
				errorMessage: "NoSuchBucket",
			}),
		);
	});

	it("still reports the failure when removing the partial archive fails", async () => {
		mocks.backupVolume.mockResolvedValue("true");
		mocks.execAsync
			.mockRejectedValueOnce(new Error("NoSuchBucket"))
			.mockRejectedValueOnce(new Error("cleanup failed"));

		await expect(runVolumeBackup("vb-1")).rejects.toThrow("NoSuchBucket");

		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("d-1", "error");
		expect(mocks.sendVolumeBackupNotifications).toHaveBeenCalledTimes(1);
	});

	it("finishes the status update and the run while the notification hangs", async () => {
		mocks.backupVolume.mockResolvedValue("true");
		mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.sendVolumeBackupNotifications.mockReturnValue(new Promise(() => {}));

		await runVolumeBackup("vb-1");

		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("d-1", "done");
		expect(mocks.sendVolumeBackupNotifications).toHaveBeenCalledTimes(1);
	});

	it("does not throw when the run succeeds", async () => {
		mocks.backupVolume.mockResolvedValue("true");
		mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });

		await expect(runVolumeBackup("vb-1")).resolves.toBeUndefined();
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("d-1", "done");
	});

	it("sends the redacted stderr tail in the failure notification", async () => {
		mocks.backupVolume.mockResolvedValue("true");
		mocks.execAsync.mockRejectedValueOnce(
			new ExecError(
				"Command execution failed: Command failed: [command omitted]",
				{
					command: "rclone --s3-secret-access-key=cmd-secret rcat x",
					stderr:
						"NoSuchBucket: status code: 404\nRCLONE_CONFIG_DOKPLOYS3_SECRET_ACCESS_KEY=err-secret",
					exitCode: 1,
				},
			),
		);

		await expect(runVolumeBackup("vb-1")).rejects.toThrow();

		const { errorMessage } =
			mocks.sendVolumeBackupNotifications.mock.calls[0]![0];
		expect(errorMessage).toContain("NoSuchBucket");
		expect(errorMessage).not.toContain("err-secret");
		expect(errorMessage).not.toContain("cmd-secret");
	});
});

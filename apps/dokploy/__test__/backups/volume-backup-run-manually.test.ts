import { ExecError } from "@dokploy/server/utils/process/ExecError";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createVolumeBackup: vi.fn(),
	findVolumeBackupById: vi.fn(),
	updateVolumeBackup: vi.fn(),
	findDestinationRow: vi.fn(),
	runVolumeBackup: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			destinations: { findFirst: mocks.findDestinationRow },
			// The fork only backs up volumes the service declares.
			mounts: {
				findMany: vi.fn(async () => [
					{ mountId: "mount-1", volumeName: "app_data" },
				]),
			},
		},
	},
}));

// Service placement has its own tests; here it must not stop the request
// before the destination check.
vi.mock("@/server/api/utils/placement-access", () => ({
	assertServicePlacementAccess: vi.fn(async () => ({})),
	assertTargetServerAccess: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
	checkServicePermissionAndAccess: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server")>()),
	IS_CLOUD: false,
	createVolumeBackup: mocks.createVolumeBackup,
	findVolumeBackupById: mocks.findVolumeBackupById,
	updateVolumeBackup: mocks.updateVolumeBackup,
	scheduleVolumeBackup: vi.fn(),
	removeVolumeBackupJob: vi.fn(),
	removeVolumeBackup: vi.fn(),
	restoreVolume: vi.fn(),
	runVolumeBackup: mocks.runVolumeBackup,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsyncRemote: vi.fn(),
	execAsyncStream: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

vi.mock("@/server/api/utils/plan-limits", () => ({
	assertVolumeBackupLimit: vi.fn(),
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
	updateJob: vi.fn(),
}));

const { volumeBackupsRouter } = await import(
	"@/server/api/routers/volume-backups"
);

const caller = volumeBackupsRouter.createCaller({
	session: { activeOrganizationId: "org-a" },
	user: { id: "user-1", email: "user@example.com", role: "owner" },
} as Parameters<typeof volumeBackupsRouter.createCaller>[0]);

describe("volumeBackups.runManually reports the outcome of the run", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findVolumeBackupById.mockResolvedValue({
			volumeBackupId: "vb-1",
			applicationId: "app-1",
			destinationId: "dest-a",
		});
	});

	it("returns normally when the run succeeds", async () => {
		mocks.runVolumeBackup.mockResolvedValue(undefined);

		await expect(caller.runManually({ volumeBackupId: "vb-1" })).resolves.toBe(
			true,
		);
	});

	it("fails the request when the run failed", async () => {
		mocks.runVolumeBackup.mockRejectedValue(new Error("NoSuchBucket"));

		await expect(
			caller.runManually({ volumeBackupId: "vb-1" }),
		).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: expect.stringContaining("NoSuchBucket"),
		});
	});

	it.each([
		[
			"local",
			{
				message: "Command execution failed: Command failed: [command omitted]",
				serverId: undefined,
			},
		],
		[
			"remote",
			{
				message: "Remote command failed with exit code 1",
				serverId: "server-1",
			},
		],
	])(
		"puts the redacted stderr tail of a failed %s run in the error",
		async (_name, { message, serverId }) => {
			mocks.runVolumeBackup.mockRejectedValue(
				new ExecError(message, {
					command: "rclone --s3-secret-access-key=cmd-secret rcat x",
					stderr:
						'NOTICE: Config file "/x/rclone.conf" not found - using defaults\nNoSuchBucket: status code: 404\nRCLONE_CONFIG_DOKPLOYS3_SECRET_ACCESS_KEY=err-secret',
					exitCode: 1,
					serverId,
				}),
			);

			const error = await caller
				.runManually({ volumeBackupId: "vb-1" })
				.catch((e) => e);

			expect(error.message).toContain(message);
			expect(error.message).toContain("NoSuchBucket");
			expect(error.message).not.toContain("Config file");
			expect(error.message).not.toContain("err-secret");
			expect(error.message).not.toContain("cmd-secret");
		},
	);
});

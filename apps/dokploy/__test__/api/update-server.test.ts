import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetDockerResourceType = vi.hoisted(() => vi.fn());
const mockStartServerUpdate = vi.hoisted(() => vi.fn());
const mockGetUpdateData = vi.hoisted(() => vi.fn());

vi.mock("@dokploy/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server")>()),
	DEFAULT_UPDATE_DATA: { latestVersion: null, updateAvailable: false },
	getDockerResourceType: mockGetDockerResourceType,
	getUpdateData: mockGetUpdateData,
	IS_CLOUD: false,
	isHostStackUpdateRunning: () => false,
	startServerUpdate: mockStartServerUpdate,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/root", () => ({
	appRouter: {},
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanAllDeploymentQueue: vi.fn(),
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
}));

const { settingsRouter } = await import("@/server/api/routers/settings");

const caller = settingsRouter.createCaller({
	session: { activeOrganizationId: "org-1" },
	user: { id: "user-1", email: "user@example.com", role: "owner" },
} as Parameters<typeof settingsRouter.createCaller>[0]);

describe("settings.updateServer", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("fails with a clear error when no dokploy docker resource exists", async () => {
		mockGetDockerResourceType.mockResolvedValue("unknown");

		await expect(caller.updateServer()).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("not running as a Docker service"),
		});

		expect(mockStartServerUpdate).not.toHaveBeenCalled();
	});

	it("fails for a standalone container where docker service update cannot run", async () => {
		mockGetDockerResourceType.mockResolvedValue("standalone");
		mockGetUpdateData.mockResolvedValue({
			latestVersion: "v9.9.9",
			updateAvailable: true,
		});

		await expect(caller.updateServer()).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("not running as a Docker service"),
		});

		expect(mockStartServerUpdate).not.toHaveBeenCalled();
	});

	it("does not report a fake success when the update command cannot run", async () => {
		mockGetDockerResourceType.mockResolvedValue("unknown");
		mockGetUpdateData.mockResolvedValue({
			latestVersion: "v9.9.9",
			updateAvailable: true,
		});

		await expect(caller.updateServer()).rejects.toBeDefined();
		expect(mockGetUpdateData).not.toHaveBeenCalled();
	});

	it("triggers the docker service update when the service exists", async () => {
		mockGetDockerResourceType.mockResolvedValue("service");
		mockGetUpdateData.mockResolvedValue({
			latestVersion: "v9.9.9",
			updateAvailable: true,
		});

		await expect(caller.updateServer()).resolves.toBe(true);

		expect(mockStartServerUpdate).toHaveBeenCalledWith(
			expect.stringContaining("docker service update"),
			"dokploy/dokploy:v9.9.9",
		);
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	killDockerBuild: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkServicePermissionAndAccess: vi.fn(async () => undefined),
}));
vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findApplicationById: mocks.findApplicationById,
	findComposeById: mocks.findComposeById,
	findLibsqlById: vi.fn(),
	findMariadbById: vi.fn(),
	findMongoById: vi.fn(),
	findMySqlById: vi.fn(),
	findPostgresById: vi.fn(),
	findRedisById: vi.fn(),
}));
vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));
vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));
vi.mock("@/server/queues/queueSetup", () => ({
	cleanQueuesByApplication: vi.fn(),
	cleanQueuesByCompose: vi.fn(),
	killDockerBuild: mocks.killDockerBuild,
	myQueue: { add: vi.fn() },
}));

const { applicationRouter } = await import("@/server/api/routers/application");
const { composeRouter } = await import("@/server/api/routers/compose");

const context = {
	session: { activeOrganizationId: "org-1" },
	user: { id: "user-1", email: "user@example.com", role: "owner" },
};

describe("killBuild", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("reaches the build server of an application that has one", async () => {
		mocks.findApplicationById.mockResolvedValue({
			applicationId: "app-1",
			appName: "web-app",
			serverId: "deploy-server",
			buildServerId: "build-server",
		});

		await applicationRouter
			.createCaller(context as never)
			.killBuild({ applicationId: "app-1" });

		expect(mocks.killDockerBuild).toHaveBeenCalledWith(
			"application",
			"build-server",
			"web-app",
		);
	});

	it("reaches the deploy server of an application without a build server", async () => {
		mocks.findApplicationById.mockResolvedValue({
			applicationId: "app-1",
			appName: "web-app",
			serverId: "deploy-server",
			buildServerId: null,
		});

		await applicationRouter
			.createCaller(context as never)
			.killBuild({ applicationId: "app-1" });

		expect(mocks.killDockerBuild).toHaveBeenCalledWith(
			"application",
			"deploy-server",
			"web-app",
		);
	});

	it("reaches the server of a compose service, which builds where it runs", async () => {
		mocks.findComposeById.mockResolvedValue({
			composeId: "compose-1",
			appName: "stack",
			serverId: "deploy-server",
		});

		await composeRouter
			.createCaller(context as never)
			.killBuild({ composeId: "compose-1" });

		expect(mocks.killDockerBuild).toHaveBeenCalledWith(
			"compose",
			"deploy-server",
			"stack",
		);
	});
});

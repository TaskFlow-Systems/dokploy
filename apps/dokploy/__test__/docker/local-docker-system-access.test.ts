import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	checkServicePermissionAndAccess: vi.fn(),
	execAsync: vi.fn(),
	getConfig: vi.fn(),
	findFirst: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock("@dokploy/server", () => ({
	execAsync: mocks.execAsync,
	getConfig: mocks.getConfig,
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: new Proxy(
			{},
			{
				get: (_target, table: string) => {
					mocks.findFirst[table] ??= vi.fn(async () => undefined);
					return { findFirst: mocks.findFirst[table] };
				},
			},
		),
	},
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));

const { assertLocalDockerContainerOrSystemAccess, isLocalSystemDockerVolume } =
	await import("@/server/api/utils/local-docker-access");

const ctx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

const serviceContainer = {
	Id: "service-container",
	Config: { Labels: { "com.docker.swarm.service.name": "web-app-1" } },
};
const panelContainer = {
	Id: "panel-container",
	Config: { Labels: { "com.docker.swarm.service.name": "dokploy-postgres" } },
};
const unlabelledContainer = { Id: "traefik-container", Config: { Labels: {} } };

describe("local Docker system containers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		for (const findFirst of Object.values(mocks.findFirst)) {
			findFirst.mockResolvedValue(undefined);
		}
		mocks.findFirst.applications ??= vi.fn();
		mocks.findFirst.applications.mockImplementation(async () => undefined);
	});

	it("checks service access for containers that belong to a service", async () => {
		mocks.getConfig.mockResolvedValue(serviceContainer);
		mocks.findFirst.applications?.mockResolvedValue({
			applicationId: "app-1",
			serverId: null,
		});
		const assertSystemAccess = vi.fn();

		await expect(
			assertLocalDockerContainerOrSystemAccess(
				ctx,
				"service-container",
				"read",
				assertSystemAccess,
			),
		).resolves.toBe(serviceContainer);

		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			ctx,
			"app-1",
			{ docker: ["read"] },
		);
		expect(assertSystemAccess).not.toHaveBeenCalled();
	});

	it("routes containers without a service through the system access check", async () => {
		for (const container of [panelContainer, unlabelledContainer]) {
			mocks.getConfig.mockResolvedValue(container);
			const assertSystemAccess = vi
				.fn()
				.mockRejectedValue(new Error("system access denied"));

			await expect(
				assertLocalDockerContainerOrSystemAccess(
					ctx,
					container.Id,
					"write",
					assertSystemAccess,
				),
			).rejects.toThrow("system access denied");
			expect(assertSystemAccess).toHaveBeenCalledTimes(1);

			assertSystemAccess.mockResolvedValue(undefined);
			await expect(
				assertLocalDockerContainerOrSystemAccess(
					ctx,
					container.Id,
					"write",
					assertSystemAccess,
				),
			).resolves.toBe(container);
		}
		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
	});

	it("flags volumes mounted by the panel's own containers", async () => {
		mocks.execAsync.mockResolvedValue({
			stdout: "service-container\npanel-container\n",
		});
		mocks.getConfig.mockImplementation(async (id: string) =>
			id === "panel-container" ? panelContainer : serviceContainer,
		);
		mocks.findFirst.applications?.mockResolvedValueOnce({
			applicationId: "app-1",
			serverId: null,
		});
		mocks.findFirst.applications?.mockResolvedValueOnce(undefined);

		await expect(isLocalSystemDockerVolume("dokploy-postgres")).resolves.toBe(
			true,
		);
		expect(mocks.execAsync).toHaveBeenCalledWith(
			"docker ps -a --no-trunc --filter volume\\=dokploy-postgres --format '{{.ID}}'",
		);
	});

	it("does not flag volumes used only by service containers", async () => {
		mocks.execAsync.mockResolvedValue({ stdout: "service-container\n" });
		mocks.getConfig.mockResolvedValue(serviceContainer);
		mocks.findFirst.applications?.mockResolvedValue({
			applicationId: "app-1",
			serverId: null,
		});

		await expect(isLocalSystemDockerVolume("app-data")).resolves.toBe(false);
	});

	it("rejects volume names that are not Docker identifiers", async () => {
		await expect(isLocalSystemDockerVolume("data;rm -rf /")).rejects.toThrow(
			"Invalid Docker resource identifier",
		);
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});
});

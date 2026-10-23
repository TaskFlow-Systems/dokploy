import { REDACTED_SECRET_VALUE } from "@dokploy/server/utils/security/redaction";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	checkPermission: vi.fn(),
	createRegistry: vi.fn(),
	dockerLogin: vi.fn(),
	findRegistryById: vi.fn(),
	findRegistryMany: vi.fn(),
	findRegistryRecord: vi.fn(),
	getAccessibleServerIds: vi.fn(),
	removeRegistry: vi.fn(),
	updateRegistry: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	createRegistry: mocks.createRegistry,
	dockerLogin: mocks.dockerLogin,
	findRegistryById: mocks.findRegistryById,
	getAccessibleServerIds: mocks.getAccessibleServerIds,
	removeRegistry: mocks.removeRegistry,
	updateRegistry: mocks.updateRegistry,
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			registry: {
				findFirst: mocks.findRegistryRecord,
				findMany: mocks.findRegistryMany,
			},
		},
	},
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: mocks.checkPermission,
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(),
}));

const { registryRouter } = await import("../../server/api/routers/registry");

const createCaller = () =>
	registryRouter.createCaller({
		db: {},
		req: {},
		res: {},
		session: {
			userId: "user-1",
			activeOrganizationId: "org-1",
		},
		user: {
			id: "user-1",
			role: "member",
		},
	} as never);

const dangerousPassword = "pa'$(touch /tmp/registry-pwn); echo";
// Usernames keep their case (ECR requires exactly "AWS"); the boundary
// under test is shell-escaping, not case normalization.
const dangerousUsername = "User;$(id)";
const normalizedDangerousUsername = dangerousUsername;

describe("registry router remote test login boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkPermission.mockResolvedValue(undefined);
		mocks.dockerLogin.mockResolvedValue(undefined);
		mocks.findRegistryMany.mockResolvedValue([]);
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-1"]));
	});

	it("redacts stored registry passwords from list reads", async () => {
		mocks.findRegistryMany.mockResolvedValue([
			{
				registryId: "registry-1",
				registryName: "registry",
				registryUrl: "registry.example.com",
				registryType: "cloud",
				username: "user",
				password: "registry-secret",
				organizationId: "org-1",
			},
		]);

		const [result] = await createCaller().all();

		expect(result?.password).toBe(REDACTED_SECRET_VALUE);
		expect(result?.username).toBe("user");
	});

	it("does not persist a redacted registry password placeholder on update", async () => {
		mocks.findRegistryById.mockResolvedValue({
			registryId: "registry-1",
			registryName: "registry",
			registryUrl: "registry.example.com",
			registryType: "cloud",
			username: "user",
			organizationId: "org-1",
		});
		mocks.updateRegistry.mockResolvedValue({ registryId: "registry-1" });

		await expect(
			createCaller().update({
				registryId: "registry-1",
				registryName: "registry",
				registryUrl: "registry.example.com",
				registryType: "cloud",
				username: "user",
				password: REDACTED_SECRET_VALUE,
			}),
		).resolves.toBe(true);

		expect(mocks.updateRegistry).toHaveBeenCalledWith(
			"registry-1",
			expect.not.objectContaining({
				password: REDACTED_SECRET_VALUE,
			}),
		);
	});

	it("requires registry update permission before changing stored credentials", async () => {
		mocks.checkPermission.mockImplementation(async (_ctx, permissions) => {
			if (
				JSON.stringify(permissions) === JSON.stringify({ registry: ["update"] })
			) {
				throw new TRPCError({ code: "UNAUTHORIZED" });
			}
		});

		await expect(
			createCaller().update({
				registryId: "registry-1",
				registryName: "registry",
				registryUrl: "registry.example.com",
				registryType: "cloud",
				username: "user",
				password: "new-registry-secret",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
			registry: ["update"],
		});
		expect(mocks.findRegistryById).not.toHaveBeenCalled();
		expect(mocks.updateRegistry).not.toHaveBeenCalled();
	});

	it("does not accept registry create permission as update permission", async () => {
		mocks.findRegistryById.mockResolvedValue({
			registryId: "registry-1",
			registryName: "registry",
			registryUrl: "registry.example.com",
			registryType: "cloud",
			username: "user",
			organizationId: "org-1",
		});
		mocks.updateRegistry.mockResolvedValue({ registryId: "registry-1" });

		await expect(
			createCaller().update({
				registryId: "registry-1",
				registryName: "registry",
				registryUrl: "registry.example.com",
				registryType: "cloud",
				username: "user",
				password: "new-registry-secret",
			}),
		).resolves.toBe(true);

		expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
			registry: ["update"],
		});
		expect(mocks.checkPermission).not.toHaveBeenCalledWith(expect.anything(), {
			registry: ["create"],
		});
		expect(mocks.updateRegistry).toHaveBeenCalledWith(
			"registry-1",
			expect.objectContaining({
				password: "new-registry-secret",
			}),
		);
	});

	it("tests ad-hoc remote registry credentials through the stdin docker login", async () => {
		await expect(
			createCaller().testRegistry({
				registryName: "registry",
				registryUrl: "registry.example.com",
				registryType: "cloud",
				username: dangerousUsername,
				password: dangerousPassword,
				serverId: "server-1",
			}),
		).resolves.toBe(true);

		expect(mocks.getAccessibleServerIds).toHaveBeenCalledWith({
			userId: "user-1",
			activeOrganizationId: "org-1",
		});
		expect(mocks.dockerLogin).toHaveBeenCalledWith(
			"registry.example.com",
			normalizedDangerousUsername,
			dangerousPassword,
			"server-1",
		);
	});

	it("rejects inaccessible remote ad-hoc registry tests before remote execution", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().testRegistry({
				registryName: "registry",
				registryUrl: "registry.example.com",
				registryType: "cloud",
				username: "user",
				password: dangerousPassword,
				serverId: "server-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.dockerLogin).not.toHaveBeenCalled();
	});

	it("keeps local ad-hoc registry tests on the local docker login", async () => {
		await expect(
			createCaller().testRegistry({
				registryName: "registry",
				registryUrl: "registry.example.com",
				registryType: "cloud",
				username: dangerousUsername,
				password: dangerousPassword,
				serverId: "none",
			}),
		).resolves.toBe(true);

		expect(mocks.getAccessibleServerIds).not.toHaveBeenCalled();
		expect(mocks.dockerLogin).toHaveBeenCalledWith(
			"registry.example.com",
			normalizedDangerousUsername,
			dangerousPassword,
			"none",
		);
	});

	it("redacts registry test passwords from wrapped login errors", async () => {
		mocks.dockerLogin.mockRejectedValue(
			new Error(`docker login failed for ${dangerousPassword}`),
		);

		await expect(
			createCaller().testRegistry({
				registryName: "registry",
				registryUrl: "registry.example.com",
				registryType: "cloud",
				username: "user",
				password: dangerousPassword,
				serverId: "server-1",
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "docker login failed for ***",
		});
	});

	it("tests stored remote registry credentials through the same stdin docker login", async () => {
		mocks.findRegistryRecord.mockResolvedValue({
			registryId: "registry-1",
			registryName: "registry",
			registryUrl: "registry.example.com",
			registryType: "cloud",
			username: dangerousUsername,
			password: dangerousPassword,
			organizationId: "org-1",
		});

		await expect(
			createCaller().testRegistryById({
				registryId: "registry-1",
				serverId: "server-1",
			}),
		).resolves.toBe(true);

		expect(mocks.dockerLogin).toHaveBeenCalledWith(
			"registry.example.com",
			dangerousUsername,
			dangerousPassword,
			"server-1",
		);
		expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
			server: ["execute"],
		});
	});

	it("requires server execute before loading stored credentials for remote registry tests", async () => {
		mocks.checkPermission.mockImplementation(async (_ctx, permissions) => {
			if (
				JSON.stringify(permissions) === JSON.stringify({ server: ["execute"] })
			) {
				throw new TRPCError({ code: "UNAUTHORIZED" });
			}
		});

		await expect(
			createCaller().testRegistryById({
				registryId: "registry-1",
				serverId: "server-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
			registry: ["create"],
		});
		expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
			server: ["execute"],
		});
		expect(mocks.findRegistryRecord).not.toHaveBeenCalled();
		expect(mocks.dockerLogin).not.toHaveBeenCalled();
	});

	it("does not require server execute for local stored registry tests", async () => {
		mocks.findRegistryRecord.mockResolvedValue({
			registryId: "registry-1",
			registryName: "registry",
			registryUrl: "registry.example.com",
			registryType: "cloud",
			username: dangerousUsername,
			password: dangerousPassword,
			organizationId: "org-1",
		});

		await expect(
			createCaller().testRegistryById({
				registryId: "registry-1",
				serverId: "none",
			}),
		).resolves.toBe(true);

		expect(mocks.checkPermission).not.toHaveBeenCalledWith(expect.anything(), {
			server: ["execute"],
		});
		expect(mocks.getAccessibleServerIds).not.toHaveBeenCalled();
		expect(mocks.dockerLogin).toHaveBeenCalledWith(
			"registry.example.com",
			dangerousUsername,
			dangerousPassword,
			"none",
		);
	});

	it("requires registry management permission before testing stored credentials", async () => {
		mocks.checkPermission.mockImplementation(async (_ctx, permissions) => {
			if (
				JSON.stringify(permissions) === JSON.stringify({ registry: ["create"] })
			) {
				throw new TRPCError({ code: "UNAUTHORIZED" });
			}
		});

		await expect(
			createCaller().testRegistryById({
				registryId: "registry-1",
				serverId: "server-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
			registry: ["create"],
		});
		expect(mocks.findRegistryRecord).not.toHaveBeenCalled();
		expect(mocks.dockerLogin).not.toHaveBeenCalled();
	});

	it("rejects inaccessible stored remote registry tests before remote execution", async () => {
		mocks.findRegistryRecord.mockResolvedValue({
			registryId: "registry-1",
			registryName: "registry",
			registryUrl: "registry.example.com",
			registryType: "cloud",
			username: "user",
			password: dangerousPassword,
			organizationId: "org-1",
		});
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().testRegistryById({
				registryId: "registry-1",
				serverId: "server-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.dockerLogin).not.toHaveBeenCalled();
	});
});

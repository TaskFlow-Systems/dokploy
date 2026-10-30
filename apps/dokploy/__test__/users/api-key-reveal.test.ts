import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	checkPermission: vi.fn(),
	findApiKeySecret: vi.fn(),
	apikeyFindFirst: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	createApiKey: vi.fn(),
	findApiKeySecret: mocks.findApiKeySecret,
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			apikey: { findFirst: mocks.apikeyFindFirst },
		},
	},
}));

vi.mock("@dokploy/server/services/permission", () => ({
	assertRoleAssignmentAllowed: vi.fn(),
	checkPermission: mocks.checkPermission,
	hasPermission: vi.fn(),
	resolvePermissions: vi.fn(),
}));

vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: vi.fn(),
}));

vi.mock("@dokploy/server/utils/url/network", () => ({
	fetchWithPublicEgress: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: mocks.audit,
}));

vi.mock("@/server/api/utils/monitoring-access", () => ({
	assertContainerMetricsServiceAccess: vi.fn(),
}));

const { userRouter } = await import("../../server/api/routers/user");

const callerFor = (session: Record<string, unknown> = {}) =>
	userRouter.createCaller({
		db: {},
		req: {},
		res: {},
		session: {
			id: "session-1",
			userId: "user-1",
			activeOrganizationId: "org-1",
			...session,
		},
		user: { id: "user-1", email: "user@example.com", role: "owner" },
	} as never);

const storedKey = {
	id: "key-1",
	name: "ci-deploy",
	referenceId: "user-1",
	metadata: JSON.stringify({ organizationId: "org-1" }),
};

describe("user.revealApiKey", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkPermission.mockResolvedValue(undefined);
		mocks.apikeyFindFirst.mockResolvedValue(storedKey);
		mocks.findApiKeySecret.mockResolvedValue("ci-deploy_secret-value");
	});

	it("returns the stored key to a browser session and audits it", async () => {
		await expect(
			callerFor().revealApiKey({ apiKeyId: "key-1" }),
		).resolves.toEqual({ key: "ci-deploy_secret-value" });
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ action: "reveal", resourceId: "key-1" }),
		);
	});

	it("refuses a session without an id", async () => {
		await expect(
			callerFor({ id: null }).revealApiKey({ apiKeyId: "key-1" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.findApiKeySecret).not.toHaveBeenCalled();
	});

	it("is never available to API key sessions", async () => {
		await expect(
			callerFor({ authMethod: "api-key" }).revealApiKey({ apiKeyId: "key-1" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.findApiKeySecret).not.toHaveBeenCalled();
	});

	it("refuses keys of other users", async () => {
		mocks.apikeyFindFirst.mockResolvedValue({
			...storedKey,
			referenceId: "user-2",
		});
		await expect(
			callerFor().revealApiKey({ apiKeyId: "key-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.findApiKeySecret).not.toHaveBeenCalled();
	});

	it("refuses keys bound to another organization", async () => {
		mocks.apikeyFindFirst.mockResolvedValue({
			...storedKey,
			metadata: JSON.stringify({ organizationId: "org-2" }),
		});
		await expect(
			callerFor().revealApiKey({ apiKeyId: "key-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("explains that keys created before the feature cannot be shown", async () => {
		mocks.findApiKeySecret.mockResolvedValue(null);
		await expect(
			callerFor().revealApiKey({ apiKeyId: "key-1" }),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: expect.stringContaining("before keys could be revealed"),
		});
		expect(mocks.audit).not.toHaveBeenCalled();
	});
});

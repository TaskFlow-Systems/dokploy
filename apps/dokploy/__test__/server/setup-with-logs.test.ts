import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	applyDockerCleanupSchedule: vi.fn(),
	assertServerDestinationAllowed: vi.fn(),
	assertSshKeyAccess: vi.fn(),
	checkPermission: vi.fn(),
	createServer: vi.fn(),
	defaultCommand: vi.fn(),
	deleteServer: vi.fn(),
	findServerById: vi.fn(),
	findServersByUserId: vi.fn(),
	findUserById: vi.fn(),
	getAccessibleServerIds: vi.fn(),
	getDokployUrl: vi.fn(),
	getPublicIpWithFallback: vi.fn(),
	getWebServerSettings: vi.fn(),
	hasValidLicense: vi.fn(),
	haveActiveServices: vi.fn(),
	removeDeploymentsByServerId: vi.fn(),
	redactServer: vi.fn((server) => server),
	resolveServerMetricsConfigUpdate: vi.fn((metricsConfig) => metricsConfig),
	serverAudit: vi.fn(),
	serverSetup: vi.fn(),
	serverValidate: vi.fn(),
	setupMonitoring: vi.fn(),
	updateServerById: vi.fn(),
	updateServersBasedOnQuantity: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	COMPONENTS_UPDATE_FAILED: "Components update failed ❌",
	UPDATABLE_COMPONENTS: [
		"docker",
		"traefik",
		"rclone",
		"nixpacks",
		"railpack",
		"buildpacks",
	],
	serverComponentsStatus: async () => [],
	updateServerComponents: async () => undefined,
	SERVER_HARDENING_FAILED: "Security hardening failed ❌",
	SERVER_HARDENING_ITEMS: ["ufw", "ssh", "fail2ban"],
	hardenServer: async () => undefined,
	IS_CLOUD: true,
	createServer: mocks.createServer,
	defaultCommand: mocks.defaultCommand,
	deleteServer: mocks.deleteServer,
	findServerById: mocks.findServerById,
	findServersByUserId: mocks.findServersByUserId,
	findUserById: mocks.findUserById,
	getAccessibleServerIds: mocks.getAccessibleServerIds,
	getDokployUrl: mocks.getDokployUrl,
	getPublicIpWithFallback: mocks.getPublicIpWithFallback,
	getWebServerSettings: mocks.getWebServerSettings,
	hasValidLicense: mocks.hasValidLicense,
	haveActiveServices: mocks.haveActiveServices,
	removeDeploymentsByServerId: mocks.removeDeploymentsByServerId,
	redactServer: mocks.redactServer,
	redactServers: vi.fn((servers) => servers.map(mocks.redactServer)),
	resolveServerMetricsConfigUpdate: mocks.resolveServerMetricsConfigUpdate,
	serverAudit: mocks.serverAudit,
	serverSetup: mocks.serverSetup,
	serverValidate: mocks.serverValidate,
	setupMonitoring: mocks.setupMonitoring,
	updateServerById: mocks.updateServerById,
}));

vi.mock("@dokploy/server/index", () => ({
	captureEvent: vi.fn(async () => undefined),
	getPostHogSessionId: vi.fn(() => undefined),
	COMPONENTS_UPDATE_FAILED: "Components update failed ❌",
	UPDATABLE_COMPONENTS: [
		"docker",
		"traefik",
		"rclone",
		"nixpacks",
		"railpack",
		"buildpacks",
	],
	serverComponentsStatus: async () => [],
	updateServerComponents: async () => undefined,
	SERVER_HARDENING_FAILED: "Security hardening failed ❌",
	SERVER_HARDENING_ITEMS: ["ufw", "ssh", "fail2ban"],
	hardenServer: async () => undefined,
	IS_CLOUD: true,
	createServer: mocks.createServer,
	defaultCommand: mocks.defaultCommand,
	deleteServer: mocks.deleteServer,
	findServerById: mocks.findServerById,
	findServersByUserId: mocks.findServersByUserId,
	findUserById: mocks.findUserById,
	getAccessibleServerIds: mocks.getAccessibleServerIds,
	getDokployUrl: mocks.getDokployUrl,
	getPublicIpWithFallback: mocks.getPublicIpWithFallback,
	getWebServerSettings: mocks.getWebServerSettings,
	hasValidLicense: mocks.hasValidLicense,
	haveActiveServices: mocks.haveActiveServices,
	removeDeploymentsByServerId: mocks.removeDeploymentsByServerId,
	redactServer: mocks.redactServer,
	redactServers: vi.fn((servers) => servers.map(mocks.redactServer)),
	resolveServerMetricsConfigUpdate: mocks.resolveServerMetricsConfigUpdate,
	serverAudit: mocks.serverAudit,
	serverSetup: mocks.serverSetup,
	serverValidate: mocks.serverValidate,
	setupMonitoring: mocks.setupMonitoring,
	updateServerById: mocks.updateServerById,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: mocks.checkPermission,
	hasPermission: vi.fn(),
	resolvePermissions: vi.fn(),
}));

vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: mocks.hasValidLicense,
}));

vi.mock("@dokploy/server/services/ssh-key", () => ({
	assertSshKeyAccess: mocks.assertSshKeyAccess,
}));

vi.mock("@dokploy/server/utils/servers/destination", () => ({
	assertServerDestinationAllowed: mocks.assertServerDestinationAllowed,
}));

vi.mock("@dokploy/server/utils/url/network", () => ({
	fetchWithPublicEgress: vi.fn(),
}));

vi.mock("@/pages/api/stripe/webhook", () => ({
	updateServersBasedOnQuantity: mocks.updateServersBasedOnQuantity,
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(),
}));

vi.mock("@/server/queues/concurrency", () => ({
	assertBuildsConcurrencyAllowed: vi.fn(),
}));

vi.mock("@/server/utils/docker-cleanup", () => ({
	applyDockerCleanupSchedule: mocks.applyDockerCleanupSchedule,
}));

const { serverRouter } = await import("../../server/api/routers/server");

const createCaller = () =>
	serverRouter.createCaller({
		db: {},
		req: {},
		res: {},
		session: {
			userId: "actor-1",
			activeOrganizationId: "org-1",
		},
		user: {
			id: "actor-1",
			email: "owner@example.com",
			role: "owner",
			ownerId: "actor-1",
			enableEnterpriseFeatures: false,
			isValidEnterpriseLicense: false,
		},
	} as never);

const subscribe = async () => {
	const observable = await createCaller().setupWithLogs({
		serverId: "server-1",
	});
	const seen = {
		logs: [] as string[],
		completed: false,
		error: undefined as Error | undefined,
	};
	observable.subscribe({
		next: (log: string) => seen.logs.push(log),
		complete: () => {
			seen.completed = true;
		},
		error: (error: Error) => {
			seen.error = error;
		},
	});
	return seen;
};

describe("server.setupWithLogs", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkPermission.mockResolvedValue(undefined);
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-1"]));
		mocks.findServerById.mockResolvedValue({
			serverId: "server-1",
			name: "primary",
			organizationId: "org-1",
		});
	});

	it("streams the setup log and completes when the setup ends", async () => {
		mocks.serverSetup.mockImplementation(
			async (_id: string, onData: (log: string) => void) => {
				onData("\nInstalling Server Dependencies: ✅\n");
				onData("\nSetup Server: ✅\n");
			},
		);

		const seen = await subscribe();
		await vi.waitFor(() => expect(seen.completed).toBe(true));

		expect(seen.logs).toEqual([
			"\nInstalling Server Dependencies: ✅\n",
			"\nSetup Server: ✅\n",
		]);
		expect(seen.error).toBeUndefined();
	});

	it("ends with an error when the setup fails", async () => {
		mocks.serverSetup.mockImplementation(
			async (_id: string, onData: (log: string) => void) => {
				onData("Error: apt failed ❌\n");
				throw new Error("apt failed");
			},
		);

		const seen = await subscribe();
		await vi.waitFor(() => expect(seen.error).toBeDefined());

		expect(seen.logs).toEqual(["Error: apt failed ❌\n"]);
		expect(seen.error).toMatchObject({ message: "apt failed" });
		expect(seen.completed).toBe(false);
	});
});

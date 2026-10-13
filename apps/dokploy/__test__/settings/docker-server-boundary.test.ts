import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	assertNoTraefikDeletion: vi.fn(),
	assertLocalHostAccess: vi.fn(),
	audit: vi.fn(),
	checkGPUStatus: vi.fn(),
	checkPermission: vi.fn(),
	checkPortInUse: vi.fn(),
	checkProtectedResourceAccess: vi.fn(),
	checkPostgresHealth: vi.fn(),
	checkRedisHealth: vi.fn(),
	checkTraefikHealth: vi.fn(),
	cleanAllDeploymentQueue: vi.fn(),
	cleanupAll: vi.fn(),
	cleanupAllBackground: vi.fn(),
	cleanupBuilders: vi.fn(),
	cleanupContainers: vi.fn(),
	cleanupImages: vi.fn(),
	cleanupSystem: vi.fn(),
	cleanupVolumes: vi.fn(),
	execAsync: vi.fn(),
	filterProtectedTraefikEntries: vi.fn(),
	findServerById: vi.fn(),
	generateOpenApiDocument: vi.fn(),
	getAccessibleServerIds: vi.fn(),
	getAgentHitsUpdateCommand: vi.fn(),
	getAgentHitsUpdateImage: vi.fn(() => "update image"),
	getOfficialUpdateCommand: vi.fn(),
	getOfficialUpdateImage: vi.fn(() => "official image"),
	getDockerDiskUsage: vi.fn(),
	getDokployImageTag: vi.fn(),
	getDokployVersionData: vi.fn(),
	getLogCleanupStatus: vi.fn(),
	getUpdateData: vi.fn(),
	getUpdateDiskSpace: vi.fn(),
	getWebServerSettings: vi.fn(),
	hasValidLicense: vi.fn(),
	isServerUpdateRunning: vi.fn(),
	parseRawConfig: vi.fn(),
	paths: vi.fn(),
	prepareEnvironmentVariables: vi.fn(),
	processLogs: vi.fn(),
	readConfig: vi.fn(),
	readConfigInPath: vi.fn(),
	readDirectory: vi.fn(),
	readEnvironmentVariables: vi.fn(),
	readMainConfig: vi.fn(),
	readMonitoringConfig: vi.fn(),
	readPorts: vi.fn(),
	recreateDirectory: vi.fn(),
	reloadDockerResource: vi.fn(),
	removeOldDokployImages: vi.fn(),
	removeJob: vi.fn(),
	schedule: vi.fn(),
	scheduleJob: vi.fn(),
	sendDockerCleanupNotifications: vi.fn(),
	setupGPUSupport: vi.fn(),
	spawnAsync: vi.fn(),
	startServerUpdate: vi.fn(),
	getServerUpdateStatus: vi.fn(),
	startLogCleanup: vi.fn(),
	stopLogCleanup: vi.fn(),
	updateLetsEncryptEmail: vi.fn(),
	updateServerById: vi.fn(),
	updateServerTraefik: vi.fn(),
	updateWebServerSettings: vi.fn(),
	writeConfig: vi.fn(),
	writeMainConfig: vi.fn(),
	writeTraefikConfigInPath: vi.fn(),
	writeTraefikSetup: vi.fn(),
}));

const redactWebServerSettings = <T>(settings: T) => settings;

vi.mock("@dokploy/server", async () => ({
	CLEANUP_CRON_JOB: "0 0 * * *",
	DEFAULT_UPDATE_DATA: {},
	dockerDiskUsageDetailLimitSchema: (await import("zod")).z.any(),
	DOKPLOY_KEEP_IMAGES_MAX: 5,
	DOKPLOY_KEEP_IMAGES_MIN: 3,
	getDokployImageKeepCount: vi.fn(),
	getDokployImages: vi.fn(),
	IS_CLOUD: false,
	HOST_STACK_COMPONENTS: ["panel", "docker", "traefik", "postgres", "redis"],
	...(await import("@dokploy/server/setup/host-stack-lock")),
	hostStackRefusals: () => [],
	isHostStackUiComponent: (component: string) =>
		component === "traefik" || component === "redis",
	readHostStackRows: vi.fn(),
	updateHostStackComponents: vi.fn(() => Promise.resolve()),
	checkGPUStatus: mocks.checkGPUStatus,
	checkPortInUse: mocks.checkPortInUse,
	checkPostgresHealth: mocks.checkPostgresHealth,
	checkRedisHealth: mocks.checkRedisHealth,
	checkTraefikHealth: mocks.checkTraefikHealth,
	cleanupAll: mocks.cleanupAll,
	cleanupAllBackground: mocks.cleanupAllBackground,
	cleanupBuilders: mocks.cleanupBuilders,
	cleanupContainers: mocks.cleanupContainers,
	cleanupImages: mocks.cleanupImages,
	cleanupSystem: mocks.cleanupSystem,
	cleanupVolumes: mocks.cleanupVolumes,
	execAsync: mocks.execAsync,
	filterProtectedTraefikEntries: mocks.filterProtectedTraefikEntries,
	findServerById: mocks.findServerById,
	getAccessibleServerIds: mocks.getAccessibleServerIds,
	getAgentHitsUpdateCommand: mocks.getAgentHitsUpdateCommand,
	getOfficialUpdateCommand: mocks.getOfficialUpdateCommand,
	getAgentHitsUpdateImage: mocks.getAgentHitsUpdateImage,
	getOfficialUpdateImage: mocks.getOfficialUpdateImage,
	getDockerDiskUsage: mocks.getDockerDiskUsage,
	getDokployImageTag: mocks.getDokployImageTag,
	getDokployVersionData: mocks.getDokployVersionData,
	getLogCleanupStatus: mocks.getLogCleanupStatus,
	getUpdateData: mocks.getUpdateData,
	getUpdateDiskSpace: mocks.getUpdateDiskSpace,
	getWebServerSettings: mocks.getWebServerSettings,
	isServerUpdateRunning: mocks.isServerUpdateRunning,
	parseRawConfig: mocks.parseRawConfig,
	paths: mocks.paths,
	prepareEnvironmentVariables: mocks.prepareEnvironmentVariables,
	processLogs: mocks.processLogs,
	readConfig: mocks.readConfig,
	readConfigInPath: mocks.readConfigInPath,
	readDirectory: mocks.readDirectory,
	readEnvironmentVariables: mocks.readEnvironmentVariables,
	readMainConfig: mocks.readMainConfig,
	readMonitoringConfig: mocks.readMonitoringConfig,
	redactWebServerSettings,
	readPorts: mocks.readPorts,
	recreateDirectory: mocks.recreateDirectory,
	reloadDockerResource: mocks.reloadDockerResource,
	removeOldDokployImages: mocks.removeOldDokployImages,
	sendDockerCleanupNotifications: mocks.sendDockerCleanupNotifications,
	setupGPUSupport: mocks.setupGPUSupport,
	spawnAsync: mocks.spawnAsync,
	startServerUpdate: mocks.startServerUpdate,
	getServerUpdateStatus: mocks.getServerUpdateStatus,
	startLogCleanup: mocks.startLogCleanup,
	stopLogCleanup: mocks.stopLogCleanup,
	updateLetsEncryptEmail: mocks.updateLetsEncryptEmail,
	updateServerById: mocks.updateServerById,
	updateServerTraefik: mocks.updateServerTraefik,
	updateWebServerSettings: mocks.updateWebServerSettings,
	writeConfig: mocks.writeConfig,
	writeMainConfig: mocks.writeMainConfig,
	writeTraefikConfigInPath: mocks.writeTraefikConfigInPath,
	writeTraefikSetup: mocks.writeTraefikSetup,
}));

vi.mock("@dokploy/server/db", () => ({
	db: {},
}));

vi.mock("@dokploy/server/services/domain-overview", () => ({
	assertNoTraefikDeletion: mocks.assertNoTraefikDeletion,
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: mocks.checkPermission,
}));

vi.mock("@dokploy/server/services/super-password", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/super-password")
	>()),
	checkProtectedResourceAccess: mocks.checkProtectedResourceAccess,
}));

vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: mocks.hasValidLicense,
}));

vi.mock("@dokploy/trpc-openapi", () => ({
	generateOpenApiDocument: mocks.generateOpenApiDocument,
}));

vi.mock("node-schedule", () => ({
	scheduledJobs: {},
	scheduleJob: mocks.scheduleJob,
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: mocks.audit,
}));

vi.mock("@/server/api/utils/local-host-access", () => ({
	assertLocalHostAccess: mocks.assertLocalHostAccess,
}));

vi.mock("@/server/queues/concurrency", () => ({
	assertBuildsConcurrencyAllowed: vi.fn(),
}));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanAllDeploymentQueue: mocks.cleanAllDeploymentQueue,
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: mocks.removeJob,
	schedule: mocks.schedule,
}));

vi.mock("../../server/api/root", () => ({
	appRouter: {},
}));

const { settingsRouter } = await import("../../server/api/routers/settings");
const { getSuperSessionDenial } = await import(
	"@dokploy/server/services/super-password"
);

const createCaller = (
	role: "owner" | "admin" | "member" = "admin",
	authMethod?: "api-key",
) =>
	settingsRouter.createCaller({
		db: {},
		req: {
			headers: {
				host: "dokploy.example.com",
				"x-forwarded-proto": "https",
			},
		},
		res: {},
		session: {
			userId: "user-1",
			activeOrganizationId: "org-1",
			...(authMethod ? { authMethod } : {}),
		},
		user: {
			id: "user-1",
			role,
		},
	} as never);

describe("settings Docker server boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkPermission.mockResolvedValue(undefined);
		mocks.hasValidLicense.mockResolvedValue(true);
		mocks.generateOpenApiDocument.mockReturnValue({
			components: {},
			info: {},
			security: [],
		});
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-1"]));
		mocks.cleanupBuilders.mockResolvedValue(undefined);
		mocks.cleanupContainers.mockResolvedValue(undefined);
		mocks.cleanupImages.mockResolvedValue(undefined);
		mocks.cleanupSystem.mockResolvedValue(undefined);
		mocks.cleanupVolumes.mockResolvedValue(undefined);
		mocks.cleanupAllBackground.mockResolvedValue({
			message: "Docker cleanup has been initiated in the background",
		});
		mocks.reloadDockerResource.mockResolvedValue(undefined);
		mocks.assertNoTraefikDeletion.mockResolvedValue(undefined);
		mocks.findServerById.mockResolvedValue({
			enableDockerCleanup: false,
			organizationId: "org-1",
			serverId: "server-1",
			serverStatus: "active",
		});
		mocks.paths.mockReturnValue({
			MAIN_TRAEFIK_PATH: "/etc/dokploy/traefik",
		});
		mocks.readConfigInPath.mockResolvedValue("http: {}");
		mocks.readDirectory.mockResolvedValue([]);
		mocks.updateServerById.mockResolvedValue({
			enableDockerCleanup: false,
			organizationId: "org-1",
			serverId: "server-1",
			serverStatus: "active",
		});
	});

	it("denies inaccessible server cleanup before Docker side effects", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().cleanUnusedImages({ serverId: "server-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.cleanupImages).not.toHaveBeenCalled();
	});

	it("denies inaccessible server reload before Docker side effects", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().reloadTraefik({ serverId: "server-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.reloadDockerResource).not.toHaveBeenCalled();
	});

	it("denies inaccessible cleanup schedule updates before server mutation", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().updateDockerCleanup({
				enableDockerCleanup: false,
				serverId: "server-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.updateServerById).not.toHaveBeenCalled();
		expect(mocks.findServerById).not.toHaveBeenCalled();
	});

	it("denies inaccessible Traefik directory listing before remote read", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().readDirectories({ serverId: "server-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.readDirectory).not.toHaveBeenCalled();
	});

	it("denies inaccessible Traefik file reads before remote read", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().readTraefikFile({
				path: `${process.cwd()}/.docker/traefik/dynamic/app.yml`,
				serverId: "server-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.readConfigInPath).not.toHaveBeenCalled();
	});

	it("denies inaccessible Traefik file updates before remote write", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().updateTraefikFile({
				path: "/etc/dokploy/traefik/dynamic/app.yml",
				traefikConfig: "http: {}",
				serverId: "server-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
	});

	it("denies inaccessible dashboard toggles before Traefik reads", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().toggleDashboard({
				enableDashboard: true,
				serverId: "server-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.readPorts).not.toHaveBeenCalled();
		expect(mocks.readEnvironmentVariables).not.toHaveBeenCalled();
		expect(mocks.checkPortInUse).not.toHaveBeenCalled();
		expect(mocks.writeTraefikSetup).not.toHaveBeenCalled();
	});

	it("denies inaccessible Traefik env writes before Traefik reads", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().writeTraefikEnv({
				env: "FOO=bar",
				serverId: "server-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.prepareEnvironmentVariables).not.toHaveBeenCalled();
		expect(mocks.readPorts).not.toHaveBeenCalled();
		expect(mocks.writeTraefikSetup).not.toHaveBeenCalled();
	});

	it("denies inaccessible GPU setup before remote setup helpers", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().setupGPU({ serverId: "server-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.setupGPUSupport).not.toHaveBeenCalled();
	});

	it("denies inaccessible GPU status reads before remote status helpers", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().checkGPUStatus({ serverId: "server-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.checkGPUStatus).not.toHaveBeenCalled();
	});

	it("denies inaccessible Traefik port writes before Traefik reads", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().updateTraefikPorts({
				additionalPorts: [
					{
						protocol: "tcp",
						publishedPort: 8443,
						targetPort: 8443,
					},
				],
				serverId: "server-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.readEnvironmentVariables).not.toHaveBeenCalled();
		expect(mocks.checkPortInUse).not.toHaveBeenCalled();
		expect(mocks.writeTraefikSetup).not.toHaveBeenCalled();
	});

	it("rejects a Traefik port that publishes host port 80 before Traefik is rewritten", async () => {
		await expect(
			createCaller().updateTraefikPorts({
				additionalPorts: [
					{ protocol: "tcp", publishedPort: 80, targetPort: 8081 },
				],
				serverId: "server-1",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(mocks.checkPortInUse).not.toHaveBeenCalled();
		expect(mocks.writeTraefikSetup).not.toHaveBeenCalled();
	});

	it("denies inaccessible Traefik port reads before Traefik reads", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().getTraefikPorts({ serverId: "server-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.readPorts).not.toHaveBeenCalled();
	});

	it("allows accessible server cleanup", async () => {
		await expect(
			createCaller().cleanAll({ serverId: "server-1" }),
		).resolves.toEqual({
			message: "Docker cleanup has been initiated in the background",
		});

		expect(mocks.cleanupAllBackground).toHaveBeenCalledWith("server-1");
	});

	it("frees disk space for an update without touching the build cache", async () => {
		const space = { availableBytes: 1, oldImageCount: 0 };
		mocks.isServerUpdateRunning.mockReturnValue(false);
		mocks.getUpdateDiskSpace.mockResolvedValue(space);

		await expect(
			createCaller().freeUpdateDiskSpace({ buildCache: false }),
		).resolves.toEqual(space);

		expect(mocks.removeOldDokployImages).toHaveBeenCalledTimes(1);
		expect(mocks.cleanupBuilders).not.toHaveBeenCalled();
	});

	it("clears the build cache only when asked", async () => {
		mocks.isServerUpdateRunning.mockReturnValue(false);

		await createCaller().freeUpdateDiskSpace({ buildCache: true });

		expect(mocks.removeOldDokployImages).toHaveBeenCalledTimes(1);
		expect(mocks.cleanupBuilders).toHaveBeenCalledWith();
	});

	it("does not free disk space while an update runs", async () => {
		mocks.isServerUpdateRunning.mockReturnValue(true);

		await expect(
			createCaller().freeUpdateDiskSpace({ buildCache: true }),
		).rejects.toMatchObject({ code: "CONFLICT" });

		expect(mocks.removeOldDokployImages).not.toHaveBeenCalled();
		expect(mocks.cleanupBuilders).not.toHaveBeenCalled();
	});

	it("updates AgentHits installs through the AgentHits update command", async () => {
		mocks.getUpdateData.mockResolvedValue({
			latestVersion: "off_v0.29.8/Fork_159+next",
			updateAvailable: true,
			updateSource: "agenthits",
			latestOfficialVersion: "v0.30.0",
		});
		mocks.getAgentHitsUpdateCommand.mockReturnValue("agenthits update command");

		await expect(createCaller().updateServer()).resolves.toBe(true);

		expect(mocks.getAgentHitsUpdateCommand).toHaveBeenCalledWith(
			"v0.30.6",
			"off_v0.29.8/Fork_159+next",
			"v0.30.0",
			undefined,
		);
		expect(mocks.startServerUpdate).toHaveBeenCalledWith(
			"agenthits update command",
			"update image",
		);
	});

	it("passes the image keep count to the AgentHits update command", async () => {
		mocks.getUpdateData.mockResolvedValue({
			latestVersion: "off_v0.29.8/Fork_159+next",
			updateAvailable: true,
			updateSource: "agenthits",
			latestOfficialVersion: "v0.30.0",
		});
		mocks.getAgentHitsUpdateCommand.mockReturnValue("agenthits update command");

		await expect(createCaller().updateServer({ keepImages: 4 })).resolves.toBe(
			true,
		);

		expect(mocks.getAgentHitsUpdateCommand).toHaveBeenCalledWith(
			"v0.30.6",
			"off_v0.29.8/Fork_159+next",
			"v0.30.0",
			4,
		);
	});

	it("rejects image keep counts outside 3 to 5", async () => {
		await expect(
			createCaller().updateServer({ keepImages: 2 }),
		).rejects.toThrow();
		await expect(
			createCaller().updateServer({ keepImages: 10 }),
		).rejects.toThrow();
		expect(mocks.startServerUpdate).not.toHaveBeenCalled();
	});

	it("keeps official updates on the official Dokploy image path", async () => {
		mocks.getUpdateData.mockResolvedValue({
			latestVersion: "v0.30.0",
			updateAvailable: true,
			updateSource: "official",
		});

		mocks.getOfficialUpdateCommand.mockReturnValue("official update command");

		await expect(createCaller().updateServer()).resolves.toBe(true);

		expect(mocks.getOfficialUpdateCommand).toHaveBeenCalledWith(
			"v0.30.0",
			undefined,
		);
		expect(mocks.startServerUpdate).toHaveBeenCalledWith(
			"official update command",
			"official image",
		);
		expect(mocks.getAgentHitsUpdateCommand).not.toHaveBeenCalled();
	});

	it("turns the image cleanup off on official updates", async () => {
		mocks.getUpdateData.mockResolvedValue({
			latestVersion: "v0.30.0",
			updateAvailable: true,
			updateSource: "official",
		});

		await expect(
			createCaller().updateServer({ keepImages: null }),
		).resolves.toBe(true);

		expect(mocks.getOfficialUpdateCommand).toHaveBeenCalledWith(
			"v0.30.0",
			null,
		);
	});

	it("does not start an update when none is available", async () => {
		mocks.getUpdateData.mockResolvedValue({
			latestVersion: null,
			updateAvailable: false,
			updateSource: "official",
		});

		await expect(createCaller().updateServer()).resolves.toBe(true);

		expect(mocks.startServerUpdate).not.toHaveBeenCalled();
	});

	it("returns the web server update status", async () => {
		const status = {
			phase: "pulling",
			startedAt: 1,
			pulledAt: null,
			finishedAt: null,
			error: null,
			layersTotal: 3,
			layersDownloaded: 1,
			layersExtracted: 0,
			diskFull: false,
			output: [],
		};
		mocks.getServerUpdateStatus.mockReturnValue(status);

		await expect(createCaller().getServerUpdateStatus()).resolves.toEqual(
			status,
		);
	});

	it("requires api.read before generating the OpenAPI document", async () => {
		const result = await createCaller().getOpenApiDocument();

		expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
			api: ["read"],
		});
		expect(mocks.generateOpenApiDocument).toHaveBeenCalled();
		expect(result).toMatchObject({
			info: {
				title: "Dokploy API",
			},
			security: [{ apiKey: [] }],
		});
	});

	it("does not generate the OpenAPI document without api.read", async () => {
		mocks.checkPermission.mockRejectedValueOnce(new Error("Permission denied"));

		await expect(createCaller().getOpenApiDocument()).rejects.toThrow(
			"Permission denied",
		);

		expect(mocks.generateOpenApiDocument).not.toHaveBeenCalled();
	});

	it("denies org admins from changing instance-wide SSO policy", async () => {
		await expect(
			createCaller("admin").updateEnforceSSO({ enforceSSO: false }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.hasValidLicense).not.toHaveBeenCalled();
		expect(mocks.updateWebServerSettings).not.toHaveBeenCalled();
	});

	it("denies org admins from changing remote-only deployment policy", async () => {
		await expect(
			createCaller("admin").updateRemoteServersOnly({
				remoteServersOnly: false,
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.hasValidLicense).not.toHaveBeenCalled();
		expect(mocks.updateWebServerSettings).not.toHaveBeenCalled();
	});

	it("allows owners with an enterprise license to change instance-wide restrictions", async () => {
		await expect(
			createCaller("owner").updateEnforceSSO({ enforceSSO: true }),
		).resolves.toBe(true);

		expect(mocks.hasValidLicense).toHaveBeenCalledWith("org-1");
		expect(mocks.updateWebServerSettings).toHaveBeenCalledWith({
			enforceSSO: true,
		});
	});

	it("allows owners with an enterprise license to change remote-only deployment policy", async () => {
		await expect(
			createCaller("owner").updateRemoteServersOnly({
				remoteServersOnly: true,
			}),
		).resolves.toBe(true);

		expect(mocks.hasValidLicense).toHaveBeenCalledWith("org-1");
		expect(mocks.updateWebServerSettings).toHaveBeenCalledWith({
			remoteServersOnly: true,
		});
	});
});

describe("settings Traefik file access", () => {
	const localTraefikPath = "/etc/dokploy/traefik";

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkPermission.mockResolvedValue(undefined);
		mocks.assertLocalHostAccess.mockResolvedValue(undefined);
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-1"]));
		mocks.paths.mockReturnValue({
			MAIN_TRAEFIK_PATH: localTraefikPath,
		});
		mocks.readConfigInPath.mockResolvedValue("http: {}");
		mocks.readDirectory.mockResolvedValue([]);
		mocks.filterProtectedTraefikEntries.mockImplementation(
			(entries: unknown[]) => entries,
		);
		mocks.checkProtectedResourceAccess.mockResolvedValue(
			"super-session-required",
		);
	});

	it("requires local host access for local Traefik files", async () => {
		mocks.assertLocalHostAccess.mockRejectedValue(
			Object.assign(new Error("Local host operations require owner or admin"), {
				code: "UNAUTHORIZED",
			}),
		);
		const caller = createCaller("member");

		await expect(caller.readDirectories({})).rejects.toThrow(
			"Local host operations require owner or admin",
		);
		await expect(
			caller.readTraefikFile({
				path: `${process.cwd()}/.docker/traefik/dynamic/app.yml`,
			}),
		).rejects.toThrow("Local host operations require owner or admin");
		await expect(
			caller.updateTraefikFile({
				path: `${localTraefikPath}/dynamic/app.yml`,
				traefikConfig: "http: {}",
			}),
		).rejects.toThrow("Local host operations require owner or admin");

		expect(mocks.assertLocalHostAccess).toHaveBeenCalledTimes(3);
		expect(mocks.readDirectory).not.toHaveBeenCalled();
		expect(mocks.readConfigInPath).not.toHaveBeenCalled();
		expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
	});

	it("hides protected entries from remote Traefik directory listings", async () => {
		const listing = [
			{ id: `${localTraefikPath}/dynamic/acme.json`, name: "acme.json" },
		];
		mocks.readDirectory.mockResolvedValue(listing);
		mocks.filterProtectedTraefikEntries.mockReturnValue([]);

		await expect(
			createCaller().readDirectories({ serverId: "server-1" }),
		).resolves.toEqual([]);

		expect(mocks.filterProtectedTraefikEntries).toHaveBeenCalledWith(
			listing,
			"server-1",
		);
		expect(mocks.assertLocalHostAccess).not.toHaveBeenCalled();
	});

	describe("TLS files behind the super session", () => {
		const acmePath = `${process.cwd()}/.docker/traefik/dynamic/acme.json`;
		const keyPath = `${process.cwd()}/.docker/traefik/dynamic/certificates/site/key.key`;

		it("denies TLS files while the super session is closed", async () => {
			const caller = createCaller("owner");

			for (const run of [
				() => caller.readTraefikFile({ path: acmePath }),
				() => caller.updateTraefikFile({ path: keyPath, traefikConfig: "x" }),
			]) {
				const error = await run().then(
					() => null,
					(caught: unknown) => caught,
				);
				expect(error).toMatchObject({ code: "FORBIDDEN" });
				expect(getSuperSessionDenial(error)).toBe("super-session-required");
			}
			expect(mocks.readConfigInPath).not.toHaveBeenCalled();
			expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
		});

		it("opens TLS files for owners and admins while the super session is open", async () => {
			mocks.checkProtectedResourceAccess.mockResolvedValue(null);
			const caller = createCaller("owner");

			await caller.readTraefikFile({ path: acmePath });
			expect(mocks.readConfigInPath).toHaveBeenCalledWith(acmePath, undefined, {
				allowProtected: true,
			});

			await caller.updateTraefikFile({ path: keyPath, traefikConfig: "x" });
			expect(mocks.writeTraefikConfigInPath).toHaveBeenCalledWith(
				keyPath,
				"x",
				undefined,
				{ allowProtected: true },
			);
			expect(mocks.checkProtectedResourceAccess).toHaveBeenCalledWith({
				userId: "user-1",
				viaApiKey: false,
			});
		});

		it("never opens TLS files through an API key", async () => {
			mocks.checkProtectedResourceAccess.mockImplementation(
				async ({ viaApiKey }: { viaApiKey: boolean }) =>
					viaApiKey ? "browser-session-required" : null,
			);

			await expect(
				createCaller("owner", "api-key").readTraefikFile({ path: acmePath }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.readConfigInPath).not.toHaveBeenCalled();
		});

		it("does not involve the super session for regular Traefik files", async () => {
			const appPath = `${process.cwd()}/.docker/traefik/dynamic/app.yml`;

			await createCaller("owner").readTraefikFile({ path: appPath });

			expect(mocks.checkProtectedResourceAccess).not.toHaveBeenCalled();
			expect(mocks.readConfigInPath).toHaveBeenCalledWith(appPath, undefined, {
				allowProtected: false,
			});
		});

		it("lists TLS files only while the super session is open", async () => {
			const listing = [{ id: acmePath, name: "acme.json" }];
			mocks.readDirectory.mockResolvedValue(listing);
			mocks.filterProtectedTraefikEntries.mockReturnValue([]);

			await expect(createCaller("owner").readDirectories({})).resolves.toEqual(
				[],
			);

			mocks.checkProtectedResourceAccess.mockResolvedValue(null);
			mocks.filterProtectedTraefikEntries.mockClear();
			await expect(createCaller("owner").readDirectories({})).resolves.toEqual(
				listing,
			);
			expect(mocks.filterProtectedTraefikEntries).not.toHaveBeenCalled();
		});
	});
});

describe("panel host update lock", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isServerUpdateRunning.mockReturnValue(false);
		mocks.getUpdateData.mockResolvedValue({
			updateAvailable: true,
			updateSource: "official",
			latestVersion: "v2.0.0",
			latestOfficialVersion: "v2.0.0",
		});
	});

	const startHostUpdate = () =>
		createCaller().updateHostStack({ components: ["redis"] });

	const runToCompletion = (
		stream: Awaited<ReturnType<typeof startHostUpdate>>,
	) =>
		new Promise<void>((resolve, reject) => {
			stream.subscribe({
				next: () => {},
				error: reject,
				complete: () => resolve(),
			});
		});

	const holdAudit = () => {
		let recorded = () => {};
		mocks.audit.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				recorded = resolve;
			}),
		);
		return () => recorded();
	};

	it("admits one host-stack update while another is still being recorded", async () => {
		const recorded = holdAudit();
		const first = startHostUpdate();
		const second = startHostUpdate();

		await expect(second).rejects.toMatchObject({ code: "CONFLICT" });
		recorded();
		await runToCompletion(await first);
		await runToCompletion(await startHostUpdate());
	});

	it("frees the lock when recording the update fails", async () => {
		mocks.audit.mockRejectedValueOnce(new Error("audit store is down"));

		await expect(startHostUpdate()).rejects.toThrow("audit store is down");
		await runToCompletion(await startHostUpdate());
	});

	it("keeps a panel update out while a host-stack update holds the lock", async () => {
		const recorded = holdAudit();
		const hostUpdate = startHostUpdate();
		await vi.waitFor(() => expect(mocks.audit).toHaveBeenCalledTimes(1));

		await expect(createCaller().updateServer()).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(mocks.startServerUpdate).not.toHaveBeenCalled();

		recorded();
		await runToCompletion(await hostUpdate);
	});

	it("starts a panel update when no host-stack update is running", async () => {
		await expect(createCaller().updateServer()).resolves.toBe(true);
		expect(mocks.startServerUpdate).toHaveBeenCalledTimes(1);
	});
});

describe("Traefik operations next to a certificate deletion", () => {
	const ports = {
		additionalPorts: [
			{ protocol: "tcp" as const, publishedPort: 8443, targetPort: 8443 },
		],
		serverId: "server-1",
	};

	const operations = [
		["reload", () => createCaller().reloadTraefik({ serverId: "server-1" })],
		[
			"dashboard toggle",
			() =>
				createCaller().toggleDashboard({
					enableDashboard: false,
					serverId: "server-1",
				}),
		],
		["port change", () => createCaller().updateTraefikPorts(ports)],
	] as const;

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkPermission.mockResolvedValue(undefined);
		mocks.hasValidLicense.mockResolvedValue(true);
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-1"]));
		mocks.reloadDockerResource.mockResolvedValue(undefined);
		mocks.assertNoTraefikDeletion.mockResolvedValue(undefined);
		mocks.readPorts.mockResolvedValue([]);
		mocks.readEnvironmentVariables.mockResolvedValue("");
		mocks.checkPortInUse.mockResolvedValue({ isInUse: false });
		mocks.writeTraefikSetup.mockResolvedValue(undefined);
	});

	it.each(operations)(
		"refuses a %s while the host reports a deletion",
		async (_name, run) => {
			mocks.assertNoTraefikDeletion.mockRejectedValue(
				Object.assign(new Error("deletion running"), { code: "CONFLICT" }),
			);

			await expect(run()).rejects.toThrow("deletion running");

			expect(mocks.reloadDockerResource).not.toHaveBeenCalled();
			expect(mocks.writeTraefikSetup).not.toHaveBeenCalled();
		},
	);

	it.each(operations)(
		"frees the lock after a refused %s",
		async (_name, run) => {
			mocks.assertNoTraefikDeletion.mockRejectedValueOnce(new Error("busy"));
			await expect(run()).rejects.toThrow("busy");

			await expect(run()).resolves.toBe(true);
		},
	);

	it.each(operations)(
		"refuses a %s while a deletion holds the in-process lock",
		async (_name, run) => {
			const { acquireTraefikOperation } = await import(
				"@dokploy/server/setup/traefik-operation-lock"
			);
			const release = acquireTraefikOperation(
				"server-1",
				"certificate deletion",
			);

			await expect(run()).rejects.toMatchObject({ code: "CONFLICT" });
			release?.();

			expect(mocks.reloadDockerResource).not.toHaveBeenCalled();
			expect(mocks.writeTraefikSetup).not.toHaveBeenCalled();
			expect(mocks.assertNoTraefikDeletion).not.toHaveBeenCalled();
		},
	);
});

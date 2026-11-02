import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	audit: vi.fn(),
	assertTargetServerAccess: vi.fn(),
	checkPermission: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	deploy: vi.fn(),
	fetchDeployApiJobs: vi.fn(),
	fetchDeployApiJobsResult: vi.fn(),
	findAllDeploymentsByApplicationId: vi.fn(),
	findAllDeploymentsByComposeId: vi.fn(),
	findAllDeploymentsByServerId: vi.fn(),
	findAllDeploymentsCentralized: vi.fn(),
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	findComposeDeploymentOperation: vi.fn(),
	findDeploymentById: vi.fn(),
	findEnvironmentById: vi.fn(),
	findLibsqlById: vi.fn(),
	findMariadbById: vi.fn(),
	findMemberByUserId: vi.fn(),
	findMongoById: vi.fn(),
	findMySqlById: vi.fn(),
	findPostgresById: vi.fn(),
	findProjectById: vi.fn(),
	findRedisById: vi.fn(),
	findScheduleById: vi.fn(),
	findServerById: vi.fn(),
	getAccessibleServerIds: vi.fn(),
	isCloud: true,
	deploymentsFindMany: vi.fn(),
	myQueueGetJobs: vi.fn(),
	myQueueAdd: vi.fn(),
	markDeploymentOperationDispatched: vi.fn(),
	removeDeployment: vi.fn(),
	resolveServicePath: vi.fn(),
	serverFindMany: vi.fn(),
	updateDeploymentStatus: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	get IS_CLOUD() {
		return mocks.isCloud;
	},
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
	findAllDeploymentsByApplicationId: mocks.findAllDeploymentsByApplicationId,
	findAllDeploymentsByComposeId: mocks.findAllDeploymentsByComposeId,
	findAllDeploymentsByServerId: mocks.findAllDeploymentsByServerId,
	findAllDeploymentsCentralized: mocks.findAllDeploymentsCentralized,
	findApplicationById: mocks.findApplicationById,
	findComposeById: mocks.findComposeById,
	findComposeDeploymentOperation: mocks.findComposeDeploymentOperation,
	findDeploymentById: mocks.findDeploymentById,
	findEnvironmentById: mocks.findEnvironmentById,
	findLibsqlById: mocks.findLibsqlById,
	findMariadbById: mocks.findMariadbById,
	findMongoById: mocks.findMongoById,
	findMySqlById: mocks.findMySqlById,
	findPostgresById: mocks.findPostgresById,
	findProjectById: mocks.findProjectById,
	findRedisById: mocks.findRedisById,
	findScheduleById: mocks.findScheduleById,
	getAccessibleServerIds: mocks.getAccessibleServerIds,
	markDeploymentOperationDispatched: mocks.markDeploymentOperationDispatched,
	removeDeployment: mocks.removeDeployment,
	resolveServicePath: mocks.resolveServicePath,
	updateDeploymentStatus: mocks.updateDeploymentStatus,
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			server: {
				findMany: mocks.serverFindMany,
			},
			deployments: {
				findMany: mocks.deploymentsFindMany,
			},
		},
	},
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: mocks.checkPermission,
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
	findMemberByUserId: mocks.findMemberByUserId,
}));

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: mocks.findServerById,
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: mocks.audit,
}));

vi.mock("@/server/api/utils/placement-access", () => ({
	assertTargetServerAccess: mocks.assertTargetServerAccess,
}));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: {
		add: mocks.myQueueAdd,
		getJobs: mocks.myQueueGetJobs,
	},
}));

vi.mock("@/server/utils/deploy", () => ({
	deploy: mocks.deploy,
	fetchDeployApiJobs: mocks.fetchDeployApiJobs,
	fetchDeployApiJobsResult: mocks.fetchDeployApiJobsResult,
}));

const { deploymentRouter } = await import(
	"../../server/api/routers/deployment"
);

const createCaller = () =>
	deploymentRouter.createCaller({
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

const panelSchedule = {
	applicationId: null,
	composeId: null,
	organizationId: "org-1",
	scheduleType: "dokploy-server",
	serverId: null,
};

describe("deployment router assigned-server boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isCloud = true;
		mocks.checkPermission.mockResolvedValue(undefined);
		mocks.assertTargetServerAccess.mockImplementation(
			async (
				ctx: { session: { activeOrganizationId: string; userId: string } },
				serverId?: string,
			) => {
				if (!serverId) {
					return;
				}

				const accessibleIds = await mocks.getAccessibleServerIds(ctx.session);
				if (!accessibleIds.has(serverId)) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this server",
					});
				}
			},
		);
		mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
		mocks.findMemberByUserId.mockResolvedValue({
			role: "member",
			accessedServices: ["app-1"],
		});
		mocks.findServerById.mockResolvedValue({
			serverId: "server-1",
			organizationId: "org-1",
		});
		mocks.findScheduleById.mockResolvedValue({
			scheduleId: "schedule-1",
			applicationId: "app-1",
			composeId: null,
			serverId: null,
		});
		mocks.deploymentsFindMany.mockResolvedValue([
			{ deploymentId: "deployment-1", rollback: null },
		]);
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-1"]));
		mocks.findAllDeploymentsByServerId.mockResolvedValue([
			{ deploymentId: "deployment-1", serverId: "server-1" },
		]);
		mocks.serverFindMany.mockResolvedValue([
			{ serverId: "server-1" },
			{ serverId: "server-2" },
		]);
		mocks.fetchDeployApiJobs.mockImplementation((serverId: string) =>
			Promise.resolve([{ id: `${serverId}-job`, serverId }]),
		);
		mocks.resolveServicePath.mockResolvedValue(undefined);
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "deployment-1",
			logPath: "/tmp/deployment.log",
			schedule: {
				serverId: "server-1",
			},
		});
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "logs" });
		mocks.findComposeById.mockResolvedValue({
			composeId: "compose-1",
			serverId: "server-1",
		});
		mocks.findComposeDeploymentOperation.mockResolvedValue({
			operationId: "operation-1",
			composeId: "compose-1",
			sourceRevision: "0123456789abcdef0123456789abcdef01234567",
			resolvedRevision: null,
			status: "accepted",
			deploymentId: null,
			deployment: null,
			createdAt: "2026-07-20T00:00:00.000Z",
			updatedAt: "2026-07-20T00:00:00.000Z",
		});
		mocks.fetchDeployApiJobsResult.mockResolvedValue({
			available: true,
			jobs: [],
		});
		mocks.deploy.mockResolvedValue({ accepted: true });
	});

	it("denies reconcile before operation lookup or queue side effects", async () => {
		mocks.checkServicePermissionAndAccess.mockRejectedValueOnce(
			new Error("permission denied"),
		);

		await expect(
			createCaller().reconcile({
				composeId: "compose-1",
				operationId: "operation-1",
				repair: true,
			}),
		).rejects.toThrow("permission denied");

		expect(mocks.findComposeDeploymentOperation).not.toHaveBeenCalled();
		expect(mocks.findComposeById).not.toHaveBeenCalled();
		expect(mocks.fetchDeployApiJobsResult).not.toHaveBeenCalled();
		expect(mocks.deploy).not.toHaveBeenCalled();
		expect(mocks.myQueueAdd).not.toHaveBeenCalled();
		expect(mocks.markDeploymentOperationDispatched).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("does not repair an unavailable queue and returns only allowlisted evidence", async () => {
		mocks.fetchDeployApiJobsResult.mockResolvedValue({
			available: false,
			reasonCode: "network-error",
			data: { secret: "queue-secret-canary" },
		});
		mocks.findComposeDeploymentOperation.mockResolvedValue({
			operationId: "operation-1",
			composeId: "compose-1",
			sourceRevision: "0123456789abcdef0123456789abcdef01234567",
			resolvedRevision: null,
			status: "accepted",
			deploymentId: null,
			deployment: null,
			createdAt: "2026-07-20T00:00:00.000Z",
			updatedAt: "2026-07-20T00:00:00.000Z",
			envRevision: "env-secret-canary",
			idempotencyKeyHash: "key-secret-canary",
		});

		const result = await createCaller().reconcile({
			composeId: "compose-1",
			operationId: "operation-1",
			repair: true,
		});

		expect(result.queue).toEqual({
			state: "queue-unavailable",
			reasonCode: "network-error",
		});
		expect(result.repairPerformed).toBe(false);
		expect(mocks.deploy).not.toHaveBeenCalled();
		expect(mocks.markDeploymentOperationDispatched).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toMatch(
			/queue-secret-canary|env-secret-canary|key-secret-canary|logPath|errorMessage|idempotencyKey|data/,
		);
	});

	it("repairs only an eligible empty queue with the same operation identity", async () => {
		const result = await createCaller().reconcile({
			composeId: "compose-1",
			operationId: "operation-1",
			repair: true,
		});

		expect(mocks.deploy).toHaveBeenCalledWith(
			expect.objectContaining({
				composeId: "compose-1",
				operationId: "operation-1",
				expectedRevision: "0123456789abcdef0123456789abcdef01234567",
			}),
		);
		expect(mocks.markDeploymentOperationDispatched).toHaveBeenCalledWith(
			"operation-1",
			"queued",
		);
		expect(result.repairPerformed).toBe(true);
		expect(result.queue).toEqual({ state: "queued" });
	});

	it("inspect mode performs no queue or durable-state writes", async () => {
		await expect(
			createCaller().reconcile({
				composeId: "compose-1",
				operationId: "operation-1",
				repair: false,
			}),
		).resolves.toMatchObject({
			repairPerformed: false,
			queue: { state: "queue-empty" },
		});

		expect(mocks.deploy).not.toHaveBeenCalled();
		expect(mocks.myQueueAdd).not.toHaveBeenCalled();
		expect(mocks.markDeploymentOperationDispatched).not.toHaveBeenCalled();
	});

	it.each(["succeeded", "failed"] as const)(
		"sqa-reconcile-01: does not repair a final %s operation",
		async (status) => {
			mocks.findComposeDeploymentOperation.mockResolvedValue({
				operationId: "operation-1",
				composeId: "compose-1",
				sourceRevision: "0123456789abcdef0123456789abcdef01234567",
				resolvedRevision: null,
				status,
				deploymentId: null,
				deployment: null,
				createdAt: "2026-07-20T00:00:00.000Z",
				updatedAt: "2026-07-20T00:00:00.000Z",
			});

			const result = await createCaller().reconcile({
				composeId: "compose-1",
				operationId: "operation-1",
				repair: true,
			});

			expect(result.repairPerformed).toBe(false);
			expect(result.queue).toEqual({ state: "queue-empty" });
			expect(mocks.deploy).not.toHaveBeenCalled();
			expect(mocks.myQueueAdd).not.toHaveBeenCalled();
			expect(mocks.markDeploymentOperationDispatched).not.toHaveBeenCalled();
		},
	);

	it("sqa-reconcile-02: does not repair a running operation", async () => {
		mocks.findComposeDeploymentOperation.mockResolvedValue({
			operationId: "operation-1",
			composeId: "compose-1",
			sourceRevision: "0123456789abcdef0123456789abcdef01234567",
			resolvedRevision: null,
			status: "running",
			deploymentId: null,
			deployment: null,
			createdAt: "2026-07-20T00:00:00.000Z",
			updatedAt: "2026-07-20T00:00:00.000Z",
		});

		const result = await createCaller().reconcile({
			composeId: "compose-1",
			operationId: "operation-1",
			repair: true,
		});

		expect(result.repairPerformed).toBe(false);
		expect(mocks.deploy).not.toHaveBeenCalled();
		expect(mocks.markDeploymentOperationDispatched).not.toHaveBeenCalled();
	});

	it("sqa-reconcile-03: does not repair an operation linked to a deployment", async () => {
		mocks.findComposeDeploymentOperation.mockResolvedValue({
			operationId: "operation-1",
			composeId: "compose-1",
			sourceRevision: "0123456789abcdef0123456789abcdef01234567",
			resolvedRevision: null,
			status: "accepted",
			deploymentId: "deployment-1",
			deployment: {
				deploymentId: "deployment-1",
				status: "running",
				startedAt: "2026-07-20T00:01:00.000Z",
				finishedAt: null,
			},
			createdAt: "2026-07-20T00:00:00.000Z",
			updatedAt: "2026-07-20T00:00:00.000Z",
		});

		const result = await createCaller().reconcile({
			composeId: "compose-1",
			operationId: "operation-1",
			repair: true,
		});

		expect(result).toMatchObject({
			repairPerformed: false,
			deployment: {
				deploymentId: "deployment-1",
				status: "running",
			},
		});
		expect(mocks.deploy).not.toHaveBeenCalled();
		expect(mocks.markDeploymentOperationDispatched).not.toHaveBeenCalled();
	});

	it("denies allByServer on inaccessible servers before deployment lookup", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().allByServer({ serverId: "server-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.findAllDeploymentsByServerId).not.toHaveBeenCalled();
	});

	it("filters cloud deployment queue jobs to accessible servers", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-1"]));

		await expect(createCaller().queueList()).resolves.toEqual([
			{ id: "server-1-job", serverId: "server-1", servicePath: undefined },
		]);

		expect(mocks.fetchDeployApiJobs).toHaveBeenCalledTimes(1);
		expect(mocks.fetchDeployApiJobs).toHaveBeenCalledWith("server-1");
	});

	it("filters self-hosted deployment queue jobs to the active organization", async () => {
		mocks.isCloud = false;
		mocks.myQueueGetJobs.mockResolvedValue([
			{
				id: "job-1",
				name: "deployments",
				data: { applicationId: "app-1", applicationType: "application" },
				timestamp: 200,
				getState: vi.fn().mockResolvedValue("waiting"),
			},
			{
				id: "job-2",
				name: "deployments",
				data: { applicationId: "foreign-app", applicationType: "application" },
				timestamp: 100,
				getState: vi.fn().mockResolvedValue("waiting"),
			},
		]);
		mocks.resolveServicePath.mockImplementation(
			(_orgId: string, data: Record<string, unknown>) =>
				Promise.resolve(
					data.applicationId === "app-1"
						? { href: "/dashboard/project/project-1", label: "Application" }
						: { href: null, label: "Application" },
				),
		);

		await expect(createCaller().queueList()).resolves.toEqual([
			{
				id: "job-1",
				name: "deployments",
				data: { applicationId: "app-1", applicationType: "application" },
				timestamp: 200,
				finishedOn: undefined,
				processedOn: undefined,
				failedReason: undefined,
				state: "waiting",
				servicePath: {
					href: "/dashboard/project/project-1",
					label: "Application",
				},
			},
		]);
	});

	it("reads service schedule deployments through service deployment permission", async () => {
		await expect(
			createCaller().allByType({ id: "schedule-1", type: "schedule" }),
		).resolves.toEqual([{ deploymentId: "deployment-1", rollback: null }]);

		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"app-1",
			{ deployment: ["read"] },
		);
		expect(mocks.checkPermission).not.toHaveBeenCalledWith(expect.anything(), {
			deployment: ["read"],
		});
	});

	it("denies unbound schedule deployments before deployment lookup", async () => {
		mocks.findScheduleById.mockResolvedValue({
			scheduleId: "schedule-1",
			applicationId: null,
			composeId: null,
			serverId: null,
		});

		await expect(
			createCaller().allByType({ id: "schedule-1", type: "schedule" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.deploymentsFindMany).not.toHaveBeenCalled();
	});

	it("checks deployment permission and target server access for server schedule deployments", async () => {
		mocks.findScheduleById.mockResolvedValue({
			scheduleId: "schedule-1",
			applicationId: null,
			composeId: null,
			serverId: "server-1",
		});
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().allByType({ id: "schedule-1", type: "schedule" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
			deployment: ["read"],
		});
		expect(mocks.assertTargetServerAccess).toHaveBeenCalledWith(
			expect.anything(),
			"server-1",
		);
		expect(mocks.deploymentsFindMany).not.toHaveBeenCalled();
	});

	it.each([
		{
			owner: "application",
			schedule: { applicationId: "app-1", composeId: null, serverId: null },
			serviceId: "app-1",
		},
		{
			owner: "compose",
			schedule: { applicationId: null, composeId: "compose-1", serverId: null },
			serviceId: "compose-1",
		},
	])(
		"reads a $owner schedule log through its owning service",
		async ({ schedule, serviceId }) => {
			mocks.isCloud = false;
			mocks.execAsync.mockResolvedValue({ stdout: "logs" });
			mocks.findDeploymentById.mockResolvedValue({
				deploymentId: "deployment-1",
				logPath: "/tmp/deployment.log",
				scheduleId: "schedule-1",
				schedule,
			});

			await expect(
				createCaller().readLogs({ deploymentId: "deployment-1", tail: 100 }),
			).resolves.toBe("logs");

			expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
				expect.anything(),
				serviceId,
				{ deployment: ["read"] },
			);
			expect(mocks.checkPermission).not.toHaveBeenCalled();
		},
	);

	it("does not read a schedule log when access to the owning service is denied", async () => {
		mocks.isCloud = false;
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "deployment-1",
			logPath: "/tmp/deployment.log",
			scheduleId: "schedule-1",
			schedule: { applicationId: "app-1", composeId: null, serverId: null },
		});
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new Error("service denied"),
		);

		await expect(
			createCaller().readLogs({ deploymentId: "deployment-1", tail: 100 }),
		).rejects.toThrow("service denied");

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it.each(["owner", "admin"])(
		"lets an %s read a panel schedule log of the active organization",
		async (role) => {
			mocks.isCloud = false;
			mocks.execAsync.mockResolvedValue({ stdout: "logs" });
			mocks.findMemberByUserId.mockResolvedValue({ role });
			mocks.findDeploymentById.mockResolvedValue({
				deploymentId: "deployment-1",
				logPath: "/tmp/deployment.log",
				scheduleId: "schedule-1",
				schedule: panelSchedule,
			});

			await expect(
				createCaller().readLogs({ deploymentId: "deployment-1", tail: 100 }),
			).resolves.toBe("logs");

			expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
				deployment: ["read"],
			});
			expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
		},
	);

	it("keeps panel schedule logs away from a plain member", async () => {
		mocks.isCloud = false;
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "deployment-1",
			logPath: "/tmp/deployment.log",
			scheduleId: "schedule-1",
			schedule: panelSchedule,
		});

		await expect(
			createCaller().readLogs({ deploymentId: "deployment-1", tail: 100 }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("keeps a panel schedule log of another organization away from an owner", async () => {
		mocks.isCloud = false;
		mocks.findMemberByUserId.mockResolvedValue({ role: "owner" });
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "deployment-1",
			logPath: "/tmp/deployment.log",
			scheduleId: "schedule-1",
			schedule: { ...panelSchedule, organizationId: "org-2" },
		});

		await expect(
			createCaller().readLogs({ deploymentId: "deployment-1", tail: 100 }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("does not downgrade a panel schedule to a service check when it carries a service id", async () => {
		mocks.isCloud = false;
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "deployment-1",
			logPath: "/tmp/deployment.log",
			scheduleId: "schedule-1",
			schedule: { ...panelSchedule, applicationId: "app-1" },
		});

		await expect(
			createCaller().readLogs({ deploymentId: "deployment-1", tail: 100 }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("checks a server schedule by its server when it carries a service id", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "deployment-1",
			logPath: "/tmp/deployment.log",
			scheduleId: "schedule-1",
			schedule: {
				applicationId: "app-1",
				composeId: null,
				organizationId: null,
				scheduleType: "server",
				serverId: "server-1",
			},
		});

		await expect(
			createCaller().readLogs({ deploymentId: "deployment-1", tail: 100 }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("fails closed for a schedule log with no owner", async () => {
		mocks.isCloud = false;
		mocks.findMemberByUserId.mockResolvedValue({ role: "owner" });
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "deployment-1",
			logPath: "/tmp/deployment.log",
			scheduleId: "schedule-1",
			schedule: {
				applicationId: null,
				composeId: null,
				organizationId: "org-1",
				scheduleType: "application",
				serverId: null,
			},
		});

		await expect(
			createCaller().readLogs({ deploymentId: "deployment-1", tail: 100 }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	// killProcess runs on schedule.serverId or the panel, so a schedule bound to
	// a service on a remote server would send its remote pid to the panel host.
	it.each([
		{
			owner: "application",
			schedule: { applicationId: "app-1", composeId: null, serverId: null },
		},
		{
			owner: "compose",
			schedule: { applicationId: null, composeId: "compose-1", serverId: null },
		},
		{ owner: "panel", schedule: panelSchedule },
	])(
		"does not open cancel actions for a $owner schedule deployment",
		async ({ schedule }) => {
			mocks.isCloud = false;
			mocks.findMemberByUserId.mockResolvedValue({ role: "owner" });
			mocks.findDeploymentById.mockResolvedValue({
				deploymentId: "deployment-1",
				logPath: "/tmp/deployment.log",
				pid: "12345",
				scheduleId: "schedule-1",
				schedule,
			});

			await expect(
				createCaller().killProcess({ deploymentId: "deployment-1" }),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			await expect(
				createCaller().removeDeployment({ deploymentId: "deployment-1" }),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });

			expect(mocks.execAsync).not.toHaveBeenCalled();
			expect(mocks.removeDeployment).not.toHaveBeenCalled();
			expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
		},
	);

	it("denies schedule-backed deployment logs on inaccessible servers before remote tail", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().readLogs({
				deploymentId: "deployment-1",
				tail: 100,
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("denies server-bound deployment logs on inaccessible servers before remote tail", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "deployment-1",
			logPath: "/tmp/deployment.log",
			serverId: "server-1",
		});

		await expect(
			createCaller().readLogs({
				deploymentId: "deployment-1",
				tail: 100,
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("denies server-bound deployment cancellation on inaccessible servers before process side effects", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "deployment-1",
			pid: "1234",
			serverId: "server-1",
		});

		await expect(
			createCaller().killProcess({ deploymentId: "deployment-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
	});

	it("denies server-bound deployment removal on inaccessible servers before persistence", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "deployment-1",
			serverId: "server-1",
		});

		await expect(
			createCaller().removeDeployment({ deploymentId: "deployment-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.removeDeployment).not.toHaveBeenCalled();
	});

	it("denies backup deployment logs through the owning backup service before log reads", async () => {
		mocks.findDeploymentById.mockResolvedValue({
			backupId: "backup-1",
			backup: {
				postgresId: "postgres-1",
			},
			deploymentId: "deployment-1",
			logPath: "/tmp/deployment.log",
		});
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new Error("service denied"),
		);

		await expect(
			createCaller().readLogs({
				deploymentId: "deployment-1",
				tail: 100,
			}),
		).rejects.toThrow("service denied");

		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"postgres-1",
			{ deployment: ["read"] },
		);
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("denies volume-backup deployment cancellation through the owning service before process side effects", async () => {
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "deployment-1",
			pid: "1234",
			volumeBackupId: "volume-backup-1",
			volumeBackup: {
				applicationId: "app-1",
			},
		});
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new Error("service denied"),
		);

		await expect(
			createCaller().killProcess({ deploymentId: "deployment-1" }),
		).rejects.toThrow("service denied");

		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"app-1",
			{ deployment: ["cancel"] },
		);
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
	});

	it("denies preview deployment removal through the preview application before persistence", async () => {
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "deployment-1",
			previewDeploymentId: "preview-1",
			previewDeployment: {
				applicationId: "app-1",
			},
		});
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new Error("service denied"),
		);

		await expect(
			createCaller().removeDeployment({ deploymentId: "deployment-1" }),
		).rejects.toThrow("service denied");

		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"app-1",
			{ deployment: ["cancel"] },
		);
		expect(mocks.removeDeployment).not.toHaveBeenCalled();
	});

	it("fails closed for deployment rows with no supported owner relation", async () => {
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "deployment-1",
			logPath: "/tmp/deployment.log",
		});

		await expect(
			createCaller().readLogs({
				deploymentId: "deployment-1",
				tail: 100,
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});
});

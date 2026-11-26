import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	IS_CLOUD: false,
	ExactDeploymentFinalizationError: class ExactDeploymentFinalizationError extends Error {},
	addDomainToCompose: vi.fn(),
	clearOldDeployments: vi.fn(),
	cloneCompose: vi.fn(),
	claimDeploymentOperation: vi.fn(),
	createCommand: vi.fn(),
	createCompose: vi.fn(),
	createComposeByTemplate: vi.fn(),
	createComposeDeploymentOperation: vi.fn(),
	createDomain: vi.fn(),
	createMount: vi.fn(),
	deleteMount: vi.fn(),
	deployApplication: vi.fn(),
	deployCompose: vi.fn(),
	deployPreviewApplication: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	finalizeDeploymentOperation: vi.fn(),
	findComposeById: vi.fn(),
	findComposeDeploymentOperation: vi.fn(),
	findApplicationById: vi.fn(),
	findDomainsByComposeId: vi.fn(),
	findEnvironmentById: vi.fn(),
	findLibsqlById: vi.fn(),
	findMariadbById: vi.fn(),
	findMongoById: vi.fn(),
	findMySqlById: vi.fn(),
	findPostgresById: vi.fn(),
	findProjectById: vi.fn(),
	findRedisById: vi.fn(),
	findServerById: vi.fn(),
	getAccessibleServerIds: vi.fn(),
	getComposeContainer: vi.fn(),
	getContainerLogs: vi.fn(),
	getContainersByAppNameMatch: vi.fn(),
	getWebServerSettings: vi.fn(),
	loadServices: vi.fn(),
	markDeploymentOperationDispatched: vi.fn(),
	randomizeComposeFile: vi.fn(),
	randomizeIsolatedDeploymentComposeFile: vi.fn(),
	rebuildApplication: vi.fn(),
	rebuildCompose: vi.fn(),
	rebuildPreviewApplication: vi.fn(),
	removeCompose: vi.fn(),
	removeComposeDirectory: vi.fn(),
	removeDeploymentsByComposeId: vi.fn(),
	removeDomainById: vi.fn(),
	startCompose: vi.fn(),
	stopCompose: vi.fn(),
	updateApplicationStatus: vi.fn(),
	updateCompose: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	updatePreviewDeployment: vi.fn(),
	upsertComposeEnvironment: vi.fn(),
}));

const routerMocks = vi.hoisted(() => ({
	audit: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	deploy: vi.fn(),
	myQueueAdd: vi.fn(),
}));

const serviceDbMocks = vi.hoisted(() => {
	const composeFindFirst = vi.fn();
	const operationFindFirst = vi.fn();
	const insertReturning = vi.fn();
	const onConflictDoNothing = vi.fn(() => ({ returning: insertReturning }));
	const values = vi.fn(() => ({ onConflictDoNothing }));
	const insert = vi.fn(() => ({ values }));
	const lockForUpdate = vi.fn();
	const selectWhere = vi.fn(() => ({ for: lockForUpdate }));
	const from = vi.fn(() => ({ where: selectWhere }));
	const select = vi.fn(() => ({ from }));
	const updateWhere = vi.fn();
	const set = vi.fn(() => ({ where: updateWhere }));
	const update = vi.fn(() => ({ set }));
	const transaction = vi.fn(
		async (
			callback: (tx: {
				select: typeof select;
				update: typeof update;
			}) => unknown,
		) => callback({ select, update }),
	);
	return {
		composeFindFirst,
		insert,
		insertReturning,
		lockForUpdate,
		onConflictDoNothing,
		operationFindFirst,
		transaction,
		values,
	};
});

vi.mock("@dokploy/server", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server")>();
	mocks.createComposeDeploymentOperation.mockImplementation(
		actual.createComposeDeploymentOperation,
	);
	mocks.upsertComposeEnvironment.mockImplementation(async (input) => ({
		...(await actual.upsertComposeEnvironment(input)),
		value: Object.values(input.variables)[0],
		env: Object.entries(input.variables)
			.map(([name, value]) => `${name}=${value}`)
			.join("\n"),
	}));
	return {
		...mocks,
		get IS_CLOUD() {
			return mocks.IS_CLOUD;
		},
	};
});
vi.mock("@dokploy/server/db", () => ({
	db: {
		insert: serviceDbMocks.insert,
		query: {
			compose: { findFirst: serviceDbMocks.composeFindFirst },
			deploymentOperations: {
				findFirst: serviceDbMocks.operationFindFirst,
			},
		},
		transaction: serviceDbMocks.transaction,
	},
}));
vi.mock("@dokploy/server/services/permission", () => ({
	addNewService: vi.fn(),
	checkServiceAccess: vi.fn(),
	checkServicePermissionAndAccess: routerMocks.checkServicePermissionAndAccess,
	findMemberByUserId: vi.fn(),
}));
vi.mock("@dokploy/server/services/deployment-freeze", () => ({
	assertDeploymentNotFrozen: vi.fn(async () => null),
	deleteDeploymentFreezesForScope: vi.fn(async () => undefined),
	formatUserActorLabel: vi.fn(async () => null),
	getActiveDeploymentFreeze: vi.fn(async () => null),
	getActiveDeploymentFreezesByIds: vi.fn(async () => new Map()),
	recordSkippedDeploymentFreeze: vi.fn(async () => undefined),
	setDeploymentFreeze: vi.fn(async () => null),
}));
vi.mock("@/server/api/utils/audit", () => ({ audit: routerMocks.audit }));
vi.mock("@/server/queues/queueSetup", () => ({
	cleanQueuesByCompose: vi.fn(),
	killDockerBuild: vi.fn(),
	myQueue: { add: routerMocks.myQueueAdd },
}));
vi.mock("@/server/utils/deploy", () => ({
	cancelDeployment: vi.fn(),
	deploy: routerMocks.deploy,
}));

const { processDeploymentJob } = await import(
	"@/server/queues/deployments-queue"
);
const { deploy: deployCloudJob } = await import("../../../api/src/utils");
const { composeRouter } = await import("@/server/api/routers/compose");

const revision = "0123456789abcdef0123456789abcdef01234567";
const exactJob = {
	applicationType: "compose" as const,
	composeId: "compose-1",
	descriptionLog: "",
	expectedRevision: revision,
	operationId: "operation-1",
	server: true,
	serverId: "server-1",
	titleLog: "Exact deployment",
	type: "deploy" as const,
};

const createCaller = () =>
	composeRouter.createCaller({
		db: {},
		req: {},
		res: {},
		session: { userId: "user-1", activeOrganizationId: "organization-1" },
		user: { id: "user-1", role: "member" },
	} as never);

describe("exact deployment worker claim", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("does not execute a duplicate local or cloud delivery when claim is false", async () => {
		mocks.claimDeploymentOperation.mockResolvedValue(false);
		await processDeploymentJob({ data: exactJob } as never);
		await expect(deployCloudJob(exactJob)).resolves.toBe(true);

		expect(mocks.claimDeploymentOperation).toHaveBeenCalledTimes(2);
		expect(mocks.updateCompose).not.toHaveBeenCalled();
		expect(mocks.deployCompose).not.toHaveBeenCalled();
		expect(mocks.finalizeDeploymentOperation).not.toHaveBeenCalled();
	});

	it.each([false, undefined])(
		"p2-worker-03: claim false stops exact cloud execution when server is %s",
		async (server) => {
			mocks.claimDeploymentOperation.mockResolvedValue(false);

			await deployCloudJob({ ...exactJob, server });

			expect(mocks.deployCompose).not.toHaveBeenCalled();
			expect(mocks.finalizeDeploymentOperation).not.toHaveBeenCalled();
			expect(mocks.updateCompose).not.toHaveBeenCalled();
		},
	);

	it("finalizes and attempts compose cleanup after a claimed local failure", async () => {
		mocks.claimDeploymentOperation.mockResolvedValue(true);
		mocks.deployCompose.mockRejectedValue(new Error("pre-deploy failure"));

		await processDeploymentJob({ data: exactJob } as never);

		expect(mocks.deployCompose).toHaveBeenCalledOnce();
		expect(mocks.finalizeDeploymentOperation).toHaveBeenCalledWith(
			"operation-1",
			"failed",
		);
		expect(mocks.updateCompose).toHaveBeenCalledWith("compose-1", {
			composeStatus: "error",
		});
	});

	it("finalizes and attempts compose cleanup after a claimed cloud failure", async () => {
		mocks.claimDeploymentOperation.mockResolvedValue(true);
		mocks.deployCompose.mockRejectedValue(new Error("pre-deploy failure"));

		await expect(deployCloudJob(exactJob)).rejects.toThrow(
			"pre-deploy failure",
		);

		expect(mocks.finalizeDeploymentOperation).toHaveBeenCalledWith(
			"operation-1",
			"failed",
		);
		expect(mocks.updateCompose).toHaveBeenCalledWith("compose-1", {
			composeStatus: "error",
		});
	});

	it("p2-worker-02: finalizes an exact cloud failure when server is false", async () => {
		mocks.claimDeploymentOperation.mockResolvedValue(true);
		mocks.deployCompose.mockRejectedValue(new Error("pre-deploy failure"));

		await expect(
			deployCloudJob({ ...exactJob, server: false }),
		).rejects.toThrow("pre-deploy failure");

		expect(mocks.claimDeploymentOperation).toHaveBeenCalledOnce();
		expect(mocks.finalizeDeploymentOperation).toHaveBeenCalledWith(
			"operation-1",
			"failed",
		);
		expect(mocks.updateCompose).toHaveBeenCalledWith("compose-1", {
			composeStatus: "error",
		});
	});

	it("does not overwrite successful state after an ambiguous terminal response", async () => {
		mocks.claimDeploymentOperation.mockResolvedValue(true);
		mocks.deployCompose.mockRejectedValue(
			new mocks.ExactDeploymentFinalizationError("terminal response lost"),
		);

		await processDeploymentJob({ data: exactJob } as never);

		expect(mocks.finalizeDeploymentOperation).not.toHaveBeenCalled();
		expect(mocks.updateCompose).toHaveBeenCalledTimes(1);
		expect(mocks.updateCompose).toHaveBeenCalledOnce();
		expect(mocks.updateCompose).toHaveBeenCalledWith("compose-1", {
			composeStatus: "running",
		});
	});

	it("keeps cloud success state on an ambiguous terminal response", async () => {
		mocks.claimDeploymentOperation.mockResolvedValue(true);
		mocks.deployCompose.mockRejectedValue(
			new mocks.ExactDeploymentFinalizationError("terminal response lost"),
		);

		await expect(deployCloudJob(exactJob)).rejects.toThrow(
			"terminal response lost",
		);

		expect(mocks.finalizeDeploymentOperation).not.toHaveBeenCalled();
		expect(mocks.updateCompose).toHaveBeenCalledTimes(1);
		expect(mocks.updateCompose).toHaveBeenCalledOnce();
		expect(mocks.updateCompose).toHaveBeenCalledWith("compose-1", {
			composeStatus: "running",
		});
	});

	it.each([false, undefined])(
		"p2-worker-01 EXACT_CLOUD_EXECUTION_USES_SIGNED_SERVER_ID_NOT_SERVER_HINT: executes when server is %s",
		async (server) => {
			mocks.claimDeploymentOperation.mockResolvedValue(true);
			mocks.deployCompose.mockResolvedValue(undefined);

			await deployCloudJob({ ...exactJob, server });

			expect(mocks.deployCompose).toHaveBeenCalledOnce();
			expect(mocks.deployCompose).toHaveBeenCalledWith(
				expect.objectContaining({
					composeId: "compose-1",
					operationId: "operation-1",
					expectedRevision: revision,
				}),
			);
		},
	);

	it("p2-worker: preserves the server hint for a legacy compose job", async () => {
		await deployCloudJob({
			applicationType: "compose",
			composeId: "compose-1",
			descriptionLog: "",
			server: false,
			serverId: "server-1",
			titleLog: "Legacy deployment",
			type: "deploy",
		});

		expect(mocks.claimDeploymentOperation).not.toHaveBeenCalled();
		expect(mocks.deployCompose).not.toHaveBeenCalled();
	});
});

describe("compose recovery router authorization ordering", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		routerMocks.checkServicePermissionAndAccess.mockRejectedValue(
			new Error("permission denied"),
		);
	});

	it("denies Compose ENV upsert before lookup, write, audit, or dispatch", async () => {
		await expect(
			createCaller().env.upsert({
				composeId: "compose-1",
				variables: { A: "two" },
			}),
		).rejects.toThrow("permission denied");

		expect(mocks.upsertComposeEnvironment).not.toHaveBeenCalled();
		expect(mocks.findComposeById).not.toHaveBeenCalled();
		expect(routerMocks.audit).not.toHaveBeenCalled();
		expect(routerMocks.myQueueAdd).not.toHaveBeenCalled();
		expect(routerMocks.deploy).not.toHaveBeenCalled();
	});

	it("denies exact deploy before operation lookup, write, audit, or dispatch", async () => {
		await expect(
			createCaller().deployExact({
				composeId: "compose-1",
				expectedRevision: revision,
				idempotencyKey: "release-operation-key",
			}),
		).rejects.toThrow("permission denied");

		expect(mocks.createComposeDeploymentOperation).not.toHaveBeenCalled();
		expect(mocks.findComposeDeploymentOperation).not.toHaveBeenCalled();
		expect(mocks.findComposeById).not.toHaveBeenCalled();
		expect(mocks.markDeploymentOperationDispatched).not.toHaveBeenCalled();
		expect(routerMocks.audit).not.toHaveBeenCalled();
		expect(routerMocks.myQueueAdd).not.toHaveBeenCalled();
		expect(routerMocks.deploy).not.toHaveBeenCalled();
	});
});

describe("compose recovery authorized caller contracts", () => {
	const operation = {
		operationId: "operation-1",
		composeId: "compose-1",
		sourceRevision: revision,
		resolvedRevision: null,
		status: "accepted" as const,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.IS_CLOUD = false;
		routerMocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
		serviceDbMocks.composeFindFirst.mockResolvedValue({
			composeId: "compose-1",
			sourceType: "git",
			env: "API_TOKEN=old",
		});
		serviceDbMocks.lockForUpdate.mockResolvedValue([{ env: "API_TOKEN=old" }]);
		mocks.findComposeDeploymentOperation.mockResolvedValue(operation);
		mocks.markDeploymentOperationDispatched.mockResolvedValue(undefined);
		routerMocks.myQueueAdd.mockResolvedValue(undefined);
		routerMocks.deploy.mockResolvedValue({ accepted: true });
	});

	it("sqa-env-01: strips raw values from an authorized dry-run response", async () => {
		const result = await createCaller().env.upsert({
			composeId: "compose-1",
			variables: { API_TOKEN: "secret-canary" },
			dryRun: true,
		});

		expect(result).toMatchObject({
			composeId: "compose-1",
			changed: true,
			dryRun: true,
			variables: [{ name: "API_TOKEN", action: "updated", secret: true }],
		});
		expect(JSON.stringify(result)).not.toContain("secret-canary");
		expect(routerMocks.audit).not.toHaveBeenCalled();
		expect(routerMocks.myQueueAdd).not.toHaveBeenCalled();
		expect(routerMocks.deploy).not.toHaveBeenCalled();
	});

	it.each([
		"prefix__DOKPLOY_REDACTED_SECRET__suffix",
		"prefix[REDACTED]suffix",
	])(
		"sqa-env-02: rejects Compose placeholder %s without side effects",
		async (value) => {
			await expect(
				createCaller().env.upsert({
					composeId: "compose-1",
					variables: { API_TOKEN: value },
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });

			expect(
				routerMocks.checkServicePermissionAndAccess,
			).toHaveBeenCalledOnce();
			expect(mocks.findComposeById).not.toHaveBeenCalled();
			expect(serviceDbMocks.composeFindFirst).not.toHaveBeenCalled();
			expect(serviceDbMocks.transaction).not.toHaveBeenCalled();
			expect(routerMocks.audit).not.toHaveBeenCalled();
			expect(routerMocks.myQueueAdd).not.toHaveBeenCalled();
			expect(routerMocks.deploy).not.toHaveBeenCalled();
		},
	);

	it.each(["main", "A".repeat(40), "a".repeat(39), "a".repeat(41)])(
		"sqa-deploy-01: rejects invalid exact revision %s before side effects",
		async (expectedRevision) => {
			await expect(
				createCaller().deployExact({
					composeId: "compose-1",
					expectedRevision,
					idempotencyKey: "release-operation-key",
				}),
			).rejects.toBeDefined();

			expect(
				routerMocks.checkServicePermissionAndAccess,
			).not.toHaveBeenCalled();
			expect(mocks.createComposeDeploymentOperation).not.toHaveBeenCalled();
			expect(routerMocks.audit).not.toHaveBeenCalled();
			expect(routerMocks.myQueueAdd).not.toHaveBeenCalled();
			expect(routerMocks.deploy).not.toHaveBeenCalled();
			expect(mocks.markDeploymentOperationDispatched).not.toHaveBeenCalled();
		},
	);

	it("sqa-deploy-02: rejects an authorized raw source without dispatch", async () => {
		serviceDbMocks.composeFindFirst.mockResolvedValue({
			composeId: "compose-1",
			sourceType: "raw",
			env: "",
		});

		await expect(
			createCaller().deployExact({
				composeId: "compose-1",
				expectedRevision: revision,
				idempotencyKey: "release-operation-key",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(routerMocks.checkServicePermissionAndAccess).toHaveBeenCalledOnce();
		expect(serviceDbMocks.insert).not.toHaveBeenCalled();
		expect(routerMocks.myQueueAdd).not.toHaveBeenCalled();
		expect(routerMocks.deploy).not.toHaveBeenCalled();
		expect(mocks.markDeploymentOperationDispatched).not.toHaveBeenCalled();
	});

	it.each([
		{ cloud: false, serverId: null },
		{ cloud: true, serverId: "server-1" },
	])(
		"sqa-deploy-03: dispatches one $cloud runtime job for a concurrent same-key replay",
		async ({ cloud, serverId }) => {
			mocks.IS_CLOUD = cloud;
			serviceDbMocks.composeFindFirst.mockResolvedValue({
				composeId: "compose-1",
				sourceType: "git",
				env: "API_TOKEN=old",
				serverId,
			});
			serviceDbMocks.insertReturning
				.mockResolvedValueOnce([operation])
				.mockResolvedValueOnce([]);
			serviceDbMocks.operationFindFirst.mockResolvedValue(operation);
			const input = {
				composeId: "compose-1",
				expectedRevision: revision,
				idempotencyKey: "release-operation-key",
			};

			const results = await Promise.all([
				createCaller().deployExact(input),
				createCaller().deployExact(input),
			]);

			expect(results.map(({ operationId }) => operationId)).toEqual([
				"operation-1",
				"operation-1",
			]);
			expect(results.map(({ deduplicated }) => deduplicated).sort()).toEqual([
				false,
				true,
			]);
			expect(routerMocks.myQueueAdd).toHaveBeenCalledTimes(cloud ? 0 : 1);
			expect(routerMocks.deploy).toHaveBeenCalledTimes(cloud ? 1 : 0);
			expect(serviceDbMocks.insert).toHaveBeenCalledTimes(2);
			expect(serviceDbMocks.operationFindFirst).toHaveBeenCalledOnce();
			expect(mocks.markDeploymentOperationDispatched).toHaveBeenCalledOnce();
		},
	);

	it.each([
		{ cloud: false, serverId: null },
		{ cloud: true, serverId: "server-1" },
	])(
		"sqa-deploy-04: does not redispatch a same-key mismatched revision in $cloud runtime",
		async ({ cloud, serverId }) => {
			mocks.IS_CLOUD = cloud;
			serviceDbMocks.composeFindFirst.mockResolvedValue({
				composeId: "compose-1",
				sourceType: "git",
				env: "API_TOKEN=old",
				serverId,
			});
			serviceDbMocks.insertReturning
				.mockResolvedValueOnce([operation])
				.mockResolvedValueOnce([]);
			serviceDbMocks.operationFindFirst.mockResolvedValue(operation);
			await createCaller().deployExact({
				composeId: "compose-1",
				expectedRevision: revision,
				idempotencyKey: "release-operation-key",
			});

			await expect(
				createCaller().deployExact({
					composeId: "compose-1",
					expectedRevision: "f".repeat(40),
					idempotencyKey: "release-operation-key",
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });

			expect(routerMocks.myQueueAdd).toHaveBeenCalledTimes(cloud ? 0 : 1);
			expect(routerMocks.deploy).toHaveBeenCalledTimes(cloud ? 1 : 0);
			expect(serviceDbMocks.insert).toHaveBeenCalledTimes(2);
			expect(serviceDbMocks.operationFindFirst).toHaveBeenCalledOnce();
			expect(mocks.markDeploymentOperationDispatched).toHaveBeenCalledOnce();
		},
	);

	it("p2-replay-01 DURABLE_REPLAY_PRECEDES_CURRENT_SOURCE_ELIGIBILITY: returns an existing operation after source changes to raw", async () => {
		serviceDbMocks.composeFindFirst.mockResolvedValue({
			composeId: "compose-1",
			sourceType: "raw",
			env: "",
		});
		serviceDbMocks.operationFindFirst.mockResolvedValue(operation);

		const result = await createCaller().deployExact({
			composeId: "compose-1",
			expectedRevision: revision,
			idempotencyKey: "release-operation-key",
		});

		expect(result).toMatchObject({
			operationId: "operation-1",
			deduplicated: true,
		});
		expect(serviceDbMocks.insert).not.toHaveBeenCalled();
		expect(routerMocks.myQueueAdd).not.toHaveBeenCalled();
		expect(routerMocks.deploy).not.toHaveBeenCalled();
	});

	it("p2-replay-03: keeps revision mismatch conflict after the source changes to raw", async () => {
		serviceDbMocks.composeFindFirst.mockResolvedValue({
			composeId: "compose-1",
			sourceType: "raw",
			env: "",
		});
		serviceDbMocks.operationFindFirst.mockResolvedValue(operation);

		await expect(
			createCaller().deployExact({
				composeId: "compose-1",
				expectedRevision: "f".repeat(40),
				idempotencyKey: "release-operation-key",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });

		expect(serviceDbMocks.insert).not.toHaveBeenCalled();
		expect(routerMocks.myQueueAdd).not.toHaveBeenCalled();
		expect(routerMocks.deploy).not.toHaveBeenCalled();
	});

	it("p2-replay-02: still rejects a new exact deployment from a raw source", async () => {
		serviceDbMocks.composeFindFirst.mockResolvedValue({
			composeId: "compose-1",
			sourceType: "raw",
			env: "",
		});
		serviceDbMocks.operationFindFirst.mockResolvedValue(undefined);

		await expect(
			createCaller().deployExact({
				composeId: "compose-1",
				expectedRevision: revision,
				idempotencyKey: "new-operation-key",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(serviceDbMocks.insert).not.toHaveBeenCalled();
	});
});

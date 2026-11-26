import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import {
	applications,
	compose,
	deploymentFreeze,
	deployments,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	redis,
	user,
} from "@dokploy/server/db/schema";
import {
	appendForcedFreezeNote,
	DEPLOY_FROZEN_CODE,
	formatDeployFrozenMessage,
	getNextFreezeExpiryTimeoutMs,
	isDeployFreezeActive,
	MAX_FREEZE_REASON_LENGTH,
	MAX_FREEZE_TIMEOUT_MS,
	sanitizeFreezeReason,
	toDeployFreezeState,
	toOverviewDeployFreeze,
} from "@dokploy/server/utils/deployments/deploy-freeze-shared";
import { TRPCError } from "@trpc/server";
import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_SHA = "0123456789abcdef0123456789abcdef01234567";
const WEBHOOK_SECRET = "test-webhook-secret-value";

const state = vi.hoisted(() => ({
	isCloud: false,
	actorUser: {
		firstName: "Alice",
		lastName: "Ops",
		email: "alice@example.com",
	} as { firstName: string; lastName: string; email: string } | null,
	singleFreeze: null as Record<string, unknown> | null,
	freezeSingleQueue: [] as Array<Array<Record<string, unknown>>>,
	freezeBatchQueue: [] as Array<Array<Record<string, unknown>>>,
	batchFreezes: [] as Array<Record<string, unknown>>,
	overviewRows: {
		application: [] as Array<Record<string, unknown>>,
		compose: [] as Array<Record<string, unknown>>,
	},
	composeEntity: {
		composeId: "compose-1",
		name: "web-stack",
		appName: "web-stack",
		sourceType: "git",
		env: "PORT=3000",
		serverId: null as string | null,
		environmentId: "env-1",
		environment: {
			environmentId: "env-1",
			projectId: "project-1",
			project: { projectId: "project-1", organizationId: "org-1" },
		},
	},
	appEntity: {
		applicationId: "app-1",
		name: "api-app",
		appName: "api-app",
		sourceType: "github",
		env: "PORT=3000",
		serverId: null as string | null,
		environmentId: "env-1",
		environment: {
			environmentId: "env-1",
			projectId: "project-1",
			project: { projectId: "project-1", organizationId: "org-1" },
		},
	},
	environmentEntity: {
		environmentId: "env-1",
		name: "production",
		projectId: "project-1",
		project: { projectId: "project-1", organizationId: "org-1" },
		applications: [
			{
				applicationId: "app-1",
				name: "api-app",
				appName: "api-app",
				env: "",
			},
			{
				applicationId: "app-2",
				name: "worker-app",
				appName: "worker-app",
				env: "",
			},
		],
		compose: [
			{
				composeId: "compose-1",
				name: "web-stack",
				appName: "web-stack",
				composeFile: "",
			},
		],
		libsql: [{ libsqlId: "db-1", name: "libsql-db" }],
		mariadb: [],
		mongo: [],
		mysql: [],
		postgres: [],
		redis: [],
	},
}));

const mocks = vi.hoisted(() => ({
	audit: vi.fn(),
	checkPermission: vi.fn(async () => true),
	checkServiceAccess: vi.fn(async () => undefined),
	checkServicePermissionAndAccess: vi.fn(async () => undefined),
	findMemberByUserId: vi.fn(),
	hasPermission: vi.fn(async () => true),
	queueAdd: vi.fn(async () => undefined),
	queueGetJobs: vi.fn(async () => []),
	cloudDeploy: vi.fn(async () => undefined),
	validateRequest: vi.fn(),
	upsertApplicationEnvironment: vi.fn(),
	updateApplication: vi.fn(async () => undefined),
	updateApplicationStatus: vi.fn(async () => undefined),
	updateCompose: vi.fn(async () => undefined),
	deployApplication: vi.fn(async () => undefined),
	deployCompose: vi.fn(async () => undefined),
	rebuildApplication: vi.fn(async () => undefined),
	rebuildCompose: vi.fn(async () => undefined),
	claimDeploymentOperation: vi.fn(async () => true),
	finalizeDeploymentOperation: vi.fn(async () => undefined),
	markDeploymentOperationDispatched: vi.fn(async () => undefined),
	findComposeDeploymentOperation: vi.fn(),
	unzipDrop: vi.fn(async () => undefined),
	createPreviewDeployment: vi.fn(
		async (): Promise<Record<string, unknown> | undefined> => undefined,
	),
	findPreviewDeploymentByApplicationId: vi.fn(async () => null),
	findPreviewDeploymentsByPullRequestIdForGithub: vi.fn(async () => []),
	shouldDeploy: vi.fn(() => true),
	webhookAppFindFirst: vi.fn(),
	webhookAppFindMany: vi.fn(
		async (): Promise<Array<Record<string, unknown>>> => [],
	),
	webhookComposeFindFirst: vi.fn(),
	webhookComposeFindMany: vi.fn(
		async (): Promise<Array<Record<string, unknown>>> => [],
	),
	githubFindFirst: vi.fn(),
	operationFindFirst: vi.fn(),
	operationInsert: vi.fn(),
	operationInsertReturning: vi.fn(),
	freezeInsertValues: vi.fn(),
	freezeUpdateSet: vi.fn(),
	skippedUpdate: vi.fn(),
	freezeDelete: vi.fn(),
	transaction: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => {
	const makeSelectFrom = (table: unknown) => {
		const isDeploymentFreeze = table === deploymentFreeze;
		const isUser = table === user;

		const resolveSingle = async () => {
			if (isDeploymentFreeze) {
				if (state.freezeSingleQueue.length > 0) {
					return state.freezeSingleQueue.shift() ?? [];
				}
				return state.singleFreeze ? [state.singleFreeze] : [];
			}
			if (isUser) {
				return state.actorUser ? [state.actorUser] : [];
			}
			return [];
		};

		const resolveBatch = async () => {
			if (isDeploymentFreeze) {
				if (state.freezeBatchQueue.length > 0) {
					return state.freezeBatchQueue.shift() ?? [];
				}
				return state.batchFreezes;
			}
			if (table === applications) {
				return state.overviewRows.application;
			}
			if (table === compose) {
				return state.overviewRows.compose;
			}
			if (
				table === deployments ||
				table === postgres ||
				table === mysql ||
				table === mariadb ||
				table === mongo ||
				table === redis ||
				table === libsql
			) {
				return [];
			}
			return [];
		};

		const limit = vi.fn(resolveSingle);
		const groupBy = vi.fn(resolveBatch);
		const where = vi.fn(() => {
			const promise = resolveBatch() as Promise<
				Array<Record<string, unknown>>
			> & {
				limit: typeof limit;
				groupBy: typeof groupBy;
			};
			promise.limit = limit;
			promise.groupBy = groupBy;
			return promise;
		});
		const builder: Record<string, unknown> = {
			where,
			limit,
			// biome-ignore lint/suspicious/noThenProperty: Drizzle query mock emulates thenable queries without .where().
			then: (
				onFulfilled?: (value: Array<Record<string, unknown>>) => unknown,
				onRejected?: (reason: unknown) => unknown,
			) => Promise.resolve([]).then(onFulfilled, onRejected),
		};
		builder.innerJoin = vi.fn(() => builder);
		builder.leftJoin = vi.fn(() => builder);
		return builder;
	};

	const select = vi.fn(() => ({
		from: vi.fn((table: unknown) => makeSelectFrom(table)),
	}));

	const insert = vi.fn((table: unknown) => ({
		values: vi.fn((val: Record<string, unknown>) => {
			if (table === deploymentFreeze) {
				mocks.freezeInsertValues(val);
				const created = {
					freezeId: "freeze-new-1",
					scopeType: val.scopeType,
					scopeId: val.scopeId,
					reason: val.reason ?? null,
					createdByUserId: val.createdByUserId ?? null,
					createdByLabel: val.createdByLabel ?? null,
					createdByAuthMethod: val.createdByAuthMethod ?? "session",
					createdAt: val.createdAt ?? "2026-06-01T12:00:00.000Z",
					expiresAt: val.expiresAt ?? null,
					liftedAt: null,
					liftedByUserId: null,
					skippedCount: val.skippedCount ?? 0,
					lastSkippedAt: null,
					lastSkippedSource: null,
				};
				return {
					returning: vi.fn(async () => [created]),
				};
			}
			mocks.operationInsert(val);
			return {
				onConflictDoNothing: vi.fn(() => ({
					returning: mocks.operationInsertReturning,
				})),
				returning: mocks.operationInsertReturning,
			};
		}),
	}));

	const update = vi.fn((table: unknown) => ({
		set: vi.fn((setVal: Record<string, unknown>) => {
			if (table === deploymentFreeze) {
				if ("skippedCount" in setVal) {
					mocks.skippedUpdate(setVal);
				} else {
					mocks.freezeUpdateSet(setVal);
				}
			}
			const where = vi.fn(() => {
				const base = state.singleFreeze
					? [{ ...state.singleFreeze, ...setVal }]
					: [];
				const promise = Promise.resolve(undefined) as Promise<undefined> & {
					returning: ReturnType<typeof vi.fn>;
				};
				promise.returning = vi.fn(async () => base);
				return promise;
			});
			return { where };
		}),
	}));

	const del = vi.fn(() => ({
		where: vi.fn(() => {
			mocks.freezeDelete();
			const promise = Promise.resolve<unknown[]>([]) as Promise<unknown[]> & {
				returning: ReturnType<typeof vi.fn>;
			};
			promise.returning = vi.fn(async () => []);
			return promise;
		}),
	}));

	const tx = { select, insert, update, delete: del };
	mocks.transaction.mockImplementation(
		async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx),
	);

	return {
		db: {
			delete: del,
			insert,
			select,
			transaction: mocks.transaction,
			update,
			query: {
				applications: {
					findFirst: mocks.webhookAppFindFirst,
					findMany: mocks.webhookAppFindMany,
				},
				compose: {
					findFirst: mocks.webhookComposeFindFirst,
					findMany: mocks.webhookComposeFindMany,
				},
				deploymentOperations: {
					findFirst: mocks.operationFindFirst,
				},
				github: {
					findFirst: mocks.githubFindFirst,
				},
			},
		},
	};
});

vi.mock("@dokploy/server/services/compose", () => ({
	findComposeById: vi.fn(async () => state.composeEntity),
	updateCompose: mocks.updateCompose,
}));

vi.mock("@dokploy/server/services/application", () => ({
	findApplicationById: vi.fn(async () => state.appEntity),
	updateApplication: mocks.updateApplication,
	updateApplicationStatus: mocks.updateApplicationStatus,
	upsertApplicationEnvironment: mocks.upsertApplicationEnvironment,
}));

vi.mock("@dokploy/server", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server")>();
	return {
		...actual,
		get IS_CLOUD() {
			return state.isCloud;
		},
		claimDeploymentOperation: mocks.claimDeploymentOperation,
		createPreviewDeployment: mocks.createPreviewDeployment,
		deployApplication: mocks.deployApplication,
		deployCompose: mocks.deployCompose,
		findApplicationById: vi.fn(async () => state.appEntity),
		findComposeById: vi.fn(async () => state.composeEntity),
		findComposeDeploymentOperation: mocks.findComposeDeploymentOperation,
		findEnvironmentById: vi.fn(async () => state.environmentEntity),
		findPreviewDeploymentByApplicationId:
			mocks.findPreviewDeploymentByApplicationId,
		findPreviewDeploymentsByPullRequestIdForGithub:
			mocks.findPreviewDeploymentsByPullRequestIdForGithub,
		finalizeDeploymentOperation: mocks.finalizeDeploymentOperation,
		getAccessibleServerIds: vi.fn(async () => []),
		getWebServerSettings: vi.fn(async () => null),
		markDeploymentOperationDispatched: mocks.markDeploymentOperationDispatched,
		rebuildApplication: mocks.rebuildApplication,
		rebuildCompose: mocks.rebuildCompose,
		shouldDeploy: mocks.shouldDeploy,
		unzipDrop: mocks.unzipDrop,
		updateApplication: mocks.updateApplication,
		updateApplicationStatus: mocks.updateApplicationStatus,
		updateCompose: mocks.updateCompose,
		upsertApplicationEnvironment: mocks.upsertApplicationEnvironment,
		validateRequest: mocks.validateRequest,
	};
});

vi.mock("@dokploy/server/services/permission", () => ({
	addNewEnvironment: vi.fn(),
	addNewService: vi.fn(),
	checkEnvironmentAccess: vi.fn(),
	checkEnvironmentCreationPermission: vi.fn(),
	checkEnvironmentDeletionPermission: vi.fn(),
	checkPermission: mocks.checkPermission,
	checkServiceAccess: mocks.checkServiceAccess,
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
	findMemberByUserId: mocks.findMemberByUserId,
	hasPermission: mocks.hasPermission,
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: mocks.audit,
}));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanQueuesByApplication: vi.fn(),
	cleanQueuesByCompose: vi.fn(),
	killDockerBuild: vi.fn(),
	myQueue: {
		add: mocks.queueAdd,
		getJobs: mocks.queueGetJobs,
	},
}));

vi.mock("@/server/utils/deploy", () => ({
	cancelDeployment: vi.fn(),
	deploy: mocks.cloudDeploy,
}));

const { composeRouter } = await import("@/server/api/routers/compose");
const { applicationRouter } = await import("@/server/api/routers/application");
const { deploymentRouter } = await import("@/server/api/routers/deployment");
const { environmentRouter } = await import("@/server/api/routers/environment");
const { handleApplicationEnvUpsert } = await import(
	"@/pages/api/application.env.upsert"
);
const { default: appRefreshWebhook } = await import(
	"@/pages/api/deploy/[refreshToken]"
);
const { default: composeRefreshWebhook } = await import(
	"@/pages/api/deploy/compose/[refreshToken]"
);
const { default: githubWebhook } = await import("@/pages/api/deploy/github");
const { processDeploymentJob } = await import(
	"@/server/queues/deployments-queue"
);
const { getAllServicesForOrganization } = await import(
	"@dokploy/server/services/overview"
);

const createSessionCtx = (authMethod: "session" | "api-key" = "session") =>
	({
		db: {},
		req: {},
		res: {},
		session: {
			id: "session-1",
			userId: "user-1",
			activeOrganizationId: "org-1",
			authMethod,
			apiKeyId: authMethod === "api-key" ? "key-1" : null,
		},
		user: {
			id: "user-1",
			ownerId: "user-1",
			role: "owner",
			email: "alice@example.com",
		},
	}) as never;

const makeFreezeRow = (overrides: Record<string, unknown> = {}) => ({
	freezeId: "freeze-1",
	scopeType: "compose",
	scopeId: "compose-1",
	reason: "Hold releases",
	createdByUserId: "user-1",
	createdByLabel: "Alice Ops",
	createdByAuthMethod: "session",
	createdAt: "2026-06-01T10:00:00.000Z",
	expiresAt: null as string | null,
	liftedAt: null as string | null,
	liftedByUserId: null as string | null,
	skippedCount: 0,
	lastSkippedAt: null as string | null,
	lastSkippedSource: null as "webhook" | "api" | "queue" | null,
	...overrides,
});

const createMockRes = () => {
	const res = {
		status: vi.fn(),
		json: vi.fn(),
		setHeader: vi.fn(),
	} as unknown as NextApiResponse & {
		status: ReturnType<typeof vi.fn>;
		json: ReturnType<typeof vi.fn>;
		setHeader: ReturnType<typeof vi.fn>;
	};
	res.status.mockReturnValue(res);
	return res;
};

const signGithub = (raw: string) =>
	`sha256=${createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex")}`;

const makeRefreshWebhookReq = (bodyObj: unknown, signature?: string) => {
	const raw = JSON.stringify(bodyObj);
	const req = Readable.from([Buffer.from(raw)]) as unknown as NextApiRequest;
	Object.assign(req, {
		method: "POST",
		query: { refreshToken: "refresh-token-1" },
		headers: {
			"content-type": "application/json",
			"x-github-event": "push",
			"x-hub-signature-256": signature ?? signGithub(raw),
		},
		body: undefined,
	});
	return req;
};

const makeGithubAppReq = (
	event: "push" | "pull_request",
	bodyObj: Record<string, unknown>,
	signature?: string,
) =>
	({
		method: "POST",
		headers: {
			"x-github-event": event,
			"x-hub-signature-256": signature ?? signGithub(JSON.stringify(bodyObj)),
		},
		body: bodyObj,
	}) as unknown as NextApiRequest;

describe("deployment freeze pure helpers", () => {
	it("evaluates active, expired, boundary, lifted, and fail-closed corrupted timestamps", () => {
		const now = new Date("2026-06-01T12:00:00.000Z");

		expect(isDeployFreezeActive(null, now)).toBe(false);
		expect(
			isDeployFreezeActive(
				{ liftedAt: "2026-06-01T11:00:00.000Z", expiresAt: null },
				now,
			),
		).toBe(false);
		expect(isDeployFreezeActive({ liftedAt: null, expiresAt: null }, now)).toBe(
			true,
		);
		expect(
			isDeployFreezeActive(
				{ liftedAt: null, expiresAt: "2026-06-01T12:00:01.000Z" },
				now,
			),
		).toBe(true);
		expect(
			isDeployFreezeActive(
				{ liftedAt: null, expiresAt: "2026-06-01T12:00:00.000Z" },
				now,
			),
		).toBe(false);
		expect(
			isDeployFreezeActive(
				{ liftedAt: null, expiresAt: "2026-06-01T11:59:59.000Z" },
				now,
			),
		).toBe(false);
		expect(
			isDeployFreezeActive({ liftedAt: null, expiresAt: "not-a-date" }, now),
		).toBe(true);
	});

	it("sanitizes control/bidi chars, trims whitespace, returns null for empty, and rejects >200 chars", () => {
		expect(sanitizeFreezeReason("   ")).toBeNull();
		expect(sanitizeFreezeReason(undefined)).toBeNull();
		expect(
			sanitizeFreezeReason("  Maintenance\u0000\nwindow\r\u202E \u2066open  "),
		).toBe("Maintenance window open");
		expect(() =>
			sanitizeFreezeReason("x".repeat(MAX_FREEZE_REASON_LENGTH + 1)),
		).toThrow();
	});

	it("computes bounded expiry timeouts, forced log notes, and messages", () => {
		const nowMs = Date.parse("2026-06-01T12:00:00.000Z");
		expect(getNextFreezeExpiryTimeoutMs(null, nowMs)).toBeNull();
		expect(getNextFreezeExpiryTimeoutMs("invalid", nowMs)).toBeNull();
		expect(
			getNextFreezeExpiryTimeoutMs("2026-06-01T11:59:50.000Z", nowMs),
		).toBe(1000);
		expect(
			getNextFreezeExpiryTimeoutMs("2026-08-01T12:00:00.000Z", nowMs),
		).toBe(MAX_FREEZE_TIMEOUT_MS);

		const stateObj = toDeployFreezeState(
			makeFreezeRow({
				expiresAt: "2026-06-01T15:00:00.000Z",
				reason: "Hotfix wait",
			}),
			{ now: new Date(nowMs) },
		);
		expect(stateObj?.active).toBe(true);
		expect(formatDeployFrozenMessage(stateObj!)).toBe(
			`${DEPLOY_FROZEN_CODE}: Deployments are frozen for this service until 2026-06-01T15:00:00.000Z (reason: Hotfix wait)`,
		);
		expect(appendForcedFreezeNote("Deploy triggered", stateObj)).toBe(
			"Deploy triggered [forced during deploy freeze until 2026-06-01T15:00:00.000Z]",
		);
		expect(appendForcedFreezeNote("Line1\nLine2", null)).toBe("Line1\nLine2");
	});
});

describe("deployment freeze router, REST, webhooks, worker, and overview integration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.isCloud = false;
		state.singleFreeze = null;
		state.freezeSingleQueue.length = 0;
		state.freezeBatchQueue.length = 0;
		state.batchFreezes = [];
		state.overviewRows.application = [];
		state.overviewRows.compose = [];
		state.composeEntity.sourceType = "git";
		state.composeEntity.serverId = null;
		state.appEntity.serverId = null;
		mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
		mocks.checkServiceAccess.mockResolvedValue(undefined);
		mocks.hasPermission.mockResolvedValue(true);
		mocks.shouldDeploy.mockReturnValue(true);
		mocks.operationFindFirst.mockResolvedValue(undefined);
		mocks.operationInsertReturning.mockResolvedValue([
			{
				operationId: "op-1",
				composeId: "compose-1",
				idempotencyKeyHash: "hash-1",
				sourceRevision: TEST_SHA,
				resolvedRevision: null,
				envRevision: "compose-env-v1:1",
				status: "accepted",
				deploymentId: null,
				createdAt: "2026-06-01T12:00:00.000Z",
				updatedAt: "2026-06-01T12:00:00.000Z",
				startedAt: null,
				finishedAt: null,
			},
		]);
		mocks.findComposeDeploymentOperation.mockResolvedValue({
			operationId: "op-1",
			composeId: "compose-1",
			sourceRevision: TEST_SHA,
			resolvedRevision: null,
			status: "queued",
			deployment: null,
			createdAt: "2026-06-01T12:00:00.000Z",
			updatedAt: "2026-06-01T12:00:00.000Z",
		});
		mocks.upsertApplicationEnvironment.mockResolvedValue({
			applicationId: "app-1",
			changed: true,
			revision: "rev-1",
			dryRun: false,
			variables: [{ name: "PORT", action: "updated", secret: false }],
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("setDeployFreeze and one manage lifecycle, RBAC, and API-key actor label redaction", async () => {
		const browserCaller = composeRouter.createCaller(
			createSessionCtx("session"),
		);
		const apiCaller = composeRouter.createCaller(createSessionCtx("api-key"));

		// RBAC denial
		mocks.checkServicePermissionAndAccess.mockRejectedValueOnce(
			new TRPCError({ code: "FORBIDDEN", message: "Denied" }),
		);
		await expect(
			browserCaller.setDeployFreeze({ composeId: "compose-1", frozen: true }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		// Reject durationMinutes when resuming
		await expect(
			browserCaller.setDeployFreeze({
				composeId: "compose-1",
				frozen: false,
				durationMinutes: 60,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		// Browser freeze sets actor label; compose.one returns frozenByLabel for browser, null for API key
		const createdRes = await browserCaller.setDeployFreeze({
			composeId: "compose-1",
			frozen: true,
			durationMinutes: 60,
			reason: "Maintenance",
		});
		expect(createdRes.deployFreeze?.active).toBe(true);
		expect(createdRes.deployFreeze?.frozenByLabel).toBe("Alice Ops");

		state.singleFreeze = makeFreezeRow({
			reason: "Maintenance",
			expiresAt: "2099-01-01T00:00:00.000Z",
		});
		const oneBrowser = await browserCaller.one({ composeId: "compose-1" });
		const oneApi = await apiCaller.one({ composeId: "compose-1" });
		expect(oneBrowser.deployFreeze?.frozenByLabel).toBe("Alice Ops");
		expect(oneApi.deployFreeze?.frozenByLabel).toBeNull();

		// Expired freeze returns null on one
		state.singleFreeze = makeFreezeRow({
			expiresAt: "2020-01-01T00:00:00.000Z",
		});
		const oneExpired = await browserCaller.one({ composeId: "compose-1" });
		expect(oneExpired.deployFreeze).toBeNull();

		// Unfreeze lifts active freeze
		const unfreezeRes = await browserCaller.setDeployFreeze({
			composeId: "compose-1",
			frozen: false,
		});
		expect(unfreezeRes.deployFreeze).toBeNull();
		expect(mocks.freezeUpdateSet).toHaveBeenCalledWith(
			expect.objectContaining({ liftedByUserId: "user-1" }),
		);
	});

	it("application.setDeployFreeze and application.one mirror compose freeze semantics", async () => {
		const caller = applicationRouter.createCaller(createSessionCtx("session"));
		const apiCaller = applicationRouter.createCaller(
			createSessionCtx("api-key"),
		);

		const res = await caller.setDeployFreeze({
			applicationId: "app-1",
			frozen: true,
			reason: "Code freeze",
		});
		expect(res).toMatchObject({
			serviceType: "application",
			serviceId: "app-1",
			deployFreeze: {
				active: true,
				reason: "Code freeze",
				frozenByLabel: "Alice Ops",
			},
		});

		state.singleFreeze = makeFreezeRow({
			scopeType: "application",
			scopeId: "app-1",
		});
		expect(
			(await apiCaller.one({ applicationId: "app-1" })).deployFreeze
				?.frozenByLabel,
		).toBeNull();
	});

	it("blocks all 8 rollout entry points when frozen and allows them with force=true", async () => {
		state.singleFreeze = makeFreezeRow({
			scopeId: "compose-1",
			reason: "Deploy hold",
		});
		const composeBrowser = composeRouter.createCaller(
			createSessionCtx("session"),
		);
		const composeApi = composeRouter.createCaller(createSessionCtx("api-key"));
		const appBrowser = applicationRouter.createCaller(
			createSessionCtx("session"),
		);
		const appApi = applicationRouter.createCaller(createSessionCtx("api-key"));
		const deployCaller = deploymentRouter.createCaller(
			createSessionCtx("api-key"),
		);

		// 1-3: compose.deploy, compose.redeploy, compose.deployExact blocked for both session and api-key
		for (const caller of [composeBrowser, composeApi]) {
			await expect(
				caller.deploy({ composeId: "compose-1" }),
			).rejects.toMatchObject({
				code: "PRECONDITION_FAILED",
			});
			await expect(
				caller.redeploy({ composeId: "compose-1" }),
			).rejects.toMatchObject({
				code: "PRECONDITION_FAILED",
			});
			await expect(
				caller.deployExact({
					composeId: "compose-1",
					expectedRevision: TEST_SHA,
					idempotencyKey: "exact-key-1",
				}),
			).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		}
		expect(mocks.operationInsert).not.toHaveBeenCalled();

		// 4-6: application.deploy, application.redeploy, application.envUpsert blocked BEFORE env write
		state.singleFreeze = makeFreezeRow({
			scopeType: "application",
			scopeId: "app-1",
		});
		for (const caller of [appBrowser, appApi]) {
			await expect(
				caller.deploy({ applicationId: "app-1" }),
			).rejects.toMatchObject({
				code: "PRECONDITION_FAILED",
			});
			await expect(
				caller.redeploy({ applicationId: "app-1" }),
			).rejects.toMatchObject({
				code: "PRECONDITION_FAILED",
			});
			await expect(
				caller.envUpsert({
					applicationId: "app-1",
					variables: { PORT: "4000" },
					redeploy: true,
				}),
			).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		}
		expect(mocks.upsertApplicationEnvironment).not.toHaveBeenCalled();

		// 6b: REST /api/application.env.upsert returns 412 BEFORE upsertApplicationEnvironment
		mocks.validateRequest.mockResolvedValue({
			session: {
				id: "s-api",
				userId: "user-1",
				activeOrganizationId: "org-1",
				authMethod: "api-key",
			},
			user: { id: "user-1", role: "owner", email: "alice@example.com" },
		});
		const restRes = createMockRes();
		await handleApplicationEnvUpsert(
			{
				method: "POST",
				body: {
					applicationId: "app-1",
					variables: { PORT: "4000" },
					redeploy: true,
				},
			} as NextApiRequest,
			restRes,
		);
		expect(restRes.status).toHaveBeenCalledWith(412);
		expect(mocks.upsertApplicationEnvironment).not.toHaveBeenCalled();

		// Note: envUpsert with dryRun=true or redeploy=false succeeds even when frozen
		await appApi.envUpsert({
			applicationId: "app-1",
			variables: { PORT: "4000" },
			redeploy: false,
		});
		expect(mocks.upsertApplicationEnvironment).toHaveBeenCalledOnce();

		// 7: application.dropDeployment blocked BEFORE unzipDrop / updateApplication
		const blockedDropForm = new FormData();
		blockedDropForm.append("applicationId", "app-1");
		blockedDropForm.append("zip", new File(["zip"], "bundle.zip"));
		await expect(
			appBrowser.dropDeployment(blockedDropForm as never),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(mocks.unzipDrop).not.toHaveBeenCalled();

		// 8: deployment.reconcile(repair=true) blocked when queue-empty
		state.singleFreeze = makeFreezeRow({ scopeId: "compose-1" });
		mocks.findComposeDeploymentOperation.mockResolvedValueOnce({
			operationId: "op-1",
			composeId: "compose-1",
			sourceRevision: TEST_SHA,
			resolvedRevision: null,
			status: "dispatch_unknown",
			deploymentId: null,
			deployment: null,
			createdAt: "2026-06-01T12:00:00.000Z",
			updatedAt: "2026-06-01T12:00:00.000Z",
		});
		await expect(
			deployCaller.reconcile({
				composeId: "compose-1",
				operationId: "op-1",
				repair: true,
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		expect(mocks.queueAdd).not.toHaveBeenCalled();

		// Forced deploys succeed across all paths, stamp descriptionLog & set bypassFreeze
		await composeBrowser.deploy({ composeId: "compose-1", force: true });
		await composeApi.deployExact({
			composeId: "compose-1",
			expectedRevision: TEST_SHA,
			idempotencyKey: "exact-key-1",
			force: true,
		});
		expect(mocks.queueAdd).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				bypassFreeze: true,
				descriptionLog: expect.stringContaining(
					"[forced during deploy freeze]",
				),
			}),
			expect.any(Object),
		);

		state.singleFreeze = makeFreezeRow({
			scopeType: "application",
			scopeId: "app-1",
		});
		const forcedDropForm = new FormData();
		forcedDropForm.append("applicationId", "app-1");
		forcedDropForm.append("zip", new File(["zip"], "bundle.zip"));
		forcedDropForm.append("force", "true");
		await expect(appApi.dropDeployment(forcedDropForm as never)).resolves.toBe(
			true,
		);
		expect(mocks.unzipDrop).toHaveBeenCalledOnce();

		state.singleFreeze = makeFreezeRow({ scopeId: "compose-1" });
		mocks.findComposeDeploymentOperation.mockResolvedValue({
			operationId: "op-1",
			composeId: "compose-1",
			sourceRevision: TEST_SHA,
			resolvedRevision: null,
			status: "dispatch_unknown",
			deploymentId: null,
			deployment: null,
			createdAt: "2026-06-01T12:00:00.000Z",
			updatedAt: "2026-06-01T12:00:00.000Z",
		});
		const repaired = await deployCaller.reconcile({
			composeId: "compose-1",
			operationId: "op-1",
			repair: true,
			force: true,
		});
		expect(repaired.operationId).toBe("op-1");
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				metadata: expect.objectContaining({ forcedDuringDeployFreeze: true }),
			}),
		);
	});

	it("preserves compose.deployExact idempotent replay and conflict checks even when frozen", async () => {
		state.singleFreeze = makeFreezeRow({ scopeId: "compose-1" });
		const apiCaller = composeRouter.createCaller(createSessionCtx("api-key"));

		mocks.operationFindFirst.mockResolvedValueOnce({
			operationId: "op-existing",
			composeId: "compose-1",
			sourceRevision: TEST_SHA,
			resolvedRevision: null,
			status: "queued",
		});
		const replay = await apiCaller.deployExact({
			composeId: "compose-1",
			expectedRevision: TEST_SHA,
			idempotencyKey: "existing-key-1",
		});
		expect(replay).toMatchObject({
			operationId: "op-existing",
			deduplicated: true,
		});
		expect(mocks.queueAdd).not.toHaveBeenCalled();

		mocks.operationFindFirst.mockResolvedValueOnce({
			operationId: "op-existing",
			composeId: "compose-1",
			sourceRevision: "f".repeat(40),
			resolvedRevision: null,
			status: "queued",
		});
		await expect(
			apiCaller.deployExact({
				composeId: "compose-1",
				expectedRevision: TEST_SHA,
				idempotencyKey: "existing-key-1",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("webhooks verify signature first, return 200 skipped without reason when frozen, and github fan-out skips only frozen services", async () => {
		// [refreshToken] and compose/[refreshToken]: invalid sig -> 401 even when frozen
		mocks.webhookAppFindFirst.mockResolvedValue({
			applicationId: "app-1",
			autoDeploy: true,
			sourceType: "github",
			branch: "main",
			webhookSecret: WEBHOOK_SECRET,
			github: { githubWebhookSecret: WEBHOOK_SECRET },
			gitlab: null,
			bitbucket: null,
			gitea: null,
		});
		mocks.webhookComposeFindFirst.mockResolvedValue({
			composeId: "compose-1",
			autoDeploy: true,
			sourceType: "github",
			branch: "main",
			webhookSecret: WEBHOOK_SECRET,
			github: { githubWebhookSecret: WEBHOOK_SECRET },
			gitlab: null,
			bitbucket: null,
			gitea: null,
		});
		state.singleFreeze = makeFreezeRow({
			reason: "SECRET_INTERNAL_REASON",
			expiresAt: "2099-01-01T00:00:00.000Z",
		});

		const payload = { ref: "refs/heads/main", head_commit: { message: "msg" } };
		const badAppRes = createMockRes();
		await appRefreshWebhook(
			makeRefreshWebhookReq(payload, "sha256=deadbeef"),
			badAppRes,
		);
		expect(badAppRes.status).toHaveBeenCalledWith(401);
		expect(mocks.skippedUpdate).not.toHaveBeenCalled();

		const badComposeRes = createMockRes();
		await composeRefreshWebhook(
			makeRefreshWebhookReq(payload, "sha256=deadbeef"),
			badComposeRes,
		);
		expect(badComposeRes.status).toHaveBeenCalledWith(401);
		expect(mocks.skippedUpdate).not.toHaveBeenCalled();

		// Valid signature while frozen -> 200 skipped, NO raw reason exposed
		const okAppRes = createMockRes();
		await appRefreshWebhook(makeRefreshWebhookReq(payload), okAppRes);
		expect(okAppRes.status).toHaveBeenCalledWith(200);
		expect(okAppRes.json).toHaveBeenCalledWith({
			skipped: true,
			code: DEPLOY_FROZEN_CODE,
			message: "Deployments are frozen for this service",
			expiresAt: "2099-01-01T00:00:00.000Z",
		});
		expect(JSON.stringify(okAppRes.json.mock.calls)).not.toContain(
			"SECRET_INTERNAL_REASON",
		);
		expect(mocks.queueAdd).not.toHaveBeenCalled();
		expect(mocks.skippedUpdate).toHaveBeenCalledTimes(1);

		const okComposeRes = createMockRes();
		await composeRefreshWebhook(makeRefreshWebhookReq(payload), okComposeRes);
		expect(okComposeRes.status).toHaveBeenCalledWith(200);
		expect(okComposeRes.json).toHaveBeenCalledWith({
			skipped: true,
			code: DEPLOY_FROZEN_CODE,
			message: "Deployments are frozen for this service",
			expiresAt: "2099-01-01T00:00:00.000Z",
		});
		expect(mocks.skippedUpdate).toHaveBeenCalledTimes(2);

		// github.ts mixed push fan-out (1 frozen app, 1 unfrozen compose)
		mocks.githubFindFirst.mockResolvedValue({
			githubId: "gh-1",
			githubInstallationId: 123,
			githubWebhookSecret: WEBHOOK_SECRET,
		});
		mocks.webhookAppFindMany.mockResolvedValueOnce([
			{ applicationId: "app-1", serverId: null, watchPaths: null },
		]);
		mocks.webhookComposeFindMany.mockResolvedValueOnce([
			{ composeId: "compose-1", serverId: null, watchPaths: null },
		]);
		state.freezeSingleQueue.push([
			makeFreezeRow({ scopeType: "application", scopeId: "app-1" }),
		]);
		state.freezeSingleQueue.push([]);

		const mixedRes = createMockRes();
		await githubWebhook(
			makeGithubAppReq("push", {
				installation: { id: 123 },
				ref: "refs/heads/main",
				after: TEST_SHA,
				head_commit: { message: "feat: deploy" },
				commits: [{ modified: ["app.ts"] }],
				repository: {
					name: "repo",
					full_name: "org/repo",
					owner: { login: "org" },
				},
			}),
			mixedRes,
		);
		expect(mixedRes.status).toHaveBeenCalledWith(200);
		expect(mixedRes.json).toHaveBeenCalledWith({
			message: "Deployed 1 apps (1 skipped due to deploy freeze)",
			deployedCount: 1,
			skippedFrozenCount: 1,
		});
		expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
		expect(mocks.queueAdd).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				composeId: "compose-1",
				applicationType: "compose",
			}),
			expect.any(Object),
		);

		// github.ts tag fan-out (refs/tags/...) also skips frozen services cleanly
		mocks.webhookAppFindMany.mockResolvedValueOnce([
			{ applicationId: "app-1", serverId: null, watchPaths: null },
		]);
		mocks.webhookComposeFindMany.mockResolvedValueOnce([]);
		state.freezeSingleQueue.push([
			makeFreezeRow({ scopeType: "application", scopeId: "app-1" }),
		]);
		const tagRes = createMockRes();
		await githubWebhook(
			makeGithubAppReq("push", {
				installation: { id: 123 },
				ref: "refs/tags/v1.0.0",
				after: TEST_SHA,
				head_commit: { message: "release v1.0.0" },
				repository: {
					name: "repo",
					full_name: "org/repo",
					owner: { login: "org" },
				},
			}),
			tagRes,
		);
		expect(tagRes.status).toHaveBeenCalledWith(200);
		expect(tagRes.json).toHaveBeenCalledWith({
			skipped: true,
			code: DEPLOY_FROZEN_CODE,
			message: "Deployments skipped: matching services are frozen",
			deployedCount: 0,
			skippedFrozenCount: 1,
		});

		// github.ts pull_request preview deployments are NOT blocked by freeze
		state.singleFreeze = makeFreezeRow({
			scopeType: "application",
			scopeId: "app-1",
		});
		mocks.webhookAppFindMany.mockResolvedValueOnce([
			{
				applicationId: "app-1",
				name: "api-app",
				serverId: null,
				isPreviewDeploymentsActive: true,
				previewRequireCollaboratorPermissions: false,
				previewLimit: 3,
				previewWildcard: "example.com",
				appName: "api-app",
				previewDeployments: [],
			},
		]);
		mocks.findPreviewDeploymentsByPullRequestIdForGithub.mockResolvedValueOnce(
			[],
		);
		mocks.createPreviewDeployment.mockResolvedValueOnce({
			previewDeploymentId: "prev-1",
			appName: "api-app",
		});
		const prRes = createMockRes();
		await githubWebhook(
			makeGithubAppReq("pull_request", {
				action: "opened",
				installation: { id: 123 },
				number: 7,
				pull_request: {
					id: 99,
					title: "PR test",
					html_url: "https://github.com/org/repo/pull/7",
					base: { ref: "main" },
					head: { ref: "feat", sha: TEST_SHA },
					user: { login: "dev", type: "User" },
				},
				repository: {
					name: "repo",
					full_name: "org/repo",
					owner: { login: "org" },
				},
			}),
			prRes,
		);
		expect(prRes.status).toHaveBeenCalledWith(200);
		expect(mocks.queueAdd).toHaveBeenLastCalledWith(
			"deployments",
			expect.objectContaining({
				applicationType: "application-preview",
				previewDeploymentId: "prev-1",
			}),
			expect.any(Object),
		);
	});

	it("queue worker re-checks active freeze before running non-forced jobs and respects bypassFreeze", async () => {
		state.singleFreeze = makeFreezeRow({ scopeId: "compose-1" });

		await processDeploymentJob({
			data: {
				composeId: "compose-1",
				titleLog: "Auto",
				descriptionLog: "",
				type: "deploy",
				applicationType: "compose",
				operationId: "op-queued-1",
			},
		} as never);
		expect(mocks.updateCompose).not.toHaveBeenCalled();
		expect(mocks.deployCompose).not.toHaveBeenCalled();
		expect(mocks.claimDeploymentOperation).toHaveBeenCalledWith(
			"compose-1",
			"op-queued-1",
		);
		expect(mocks.finalizeDeploymentOperation).toHaveBeenCalledWith(
			"op-queued-1",
			"failed",
		);
		expect(mocks.skippedUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ lastSkippedSource: "queue" }),
		);

		vi.clearAllMocks();
		await processDeploymentJob({
			data: {
				applicationId: "app-1",
				titleLog: "Forced",
				descriptionLog: "[forced during deploy freeze]",
				type: "deploy",
				applicationType: "application",
				bypassFreeze: true,
			},
		} as never);
		expect(mocks.updateApplicationStatus).toHaveBeenCalledWith(
			"app-1",
			"running",
		);
		expect(mocks.deployApplication).toHaveBeenCalledOnce();
	});

	it("attaches active deployFreeze to overview.services and environment.one and hides expired or DB freezes", async () => {
		state.overviewRows.application = [
			{
				id: "app-1",
				name: "api-app",
				appName: "api-app",
				status: "done",
				createdAt: "2026-06-01T00:00:00.000Z",
				serverId: null,
				serverName: null,
				icon: null,
				projectId: "project-1",
				projectName: "Core",
				environmentId: "env-1",
				environmentName: "production",
			},
			{
				id: "app-2",
				name: "worker-app",
				appName: "worker-app",
				status: "done",
				createdAt: "2026-06-01T00:00:00.000Z",
				serverId: null,
				serverName: null,
				icon: null,
				projectId: "project-1",
				projectName: "Core",
				environmentId: "env-1",
				environmentName: "production",
			},
		];
		state.overviewRows.compose = [
			{
				id: "compose-1",
				name: "web-stack",
				appName: "web-stack",
				status: "done",
				createdAt: "2026-06-01T00:00:00.000Z",
				serverId: null,
				serverName: null,
				icon: null,
				projectId: "project-1",
				projectName: "Core",
				environmentId: "env-1",
				environmentName: "production",
			},
		];
		state.freezeBatchQueue.push([
			makeFreezeRow({
				scopeType: "application",
				scopeId: "app-1",
				reason: "App hold",
				skippedCount: 3,
				expiresAt: "2099-01-01T00:00:00.000Z",
			}),
			makeFreezeRow({
				scopeType: "application",
				scopeId: "app-2",
				expiresAt: "2020-01-01T00:00:00.000Z",
			}),
		]);
		state.freezeBatchQueue.push([]);

		const services = await getAllServicesForOrganization("org-1", null);
		const app1Overview = services.find((s) => s.id === "app-1");
		const app2Overview = services.find((s) => s.id === "app-2");
		const comp1Overview = services.find((s) => s.id === "compose-1");
		expect(
			toOverviewDeployFreeze(makeFreezeRow({ scopeId: "app-1" })),
		).not.toBeNull();
		expect(app1Overview?.deployFreeze).toMatchObject({
			reason: "App hold",
			skippedCount: 3,
		});
		expect(app2Overview?.deployFreeze).toBeNull();
		expect(comp1Overview?.deployFreeze).toBeNull();

		state.freezeBatchQueue.push([
			makeFreezeRow({
				scopeType: "application",
				scopeId: "app-1",
				reason: "Env hold",
				skippedCount: 1,
			}),
		]);
		state.freezeBatchQueue.push([]);
		const envCaller = environmentRouter.createCaller(
			createSessionCtx("session"),
		);
		const envOne = await envCaller.one({ environmentId: "env-1" });
		const envApp1 = (
			envOne.applications as Array<Record<string, unknown>>
		).find((a) => a.applicationId === "app-1");
		const envDb = (envOne.libsql as Array<Record<string, unknown>>)[0];
		expect(envApp1?.deployFreeze).toMatchObject({
			reason: "Env hold",
			skippedCount: 1,
		});
		expect(envDb?.deployFreeze).toBeUndefined();
	});
});

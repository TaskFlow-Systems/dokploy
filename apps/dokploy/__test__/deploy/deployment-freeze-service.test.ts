import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => {
	const selectRowsQueue: Array<Array<Record<string, unknown>>> = [];
	const insertReturningQueue: Array<Array<Record<string, unknown>>> = [];
	const updateReturningQueue: Array<Array<Record<string, unknown>>> = [];
	const deleteReturningQueue: Array<Array<Record<string, unknown>>> = [];
	const deleteCalls: Array<unknown> = [];
	const envFindFirst = vi.fn();

	const selectLimit = vi.fn(async () => selectRowsQueue.shift() ?? []);
	const selectWhere = vi.fn(() => {
		const chain: {
			limit: typeof selectLimit;
			then: Promise<Array<Record<string, unknown>>>["then"];
		} = {
			limit: selectLimit,
			// biome-ignore lint/suspicious/noThenProperty: Drizzle query mock emulates thenable chains without .limit().
			then(onFulfilled, onRejected) {
				const rows = selectRowsQueue.shift() ?? [];
				return Promise.resolve(rows).then(onFulfilled, onRejected);
			},
		};
		return chain;
	});
	const selectFrom = vi.fn(() => ({ where: selectWhere }));
	const select = vi.fn(() => ({ from: selectFrom }));

	const updateReturning = vi.fn(async () => updateReturningQueue.shift() ?? []);
	const updateWhere = vi.fn(() => {
		const promise = Promise.resolve(undefined) as Promise<undefined> & {
			returning: typeof updateReturning;
		};
		promise.returning = updateReturning;
		return promise;
	});
	const updateSet = vi.fn(() => ({ where: updateWhere }));
	const update = vi.fn(() => ({ set: updateSet }));

	const insertReturning = vi.fn(async () => insertReturningQueue.shift() ?? []);
	const insertValues = vi.fn(() => ({ returning: insertReturning }));
	const insert = vi.fn(() => ({ values: insertValues }));

	const deleteReturning = vi.fn(async () => deleteReturningQueue.shift() ?? []);
	const deleteWhere = vi.fn(() => {
		const promise = Promise.resolve(undefined) as Promise<undefined> & {
			returning: typeof deleteReturning;
		};
		promise.returning = deleteReturning;
		return promise;
	});
	const del = vi.fn((table?: unknown) => {
		deleteCalls.push(table);
		return { where: deleteWhere };
	});

	const tx = {
		delete: del,
		insert,
		select,
		update,
	};
	const transaction = vi.fn(
		async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx),
	);

	return {
		del,
		deleteCalls,
		deleteReturning,
		deleteReturningQueue,
		deleteWhere,
		envFindFirst,
		insert,
		insertReturning,
		insertReturningQueue,
		insertValues,
		select,
		selectFrom,
		selectLimit,
		selectRowsQueue,
		selectWhere,
		transaction,
		tx,
		update,
		updateReturning,
		updateReturningQueue,
		updateSet,
		updateWhere,
	};
});

vi.mock("@dokploy/server/db", () => ({
	db: {
		delete: dbState.del,
		insert: dbState.insert,
		query: {
			environments: {
				findFirst: dbState.envFindFirst,
			},
		},
		select: dbState.select,
		transaction: dbState.transaction,
		update: dbState.update,
	},
}));

const { applications, compose, deploymentFreeze, environments, projects } =
	await import("@dokploy/server/db/schema");
const {
	assertDeploymentNotFrozen,
	deleteDeploymentFreezesForScope,
	deleteDeploymentFreezesForScopes,
	formatUserActorLabel,
	getActiveDeploymentFreeze,
	getActiveDeploymentFreezesByIds,
	getEffectiveDeploymentFreeze,
	recordSkippedDeploymentFreeze,
	recordSkippedEffectiveDeploymentFreeze,
	setDeploymentFreeze,
} = await import("@dokploy/server/services/deployment-freeze");
const { deleteEnvironment } = await import(
	"@dokploy/server/services/environment"
);
const { deleteProject } = await import("@dokploy/server/services/project");

const makeRow = (overrides: Record<string, unknown> = {}) => ({
	freezeId: "freeze-1",
	scopeType: "compose",
	scopeId: "compose-1",
	reason: "Incident hold",
	createdByUserId: "user-1",
	createdByLabel: "Alice Ops",
	createdByAuthMethod: "session",
	createdAt: "2026-06-01T10:00:00.000Z",
	expiresAt: null,
	liftedAt: null,
	liftedByUserId: null,
	skippedCount: 2,
	lastSkippedAt: null,
	lastSkippedSource: null,
	...overrides,
});

describe("deployment-freeze service", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		dbState.selectRowsQueue.length = 0;
		dbState.insertReturningQueue.length = 0;
		dbState.updateReturningQueue.length = 0;
		dbState.deleteReturningQueue.length = 0;
		dbState.deleteCalls.length = 0;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns active freeze rows and filters expired ones lazily", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));

		dbState.selectRowsQueue.push([
			makeRow({ expiresAt: "2026-06-01T13:00:00.000Z" }),
		]);
		const active = await getActiveDeploymentFreeze("compose", "compose-1");
		expect(active?.freezeId).toBe("freeze-1");

		dbState.selectRowsQueue.push([
			makeRow({ expiresAt: "2026-06-01T12:00:00.000Z" }),
		]);
		const boundary = await getActiveDeploymentFreeze("compose", "compose-1");
		expect(boundary).toBeNull();
	});

	it("batch-loads active freezes (including environment scope) and skips DB query for empty scopeIds", async () => {
		expect(await getActiveDeploymentFreezesByIds("application", [])).toEqual(
			new Map(),
		);
		expect(await getActiveDeploymentFreezesByIds("environment", [])).toEqual(
			new Map(),
		);
		expect(dbState.select).not.toHaveBeenCalled();

		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
		dbState.selectRowsQueue.push([
			makeRow({ scopeType: "application", scopeId: "app-1", expiresAt: null }),
			makeRow({
				freezeId: "freeze-2",
				scopeType: "application",
				scopeId: "app-2",
				expiresAt: "2026-06-01T11:00:00.000Z",
			}),
		]);

		const map = await getActiveDeploymentFreezesByIds("application", [
			"app-1",
			"app-2",
			"app-1",
		]);
		expect(Array.from(map.keys())).toEqual(["app-1"]);
	});

	it("getEffectiveDeploymentFreeze resolves live environmentId when omitted and picks strictest lock", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));

		// Omitted environmentId -> 1 PK lookup on compose + 1 candidate freeze query
		dbState.selectRowsQueue.push([{ environmentId: "env-live" }]);
		dbState.selectRowsQueue.push([
			makeRow({
				freezeId: "svc-timed",
				scopeType: "compose",
				scopeId: "compose-1",
				expiresAt: "2026-06-01T13:00:00.000Z",
			}),
			makeRow({
				freezeId: "env-indef",
				scopeType: "environment",
				scopeId: "env-live",
				expiresAt: null,
			}),
		]);

		const res = await getEffectiveDeploymentFreeze({
			scopeType: "compose",
			scopeId: "compose-1",
		});
		expect(res.environmentId).toBe("env-live");
		expect(res.serviceFreeze?.freezeId).toBe("svc-timed");
		expect(res.environmentFreeze?.freezeId).toBe("env-indef");
		expect(res.effective?.freezeId).toBe("env-indef");
		expect(dbState.selectFrom).toHaveBeenNthCalledWith(1, compose);
		expect(dbState.selectFrom).toHaveBeenNthCalledWith(2, deploymentFreeze);

		// Provided environmentId -> skips PK lookup (1 query total); indefinite service beats timed env
		vi.clearAllMocks();
		dbState.selectRowsQueue.push([
			makeRow({
				freezeId: "app-indef",
				scopeType: "application",
				scopeId: "app-1",
				expiresAt: null,
			}),
			makeRow({
				freezeId: "env-timed",
				scopeType: "environment",
				scopeId: "env-1",
				expiresAt: "2026-06-01T14:00:00.000Z",
			}),
		]);
		const appRes = await getEffectiveDeploymentFreeze({
			scopeType: "application",
			scopeId: "app-1",
			environmentId: "env-1",
		});
		expect(dbState.select).toHaveBeenCalledTimes(1);
		expect(appRes.effective?.freezeId).toBe("app-indef");
		expect(appRes.serviceFreeze?.freezeId).toBe("app-indef");
		expect(appRes.environmentFreeze?.freezeId).toBe("env-timed");

		// Omitted environmentId for application queries applications table
		vi.clearAllMocks();
		dbState.selectRowsQueue.push([{ environmentId: "env-app" }]);
		dbState.selectRowsQueue.push([
			makeRow({
				freezeId: "env-tie",
				scopeType: "environment",
				scopeId: "env-app",
				expiresAt: "2026-06-01T15:00:00.000Z",
			}),
			makeRow({
				freezeId: "app-tie",
				scopeType: "application",
				scopeId: "app-1",
				expiresAt: "2026-06-01T15:00:00.000Z",
			}),
		]);
		const tieRes = await getEffectiveDeploymentFreeze({
			scopeType: "application",
			scopeId: "app-1",
		});
		expect(dbState.selectFrom).toHaveBeenNthCalledWith(1, applications);
		expect(tieRes.effective?.freezeId).toBe("env-tie");
	});

	it("formats user actor labels with full name -> email -> fallback", async () => {
		dbState.selectRowsQueue.push([
			{ firstName: "Jane", lastName: "Doe", email: "jane@example.com" },
		]);
		expect(await formatUserActorLabel("u-1")).toBe("Jane Doe");

		dbState.selectRowsQueue.push([
			{ firstName: "", lastName: "", email: "ops@example.com" },
		]);
		expect(await formatUserActorLabel("u-2")).toBe("ops@example.com");

		dbState.selectRowsQueue.push([]);
		expect(await formatUserActorLabel("u-3", "fallback@example.com")).toBe(
			"fallback@example.com",
		);
	});

	it("manages freeze create, active update preserving skip count, expired rollover, and resume validation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));

		// Create new timed freeze
		dbState.selectRowsQueue.push([]);
		const createdRow = makeRow({
			expiresAt: "2026-06-01T13:00:00.000Z",
			skippedCount: 0,
		});
		dbState.insertReturningQueue.push([createdRow]);
		const created = await setDeploymentFreeze({
			scopeType: "compose",
			scopeId: "compose-1",
			frozen: true,
			durationMinutes: 60,
			reason: "  Deploy\nwindow\u202Ehold  ",
			actor: { userId: "user-1", label: "Alice Ops", authMethod: "session" },
		});
		expect(created).toEqual(createdRow);
		expect(dbState.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				scopeType: "compose",
				scopeId: "compose-1",
				reason: "Deploy windowhold",
				expiresAt: "2026-06-01T13:00:00.000Z",
				skippedCount: 0,
			}),
		);

		// Create environment-scoped freeze
		dbState.selectRowsQueue.push([]);
		const createdEnvRow = makeRow({
			freezeId: "env-freeze-1",
			scopeType: "environment",
			scopeId: "env-1",
			skippedCount: 0,
		});
		dbState.insertReturningQueue.push([createdEnvRow]);
		const createdEnv = await setDeploymentFreeze({
			scopeType: "environment",
			scopeId: "env-1",
			frozen: true,
			reason: "Release freeze",
			actor: { userId: "user-1", label: "Alice Ops", authMethod: "session" },
		});
		expect(createdEnv?.scopeType).toBe("environment");

		// Update active freeze preserves createdAt/skippedCount
		dbState.selectRowsQueue.push([
			makeRow({ expiresAt: "2026-06-01T14:00:00.000Z", skippedCount: 4 }),
		]);
		dbState.updateReturningQueue.push([makeRow({ skippedCount: 4 })]);
		await setDeploymentFreeze({
			scopeType: "compose",
			scopeId: "compose-1",
			frozen: true,
			durationMinutes: null,
			reason: "Extended",
			actor: { userId: "user-2", label: "Bob", authMethod: "api-key" },
		});
		expect(dbState.updateSet).toHaveBeenCalledWith({
			expiresAt: null,
			reason: "Extended",
			createdByUserId: "user-2",
			createdByLabel: "Bob",
			createdByAuthMethod: "api-key",
		});

		// Expired unlifted row gets closed before inserting new freeze
		dbState.selectRowsQueue.push([
			makeRow({
				freezeId: "old-expired",
				expiresAt: "2026-06-01T11:30:00.000Z",
			}),
		]);
		dbState.insertReturningQueue.push([makeRow({ freezeId: "fresh-freeze" })]);
		const rolled = await setDeploymentFreeze({
			scopeType: "compose",
			scopeId: "compose-1",
			frozen: true,
			actor: { userId: "user-1", label: null, authMethod: "session" },
		});
		expect(rolled?.freezeId).toBe("fresh-freeze");
		expect(dbState.updateSet).toHaveBeenCalledWith({
			liftedAt: "2026-06-01T11:30:00.000Z",
			liftedByUserId: null,
		});

		// Reject durationMinutes or reason when unfreezing
		await expect(
			setDeploymentFreeze({
				scopeType: "compose",
				scopeId: "compose-1",
				frozen: false,
				durationMinutes: 10,
				actor: { userId: "user-1", label: null, authMethod: "session" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		await expect(
			setDeploymentFreeze({
				scopeType: "compose",
				scopeId: "compose-1",
				frozen: false,
				reason: "Still set",
				actor: { userId: "user-1", label: null, authMethod: "session" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		// Unfreeze lifts active row
		const res = await setDeploymentFreeze({
			scopeType: "compose",
			scopeId: "compose-1",
			frozen: false,
			actor: { userId: "user-1", label: null, authMethod: "session" },
		});
		expect(res).toBeNull();
		expect(dbState.updateSet).toHaveBeenCalledWith({
			liftedAt: "2026-06-01T12:00:00.000Z",
			liftedByUserId: "user-1",
		});
	});

	it("assertDeploymentNotFrozen throws PRECONDITION_FAILED + increments skip count across active scopes unless forced", async () => {
		dbState.selectRowsQueue.push([
			makeRow({ reason: "DB migration", createdByLabel: "Secret Actor" }),
		]);
		await expect(
			assertDeploymentNotFrozen({
				scopeType: "compose",
				scopeId: "compose-1",
				environmentId: "env-1",
				source: "api",
			}),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			message:
				"DEPLOY_FROZEN: Deployments are frozen for this service (reason: DB migration)",
		});
		expect(dbState.update).toHaveBeenCalledTimes(1);

		// Environment-level freeze produces environment message
		dbState.selectRowsQueue.push([
			makeRow({
				scopeType: "environment",
				scopeId: "env-1",
				reason: "Prod freeze",
			}),
		]);
		await expect(
			assertDeploymentNotFrozen({
				scopeType: "compose",
				scopeId: "compose-1",
				environmentId: "env-1",
				source: "api",
			}),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			message:
				"DEPLOY_FROZEN: Deployments are frozen for this environment (reason: Prod freeze)",
		});
		expect(dbState.update).toHaveBeenCalledTimes(2);

		dbState.selectRowsQueue.push([
			makeRow({
				scopeType: "environment",
				scopeId: "env-1",
				createdByLabel: "Alice Ops",
			}),
		]);
		const bypassed = await assertDeploymentNotFrozen({
			scopeType: "compose",
			scopeId: "compose-1",
			environmentId: "env-1",
			force: true,
			source: "api",
		});
		expect(bypassed).toMatchObject({
			active: true,
			scopeType: "environment",
			scopeId: "env-1",
			frozenByLabel: null,
		});
		expect(dbState.update).toHaveBeenCalledTimes(2);
	});

	it("swallows DB failures inside skip recorders and handles empty/bulk scope deletion", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		dbState.updateWhere.mockRejectedValueOnce(new Error("transient db error"));
		await expect(
			recordSkippedDeploymentFreeze("application", "app-1", "webhook"),
		).resolves.toBeUndefined();
		dbState.updateWhere.mockRejectedValueOnce(new Error("transient db error"));
		await expect(
			recordSkippedEffectiveDeploymentFreeze({
				scopeType: "application",
				scopeId: "app-1",
				environmentId: "env-1",
				source: "queue",
			}),
		).resolves.toBeUndefined();
		expect(warnSpy).toHaveBeenCalledTimes(2);
		warnSpy.mockRestore();

		await deleteDeploymentFreezesForScopes("environment", []);
		expect(dbState.del).not.toHaveBeenCalled();

		await deleteDeploymentFreezesForScope("compose", "compose-1");
		expect(dbState.del).toHaveBeenCalledTimes(1);
	});

	it("transactionally deletes environment and project freezes before cascading in deleteEnvironment and deleteProject", async () => {
		dbState.envFindFirst.mockResolvedValueOnce({
			environmentId: "env-2",
			name: "staging",
			isDefault: false,
			projectId: "proj-1",
			applications: [],
			compose: [],
			libsql: [],
			mariadb: [],
			mongo: [],
			mysql: [],
			postgres: [],
			redis: [],
			project: { projectId: "proj-1" },
		});
		dbState.deleteReturningQueue.push([{ environmentId: "env-2" }]);

		const deletedEnv = await deleteEnvironment("env-2");
		expect(deletedEnv).toEqual({ environmentId: "env-2" });
		expect(dbState.transaction).toHaveBeenCalledTimes(1);
		expect(dbState.deleteCalls).toEqual([deploymentFreeze, environments]);

		vi.clearAllMocks();
		dbState.deleteCalls.length = 0;
		dbState.selectRowsQueue.push([
			{ environmentId: "env-1" },
			{ environmentId: "env-2" },
		]);
		dbState.deleteReturningQueue.push([{ projectId: "proj-1" }]);

		const deletedProj = await deleteProject("proj-1");
		expect(deletedProj).toEqual({ projectId: "proj-1" });
		expect(dbState.transaction).toHaveBeenCalledTimes(1);
		expect(dbState.deleteCalls).toEqual([
			deploymentFreeze,
			deploymentFreeze,
			projects,
		]);
	});
});

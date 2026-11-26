import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => {
	const selectRowsQueue: Array<Array<Record<string, unknown>>> = [];
	const insertReturningQueue: Array<Array<Record<string, unknown>>> = [];
	const updateReturningQueue: Array<Array<Record<string, unknown>>> = [];

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

	const deleteWhere = vi.fn(async () => undefined);
	const del = vi.fn(() => ({ where: deleteWhere }));

	const tx = {
		select,
		update,
		insert,
	};
	const transaction = vi.fn(
		async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx),
	);

	return {
		del,
		deleteWhere,
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
		select: dbState.select,
		transaction: dbState.transaction,
		update: dbState.update,
	},
}));

const {
	assertDeploymentNotFrozen,
	deleteDeploymentFreezesForScope,
	formatUserActorLabel,
	getActiveDeploymentFreeze,
	getActiveDeploymentFreezesByIds,
	recordSkippedDeploymentFreeze,
	setDeploymentFreeze,
} = await import("@dokploy/server/services/deployment-freeze");

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

	it("batch-loads active freezes and skips DB query for empty scopeIds", async () => {
		expect(await getActiveDeploymentFreezesByIds("application", [])).toEqual(
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

	it("assertDeploymentNotFrozen throws PRECONDITION_FAILED + increments skip count unless forced", async () => {
		dbState.selectRowsQueue.push([
			makeRow({ reason: "DB migration", createdByLabel: "Secret Actor" }),
		]);
		await expect(
			assertDeploymentNotFrozen({
				scopeType: "compose",
				scopeId: "compose-1",
				source: "api",
			}),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			message:
				"DEPLOY_FROZEN: Deployments are frozen for this service (reason: DB migration)",
		});
		expect(dbState.update).toHaveBeenCalledTimes(1);

		dbState.selectRowsQueue.push([makeRow({ createdByLabel: "Alice Ops" })]);
		const bypassed = await assertDeploymentNotFrozen({
			scopeType: "compose",
			scopeId: "compose-1",
			force: true,
			source: "api",
		});
		expect(bypassed).toMatchObject({
			active: true,
			frozenByLabel: null,
		});
		expect(dbState.update).toHaveBeenCalledTimes(1);
	});

	it("swallows DB failures inside recordSkippedDeploymentFreeze and deletes freezes on scope removal", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		dbState.updateWhere.mockRejectedValueOnce(new Error("transient db error"));
		await expect(
			recordSkippedDeploymentFreeze("application", "app-1", "webhook"),
		).resolves.toBeUndefined();
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();

		await deleteDeploymentFreezesForScope("compose", "compose-1");
		expect(dbState.del).toHaveBeenCalledTimes(1);
	});
});

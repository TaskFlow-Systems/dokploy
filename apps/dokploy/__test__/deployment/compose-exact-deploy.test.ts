import {
	createComposeDeploymentOperation,
	finalizeDeploymentOperation,
} from "@dokploy/server/services/deployment";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiDeployComposeExact,
	apiDeployComposeExactResponse,
	apiReconcileDeploymentResponse,
	apiUpsertComposeEnvResponse,
} from "@/server/db/schema";

const mocks = vi.hoisted(() => {
	const returning = vi.fn();
	const onConflictDoNothing = vi.fn(() => ({ returning }));
	const values = vi.fn(() => ({ onConflictDoNothing }));
	const insert = vi.fn(() => ({ values }));
	const updateReturning = vi.fn();
	const updateWhere = vi.fn(() => ({ returning: updateReturning }));
	const updateSet = vi.fn(() => ({ where: updateWhere }));
	const update = vi.fn(() => ({ set: updateSet }));
	const findOperation = vi.fn();
	const findComposeById = vi.fn();
	return {
		findComposeById,
		findOperation,
		insert,
		onConflictDoNothing,
		returning,
		update,
		updateReturning,
		updateSet,
		updateWhere,
		values,
	};
});

vi.mock("@dokploy/server/db", () => ({
	db: {
		insert: mocks.insert,
		update: mocks.update,
		query: { deploymentOperations: { findFirst: mocks.findOperation } },
	},
}));

vi.mock("@dokploy/server/services/compose", () => ({
	findComposeById: mocks.findComposeById,
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

const revision = "0123456789abcdef0123456789abcdef01234567";
const operation = {
	operationId: "operation-1",
	composeId: "compose-1",
	idempotencyKeyHash: "opaque-hash",
	sourceRevision: revision,
	resolvedRevision: null,
	envRevision: "compose-env-v1:opaque",
	status: "accepted" as const,
	deploymentId: null,
	createdAt: "2026-07-20T00:00:00.000Z",
	updatedAt: "2026-07-20T00:00:00.000Z",
	startedAt: null,
	finishedAt: null,
};

describe("exact Compose deployment operation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findOperation.mockResolvedValue(undefined);
		mocks.findComposeById.mockResolvedValue({
			composeId: "compose-1",
			sourceType: "git",
			env: "SECRET=canary",
		});
	});

	it("requires a full Git SHA and bounded idempotency key", () => {
		expect(
			apiDeployComposeExact.safeParse({
				composeId: "compose-1",
				expectedRevision: "main",
				idempotencyKey: "short",
			}).success,
		).toBe(false);
	});

	it("stores only a hash and returns the insert winner", async () => {
		mocks.returning.mockResolvedValue([operation]);
		const result = await createComposeDeploymentOperation({
			composeId: "compose-1",
			sourceRevision: revision,
			idempotencyKey: "release-key-canary",
		});
		expect(result.deduplicated).toBe(false);
		expect(mocks.values).toHaveBeenCalledWith(
			expect.objectContaining({
				composeId: "compose-1",
				sourceRevision: revision,
				idempotencyKeyHash: expect.not.stringContaining("release-key-canary"),
			}),
		);
	});

	it("returns the durable operation for a same-key replay", async () => {
		mocks.returning.mockResolvedValue([]);
		mocks.findOperation.mockResolvedValue(operation);
		const result = await createComposeDeploymentOperation({
			composeId: "compose-1",
			sourceRevision: revision,
			idempotencyKey: "release-key-canary",
		});
		expect(result.deduplicated).toBe(true);
		expect(result.operation.operationId).toBe("operation-1");
	});

	it("rejects a same-key replay bound to another revision", async () => {
		mocks.returning.mockResolvedValue([]);
		mocks.findOperation.mockResolvedValue({
			...operation,
			sourceRevision: "f".repeat(40),
		});
		await expect(
			createComposeDeploymentOperation({
				composeId: "compose-1",
				sourceRevision: revision,
				idempotencyKey: "release-key-canary",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("rejects raw sources before operation insert", async () => {
		mocks.findComposeById.mockResolvedValue({
			composeId: "compose-1",
			sourceType: "raw",
			env: "",
		});
		await expect(
			createComposeDeploymentOperation({
				composeId: "compose-1",
				sourceRevision: revision,
				idempotencyKey: "release-key-canary",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.insert).not.toHaveBeenCalled();
	});

	it("exact response schema excludes secret-bearing fields", () => {
		const parsed = apiDeployComposeExactResponse.parse({
			composeId: "compose-1",
			operationId: "operation-1",
			sourceRevision: revision,
			resolvedRevision: null,
			status: "queued",
			deduplicated: false,
		});
		expect(JSON.stringify(parsed)).not.toMatch(
			/envRevision|idempotencyKey|SECRET=canary/,
		);
	});

	it("treats an ambiguous finalize response as success after durable read-back", async () => {
		mocks.updateReturning.mockRejectedValueOnce(
			new Error("database response lost after commit"),
		);
		mocks.findOperation.mockResolvedValue({
			...operation,
			status: "succeeded",
		});

		await expect(
			finalizeDeploymentOperation("operation-1", "succeeded"),
		).resolves.toEqual([
			expect.objectContaining({
				operationId: "operation-1",
				status: "succeeded",
			}),
		]);
	});

	it("rejects a conflicting terminal transition", async () => {
		mocks.updateReturning.mockResolvedValueOnce([]);
		mocks.findOperation.mockResolvedValue({
			...operation,
			status: "failed",
		});

		await expect(
			finalizeDeploymentOperation("operation-1", "succeeded"),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("surfaces unresolved ambiguity when update and terminal read-back both fail", async () => {
		mocks.updateReturning.mockRejectedValueOnce(
			new Error("database response lost after commit"),
		);
		mocks.findOperation.mockRejectedValueOnce(
			new Error("terminal read-back unavailable"),
		);

		await expect(
			finalizeDeploymentOperation("operation-1", "succeeded"),
		).rejects.toThrow("database response lost after commit");
	});
});

describe("release recovery OpenAPI source contract", () => {
	it("declares all three additive OpenAPI paths", () => {
		const composeRouterSource = readFileSync(
			new URL("../../server/api/routers/compose.ts", import.meta.url),
			"utf8",
		);
		const deploymentRouterSource = readFileSync(
			new URL("../../server/api/routers/deployment.ts", import.meta.url),
			"utf8",
		);

		expect(composeRouterSource).toContain('path: "/compose/env/upsert"');
		expect(composeRouterSource).toContain('path: "/compose/deploy/exact"');
		expect(deploymentRouterSource).toContain('path: "/deployment/reconcile"');
	});

	it("keeps recovery response schemas on explicit allowlists", () => {
		const envResponse = apiUpsertComposeEnvResponse.parse({
			composeId: "compose-1",
			changed: true,
			revision: "compose-env-v1:opaque",
			dryRun: false,
			variables: [{ name: "A", action: "updated", secret: false }],
		});
		const reconcileResponse = apiReconcileDeploymentResponse.parse({
			composeId: "compose-1",
			operationId: "operation-1",
			sourceRevision: revision,
			resolvedRevision: null,
			operationStatus: "accepted",
			deployment: null,
			queue: { state: "queue-empty" },
			repairPerformed: false,
			createdAt: "2026-07-20T00:00:00.000Z",
			updatedAt: "2026-07-20T00:00:00.000Z",
			checkedAt: "2026-07-20T00:00:00.000Z",
		});
		const serialized = JSON.stringify({ envResponse, reconcileResponse });

		expect(serialized).not.toMatch(
			/"env"|idempotencyKey|logPath|errorMessage|queuePayload|"data"/,
		);
	});
});

import { readFileSync } from "node:fs";

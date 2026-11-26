import { db } from "@dokploy/server/db";
import {
	type DeploymentFreeze,
	deploymentFreeze,
	user,
} from "@dokploy/server/db/schema";
import {
	type DeployFreezeState,
	type DeploymentFreezeSkipSource,
	formatDeployFrozenMessage,
	isDeployFreezeActive,
	MAX_FREEZE_DURATION_MINUTES,
	sanitizeFreezeReason,
	toDeployFreezeState,
} from "@dokploy/server/utils/deployments/deploy-freeze-shared";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

export type DeployFreezeTargetScope = "application" | "compose";

export interface DeploymentFreezeActor {
	userId: string;
	label: string | null;
	authMethod: "session" | "api-key";
}

export async function getActiveDeploymentFreeze(
	scopeType: DeployFreezeTargetScope,
	scopeId: string,
	now = new Date(),
): Promise<DeploymentFreeze | null> {
	const rows = await db
		.select()
		.from(deploymentFreeze)
		.where(
			and(
				eq(deploymentFreeze.scopeType, scopeType),
				eq(deploymentFreeze.scopeId, scopeId),
				isNull(deploymentFreeze.liftedAt),
			),
		)
		.limit(1);
	const row = rows[0];
	return row && isDeployFreezeActive(row, now) ? row : null;
}

export async function getActiveDeploymentFreezesByIds(
	scopeType: DeployFreezeTargetScope,
	scopeIds: string[],
	now = new Date(),
): Promise<Map<string, DeploymentFreeze>> {
	if (scopeIds.length === 0) {
		return new Map();
	}
	const uniqueIds = Array.from(new Set(scopeIds));
	const rows = await db
		.select()
		.from(deploymentFreeze)
		.where(
			and(
				eq(deploymentFreeze.scopeType, scopeType),
				inArray(deploymentFreeze.scopeId, uniqueIds),
				isNull(deploymentFreeze.liftedAt),
			),
		);
	const result = new Map<string, DeploymentFreeze>();
	for (const row of rows) {
		if (isDeployFreezeActive(row, now)) {
			result.set(row.scopeId, row);
		}
	}
	return result;
}

export async function formatUserActorLabel(
	userId: string,
	fallbackEmail?: string | null,
): Promise<string | null> {
	const rows = await db
		.select({
			firstName: user.firstName,
			lastName: user.lastName,
			email: user.email,
		})
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	const found = rows[0];
	if (!found) {
		return fallbackEmail?.trim() || null;
	}
	const fullName = [found.firstName, found.lastName]
		.filter((part): part is string => Boolean(part?.trim()))
		.join(" ")
		.trim();
	return fullName || found.email?.trim() || fallbackEmail?.trim() || null;
}

export async function setDeploymentFreeze(input: {
	scopeType: DeployFreezeTargetScope;
	scopeId: string;
	frozen: boolean;
	durationMinutes?: number | null;
	reason?: string | null;
	actor: DeploymentFreezeActor;
}): Promise<DeploymentFreeze | null> {
	if (!input.frozen) {
		if (
			input.durationMinutes != null ||
			(input.reason != null && input.reason.trim() !== "")
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"durationMinutes and reason cannot be set when resuming deployments",
			});
		}
		const nowIso = new Date().toISOString();
		await db.transaction(async (tx) => {
			await tx
				.update(deploymentFreeze)
				.set({
					liftedAt: nowIso,
					liftedByUserId: input.actor.userId,
				})
				.where(
					and(
						eq(deploymentFreeze.scopeType, input.scopeType),
						eq(deploymentFreeze.scopeId, input.scopeId),
						isNull(deploymentFreeze.liftedAt),
					),
				);
		});
		return null;
	}

	if (
		input.durationMinutes != null &&
		(!Number.isInteger(input.durationMinutes) ||
			input.durationMinutes < 1 ||
			input.durationMinutes > MAX_FREEZE_DURATION_MINUTES)
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `durationMinutes must be an integer between 1 and ${MAX_FREEZE_DURATION_MINUTES}`,
		});
	}

	let sanitizedReason: string | null = null;
	try {
		sanitizedReason = sanitizeFreezeReason(input.reason);
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				error instanceof Error ? error.message : "Invalid deploy freeze reason",
		});
	}

	const now = new Date();
	const nowIso = now.toISOString();
	const expiresAt =
		input.durationMinutes != null
			? new Date(now.getTime() + input.durationMinutes * 60_000).toISOString()
			: null;

	return db.transaction(async (tx) => {
		const existingRows = await tx
			.select()
			.from(deploymentFreeze)
			.where(
				and(
					eq(deploymentFreeze.scopeType, input.scopeType),
					eq(deploymentFreeze.scopeId, input.scopeId),
					isNull(deploymentFreeze.liftedAt),
				),
			)
			.limit(1);
		const existing = existingRows[0];

		if (existing) {
			if (!isDeployFreezeActive(existing, now)) {
				// Close expired row cleanly before inserting a fresh freeze so partial unique index stays free.
				await tx
					.update(deploymentFreeze)
					.set({
						liftedAt: existing.expiresAt ?? nowIso,
						liftedByUserId: null,
					})
					.where(eq(deploymentFreeze.freezeId, existing.freezeId));
			} else {
				const updatedRows = await tx
					.update(deploymentFreeze)
					.set({
						expiresAt,
						reason: sanitizedReason,
						createdByUserId: input.actor.userId,
						createdByLabel: input.actor.label,
						createdByAuthMethod: input.actor.authMethod,
					})
					.where(eq(deploymentFreeze.freezeId, existing.freezeId))
					.returning();
				return updatedRows[0] ?? null;
			}
		}

		const insertedRows = await tx
			.insert(deploymentFreeze)
			.values({
				scopeType: input.scopeType,
				scopeId: input.scopeId,
				reason: sanitizedReason,
				createdByUserId: input.actor.userId,
				createdByLabel: input.actor.label,
				createdByAuthMethod: input.actor.authMethod,
				createdAt: nowIso,
				expiresAt,
				skippedCount: 0,
			})
			.returning();
		return insertedRows[0] ?? null;
	});
}

export async function recordSkippedDeploymentFreeze(
	scopeType: DeployFreezeTargetScope,
	scopeId: string,
	source: DeploymentFreezeSkipSource,
	now = new Date(),
): Promise<void> {
	const nowIso = now.toISOString();
	try {
		await db
			.update(deploymentFreeze)
			.set({
				skippedCount: sql`${deploymentFreeze.skippedCount} + 1`,
				lastSkippedAt: nowIso,
				lastSkippedSource: source,
			})
			.where(
				and(
					eq(deploymentFreeze.scopeType, scopeType),
					eq(deploymentFreeze.scopeId, scopeId),
					isNull(deploymentFreeze.liftedAt),
					or(
						isNull(deploymentFreeze.expiresAt),
						gt(deploymentFreeze.expiresAt, nowIso),
					),
				),
			);
	} catch (error) {
		console.warn("[deploy-freeze] Failed to record skipped deploy:", error);
	}
}

export async function deleteDeploymentFreezesForScope(
	scopeType: DeployFreezeTargetScope,
	scopeId: string,
): Promise<void> {
	await db
		.delete(deploymentFreeze)
		.where(
			and(
				eq(deploymentFreeze.scopeType, scopeType),
				eq(deploymentFreeze.scopeId, scopeId),
			),
		);
}

export async function assertDeploymentNotFrozen(input: {
	scopeType: DeployFreezeTargetScope;
	scopeId: string;
	force?: boolean;
	source: DeploymentFreezeSkipSource;
}): Promise<DeployFreezeState | null> {
	const now = new Date();
	const active = await getActiveDeploymentFreeze(
		input.scopeType,
		input.scopeId,
		now,
	);
	if (!active) {
		return null;
	}
	const state = toDeployFreezeState(active, { includeActorLabel: false, now });
	if (!state) {
		return null;
	}
	if (input.force === true) {
		return state;
	}
	await recordSkippedDeploymentFreeze(
		input.scopeType,
		input.scopeId,
		input.source,
		now,
	);
	throw new TRPCError({
		code: "PRECONDITION_FAILED",
		message: formatDeployFrozenMessage(state),
	});
}

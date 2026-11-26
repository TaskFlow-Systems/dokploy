import { sql } from "drizzle-orm";
import {
	index,
	integer,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
	type DeploymentFreezeScopeType,
	type DeploymentFreezeSkipSource,
	MAX_FREEZE_DURATION_MINUTES,
	MAX_FREEZE_REASON_LENGTH,
} from "../../utils/deployments/deploy-freeze-shared";

export const deploymentFreeze = pgTable(
	"deployment_freeze",
	{
		freezeId: text("freezeId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		scopeType: text("scopeType").$type<DeploymentFreezeScopeType>().notNull(),
		scopeId: text("scopeId").notNull(),
		reason: text("reason"),
		createdByUserId: text("createdByUserId"),
		createdByLabel: text("createdByLabel"),
		createdByAuthMethod: text("createdByAuthMethod")
			.notNull()
			.default("session"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		expiresAt: text("expiresAt"),
		liftedAt: text("liftedAt"),
		liftedByUserId: text("liftedByUserId"),
		skippedCount: integer("skippedCount").notNull().default(0),
		lastSkippedAt: text("lastSkippedAt"),
		lastSkippedSource:
			text("lastSkippedSource").$type<DeploymentFreezeSkipSource>(),
	},
	(table) => [
		uniqueIndex("deployment_freeze_active_scope_uidx")
			.on(table.scopeType, table.scopeId)
			.where(sql`${table.liftedAt} IS NULL`),
		index("deployment_freeze_scope_created_idx").on(
			table.scopeType,
			table.scopeId,
			table.createdAt,
		),
	],
);

export type DeploymentFreeze = typeof deploymentFreeze.$inferSelect;

export const apiDeployFreezeState = z.object({
	active: z.literal(true),
	frozenAt: z.string(),
	expiresAt: z.string().nullable(),
	reason: z.string().nullable(),
	frozenByLabel: z.string().nullable(),
	skippedCount: z.number().int().nonnegative(),
	lastSkippedAt: z.string().nullable(),
	lastSkippedSource: z.enum(["webhook", "api", "queue"]).nullable(),
});

export const apiSetComposeDeployFreeze = z.object({
	composeId: z.string().min(1),
	frozen: z.boolean(),
	durationMinutes: z
		.number()
		.int()
		.min(1)
		.max(MAX_FREEZE_DURATION_MINUTES)
		.nullable()
		.optional(),
	reason: z.string().max(MAX_FREEZE_REASON_LENGTH).nullable().optional(),
});

export const apiSetApplicationDeployFreeze = z.object({
	applicationId: z.string().min(1),
	frozen: z.boolean(),
	durationMinutes: z
		.number()
		.int()
		.min(1)
		.max(MAX_FREEZE_DURATION_MINUTES)
		.nullable()
		.optional(),
	reason: z.string().max(MAX_FREEZE_REASON_LENGTH).nullable().optional(),
});

export const apiSetDeployFreezeResponse = z.object({
	serviceId: z.string(),
	serviceType: z.enum(["compose", "application"]),
	deployFreeze: apiDeployFreezeState.nullable(),
});

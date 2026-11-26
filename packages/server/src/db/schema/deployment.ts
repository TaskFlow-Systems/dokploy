import { relations } from "drizzle-orm";
import {
	type AnyPgColumn,
	boolean,
	pgEnum,
	pgTable,
	text,
	unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { applications } from "./application";
import { backups } from "./backups";
import { compose } from "./compose";
import { previewDeployments } from "./preview-deployments";
import { rollbacks } from "./rollbacks";
import { schedules } from "./schedule";
import { server } from "./server";
import { volumeBackups } from "./volume-backups";
export const deploymentStatus = pgEnum("deploymentStatus", [
	"running",
	"done",
	"error",
	"cancelled",
]);

export const deploymentOperationStatus = pgEnum("deploymentOperationStatus", [
	"accepted",
	"queued",
	"dispatch_unknown",
	"running",
	"succeeded",
	"failed",
]);

export const deployments = pgTable("deployment", {
	deploymentId: text("deploymentId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	title: text("title").notNull(),
	description: text("description"),
	status: deploymentStatus("status").default("running"),
	logPath: text("logPath").notNull(),
	pid: text("pid"),
	applicationId: text("applicationId").references(
		() => applications.applicationId,
		{ onDelete: "cascade" },
	),
	composeId: text("composeId").references(() => compose.composeId, {
		onDelete: "cascade",
	}),
	serverId: text("serverId").references(() => server.serverId, {
		onDelete: "cascade",
	}),
	isPreviewDeployment: boolean("isPreviewDeployment").default(false),
	previewDeploymentId: text("previewDeploymentId").references(
		(): AnyPgColumn => previewDeployments.previewDeploymentId,
		{ onDelete: "cascade" },
	),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	startedAt: text("startedAt"),
	finishedAt: text("finishedAt"),
	errorMessage: text("errorMessage"),
	scheduleId: text("scheduleId").references(
		(): AnyPgColumn => schedules.scheduleId,
		{ onDelete: "cascade" },
	),
	backupId: text("backupId").references((): AnyPgColumn => backups.backupId, {
		onDelete: "cascade",
	}),
	rollbackId: text("rollbackId").references(
		(): AnyPgColumn => rollbacks.rollbackId,
		{ onDelete: "cascade" },
	),
	volumeBackupId: text("volumeBackupId").references(
		(): AnyPgColumn => volumeBackups.volumeBackupId,
		{ onDelete: "cascade" },
	),
	buildServerId: text("buildServerId").references(() => server.serverId, {
		onDelete: "cascade",
	}),
});

export const deploymentOperations = pgTable(
	"deploymentOperation",
	{
		operationId: text("operationId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		composeId: text("composeId")
			.notNull()
			.references(() => compose.composeId, { onDelete: "cascade" }),
		idempotencyKeyHash: text("idempotencyKeyHash").notNull(),
		sourceRevision: text("sourceRevision").notNull(),
		resolvedRevision: text("resolvedRevision"),
		envRevision: text("envRevision").notNull(),
		status: deploymentOperationStatus("status").notNull().default("accepted"),
		deploymentId: text("deploymentId").references(
			() => deployments.deploymentId,
			{ onDelete: "set null" },
		),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		startedAt: text("startedAt"),
		finishedAt: text("finishedAt"),
	},
	(table) => [
		unique("deployment_operation_compose_key_unique").on(
			table.composeId,
			table.idempotencyKeyHash,
		),
		unique("deployment_operation_deployment_unique").on(table.deploymentId),
	],
);

export const deploymentOperationsRelations = relations(
	deploymentOperations,
	({ one }) => ({
		compose: one(compose, {
			fields: [deploymentOperations.composeId],
			references: [compose.composeId],
		}),
		deployment: one(deployments, {
			fields: [deploymentOperations.deploymentId],
			references: [deployments.deploymentId],
		}),
	}),
);

export const deploymentsRelations = relations(deployments, ({ one }) => ({
	application: one(applications, {
		fields: [deployments.applicationId],
		references: [applications.applicationId],
	}),
	compose: one(compose, {
		fields: [deployments.composeId],
		references: [compose.composeId],
	}),
	server: one(server, {
		fields: [deployments.serverId],
		references: [server.serverId],
		relationName: "deploymentServer",
	}),
	buildServer: one(server, {
		fields: [deployments.buildServerId],
		references: [server.serverId],
		relationName: "deploymentBuildServer",
	}),
	previewDeployment: one(previewDeployments, {
		fields: [deployments.previewDeploymentId],
		references: [previewDeployments.previewDeploymentId],
	}),
	schedule: one(schedules, {
		fields: [deployments.scheduleId],
		references: [schedules.scheduleId],
	}),
	backup: one(backups, {
		fields: [deployments.backupId],
		references: [backups.backupId],
	}),
	rollback: one(rollbacks, {
		fields: [deployments.deploymentId],
		references: [rollbacks.deploymentId],
	}),
	volumeBackup: one(volumeBackups, {
		fields: [deployments.volumeBackupId],
		references: [volumeBackups.volumeBackupId],
	}),
}));

const schema = createInsertSchema(deployments, {
	title: z.string().min(1),
	status: z.string().default("running").nullable().optional(),
	logPath: z.string().min(1),
	applicationId: z.string().nullable().optional(),
	composeId: z.string().nullable().optional(),
	description: z.string().nullable().optional(),
	previewDeploymentId: z.string().nullable().optional(),
	buildServerId: z.string().nullable().optional(),
});
export const apiCreateDeployment = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		applicationId: true,
		description: true,
	})
	.extend({
		applicationId: z.string().min(1),
	});

export const apiCreateDeploymentPreview = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		description: true,
		previewDeploymentId: true,
	})
	.extend({
		previewDeploymentId: z.string().min(1),
	});

export const apiCreateDeploymentCompose = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		composeId: true,
		description: true,
	})
	.extend({
		composeId: z.string().min(1),
	});

export const apiCreateDeploymentBackup = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		backupId: true,
		description: true,
	})
	.extend({
		backupId: z.string().min(1),
	});

export const apiCreateDeploymentServer = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		serverId: true,
		description: true,
	})
	.extend({
		serverId: z.string().min(1),
	});

export const apiCreateDeploymentSchedule = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		description: true,
	})
	.extend({
		scheduleId: z.string().min(1),
	});

export const apiCreateDeploymentVolumeBackup = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		description: true,
	})
	.extend({
		volumeBackupId: z.string().min(1),
	});

export const apiFindAllByApplication = z.object({
	applicationId: z.string().min(1),
});

export const apiFindAllByCompose = z.object({
	composeId: z.string().min(1),
});

export const apiFindAllByServer = z.object({
	serverId: z.string().min(1),
});

export const apiFindAllByType = z.object({
	id: z.string().min(1),
	type: z.enum([
		"application",
		"compose",
		"server",
		"schedule",
		"previewDeployment",
		"backup",
		"volumeBackup",
	]),
});

export const apiReconcileDeployment = z.object({
	composeId: z.string().min(1),
	operationId: z.string().min(1),
	repair: z.boolean().optional().default(false),
	force: z.boolean().optional(),
});

export const apiReconcileDeploymentResponse = z.object({
	composeId: z.string(),
	operationId: z.string(),
	sourceRevision: z.string(),
	resolvedRevision: z.string().nullable(),
	operationStatus: z.enum([
		"accepted",
		"queued",
		"dispatch_unknown",
		"running",
		"succeeded",
		"failed",
	]),
	deployment: z
		.object({
			deploymentId: z.string(),
			status: z.enum(["running", "done", "error", "cancelled"]).nullable(),
			startedAt: z.string().nullable(),
			finishedAt: z.string().nullable(),
		})
		.nullable(),
	queue: z.object({
		state: z.enum(["queued", "active", "queue-empty", "queue-unavailable"]),
		reasonCode: z
			.enum([
				"not-configured",
				"network-error",
				"remote-error",
				"invalid-response",
			])
			.optional(),
	}),
	repairPerformed: z.boolean(),
	createdAt: z.string(),
	updatedAt: z.string(),
	checkedAt: z.string(),
});

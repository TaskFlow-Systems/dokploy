import { relations } from "drizzle-orm";
import {
	bigint,
	boolean,
	integer,
	json,
	pgTable,
	text,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { backups } from "./backups";
import { environments } from "./environment";
import { mounts } from "./mount";
import { server } from "./server";
import {
	applicationStatus,
	type EndpointSpecSwarm,
	EndpointSpecSwarmSchema,
	type HealthCheckSwarm,
	HealthCheckSwarmSchema,
	type LabelsSwarm,
	LabelsSwarmSchema,
	type NetworkSwarm,
	NetworkSwarmSchema,
	type PlacementSwarm,
	PlacementSwarmSchema,
	type RestartPolicySwarm,
	RestartPolicySwarmSchema,
	type ServiceModeSwarm,
	ServiceModeSwarmSchema,
	sqldNode,
	type UpdateConfigSwarm,
	UpdateConfigSwarmSchema,
} from "./shared";
import {
	APP_NAME_MESSAGE,
	APP_NAME_REGEX,
	DATABASE_PASSWORD_MESSAGE,
	DATABASE_PASSWORD_REGEX,
	encryptedText,
	generateAppName,
} from "./utils";

export const LIBSQL_DEFAULT_IMAGE =
	"ghcr.io/tursodatabase/libsql-server:v0.24.32";

export const libsql = pgTable("libsql", {
	libsqlId: text("libsqlId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	name: text("name").notNull(),
	appName: text("appName")
		.notNull()
		.$defaultFn(() => generateAppName("libsql"))
		.unique(),
	description: text("description"),
	databaseUser: text("databaseUser").notNull(),
	databasePassword: text("databasePassword").notNull(),
	sqldNode: sqldNode("sqldNode").notNull().default("primary"),
	sqldPrimaryUrl: text("sqldPrimaryUrl"),
	enableNamespaces: boolean("enableNamespaces").notNull().default(false),
	dockerImage: text("dockerImage").notNull(),
	command: text("command"),
	env: encryptedText("env"),
	// RESOURCES
	memoryReservation: text("memoryReservation"),
	memoryLimit: text("memoryLimit"),
	cpuReservation: text("cpuReservation"),
	cpuLimit: text("cpuLimit"),
	//
	externalPort: integer("externalPort"),
	externalGRPCPort: integer("externalGRPCPort"),
	externalAdminPort: integer("externalAdminPort"),
	applicationStatus: applicationStatus("applicationStatus")
		.notNull()
		.default("idle"),
	healthCheckSwarm: json("healthCheckSwarm").$type<HealthCheckSwarm>(),
	restartPolicySwarm: json("restartPolicySwarm").$type<RestartPolicySwarm>(),
	placementSwarm: json("placementSwarm").$type<PlacementSwarm>(),
	updateConfigSwarm: json("updateConfigSwarm").$type<UpdateConfigSwarm>(),
	rollbackConfigSwarm: json("rollbackConfigSwarm").$type<UpdateConfigSwarm>(),
	modeSwarm: json("modeSwarm").$type<ServiceModeSwarm>(),
	labelsSwarm: json("labelsSwarm").$type<LabelsSwarm>(),
	networkSwarm: json("networkSwarm").$type<NetworkSwarm[]>(),
	stopGracePeriodSwarm: bigint("stopGracePeriodSwarm", { mode: "number" }),
	endpointSpecSwarm: json("endpointSpecSwarm").$type<EndpointSpecSwarm>(),
	replicas: integer("replicas").default(1).notNull(),
	networkIds: text("networkIds").array().default([]),
	detachDokployNetwork: boolean("detachDokployNetwork")
		.notNull()
		.default(false),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),

	environmentId: text("environmentId")
		.notNull()
		.references(() => environments.environmentId, { onDelete: "cascade" }),
	serverId: text("serverId").references(() => server.serverId, {
		onDelete: "cascade",
	}),
});

export const libsqlRelations = relations(libsql, ({ one, many }) => ({
	environment: one(environments, {
		fields: [libsql.environmentId],
		references: [environments.environmentId],
	}),
	backups: many(backups),
	mounts: many(mounts),
	server: one(server, {
		fields: [libsql.serverId],
		references: [server.serverId],
	}),
}));

const createSchema = createInsertSchema(libsql, {
	libsqlId: z.string().optional(),
	name: z.string().min(1),
	appName: z
		.string()
		.min(1)
		.max(63)
		.regex(APP_NAME_REGEX, APP_NAME_MESSAGE)
		.optional(),
	createdAt: z.string().optional(),
	databaseUser: z.string().min(1),
	databasePassword: z.string().regex(DATABASE_PASSWORD_REGEX, {
		message: DATABASE_PASSWORD_MESSAGE,
	}),
	sqldNode: z.enum(sqldNode.enumValues).optional(),
	sqldPrimaryUrl: z.string().nullable().optional(),
	enableNamespaces: z.boolean().default(false).optional(),
	dockerImage: z.string().default(LIBSQL_DEFAULT_IMAGE),
	command: z.string().nullable().optional(),
	env: z.string().nullable().optional(),
	memoryReservation: z.string().nullable().optional(),
	memoryLimit: z.string().nullable().optional(),
	cpuReservation: z.string().nullable().optional(),
	cpuLimit: z.string().nullable().optional(),
	environmentId: z.string(),
	applicationStatus: z.enum(["idle", "running", "done", "error"]).optional(),
	externalPort: z.number().nullable().optional(),
	externalGRPCPort: z.number().nullable().optional(),
	externalAdminPort: z.number().nullable().optional(),
	description: z.string().nullable().optional(),
	serverId: z.string().nullable().optional(),
	healthCheckSwarm: HealthCheckSwarmSchema.nullable().optional(),
	restartPolicySwarm: RestartPolicySwarmSchema.nullable().optional(),
	placementSwarm: PlacementSwarmSchema.nullable().optional(),
	updateConfigSwarm: UpdateConfigSwarmSchema.nullable().optional(),
	rollbackConfigSwarm: UpdateConfigSwarmSchema.nullable().optional(),
	modeSwarm: ServiceModeSwarmSchema.nullable().optional(),
	labelsSwarm: LabelsSwarmSchema.nullable().optional(),
	networkSwarm: NetworkSwarmSchema.nullable().optional(),
	stopGracePeriodSwarm: z.number().nullable().optional(),
	endpointSpecSwarm: EndpointSpecSwarmSchema.nullable().optional(),
	networkIds: z.array(z.string()).nullable().optional(),
	detachDokployNetwork: z.boolean().optional(),
});

export const apiCreateLibsql = createSchema
	.pick({
		name: true,
		appName: true,
		dockerImage: true,
		environmentId: true,
		description: true,
		databaseUser: true,
		databasePassword: true,
		sqldNode: true,
		sqldPrimaryUrl: true,
		enableNamespaces: true,
		serverId: true,
	})
	.required()
	.superRefine((data, ctx) => {
		if (data.sqldNode === "replica" && !data.sqldPrimaryUrl) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["sqldPrimaryUrl"],
				message: "sqldPrimaryUrl is required when sqldNode is 'replica'.",
			});
		}
		if (data.sqldNode !== "replica" && data.sqldPrimaryUrl) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["sqldPrimaryUrl"],
				message:
					"sqldPrimaryUrl should not be provided when sqldNode is not 'replica'.",
			});
		}
	});

export const apiFindOneLibsql = z.object({
	libsqlId: z.string().min(1),
});

export const apiChangeLibsqlStatus = createSchema
	.pick({
		libsqlId: true,
		applicationStatus: true,
	})
	.required();

export const apiSaveEnvironmentVariablesLibsql = createSchema
	.pick({
		libsqlId: true,
		env: true,
	})
	.required();

export const apiSaveExternalPortsLibsql = createSchema
	.pick({
		libsqlId: true,
		externalPort: true,
		externalGRPCPort: true,
		externalAdminPort: true,
	})
	.required({ libsqlId: true })
	.superRefine((data, ctx) => {
		if (
			data.externalPort === null &&
			data.externalGRPCPort === null &&
			data.externalAdminPort === null
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					"Either externalPort, externalGRPCPort or externalAdminPort must be provided.",
				path: ["externalPort", "externalGRPCPort", "externalAdminPort"],
			});
		}
	});

export const apiDeployLibsql = createSchema
	.pick({
		libsqlId: true,
	})
	.required();

export const apiResetLibsql = createSchema
	.pick({
		libsqlId: true,
		appName: true,
	})
	.required();

export const apiUpdateLibsql = createSchema
	.partial()
	.extend({
		libsqlId: z.string().min(1),
		// .partial() keeps a default, which would then overwrite the stored value on
		// every update that does not send the field.
		enableNamespaces: z.boolean().optional(),
		dockerImage: z.string().optional(),
	})
	.omit({ serverId: true, environmentId: true });

export const apiRebuildLibsql = createSchema
	.pick({
		libsqlId: true,
	})
	.required();

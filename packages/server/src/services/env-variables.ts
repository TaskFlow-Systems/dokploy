import { randomBytes, randomInt } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	type apiEnvApply,
	type apiEnvKeys,
	applications,
	compose,
	type EnvField,
	type EnvGenerateFormat,
	type EnvScope,
	environments,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	projects,
	redis,
} from "@dokploy/server/db/schema";
import { isEncrypted } from "@dokploy/server/lib/encryption";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { applyEnvLayout, readEnvLayout } from "../utils/env-layout";
import {
	applyEnvChanges,
	assertNoRedactedSecretPlaceholders,
	type EnvChange,
	getApplicationEnvRevision,
	getComposeEnvRevision,
	getEnvFieldRevision,
	getEnvVariableValue,
	listEnvVariables,
} from "../utils/env-upsert";

type EnvTarget = {
	scope: EnvScope;
	id: string;
	field: EnvField;
};

type EnvReader = Pick<typeof db, "select">;

const ENV_TABLES: Record<
	EnvScope,
	{
		table: PgTable;
		idColumn: AnyPgColumn;
		fields: Partial<Record<EnvField, AnyPgColumn>>;
	}
> = {
	application: {
		table: applications,
		idColumn: applications.applicationId,
		fields: {
			env: applications.env,
			buildArgs: applications.buildArgs,
			buildSecrets: applications.buildSecrets,
		},
	},
	compose: {
		table: compose,
		idColumn: compose.composeId,
		fields: { env: compose.env },
	},
	postgres: {
		table: postgres,
		idColumn: postgres.postgresId,
		fields: { env: postgres.env },
	},
	mysql: {
		table: mysql,
		idColumn: mysql.mysqlId,
		fields: { env: mysql.env },
	},
	mariadb: {
		table: mariadb,
		idColumn: mariadb.mariadbId,
		fields: { env: mariadb.env },
	},
	mongo: {
		table: mongo,
		idColumn: mongo.mongoId,
		fields: { env: mongo.env },
	},
	redis: {
		table: redis,
		idColumn: redis.redisId,
		fields: { env: redis.env },
	},
	libsql: {
		table: libsql,
		idColumn: libsql.libsqlId,
		fields: { env: libsql.env },
	},
	project: {
		table: projects,
		idColumn: projects.projectId,
		fields: { env: projects.env },
	},
	environment: {
		table: environments,
		idColumn: environments.environmentId,
		fields: { env: environments.env },
	},
};

const serviceOwner = {
	columns: { name: true, appName: true },
	with: {
		environment: {
			columns: { environmentId: true },
			with: { project: { columns: { organizationId: true } } },
		},
	},
} as const;

const SERVICE_OWNERS = {
	application: (id: string) =>
		db.query.applications.findFirst({
			where: eq(applications.applicationId, id),
			...serviceOwner,
		}),
	compose: (id: string) =>
		db.query.compose.findFirst({
			where: eq(compose.composeId, id),
			...serviceOwner,
		}),
	postgres: (id: string) =>
		db.query.postgres.findFirst({
			where: eq(postgres.postgresId, id),
			...serviceOwner,
		}),
	mysql: (id: string) =>
		db.query.mysql.findFirst({
			where: eq(mysql.mysqlId, id),
			...serviceOwner,
		}),
	mariadb: (id: string) =>
		db.query.mariadb.findFirst({
			where: eq(mariadb.mariadbId, id),
			...serviceOwner,
		}),
	mongo: (id: string) =>
		db.query.mongo.findFirst({
			where: eq(mongo.mongoId, id),
			...serviceOwner,
		}),
	redis: (id: string) =>
		db.query.redis.findFirst({
			where: eq(redis.redisId, id),
			...serviceOwner,
		}),
	libsql: (id: string) =>
		db.query.libsql.findFirst({
			where: eq(libsql.libsqlId, id),
			...serviceOwner,
		}),
};

const ALPHANUMERIC =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const notFound = (scope: EnvScope) =>
	new TRPCError({
		code: "NOT_FOUND",
		message: `No ${scope} found with this id`,
	});

const badRequest = (error: unknown) =>
	new TRPCError({
		code: "BAD_REQUEST",
		message:
			error instanceof Error ? error.message : "Invalid environment variables",
	});

export const findEnvVariablesOwner = async (scope: EnvScope, id: string) => {
	if (scope === "project") {
		const project = await db.query.projects.findFirst({
			where: eq(projects.projectId, id),
			columns: { name: true, organizationId: true },
		});
		if (!project) {
			throw notFound(scope);
		}
		return {
			organizationId: project.organizationId,
			resourceName: project.name,
		};
	}

	if (scope === "environment") {
		const environment = await db.query.environments.findFirst({
			where: eq(environments.environmentId, id),
			columns: { name: true },
			with: { project: { columns: { organizationId: true } } },
		});
		if (!environment) {
			throw notFound(scope);
		}
		return {
			organizationId: environment.project.organizationId,
			resourceName: environment.name,
		};
	}

	const service = await SERVICE_OWNERS[scope](id);
	if (!service) {
		throw notFound(scope);
	}
	return {
		organizationId: service.environment.project.organizationId,
		resourceName: scope === "compose" ? service.name : service.appName,
	};
};

const getEnvTargetRevision = ({ scope, id, field }: EnvTarget, env: string) => {
	if (scope === "application" && field === "env") {
		return getApplicationEnvRevision(id, env);
	}
	if (scope === "compose") {
		return getComposeEnvRevision(id, env);
	}
	return getEnvFieldRevision(scope, id, field, env);
};

const getEnvColumn = ({ scope, field }: EnvTarget) => {
	const column = ENV_TABLES[scope].fields[field];
	if (!column) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Field ${field} is only available for the application scope, not ${scope}`,
		});
	}
	return column;
};

const readEnvText = async (
	reader: EnvReader,
	target: EnvTarget,
	lock: boolean,
) => {
	const { table, idColumn } = ENV_TABLES[target.scope];
	const query = reader
		.select({ text: getEnvColumn(target) })
		.from(table)
		.where(eq(idColumn, target.id));
	const [row] = await (lock ? query.for("update") : query);

	if (!row) {
		throw notFound(target.scope);
	}

	const text = typeof row.text === "string" ? row.text : "";
	// The column read falls back to the ciphertext when it cannot be decrypted;
	// editing that would store the new variables next to it in plain text.
	if (isEncrypted(text)) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: `The stored ${target.field} of this ${target.scope} cannot be decrypted, so it cannot be read or edited`,
		});
	}

	return text;
};

const writeEnvText = async (
	writer: Pick<typeof db, "update">,
	target: EnvTarget,
	env: string,
) => {
	const { table, idColumn } = ENV_TABLES[target.scope];
	await writer
		.update(table)
		.set({ [target.field]: env })
		.where(eq(idColumn, target.id));
};

const generateEnvValue = (length: number, format: EnvGenerateFormat) => {
	if (format === "alphanumeric") {
		return Array.from(
			{ length },
			() => ALPHANUMERIC[randomInt(ALPHANUMERIC.length)],
		).join("");
	}
	return randomBytes(length).toString(format).slice(0, length);
};

export const listEnvVariableKeys = async (
	input: z.infer<typeof apiEnvKeys>,
) => {
	const target = { scope: input.scope, id: input.id, field: input.field };
	const env = await readEnvText(db, target, false);

	return {
		...target,
		revision: getEnvTargetRevision(target, env),
		variables: listEnvVariables(env),
	};
};

export const listEnvVariableLayout = async (
	input: z.infer<typeof apiEnvKeys>,
) => {
	const target = { scope: input.scope, id: input.id, field: input.field };
	const env = await readEnvText(db, target, false);

	let layout: ReturnType<typeof readEnvLayout>;
	try {
		layout = readEnvLayout(env);
	} catch (error) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: error instanceof Error ? error.message : "Invalid env layout",
		});
	}

	return {
		...target,
		revision: getEnvTargetRevision(target, env),
		variables: listEnvVariables(env),
		layout,
	};
};

const applyLayoutChange = (
	currentEnv: string,
	layout: NonNullable<z.infer<typeof apiEnvApply>["layout"]>,
) => {
	const texts = Object.fromEntries(
		layout.flatMap((item, index) =>
			item.type === "comment" && item.text !== undefined
				? [[`layout[${index}]`, item.text]]
				: [],
		),
	);
	try {
		assertNoRedactedSecretPlaceholders(texts);
		return applyEnvLayout(currentEnv, layout);
	} catch (error) {
		throw badRequest(error);
	}
};

export const applyEnvVariableChanges = async (
	input: z.infer<typeof apiEnvApply>,
) => {
	const target = { scope: input.scope, id: input.id, field: input.field };
	const dryRun = input.dryRun ?? false;

	try {
		assertNoRedactedSecretPlaceholders(input.set ?? {});
	} catch (error) {
		throw badRequest(error);
	}

	return await db.transaction(async (tx) => {
		// The env columns are encrypted with a random IV, so they can't be compared
		// in SQL; the row lock is what makes the revision check and write atomic.
		const currentEnv = await readEnvText(tx, target, true);
		const currentRevision = getEnvTargetRevision(target, currentEnv);

		if (input.expectedRevision && input.expectedRevision !== currentRevision) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Environment revision does not match",
			});
		}

		if (input.layout) {
			const result = applyLayoutChange(currentEnv, input.layout);
			const summary = {
				...target,
				changed: result.changed,
				dryRun,
				variables: [],
				layout: result.layout,
			};
			if (dryRun || !result.changed) {
				return { ...summary, revision: currentRevision };
			}
			await writeEnvText(tx, target, result.env);
			return { ...summary, revision: getEnvTargetRevision(target, result.env) };
		}

		const sourceKey = (source: EnvTarget) =>
			`${source.scope}:${source.field}:${source.id}`;
		const sourceEnvs = new Map([[sourceKey(target), currentEnv]]);
		const changes: EnvChange[] = Object.entries(input.set ?? {}).map(
			([name, value]) => ({ name, source: "set", value }),
		);

		for (const [name, options] of Object.entries(input.generate ?? {})) {
			changes.push({
				name,
				source: "generate",
				value: dryRun ? null : generateEnvValue(options.length, options.format),
			});
		}

		for (const [name, from] of Object.entries(input.copy ?? {})) {
			const source = {
				scope: from.fromScope,
				id: from.fromId,
				field: from.fromField,
			};
			const sourceEnv =
				sourceEnvs.get(sourceKey(source)) ??
				(await readEnvText(tx, source, false));
			sourceEnvs.set(sourceKey(source), sourceEnv);

			const value = getEnvVariableValue(sourceEnv, from.fromName);
			if (value === undefined) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Variable ${from.fromName} does not exist in ${source.field} of ${source.scope} ${source.id}`,
				});
			}
			changes.push({ name, source: "copy", value });
		}

		for (const name of new Set(input.remove ?? [])) {
			changes.push({ name, source: "remove" });
		}

		let result: ReturnType<typeof applyEnvChanges>;
		try {
			result = applyEnvChanges(currentEnv, changes);
		} catch (error) {
			throw badRequest(error);
		}

		const summary = {
			...target,
			changed: result.changed,
			dryRun,
			variables: result.variables,
		};
		if (dryRun || !result.changed) {
			return { ...summary, revision: currentRevision };
		}

		await writeEnvText(tx, target, result.env);

		return { ...summary, revision: getEnvTargetRevision(target, result.env) };
	});
};

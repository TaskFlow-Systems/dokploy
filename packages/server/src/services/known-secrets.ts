import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	environments,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	projects,
	redis,
	registry,
} from "@dokploy/server/db/schema";
import { collectComposeSecretValues } from "@dokploy/server/utils/security/compose-secrets";
import {
	buildKnownSecretMatcher,
	collectEnvSecretValues,
	collectSecretValue,
	type KnownSecretMatcher,
} from "@dokploy/server/utils/security/secret-scrub";

// A secret saved a moment ago only reaches a container after a redeploy, so a
// short-lived cache cannot let it slip through a log read.
const CACHE_TTL_MS = 30_000;

let cached: { matcher: KnownSecretMatcher; expiresAt: number } | null = null;
let pending: Promise<KnownSecretMatcher> | null = null;

const loadKnownSecretValues = async () => {
	const [
		applicationRows,
		composeRows,
		postgresRows,
		mysqlRows,
		mariadbRows,
		mongoRows,
		redisRows,
		libsqlRows,
		projectRows,
		environmentRows,
		registryRows,
	] = await Promise.all([
		db
			.select({
				env: applications.env,
				previewEnv: applications.previewEnv,
				buildArgs: applications.buildArgs,
				buildSecrets: applications.buildSecrets,
				previewBuildArgs: applications.previewBuildArgs,
				previewBuildSecrets: applications.previewBuildSecrets,
				password: applications.password,
			})
			.from(applications),
		db
			.select({ env: compose.env, composeFile: compose.composeFile })
			.from(compose),
		db
			.select({ env: postgres.env, password: postgres.databasePassword })
			.from(postgres),
		db
			.select({
				env: mysql.env,
				password: mysql.databasePassword,
				rootPassword: mysql.databaseRootPassword,
			})
			.from(mysql),
		db
			.select({
				env: mariadb.env,
				password: mariadb.databasePassword,
				rootPassword: mariadb.databaseRootPassword,
			})
			.from(mariadb),
		db.select({ env: mongo.env, password: mongo.databasePassword }).from(mongo),
		db.select({ env: redis.env, password: redis.databasePassword }).from(redis),
		db
			.select({ env: libsql.env, password: libsql.databasePassword })
			.from(libsql),
		db.select({ env: projects.env }).from(projects),
		db.select({ env: environments.env }).from(environments),
		db.select({ password: registry.password }).from(registry),
	]);

	const values: string[] = [];
	const addEnv = (...texts: (string | null | undefined)[]) => {
		for (const text of texts) {
			values.push(...collectEnvSecretValues(text));
		}
	};
	const addPassword = (...passwords: (string | null | undefined)[]) => {
		for (const password of passwords) {
			values.push(...collectSecretValue("PASSWORD", password));
		}
	};

	for (const row of applicationRows) {
		addEnv(
			row.env,
			row.previewEnv,
			row.buildArgs,
			row.buildSecrets,
			row.previewBuildArgs,
			row.previewBuildSecrets,
		);
		addPassword(row.password);
	}
	for (const row of composeRows) {
		addEnv(row.env);
		values.push(...collectComposeSecretValues(row.composeFile));
	}
	for (const row of [...projectRows, ...environmentRows]) {
		addEnv(row.env);
	}
	for (const row of [
		...postgresRows,
		...mongoRows,
		...redisRows,
		...libsqlRows,
	]) {
		addEnv(row.env);
		addPassword(row.password);
	}
	for (const row of [...mysqlRows, ...mariadbRows]) {
		addEnv(row.env);
		addPassword(row.password, row.rootPassword);
	}
	for (const row of registryRows) {
		addPassword(row.password);
	}

	return values;
};

/**
 * Every secret value the panel stores for services, projects and environments,
 * compiled into one matcher used to scrub API key responses. It covers the
 * whole instance: scrubbing another organization's secret is harmless, missing
 * one is not.
 */
export const getKnownSecretMatcher = async (): Promise<KnownSecretMatcher> => {
	if (cached && cached.expiresAt > Date.now()) {
		return cached.matcher;
	}
	pending ??= loadKnownSecretValues()
		.then((values) => {
			const matcher = buildKnownSecretMatcher(values);
			cached = { matcher, expiresAt: Date.now() + CACHE_TTL_MS };
			return matcher;
		})
		.finally(() => {
			pending = null;
		});
	return pending;
};

export const resetKnownSecretMatcherCache = () => {
	cached = null;
	pending = null;
};

import { db } from "@dokploy/server/db";
import {
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	redis,
} from "@dokploy/server/db/schema";
import { deployLibsql } from "@dokploy/server/services/libsql";
import { deployMariadb } from "@dokploy/server/services/mariadb";
import { deployMongo } from "@dokploy/server/services/mongo";
import { deployMySql } from "@dokploy/server/services/mysql";
import { deployPostgres } from "@dokploy/server/services/postgres";
import { deployRedis } from "@dokploy/server/services/redis";
import { eq } from "drizzle-orm";
import { removeService } from "../docker/utils";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import { quoteShellArgs, quoteShellArgument } from "../shell";
import { normalizeDockerVolumeName } from "../volume-backups/safe-input";

type DatabaseType =
	| "libsql"
	| "mariadb"
	| "mongo"
	| "mysql"
	| "postgres"
	| "redis";

// Swarm gives a container 10 s to stop by default and a service can ask for
// more, and a volume in use cannot be removed: the fixed 6 s this used to wait
// could leave the service removed and the Rebuild failed on `volume is in use`.
const waitForContainersGone = async (
	appName: string,
	serverId: string | null | undefined,
	limitMs: number,
) => {
	const seconds = Math.ceil(limitMs / 1000);
	const list = quoteShellArgs([
		"docker",
		"ps",
		"-aq",
		"--filter",
		`label=com.docker.swarm.service.name=${appName}`,
	]);
	const message = quoteShellArgument(
		`The containers of ${appName} did not stop within ${seconds} s, so its volumes were left as they are`,
	);
	const command = `i=0; while [ -n "$(${list})" ]; do i=$((i + 1)); if [ "$i" -gt ${seconds} ]; then echo ${message} >&2; exit 1; fi; sleep 1; done`;
	if (serverId) {
		await execAsyncRemote(serverId, command);
	} else {
		await execAsync(command);
	}
};

export const rebuildDatabase = async (
	databaseId: string,
	type: DatabaseType,
	stopLimitMs = 120_000,
) => {
	const database = await findDatabaseById(databaseId, type);

	if (!database) {
		throw new Error("Database not found");
	}

	await removeService(database.appName, database.serverId);
	if (stopLimitMs > 0) {
		await waitForContainersGone(
			database.appName,
			database.serverId,
			stopLimitMs,
		);
	}

	for (const mount of database.mounts) {
		if (mount.type === "volume") {
			const safeVolumeName = normalizeDockerVolumeName(mount.volumeName || "");
			const command = quoteShellArgs([
				"docker",
				"volume",
				"rm",
				safeVolumeName,
				"--force",
			]);
			if (database.serverId) {
				await execAsyncRemote(database.serverId, command);
			} else {
				await execAsync(command);
			}
		}
	}

	if (type === "libsql") {
		await deployLibsql(databaseId);
	} else if (type === "mariadb") {
		await deployMariadb(databaseId);
	} else if (type === "mongo") {
		await deployMongo(databaseId);
	} else if (type === "mysql") {
		await deployMySql(databaseId);
	} else if (type === "postgres") {
		await deployPostgres(databaseId);
	} else if (type === "redis") {
		await deployRedis(databaseId);
	}
};

const findDatabaseById = async (databaseId: string, type: DatabaseType) => {
	if (type === "libsql") {
		return await db.query.libsql.findFirst({
			where: eq(libsql.libsqlId, databaseId),
			with: {
				mounts: true,
			},
		});
	}
	if (type === "mariadb") {
		return await db.query.mariadb.findFirst({
			where: eq(mariadb.mariadbId, databaseId),
			with: {
				mounts: true,
			},
		});
	}
	if (type === "mongo") {
		return await db.query.mongo.findFirst({
			where: eq(mongo.mongoId, databaseId),
			with: {
				mounts: true,
			},
		});
	}
	if (type === "mysql") {
		return await db.query.mysql.findFirst({
			where: eq(mysql.mysqlId, databaseId),
			with: {
				mounts: true,
			},
		});
	}
	if (type === "postgres") {
		return await db.query.postgres.findFirst({
			where: eq(postgres.postgresId, databaseId),
			with: {
				mounts: true,
			},
		});
	}
	if (type === "redis") {
		return await db.query.redis.findFirst({
			where: eq(redis.redisId, databaseId),
			with: {
				mounts: true,
			},
		});
	}
};

import { useState } from "react";
import { api } from "@/utils/api";

type DatabaseType =
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis"
	| "libsql";

type Secrets = {
	databasePassword?: string;
	databaseRootPassword?: string;
};

const revealMutations = {
	postgres: () => api.postgres.revealCredentials.useMutation(),
	mysql: () => api.mysql.revealCredentials.useMutation(),
	mariadb: () => api.mariadb.revealCredentials.useMutation(),
	mongo: () => api.mongo.revealCredentials.useMutation(),
	redis: () => api.redis.revealCredentials.useMutation(),
	libsql: () => api.libsql.revealCredentials.useMutation(),
};

const idKeys = {
	postgres: "postgresId",
	mysql: "mysqlId",
	mariadb: "mariadbId",
	mongo: "mongoId",
	redis: "redisId",
	libsql: "libsqlId",
} as const;

// `*.one` gives a placeholder in place of the passwords, so the cards ask for
// them on the first eye or copy click and build their strings from the answer.
export const useDatabaseCredentials = <T extends object>(
	type: DatabaseType,
	id: string,
	data: T | undefined,
) => {
	const [secrets, setSecrets] = useState<Secrets | null>(null);
	const { mutateAsync } = revealMutations[type]();

	const reveal = async (): Promise<T & Secrets> => {
		if (!data) {
			throw new Error("The database is still loading");
		}
		if (secrets) {
			return { ...data, ...secrets };
		}
		const answer = (await mutateAsync({
			[idKeys[type]]: id,
		} as never)) as Secrets;
		setSecrets(answer);
		return { ...data, ...answer };
	};

	return {
		credentials: data && secrets ? { ...data, ...secrets } : data,
		reveal,
		forget: () => setSecrets(null),
	};
};

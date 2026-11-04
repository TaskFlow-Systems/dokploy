import {
	encodeCredentials,
	formatUrlHost,
} from "@/lib/database-connection-url";

interface MongoCredentials {
	databaseUser: string;
	databasePassword: string;
}

interface InternalMongoUrl extends MongoCredentials {
	appName: string;
	replicaSets: boolean | null;
}

interface ExternalMongoUrl extends MongoCredentials {
	host: string;
	port: number;
}

export const buildInternalMongoUrl = ({
	databaseUser,
	databasePassword,
	appName,
	replicaSets,
}: InternalMongoUrl) =>
	`mongodb://${encodeCredentials({ databaseUser, databasePassword })}@${appName}:27017/?authSource=admin${replicaSets ? "" : "&directConnection=true"}`;

// A replica set names its member <appName>:27017, which resolves only inside the
// Docker network, so a driver outside it must not follow discovery.
export const buildExternalMongoUrl = ({
	databaseUser,
	databasePassword,
	host,
	port,
}: ExternalMongoUrl) =>
	`mongodb://${encodeCredentials({ databaseUser, databasePassword })}@${formatUrlHost(host)}:${port}/?authSource=admin&directConnection=true`;

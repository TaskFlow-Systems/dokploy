interface Credentials {
	databaseUser: string;
	databasePassword: string;
}

interface NamedDatabase extends Credentials {
	databaseName: string;
}

interface Endpoint {
	host: string;
	port: number;
}

export const encodeCredentials = ({
	databaseUser,
	databasePassword,
}: Credentials) =>
	`${encodeURIComponent(databaseUser)}:${encodeURIComponent(databasePassword)}`;

// The panel falls back to the IPv6 address on a host without IPv4, and without
// brackets a client takes the address's last group for the port.
export const formatUrlHost = (host: string) =>
	host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

const buildUrl = (
	scheme: string,
	credentials: Credentials,
	{ host, port }: Endpoint,
	path = "",
) =>
	`${scheme}://${encodeCredentials(credentials)}@${formatUrlHost(host)}:${port}${path}`;

const databasePath = ({ databaseName }: NamedDatabase) =>
	`/${encodeURIComponent(databaseName)}`;

export const buildPostgresUrl = (database: NamedDatabase, endpoint: Endpoint) =>
	buildUrl("postgresql", database, endpoint, databasePath(database));

export const buildMysqlUrl = (database: NamedDatabase, endpoint: Endpoint) =>
	buildUrl("mysql", database, endpoint, databasePath(database));

export const buildMariadbUrl = (database: NamedDatabase, endpoint: Endpoint) =>
	buildUrl("mariadb", database, endpoint, databasePath(database));

export const buildRedisUrl = (
	{ databasePassword }: { databasePassword: string },
	endpoint: Endpoint,
) => buildUrl("redis", { databaseUser: "default", databasePassword }, endpoint);

export const buildLibsqlUrl = (credentials: Credentials, endpoint: Endpoint) =>
	buildUrl("http", credentials, endpoint);

// Port 5001 checks a node's certificate, not a user and password.
export const buildLibsqlGrpcUrl = ({ host, port }: Endpoint) =>
	`https://${formatUrlHost(host)}:${port}`;

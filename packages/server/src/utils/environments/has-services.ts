type EnvironmentServices = Record<
	| "applications"
	| "compose"
	| "libsql"
	| "mariadb"
	| "mongo"
	| "mysql"
	| "postgres"
	| "redis",
	unknown[]
>;

export const environmentHasServices = (environment: EnvironmentServices) =>
	[
		environment.applications,
		environment.compose,
		environment.libsql,
		environment.mariadb,
		environment.mongo,
		environment.mysql,
		environment.postgres,
		environment.redis,
	].some((services) => services.length > 0);

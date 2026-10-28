import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	previewDeployments,
	redis,
} from "@dokploy/server/db/schema";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { execAsync } from "@dokploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { quote } from "shell-quote";

type MonitoringAccessCtx = {
	session: {
		activeOrganizationId: string;
	};
	user: {
		id: string;
		role?: string;
	};
};

type MonitoringService = {
	id: string;
	appName: string;
	serverId?: string | null;
	environment?: {
		project?: {
			organizationId?: string | null;
		} | null;
	} | null;
};

const findMonitoringServiceByAppName = async (appName: string) => {
	const applicationService = await db.query.applications.findFirst({
		where: eq(applications.appName, appName),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
		},
	});
	if (applicationService) {
		return {
			id: applicationService.applicationId,
			appName: applicationService.appName,
			serverId: applicationService.serverId,
			environment: applicationService.environment,
		} satisfies MonitoringService;
	}

	// The application table has more than 100 columns. Drizzle puts every
	// selected column of a nested relation into one json_build_array() call,
	// and Postgres rejects calls with more than 100 arguments (54023).
	const previewDeployment = await db.query.previewDeployments.findFirst({
		where: eq(previewDeployments.appName, appName),
		with: {
			application: {
				columns: { applicationId: true, serverId: true },
				with: {
					environment: {
						with: {
							project: true,
						},
					},
				},
			},
		},
	});
	if (previewDeployment?.application) {
		return {
			id: previewDeployment.application.applicationId,
			appName: previewDeployment.appName,
			serverId: previewDeployment.application.serverId,
			environment: previewDeployment.application.environment,
		} satisfies MonitoringService;
	}

	const composeService = await db.query.compose.findFirst({
		where: eq(compose.appName, appName),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
		},
	});
	if (composeService) {
		return {
			id: composeService.composeId,
			appName: composeService.appName,
			serverId: composeService.serverId,
			environment: composeService.environment,
		} satisfies MonitoringService;
	}

	const postgresService = await db.query.postgres.findFirst({
		where: eq(postgres.appName, appName),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
		},
	});
	if (postgresService) {
		return {
			id: postgresService.postgresId,
			appName: postgresService.appName,
			serverId: postgresService.serverId,
			environment: postgresService.environment,
		} satisfies MonitoringService;
	}

	const mysqlService = await db.query.mysql.findFirst({
		where: eq(mysql.appName, appName),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
		},
	});
	if (mysqlService) {
		return {
			id: mysqlService.mysqlId,
			appName: mysqlService.appName,
			serverId: mysqlService.serverId,
			environment: mysqlService.environment,
		} satisfies MonitoringService;
	}

	const mariadbService = await db.query.mariadb.findFirst({
		where: eq(mariadb.appName, appName),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
		},
	});
	if (mariadbService) {
		return {
			id: mariadbService.mariadbId,
			appName: mariadbService.appName,
			serverId: mariadbService.serverId,
			environment: mariadbService.environment,
		} satisfies MonitoringService;
	}

	const mongoService = await db.query.mongo.findFirst({
		where: eq(mongo.appName, appName),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
		},
	});
	if (mongoService) {
		return {
			id: mongoService.mongoId,
			appName: mongoService.appName,
			serverId: mongoService.serverId,
			environment: mongoService.environment,
		} satisfies MonitoringService;
	}

	const redisService = await db.query.redis.findFirst({
		where: eq(redis.appName, appName),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
		},
	});
	if (redisService) {
		return {
			id: redisService.redisId,
			appName: redisService.appName,
			serverId: redisService.serverId,
			environment: redisService.environment,
		} satisfies MonitoringService;
	}

	const libsqlService = await db.query.libsql.findFirst({
		where: eq(libsql.appName, appName),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
		},
	});
	if (libsqlService) {
		return {
			id: libsqlService.libsqlId,
			appName: libsqlService.appName,
			serverId: libsqlService.serverId,
			environment: libsqlService.environment,
		} satisfies MonitoringService;
	}

	return null;
};

const isDeniedAccessError = (error: unknown) =>
	error instanceof TRPCError
		? error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN"
		: (error as { code?: unknown } | null)?.code === "UNAUTHORIZED" ||
			(error as { code?: unknown } | null)?.code === "FORBIDDEN";

const dockerIdentifierRegex = /^[a-zA-Z0-9._-]+$/;

const normalizeDockerLabelValue = (value?: string | null) => {
	const normalized = value?.trim();
	return normalized && dockerIdentifierRegex.test(normalized)
		? normalized
		: null;
};

const parseDockerLabelString = (labels: string) =>
	labels.split(",").reduce<Record<string, string>>((accumulator, label) => {
		const separatorIndex = label.indexOf("=");
		if (separatorIndex <= 0) {
			return accumulator;
		}

		const key = label.slice(0, separatorIndex).trim();
		const value = label.slice(separatorIndex + 1).trim();
		if (key && value) {
			accumulator[key] = value;
		}
		return accumulator;
	}, {});

const parseDockerLabels = (
	labels?: Record<string, string> | string | null,
): Record<string, string> => {
	if (!labels) {
		return {};
	}

	if (typeof labels === "string") {
		return parseDockerLabelString(labels);
	}

	return labels;
};

export type ContainerResourceStatAccessInput = {
	Container?: string | null;
	ID?: string | null;
	Labels?: Record<string, string> | string | null;
	Name?: string | null;
};

const getSwarmServiceNameCandidate = (name?: string | null) => {
	const normalized = normalizeDockerLabelValue(name);
	if (!normalized) {
		return null;
	}

	return normalized.match(/^(.+)\.[0-9]+\.[^.]+$/)?.[1] ?? null;
};

const getContainerResourceStatAppNameCandidates = (
	stat: ContainerResourceStatAccessInput,
) => {
	const labels = parseDockerLabels(stat.Labels);
	const candidates = [
		labels["com.docker.compose.project"],
		labels["com.docker.stack.namespace"],
		labels["com.docker.swarm.service.name"],
		stat.Name,
		stat.Container,
		getSwarmServiceNameCandidate(stat.Name),
		getSwarmServiceNameCandidate(stat.Container),
	];

	return new Set(
		candidates
			.map((candidate) => normalizeDockerLabelValue(candidate))
			.filter((candidate): candidate is string => Boolean(candidate)),
	);
};

const getContainerResourceStatIdentifierCandidates = (
	stat: ContainerResourceStatAccessInput,
) =>
	new Set(
		[stat.ID, stat.Container, stat.Name]
			.map((candidate) => normalizeDockerLabelValue(candidate))
			.filter((candidate): candidate is string => Boolean(candidate)),
	);

const getAccessibleLocalMonitoringAppNames = async (
	ctx: MonitoringAccessCtx,
	stats: ContainerResourceStatAccessInput[],
) => {
	const appNames = new Set<string>();
	for (const stat of stats) {
		for (const candidate of getContainerResourceStatAppNameCandidates(stat)) {
			appNames.add(candidate);
		}
	}

	const accessibleAppNames = new Set<string>();
	for (const appName of appNames) {
		const service = await findMonitoringServiceByAppName(appName);
		if (
			!service ||
			service.serverId ||
			service.environment?.project?.organizationId !==
				ctx.session.activeOrganizationId
		) {
			continue;
		}

		try {
			await checkServicePermissionAndAccess(ctx, service.id, {
				monitoring: ["read"],
			});
			accessibleAppNames.add(appName);
		} catch (error) {
			if (!isDeniedAccessError(error)) {
				throw error;
			}
		}
	}

	return accessibleAppNames;
};

export const filterContainerResourceStatsByAccess = async <
	T extends ContainerResourceStatAccessInput,
>(
	ctx: MonitoringAccessCtx,
	stats: T[],
) => {
	const appNames = await getAccessibleLocalMonitoringAppNames(ctx, stats);
	return stats.filter((stat) => {
		const candidates = getContainerResourceStatAppNameCandidates(stat);
		return [...candidates].some((candidate) => appNames.has(candidate));
	});
};

export const findAccessibleContainerResourceStat = async <
	T extends ContainerResourceStatAccessInput,
>(
	ctx: MonitoringAccessCtx,
	stats: T[],
	containerId: string,
) => {
	const normalizedContainerId = normalizeDockerLabelValue(containerId);
	if (!normalizedContainerId) {
		return null;
	}

	const accessibleStats = await filterContainerResourceStatsByAccess(
		ctx,
		stats,
	);
	return (
		accessibleStats.find((stat) =>
			getContainerResourceStatIdentifierCandidates(stat).has(
				normalizedContainerId,
			),
		) ?? null
	);
};

const CONTAINER_OWNER_LABELS = [
	"com.docker.compose.project",
	"com.docker.stack.namespace",
	"com.docker.swarm.service.name",
];

// Compose and stack containers are named "<project>-<service>-1" or
// "<stack>_<service>.1.<task>", not after the Dokploy service, so the monitoring
// tab asks for a container name that matches no service. The owning service is
// then taken from the local container's labels; only services on this host
// count, because the lookup only sees local containers.
const findLocalContainerMonitoringService = async (containerName: string) => {
	const name = normalizeDockerLabelValue(containerName);
	if (!name) {
		return null;
	}

	let container: { name?: string; labels?: Record<string, string> | null };
	try {
		const { stdout } = await execAsync(
			quote([
				"docker",
				"inspect",
				"--type",
				"container",
				"--format",
				'{"name":{{json .Name}},"labels":{{json .Config.Labels}}}',
				name,
			]),
		);
		container = JSON.parse(stdout.trim());
	} catch {
		return null;
	}

	// `docker inspect` also resolves ID prefixes; only an exact name counts.
	if (container.name !== `/${name}`) {
		return null;
	}

	const labels = parseDockerLabels(container.labels);
	for (const label of CONTAINER_OWNER_LABELS) {
		const ownerAppName = normalizeDockerLabelValue(labels[label]);
		if (!ownerAppName) {
			continue;
		}
		const service = await findMonitoringServiceByAppName(ownerAppName);
		if (service && !service.serverId) {
			return service;
		}
	}

	return null;
};

export const assertContainerMetricsServiceAccess = async (
	ctx: MonitoringAccessCtx,
	appName: string,
	serverId?: string,
) => {
	if (!ctx.session.activeOrganizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this monitored service",
		});
	}
	const service =
		(await findMonitoringServiceByAppName(appName)) ??
		(serverId === undefined
			? await findLocalContainerMonitoringService(appName)
			: null);
	if (
		!service ||
		service.environment?.project?.organizationId !==
			ctx.session.activeOrganizationId
	) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this monitored service",
		});
	}

	if (serverId !== undefined && service.serverId !== serverId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "Monitored service is not linked to this metrics server",
		});
	}

	await checkServicePermissionAndAccess(ctx, service.id, {
		monitoring: ["read"],
	});
};

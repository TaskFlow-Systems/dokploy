import { isIP } from "node:net";
import { IS_CLOUD, paths } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	environments,
	projects,
	server,
} from "@dokploy/server/db/schema";
import { getAllDomainsForOrganization } from "@dokploy/server/services/overview";
import {
	ACME_FILE_MISSING_EXIT_CODE,
	ACME_FILE_NAME,
	type AcmeCertificate,
	AcmeFileFormatError,
	buildAcmeReadCommand,
	type CertificateTone,
	certificateTone,
	daysUntil,
	findCertificateFor,
	normalizeDomainName,
	parseAcmeCertificates,
} from "@dokploy/server/utils/domain-overview/acme";
import {
	type DnsRecords,
	type DnsStatus,
	mapDnsStatus,
	resolveDomainRecords,
	resolvedAddresses,
} from "@dokploy/server/utils/domain-overview/dns-status";
import {
	classifyTraefikError,
	type TraefikErrorCause,
} from "@dokploy/server/utils/domain-overview/traefik-errors";
import {
	buildTraefikLogsCommand,
	extractLogDomain,
	isErrorLine,
	readLogLevel,
	readLogTime,
	selectAcmeLogLines,
	TRAEFIK_CONTAINER_NAME,
} from "@dokploy/server/utils/domain-overview/traefik-logs";
import {
	buildTraefikRoutesCommand,
	parseTraefikRoutes,
	type TraefikRoute,
} from "@dokploy/server/utils/domain-overview/traefik-routes";
import {
	OperationTimeoutError,
	withTimeout,
} from "@dokploy/server/utils/domain-overview/with-timeout";
import { ExecError } from "@dokploy/server/utils/process/ExecError";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { getPublicIpWithFallback } from "@dokploy/server/wss/utils";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";

const LOCAL_KEY = "local";
const LOCAL_NAME = "Dokploy server";
const SERVER_COMMAND_TIMEOUT_MS = 15_000;
const LOCAL_ADDRESS_TIMEOUT_MS = 10_000;
const LOCAL_ADDRESS_CACHE_TTL_MS = 10 * 60 * 1000;
const LOG_LINE_MAX_LENGTH = 2000;

export type DomainOverviewServer = {
	serverId: string | null;
	name: string;
	address: string | null;
	isLocal: boolean;
};

type ServerTarget = DomainOverviewServer & { key: string };

type ServiceOwner = {
	ownerType: "application" | "compose";
	ownerId: string;
	ownerName: string;
	projectId: string;
	environmentId: string;
};

export type DomainPanelUse = ServiceOwner & {
	domainType: string | null;
	enabled: boolean;
};

export type DomainRouteUse = {
	containerName: string;
	composeProject: string | null;
	serviceName: string | null;
	owner: ServiceOwner | null;
};

export type DomainCertificateView = {
	validTo: string;
	daysLeft: number;
	tone: CertificateTone;
	issuer: string;
};

export type DomainErrorView = {
	time: string | null;
	message: string;
	cause: TraefikErrorCause;
	explanation: string;
};

export type DomainOverviewRow = {
	key: string;
	domain: string;
	serverId: string | null;
	serverName: string;
	isLocal: boolean;
	panelUses: DomainPanelUse[];
	routeUses: DomainRouteUse[];
	dns: { status: DnsStatus; addresses: string[] };
	certificate: DomainCertificateView | null;
	certificateOnly: boolean;
	lastError: DomainErrorView | null;
};

export type DomainOverviewAccess = {
	canReadHost: (serverId: string | null) => Promise<boolean>;
	canReadCertificates: boolean;
};

export type DomainOverview = {
	generatedAt: string;
	certificatesVisible: boolean;
	servers: DomainOverviewServer[];
	serverErrors: {
		serverId: string | null;
		serverName: string;
		message: string;
	}[];
	rows: DomainOverviewRow[];
};

export type TraefikLogLine = {
	time: string | null;
	level: string | null;
	domain: string | null;
	text: string;
};

export type TraefikLogsResult = {
	serverId: string | null;
	serverName: string;
	checkedAt: string;
	containerFound: boolean;
	error: string | null;
	lines: TraefikLogLine[];
};

type Workload = ServiceOwner & {
	serverKey: string;
	appName: string;
	type: "application" | "compose";
};

type ServerReads = {
	target: ServerTarget;
	routes: TraefikRoute[];
	certificates: AcmeCertificate[];
	logLines: string[];
	errors: string[];
};

type MutableRow = {
	key: string;
	domain: string;
	target: ServerTarget;
	panelUses: DomainPanelUse[];
	routeUses: DomainRouteUse[];
	lastError: DomainErrorView | null;
};

const truncate = (value: string) =>
	value.length > LOG_LINE_MAX_LENGTH
		? `${value.slice(0, LOG_LINE_MAX_LENGTH)}...`
		: value;

let localAddressCache: { address: string; expiresAt: number } | null = null;

const readLocalAddress = async (): Promise<string | null> => {
	const settings = await db.query.webServerSettings.findFirst({
		columns: { serverIp: true },
		orderBy: (table, { asc }) => [asc(table.createdAt)],
	});
	const configured = settings?.serverIp?.trim();
	if (configured) {
		return isIP(configured) === 0 ? null : configured;
	}

	const now = Date.now();
	if (localAddressCache && localAddressCache.expiresAt > now) {
		return localAddressCache.address;
	}
	const detected = await withTimeout(
		getPublicIpWithFallback(),
		LOCAL_ADDRESS_TIMEOUT_MS,
	).catch(() => null);
	if (detected) {
		localAddressCache = {
			address: detected,
			expiresAt: now + LOCAL_ADDRESS_CACHE_TTL_MS,
		};
	}
	return detected;
};

const loadTargets = async (orgId: string): Promise<ServerTarget[]> => {
	const servers = await db.query.server.findMany({
		where: eq(server.organizationId, orgId),
		columns: { serverId: true, name: true, ipAddress: true },
		orderBy: (table, { asc }) => [asc(table.name)],
	});
	const remote = servers.map(
		(row): ServerTarget => ({
			key: row.serverId,
			serverId: row.serverId,
			name: row.name,
			address: isIP(row.ipAddress) === 0 ? null : row.ipAddress,
			isLocal: false,
		}),
	);
	if (IS_CLOUD) {
		return remote;
	}
	return [
		{
			key: LOCAL_KEY,
			serverId: null,
			name: LOCAL_NAME,
			address: null,
			isLocal: true,
		},
		...remote,
	];
};

const loadWorkloads = async (orgId: string): Promise<Workload[]> => {
	const [applicationRows, composeRows] = await Promise.all([
		db
			.select({
				id: applications.applicationId,
				name: applications.name,
				appName: applications.appName,
				serverId: applications.serverId,
				environmentId: environments.environmentId,
				projectId: projects.projectId,
			})
			.from(applications)
			.innerJoin(
				environments,
				eq(applications.environmentId, environments.environmentId),
			)
			.innerJoin(projects, eq(environments.projectId, projects.projectId))
			.where(eq(projects.organizationId, orgId)),
		db
			.select({
				id: compose.composeId,
				name: compose.name,
				appName: compose.appName,
				serverId: compose.serverId,
				environmentId: environments.environmentId,
				projectId: projects.projectId,
			})
			.from(compose)
			.innerJoin(
				environments,
				eq(compose.environmentId, environments.environmentId),
			)
			.innerJoin(projects, eq(environments.projectId, projects.projectId))
			.where(eq(projects.organizationId, orgId)),
	]);

	const toWorkload = (
		type: Workload["type"],
		row: {
			id: string;
			name: string;
			appName: string;
			serverId: string | null;
			environmentId: string;
			projectId: string;
		},
	): Workload => ({
		type,
		ownerType: type,
		ownerId: row.id,
		ownerName: row.name,
		appName: row.appName,
		serverKey: row.serverId ?? LOCAL_KEY,
		projectId: row.projectId,
		environmentId: row.environmentId,
	});

	return [
		...applicationRows.map((row) => toWorkload("application", row)),
		...composeRows.map((row) => toWorkload("compose", row)),
	];
};

const runOnServer = (target: ServerTarget, command: string) =>
	withTimeout(
		target.isLocal
			? execAsync(command)
			: execAsyncRemote(target.serverId, command),
		SERVER_COMMAND_TIMEOUT_MS,
	);

const describeFailure = (error: unknown, target: ServerTarget) => {
	if (error instanceof OperationTimeoutError) {
		return `no answer within ${SERVER_COMMAND_TIMEOUT_MS / 1000} s`;
	}
	if (error instanceof AcmeFileFormatError) {
		return error.message;
	}
	if (
		error instanceof Error &&
		error.message === "No SSH key available for this server"
	) {
		return "no SSH key is set for this server";
	}
	if (error instanceof ExecError) {
		if (error.exitCode !== undefined) {
			return `command exited with code ${error.exitCode}`;
		}
		return target.isLocal
			? "command failed"
			: "could not run the command over SSH";
	}
	return "unexpected error";
};

const readStage = async <T>(
	target: ServerTarget,
	stage: string,
	fallback: T,
	read: () => Promise<T>,
) => {
	try {
		return { value: await read(), error: null };
	} catch (error) {
		return {
			value: fallback,
			error: `${stage}: ${describeFailure(error, target)}`,
		};
	}
};

const readRoutes = async (target: ServerTarget) => {
	const { stdout } = await runOnServer(target, buildTraefikRoutesCommand());
	return parseTraefikRoutes(stdout);
};

const readCertificates = async (target: ServerTarget) => {
	const dynamicPath = paths(!target.isLocal).DYNAMIC_TRAEFIK_PATH;
	try {
		const { stdout } = await runOnServer(
			target,
			buildAcmeReadCommand(`${dynamicPath}/${ACME_FILE_NAME}`),
		);
		return parseAcmeCertificates(stdout);
	} catch (error) {
		if (
			error instanceof ExecError &&
			error.exitCode === ACME_FILE_MISSING_EXIT_CODE
		) {
			return [];
		}
		throw error;
	}
};

type LogOutput = { containerFound: boolean; output: string };

const readLogOutput = async (target: ServerTarget): Promise<LogOutput> => {
	try {
		const { stdout } = await runOnServer(target, buildTraefikLogsCommand());
		return { containerFound: true, output: stdout };
	} catch (error) {
		if (
			error instanceof ExecError &&
			/No such container/i.test(error.stdout ?? "")
		) {
			return { containerFound: false, output: "" };
		}
		throw error;
	}
};

const readServer = async (
	target: ServerTarget,
	includeCertificates: boolean,
): Promise<ServerReads> => {
	const [routes, certificates, logs] = await Promise.all([
		readStage(target, "Routes", [] as TraefikRoute[], () => readRoutes(target)),
		includeCertificates
			? readStage(target, "Certificates", [] as AcmeCertificate[], () =>
					readCertificates(target),
				)
			: { value: [] as AcmeCertificate[], error: null },
		readStage(
			target,
			"Traefik logs",
			{ containerFound: false, output: "" },
			() => readLogOutput(target),
		),
	]);
	return {
		target,
		routes: routes.value,
		certificates: certificates.value,
		logLines: selectAcmeLogLines(logs.value.output),
		errors: [routes.error, certificates.error, logs.error].filter(
			(error): error is string => error !== null,
		),
	};
};

const isDnsCheckable = (domain: string) => !domain.includes("*");

export const getDomainOverview = async (
	orgId: string,
	access: DomainOverviewAccess,
): Promise<DomainOverview> => {
	const allTargets = await loadTargets(orgId);
	const readable = await Promise.all(
		allTargets.map((target) => access.canReadHost(target.serverId)),
	);
	const serverTargets = allTargets.filter((_, index) => readable[index]);
	const localAddressPromise = serverTargets.some((target) => target.isLocal)
		? readLocalAddress()
		: Promise.resolve(null);
	const snapshotsPromise = Promise.all(
		serverTargets.map((target) =>
			readServer(target, access.canReadCertificates),
		),
	);
	const [workloads, domainRecords, localAddress] = await Promise.all([
		loadWorkloads(orgId),
		getAllDomainsForOrganization(orgId, null),
		localAddressPromise,
	]);
	const targets = serverTargets.map((target) =>
		target.isLocal ? { ...target, address: localAddress } : target,
	);
	const snapshots = await snapshotsPromise;
	const now = new Date();

	const targetByKey = new Map(targets.map((target) => [target.key, target]));
	const workloadById = new Map(
		workloads.map((workload) => [workload.ownerId, workload]),
	);
	const composeByAppName = new Map(
		workloads
			.filter((workload) => workload.type === "compose")
			.map((workload) => [
				`${workload.serverKey}|${workload.appName}`,
				workload,
			]),
	);
	const applicationByAppName = new Map(
		workloads
			.filter((workload) => workload.type === "application")
			.map((workload) => [
				`${workload.serverKey}|${workload.appName}`,
				workload,
			]),
	);

	const rows = new Map<string, MutableRow>();
	const rowFor = (target: ServerTarget, domain: string): MutableRow => {
		const key = `${target.key}|${domain}`;
		const existing = rows.get(key);
		if (existing) {
			return existing;
		}
		const row: MutableRow = {
			key,
			domain,
			target,
			panelUses: [],
			routeUses: [],
			lastError: null,
		};
		rows.set(key, row);
		return row;
	};

	for (const record of domainRecords) {
		const owner = workloadById.get(record.serviceOwnerId);
		const target = targetByKey.get(owner?.serverKey ?? LOCAL_KEY);
		if (!target) {
			continue;
		}
		rowFor(target, normalizeDomainName(record.host)).panelUses.push({
			ownerType: record.serviceOwnerType,
			ownerId: record.serviceOwnerId,
			ownerName: record.serviceName,
			projectId: record.projectId,
			environmentId: record.environmentId,
			domainType: record.domainType,
			enabled: record.enabled,
		});
	}

	for (const snapshot of snapshots) {
		const serverKey = snapshot.target.key;
		for (const route of snapshot.routes) {
			const composeOwner = route.composeProject
				? composeByAppName.get(`${serverKey}|${route.composeProject}`)
				: undefined;
			const applicationOwner = route.serviceName
				? applicationByAppName.get(`${serverKey}|${route.serviceName}`)
				: undefined;
			const owner = composeOwner ?? applicationOwner ?? null;
			rowFor(snapshot.target, route.host).routeUses.push({
				containerName: route.containerName,
				composeProject: route.composeProject,
				serviceName: route.serviceName,
				owner,
			});
		}
		for (const certificate of snapshot.certificates) {
			for (const name of certificate.names) {
				rowFor(snapshot.target, name);
			}
		}
	}

	for (const snapshot of snapshots) {
		const serverKey = snapshot.target.key;
		const knownHosts = new Set(
			[...rows.values()]
				.filter((row) => row.target.key === serverKey)
				.map((row) => row.domain),
		);
		for (const line of snapshot.logLines) {
			if (!isErrorLine(line)) {
				continue;
			}
			const domain = extractLogDomain(line, knownHosts);
			if (!domain) {
				continue;
			}
			const classified = classifyTraefikError(line);
			rowFor(snapshot.target, domain).lastError = {
				time: readLogTime(line),
				message: truncate(line),
				cause: classified.cause,
				explanation: classified.explanation,
			};
		}
	}

	const domains = [...new Set([...rows.values()].map((row) => row.domain))];
	const recordsByDomain = new Map<string, DnsRecords>(
		await Promise.all(
			domains
				.filter(isDnsCheckable)
				.map(
					async (domain) =>
						[domain, await resolveDomainRecords(domain)] as const,
				),
		),
	);

	const certificatesByServer = new Map(
		snapshots.map((snapshot) => [snapshot.target.key, snapshot.certificates]),
	);
	const serverOrder = new Map(
		targets.map((target, index) => [target.key, index]),
	);

	const outputRows: DomainOverviewRow[] = [...rows.values()]
		.sort(
			(a, b) =>
				(serverOrder.get(a.target.key) ?? 0) -
					(serverOrder.get(b.target.key) ?? 0) ||
				a.domain.localeCompare(b.domain),
		)
		.map((row) => {
			const records = recordsByDomain.get(row.domain);
			const dns = records
				? {
						status: mapDnsStatus({
							records,
							serverAddress: row.target.address,
						}),
						addresses: resolvedAddresses(records),
					}
				: { status: "not_checked" as const, addresses: [] };

			const certificate = findCertificateFor(
				certificatesByServer.get(row.target.key) ?? [],
				row.domain,
			);
			const daysLeft = certificate ? daysUntil(certificate.validTo, now) : null;
			const isWildcard = row.domain.startsWith("*.");
			const unused = row.panelUses.length === 0 && row.routeUses.length === 0;

			return {
				key: row.key,
				domain: row.domain,
				serverId: row.target.serverId,
				serverName: row.target.name,
				isLocal: row.target.isLocal,
				panelUses: row.panelUses,
				routeUses: row.routeUses,
				dns,
				certificate:
					certificate && daysLeft !== null
						? {
								validTo: certificate.validTo.toISOString(),
								daysLeft,
								tone: certificateTone(daysLeft),
								issuer: certificate.issuer,
							}
						: null,
				certificateOnly: Boolean(certificate) && unused && !isWildcard,
				lastError: row.lastError,
			};
		});

	return {
		generatedAt: now.toISOString(),
		certificatesVisible: access.canReadCertificates,
		servers: targets.map(({ serverId, name, address, isLocal }) => ({
			serverId,
			name,
			address,
			isLocal,
		})),
		serverErrors: snapshots.flatMap((snapshot) =>
			snapshot.errors.map((message) => ({
				serverId: snapshot.target.serverId,
				serverName: snapshot.target.name,
				message,
			})),
		),
		rows: outputRows,
	};
};

const resolveTarget = async (
	orgId: string,
	serverId: string | null,
): Promise<ServerTarget> => {
	if (serverId === null) {
		if (IS_CLOUD) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "This instance has no local server",
			});
		}
		return {
			key: LOCAL_KEY,
			serverId: null,
			name: LOCAL_NAME,
			address: null,
			isLocal: true,
		};
	}
	const found = await db.query.server.findFirst({
		where: and(eq(server.serverId, serverId), eq(server.organizationId, orgId)),
		columns: { serverId: true, name: true },
	});
	if (!found) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Server not found" });
	}
	return {
		key: found.serverId,
		serverId: found.serverId,
		name: found.name,
		address: null,
		isLocal: false,
	};
};

export const getTraefikLogs = async (
	orgId: string,
	serverId: string | null,
): Promise<TraefikLogsResult> => {
	const target = await resolveTarget(orgId, serverId);
	const base = {
		serverId,
		serverName: target.name,
		checkedAt: new Date().toISOString(),
	};
	try {
		const { stdout } = await runOnServer(target, buildTraefikLogsCommand());
		const lines = selectAcmeLogLines(stdout).map((text) => ({
			time: readLogTime(text),
			level: readLogLevel(text),
			domain: extractLogDomain(text, new Set()),
			text: truncate(text),
		}));
		return { ...base, containerFound: true, error: null, lines };
	} catch (error) {
		if (
			error instanceof ExecError &&
			/No such container/i.test(error.stdout ?? "")
		) {
			return { ...base, containerFound: false, error: null, lines: [] };
		}
		return {
			...base,
			containerFound: true,
			error: `${TRAEFIK_CONTAINER_NAME} logs: ${describeFailure(error, target)}`,
			lines: [],
		};
	}
};

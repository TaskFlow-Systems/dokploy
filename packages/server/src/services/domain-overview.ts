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
import { isHostStackUpdateRunning } from "@dokploy/server/setup/host-stack-lock";
import {
	ACME_FILE_MISSING_EXIT_CODE,
	ACME_FILE_NAME,
	type AcmeCertificate,
	AcmeFileFormatError,
	buildAcmeReadCommand,
	type CertificateTone,
	certificateCovers,
	certificateTone,
	daysUntil,
	findCertificateFor,
	normalizeDomainName,
	parseAcmeCertificates,
	shellQuote,
} from "@dokploy/server/utils/domain-overview/acme";
import {
	ACME_DELETE_MAX_DOMAINS,
	ACME_DELETE_MESSAGES,
	type AcmeDeleteStatus,
	buildAcmeDeleteScript,
	formatBackupTimestamp,
	isValidCertificateDomain,
	parseAcmeDeleteOutput,
} from "@dokploy/server/utils/domain-overview/acme-delete";
import {
	type DnsRecords,
	type DnsStatus,
	mapDnsStatus,
	resolveDomainRecords,
	resolvedAddresses,
} from "@dokploy/server/utils/domain-overview/dns-status";
import { buildFailureReason } from "@dokploy/server/utils/domain-overview/failure-reason";
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
	readTraefikLogOutput,
	selectAcmeLogLines,
	TRAEFIK_CONTAINER_NAME,
	TRAEFIK_LOG_CONTAINER_MISSING_EXIT_CODE,
	TRAEFIK_LOG_NODE_TIMEOUT_MS,
} from "@dokploy/server/utils/domain-overview/traefik-logs";
import {
	buildDynamicHostsCommand,
	buildTraefikRoutesCommand,
	DYNAMIC_CONFIG_DIR_MISSING_EXIT_CODE,
	type DynamicConfigHost,
	parseDynamicHosts,
	parseTraefikRoutes,
	type TraefikRoute,
} from "@dokploy/server/utils/domain-overview/traefik-routes";
import {
	OperationTimeoutError,
	withTimeout,
} from "@dokploy/server/utils/domain-overview/with-timeout";
import { ExecError } from "@dokploy/server/utils/process/ExecError";
import {
	CommandTimeoutError,
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";

const LOCAL_KEY = "local";
const LOCAL_NAME = "Dokploy server";
const ACME_RESOLVER_NAME = "letsencrypt";
const SERVER_COMMAND_TIMEOUT_MS = 15_000;
const DELETE_PREPARE_TIMEOUT_MS = 60_000;
const DELETE_REMOTE_TIMEOUT_MS = 240_000;
const LOCAL_APPLY_START_DELAY_SECONDS = 3;
const LOG_LINE_MAX_LENGTH = 2000;

export type DomainOverviewServer = {
	serverId: string | null;
	name: string;
	addresses: string[];
	isLocal: boolean;
	usageVerified: boolean;
};

type ServerTarget = {
	key: string;
	serverId: string | null;
	name: string;
	addresses: string[];
	isLocal: boolean;
};

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
	panelHost: boolean;
	panelUses: DomainPanelUse[];
	routeUses: DomainRouteUse[];
	configFiles: string[];
	dns: { status: DnsStatus; addresses: string[] };
	certificate: DomainCertificateView | null;
	lastError: DomainErrorView | null;
	logAvailable: boolean;
};

export type UnusedCertificateView = {
	key: string;
	main: string | null;
	names: string[];
	serverId: string | null;
	serverName: string;
	isLocal: boolean;
	storagePath: string;
	resolver: string;
	dns: { status: DnsStatus; addresses: string[] };
	certificate: DomainCertificateView;
	lastError: DomainErrorView | null;
	logAvailable: boolean;
	deletable: boolean;
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
	unusedCertificates: UnusedCertificateView[];
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
	dynamicHosts: DynamicConfigHost[];
	certificates: AcmeCertificate[];
	logLines: string[];
	logAvailable: boolean;
	usageVerified: boolean;
	errors: string[];
};

type MutableRow = {
	key: string;
	domain: string;
	target: ServerTarget;
	panelHost: boolean;
	panelUses: DomainPanelUse[];
	routeUses: DomainRouteUse[];
	configFiles: string[];
	lastError: DomainErrorView | null;
};

type UnusedEntry = {
	target: ServerTarget;
	certificate: AcmeCertificate;
};

type PanelSettings = { serverIp: string | null; host: string | null };

const truncate = (value: string) =>
	value.length > LOG_LINE_MAX_LENGTH
		? `${value.slice(0, LOG_LINE_MAX_LENGTH)}...`
		: value;

const readPanelSettings = async (): Promise<PanelSettings> => {
	const settings = await db.query.webServerSettings.findFirst({
		columns: { serverIp: true, host: true },
		orderBy: (table, { asc }) => [asc(table.createdAt)],
	});
	const serverIp = settings?.serverIp?.trim() ?? "";
	const host = settings?.host ? normalizeDomainName(settings.host) : "";
	return {
		serverIp: isIP(serverIp) === 0 ? null : serverIp,
		host: host || null,
	};
};

// A server entered by hostname has no literal address, so its addresses are
// whatever that name resolves to. Nothing outside the DNS resolver is asked.
const resolveConfiguredAddresses = async (value: string) => {
	if (isIP(value) !== 0) {
		return [value];
	}
	if (value.trim() === "") {
		return [];
	}
	const records = await resolveDomainRecords(normalizeDomainName(value));
	return resolvedAddresses(records);
};

const loadTargets = async (
	orgId: string,
	settings: PanelSettings,
): Promise<ServerTarget[]> => {
	const servers = await db.query.server.findMany({
		where: eq(server.organizationId, orgId),
		columns: { serverId: true, name: true, ipAddress: true },
		orderBy: (table, { asc }) => [asc(table.name)],
	});
	const remote = await Promise.all(
		servers.map(
			async (row): Promise<ServerTarget> => ({
				key: row.serverId,
				serverId: row.serverId,
				name: row.name,
				addresses: await resolveConfiguredAddresses(row.ipAddress ?? ""),
				isLocal: false,
			}),
		),
	);
	if (IS_CLOUD) {
		return remote;
	}
	return [
		{
			key: LOCAL_KEY,
			serverId: null,
			name: LOCAL_NAME,
			addresses: settings.serverIp ? [settings.serverIp] : [],
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

// Every remote command opens its own SSH connection. Firewalls that rate
// limit new SSH connections drop bursts, so the commands for one server run
// one after the other.
const serverQueues = new Map<string, Promise<unknown>>();

const enqueueForServer = <T>(
	key: string,
	task: () => Promise<T>,
): Promise<T> => {
	const previous = serverQueues.get(key) ?? Promise.resolve();
	const next = previous.then(task, task);
	const tail = next.catch(() => undefined);
	serverQueues.set(key, tail);
	void tail.then(() => {
		if (serverQueues.get(key) === tail) {
			serverQueues.delete(key);
		}
	});
	return next;
};

const runOnServer = (
	target: ServerTarget,
	command: string,
	timeoutMs = SERVER_COMMAND_TIMEOUT_MS,
) =>
	target.isLocal
		? withTimeout(execAsync(command, { timeoutMs }), timeoutMs + 2_000)
		: enqueueForServer(target.key, () =>
				withTimeout(
					execAsyncRemote(target.serverId, command, undefined, { timeoutMs }),
					timeoutMs + 2_000,
				),
			);

const isTimeout = (error: unknown) =>
	error instanceof OperationTimeoutError ||
	error instanceof CommandTimeoutError;

const isTransportFailure = (error: unknown, target: ServerTarget) =>
	!target.isLocal &&
	(isTimeout(error) ||
		(error instanceof ExecError && typeof error.exitCode !== "number") ||
		(error instanceof Error &&
			error.message === "No SSH key available for this server"));

const describeFailure = (error: unknown, target: ServerTarget) => {
	if (isTimeout(error)) {
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
		if (typeof error.exitCode === "number") {
			const reason = buildFailureReason({
				exitCode: error.exitCode,
				text: error.stderr || error.stdout,
			});
			return `command failed (${reason})`;
		}
		const detail = buildFailureReason({ text: error.message });
		return target.isLocal
			? `command failed${detail ? ` (${detail})` : ""}`
			: `could not run the command over SSH${detail ? ` (${detail})` : ""}`;
	}
	return "unexpected error";
};

type StageResult<T> = { value: T; error: string | null; transport: boolean };

const readStage = async <T>(
	target: ServerTarget,
	stage: string,
	fallback: T,
	read: () => Promise<T>,
): Promise<StageResult<T>> => {
	try {
		return { value: await read(), error: null, transport: false };
	} catch (error) {
		return {
			value: fallback,
			error: `${stage}: ${describeFailure(error, target)}`,
			transport: isTransportFailure(error, target),
		};
	}
};

const readRoutes = async (target: ServerTarget) => {
	const { stdout } = await runOnServer(target, buildTraefikRoutesCommand());
	return parseTraefikRoutes(stdout);
};

const dynamicPathFor = (target: ServerTarget) =>
	paths(!target.isLocal).DYNAMIC_TRAEFIK_PATH;

const acmeFileFor = (target: ServerTarget) =>
	`${dynamicPathFor(target)}/${ACME_FILE_NAME}`;

const readDynamicHosts = async (target: ServerTarget) => {
	try {
		const { stdout } = await runOnServer(
			target,
			buildDynamicHostsCommand(dynamicPathFor(target)),
		);
		return parseDynamicHosts(stdout);
	} catch (error) {
		if (
			error instanceof ExecError &&
			error.exitCode === DYNAMIC_CONFIG_DIR_MISSING_EXIT_CODE
		) {
			return [];
		}
		throw error;
	}
};

const readCertificates = async (target: ServerTarget) => {
	try {
		const { stdout } = await runOnServer(
			target,
			buildAcmeReadCommand(acmeFileFor(target)),
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

type LogRead =
	| { status: "ok"; output: string }
	| { status: "missing" }
	| { status: "failed"; reason: string };

const readLogs = async (target: ServerTarget): Promise<LogRead> => {
	try {
		const { stdout } = await runOnServer(
			target,
			buildTraefikLogsCommand(),
			TRAEFIK_LOG_NODE_TIMEOUT_MS,
		);
		const parsed = readTraefikLogOutput(stdout);
		return parsed.ok
			? { status: "ok", output: parsed.output }
			: { status: "failed", reason: parsed.reason };
	} catch (error) {
		if (
			error instanceof ExecError &&
			error.exitCode === TRAEFIK_LOG_CONTAINER_MISSING_EXIT_CODE
		) {
			return { status: "missing" };
		}
		throw error;
	}
};

const readServer = async (
	target: ServerTarget,
	includeCertificates: boolean,
): Promise<ServerReads> => {
	const errors: string[] = [];
	let usageVerified = true;
	let connectionLost = false;

	const stage = async <T>(
		name: string,
		fallback: T,
		read: () => Promise<T>,
		affectsUsage: boolean,
	) => {
		if (connectionLost) {
			if (affectsUsage) {
				usageVerified = false;
			}
			return fallback;
		}
		const result = await readStage(target, name, fallback, read);
		if (result.error) {
			errors.push(result.error);
			if (affectsUsage) {
				usageVerified = false;
			}
			connectionLost = result.transport;
		}
		return result.value;
	};

	const routes = await stage(
		"Routes",
		[] as TraefikRoute[],
		() => readRoutes(target),
		true,
	);
	const dynamicHosts = await stage(
		"Dynamic config",
		[] as DynamicConfigHost[],
		() => readDynamicHosts(target),
		true,
	);
	const certificates = includeCertificates
		? await stage(
				"Certificates",
				[] as AcmeCertificate[],
				() => readCertificates(target),
				true,
			)
		: [];
	const logs = await stage<LogRead>(
		"Traefik logs",
		{ status: "failed", reason: "not read" },
		() => readLogs(target),
		false,
	);
	if (logs.status === "failed" && !connectionLost) {
		errors.push(`Traefik logs: ${buildFailureReason({ text: logs.reason })}`);
	}

	return {
		target,
		routes,
		dynamicHosts,
		certificates,
		logLines: logs.status === "ok" ? selectAcmeLogLines(logs.output) : [],
		logAvailable: logs.status === "ok",
		usageVerified,
		errors,
	};
};

const isDnsCheckable = (domain: string) => !domain.includes("*");

type ServerAnalysis = {
	snapshot: ServerReads;
	rows: MutableRow[];
	unused: UnusedEntry[];
};

type Analysis = {
	servers: ServerAnalysis[];
	targets: ServerTarget[];
};

const analyzeServers = async (
	orgId: string,
	serverTargets: ServerTarget[],
	settings: PanelSettings,
	includeCertificates: boolean,
): Promise<Analysis> => {
	const snapshotsPromise = Promise.all(
		serverTargets.map((target) => readServer(target, includeCertificates)),
	);
	const [workloads, domainRecords] = await Promise.all([
		loadWorkloads(orgId),
		getAllDomainsForOrganization(orgId, null),
	]);
	const snapshots = await snapshotsPromise;

	const targetByKey = new Map(
		serverTargets.map((target) => [target.key, target]),
	);
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
			panelHost: false,
			panelUses: [],
			routeUses: [],
			configFiles: [],
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

	const localTarget = targetByKey.get(LOCAL_KEY);
	if (localTarget && settings.host) {
		rowFor(localTarget, settings.host).panelHost = true;
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
		for (const { host, file } of snapshot.dynamicHosts) {
			const row = rowFor(snapshot.target, host);
			if (!row.configFiles.includes(file)) {
				row.configFiles.push(file);
			}
		}
	}

	const result: ServerAnalysis[] = snapshots.map((snapshot) => {
		const own = [...rows.values()].filter(
			(row) => row.target.key === snapshot.target.key,
		);
		const used = own.map((row) => row.domain);
		const unused = snapshot.certificates
			.filter(
				(certificate) =>
					!used.some((domain) => certificateCovers(certificate.names, domain)),
			)
			.map((certificate) => ({ target: snapshot.target, certificate }));
		return { snapshot, rows: own, unused };
	});

	for (const analysis of result) {
		const { snapshot } = analysis;
		const knownHosts = new Set([
			...analysis.rows.map((row) => row.domain),
			...analysis.unused.flatMap((entry) => entry.certificate.names),
		]);
		for (const line of snapshot.logLines) {
			if (!isErrorLine(line)) {
				continue;
			}
			const domain = extractLogDomain(line, knownHosts);
			if (!domain) {
				continue;
			}
			const classified = classifyTraefikError(line);
			const view: DomainErrorView = {
				time: readLogTime(line),
				message: truncate(line),
				cause: classified.cause,
				explanation: classified.explanation,
			};
			const row = analysis.rows.find((item) => item.domain === domain);
			if (row) {
				row.lastError = view;
			}
			for (const entry of analysis.unused) {
				if (entry.certificate.names.includes(domain)) {
					errorsByEntry.set(entry.certificate, view);
				}
			}
		}
	}

	return { servers: result, targets: serverTargets };
};

const errorsByEntry = new WeakMap<AcmeCertificate, DomainErrorView>();

const byProblemThenName =
	<T>(daysLeft: (item: T) => number | null, name: (item: T) => string) =>
	(a: T, b: T) =>
		(daysLeft(a) ?? Number.POSITIVE_INFINITY) -
			(daysLeft(b) ?? Number.POSITIVE_INFINITY) ||
		name(a).localeCompare(name(b));

export const getDomainOverview = async (
	orgId: string,
	access: DomainOverviewAccess,
): Promise<DomainOverview> => {
	const settings = await readPanelSettings();
	const allTargets = await loadTargets(orgId, settings);
	const readable = await Promise.all(
		allTargets.map((target) => access.canReadHost(target.serverId)),
	);
	const targets = allTargets.filter((_, index) => readable[index]);
	const analysis = await analyzeServers(
		orgId,
		targets,
		settings,
		access.canReadCertificates,
	);
	const now = new Date();

	const usedDomains = analysis.servers.flatMap((server) =>
		server.rows.map((row) => row.domain),
	);
	const unusedMains = analysis.servers.flatMap((server) =>
		server.unused.flatMap((entry) =>
			entry.certificate.main ? [entry.certificate.main] : [],
		),
	);
	const recordsByDomain = new Map<string, DnsRecords>(
		await Promise.all(
			[...new Set([...usedDomains, ...unusedMains])]
				.filter(isDnsCheckable)
				.map(
					async (domain) =>
						[domain, await resolveDomainRecords(domain)] as const,
				),
		),
	);
	const dnsFor = (domain: string, target: ServerTarget) => {
		const records = recordsByDomain.get(domain);
		return records
			? {
					status: mapDnsStatus({ records, serverAddresses: target.addresses }),
					addresses: resolvedAddresses(records),
				}
			: { status: "not_checked" as const, addresses: [] };
	};
	const toCertificateView = (certificate: AcmeCertificate) => {
		const daysLeft = daysUntil(certificate.validTo, now);
		return {
			validTo: certificate.validTo.toISOString(),
			daysLeft,
			tone: certificateTone(daysLeft),
			issuer: certificate.issuer,
		};
	};

	const rows: DomainOverviewRow[] = [];
	const unusedCertificates: UnusedCertificateView[] = [];
	for (const server of analysis.servers) {
		const { snapshot } = server;
		for (const row of server.rows) {
			const certificate = findCertificateFor(snapshot.certificates, row.domain);
			rows.push({
				key: row.key,
				domain: row.domain,
				serverId: row.target.serverId,
				serverName: row.target.name,
				isLocal: row.target.isLocal,
				panelHost: row.panelHost,
				panelUses: row.panelUses,
				routeUses: row.routeUses,
				configFiles: row.configFiles,
				dns: dnsFor(row.domain, row.target),
				certificate: certificate ? toCertificateView(certificate) : null,
				lastError: row.lastError,
				logAvailable: snapshot.logAvailable,
			});
		}
		if (!snapshot.usageVerified) {
			continue;
		}
		for (const entry of server.unused) {
			const { certificate, target } = entry;
			const name = certificate.main ?? certificate.names[0] ?? "";
			unusedCertificates.push({
				key: `${target.key}|${name}|${certificate.validTo.getTime()}`,
				main: certificate.main,
				names: certificate.names,
				serverId: target.serverId,
				serverName: target.name,
				isLocal: target.isLocal,
				storagePath: acmeFileFor(target),
				resolver: ACME_RESOLVER_NAME,
				dns: dnsFor(name, target),
				certificate: toCertificateView(certificate),
				lastError: errorsByEntry.get(certificate) ?? null,
				logAvailable: snapshot.logAvailable,
				deletable: certificate.main !== null,
			});
		}
	}

	rows.sort(
		byProblemThenName(
			(row) => row.certificate?.daysLeft ?? null,
			(row) => row.domain,
		),
	);
	unusedCertificates.sort(
		byProblemThenName(
			(item) => item.certificate.daysLeft,
			(item) => item.main ?? item.names[0] ?? "",
		),
	);

	return {
		generatedAt: now.toISOString(),
		certificatesVisible: access.canReadCertificates,
		servers: analysis.servers.map(({ snapshot }) => ({
			serverId: snapshot.target.serverId,
			name: snapshot.target.name,
			addresses: snapshot.target.addresses,
			isLocal: snapshot.target.isLocal,
			usageVerified: snapshot.usageVerified,
		})),
		serverErrors: analysis.servers.flatMap(({ snapshot }) =>
			snapshot.errors.map((message) => ({
				serverId: snapshot.target.serverId,
				serverName: snapshot.target.name,
				message,
			})),
		),
		rows,
		unusedCertificates,
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
			addresses: [],
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
		addresses: [],
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
		const logs = await readLogs(target);
		if (logs.status === "missing") {
			return { ...base, containerFound: false, error: null, lines: [] };
		}
		if (logs.status === "failed") {
			return {
				...base,
				containerFound: true,
				error: `${TRAEFIK_CONTAINER_NAME} logs: ${buildFailureReason({ text: logs.reason })}`,
				lines: [],
			};
		}
		const lines = selectAcmeLogLines(logs.output).map((text) => ({
			time: readLogTime(text),
			level: readLogLevel(text),
			domain: extractLogDomain(text, new Set()),
			text: truncate(text),
		}));
		return { ...base, containerFound: true, error: null, lines };
	} catch (error) {
		return {
			...base,
			containerFound: true,
			error: `${TRAEFIK_CONTAINER_NAME} logs: ${describeFailure(error, target)}`,
			lines: [],
		};
	}
};

export type CertificateRefusalReason =
	| "invalid_name"
	| "usage_unverified"
	| "not_in_storage"
	| "in_use"
	| "panel_host"
	| "no_main_domain"
	| "ambiguous";

const REFUSAL_MESSAGES: Record<CertificateRefusalReason, string> = {
	invalid_name: "This is not a valid domain name.",
	usage_unverified:
		"The routes or the certificate file of this server could not be read, so it cannot be checked that the certificate is unused.",
	not_in_storage: "There is no certificate for this domain in the storage.",
	in_use: "A route, a panel domain or a Traefik config file still uses it.",
	panel_host: "This is the panel's own domain. It is never deleted here.",
	no_main_domain:
		"This certificate has no main domain, so it cannot be removed.",
	ambiguous: "More than one certificate has this main domain.",
};

export type DeleteUnusedCertificatesResult =
	| {
			status: "refused";
			refused: {
				domain: string;
				reason: CertificateRefusalReason;
				message: string;
			}[];
	  }
	| {
			status: "deleted" | "restarting" | "failed";
			code: AcmeDeleteStatus | "no_result" | "timeout";
			message: string;
			backupFile: string | null;
			logFile: string | null;
	  };

const deletionLocks = new Set<string>();

const refusal = (domain: string, reason: CertificateRefusalReason) => ({
	domain,
	reason,
	message: REFUSAL_MESSAGES[reason],
});

const wrapScript = (script: string) => `sh -c ${shellQuote(script)}`;

const stdoutOf = (error: unknown) =>
	error instanceof ExecError ? (error.stdout ?? "") : "";

const failedResult = (
	code: AcmeDeleteStatus | "no_result" | "timeout",
	backupFile: string | null,
	detail?: string,
): DeleteUnusedCertificatesResult => ({
	status: "failed",
	code,
	message:
		code === "no_result"
			? `The command did not report a result${detail ? ` (${detail})` : ""}. Check the server before trying again.`
			: code === "timeout"
				? "The server did not finish in time. Check that Traefik is running and look for the backup file before trying again."
				: ACME_DELETE_MESSAGES[code],
	backupFile,
	logFile: null,
});

export const deleteUnusedCertificates = async (
	orgId: string,
	serverId: string | null,
	requested: string[],
): Promise<DeleteUnusedCertificatesResult> => {
	const domains = [...new Set(requested.map(normalizeDomainName))];
	if (domains.length === 0 || domains.length > ACME_DELETE_MAX_DOMAINS) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Choose between 1 and ${ACME_DELETE_MAX_DOMAINS} certificates.`,
		});
	}
	const invalid = domains.filter((domain) => !isValidCertificateDomain(domain));
	if (invalid.length > 0) {
		return {
			status: "refused",
			refused: invalid.map((domain) => refusal(domain, "invalid_name")),
		};
	}

	const target = await resolveTarget(orgId, serverId);
	if (target.isLocal && isHostStackUpdateRunning()) {
		throw new TRPCError({
			code: "CONFLICT",
			message:
				"An update of this panel host is running. Try again when it ends.",
		});
	}
	if (deletionLocks.has(target.key)) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Another certificate deletion is running on this server.",
		});
	}
	deletionLocks.add(target.key);
	try {
		return await runDeletion(orgId, target, domains);
	} finally {
		deletionLocks.delete(target.key);
	}
};

const runDeletion = async (
	orgId: string,
	target: ServerTarget,
	domains: string[],
): Promise<DeleteUnusedCertificatesResult> => {
	const settings = await readPanelSettings();
	const analysis = await analyzeServers(orgId, [target], settings, true);
	const server = analysis.servers[0];
	if (!server?.snapshot.usageVerified) {
		return {
			status: "refused",
			refused: domains.map((domain) => refusal(domain, "usage_unverified")),
		};
	}

	const { certificates } = server.snapshot;
	const refused: ReturnType<typeof refusal>[] = [];
	for (const domain of domains) {
		const matching = certificates.filter(
			(certificate) => certificate.main === domain,
		);
		if (matching.length === 0) {
			refused.push(
				refusal(
					domain,
					certificates.some((certificate) => certificate.names.includes(domain))
						? "no_main_domain"
						: "not_in_storage",
				),
			);
			continue;
		}
		if (matching.length > 1) {
			refused.push(refusal(domain, "ambiguous"));
			continue;
		}
		const certificate = matching[0];
		if (
			target.isLocal &&
			settings.host &&
			certificateCovers(certificate?.names ?? [], settings.host)
		) {
			refused.push(refusal(domain, "panel_host"));
			continue;
		}
		const stillUnused = server.unused.some(
			(entry) => entry.certificate === certificate,
		);
		if (!stillUnused) {
			refused.push(refusal(domain, "in_use"));
		}
	}
	if (refused.length > 0) {
		return { status: "refused", refused };
	}

	const timestamp = formatBackupTimestamp(new Date());
	const acmeFile = acmeFileFor(target);
	const script = (phase: "all" | "prepare" | "apply", delay = 0) =>
		buildAcmeDeleteScript({
			acmeFile,
			domains,
			timestamp,
			phase,
			startDelaySeconds: delay,
		});

	if (!target.isLocal) {
		try {
			const { stdout } = await runOnServer(
				target,
				wrapScript(script("all")),
				DELETE_REMOTE_TIMEOUT_MS,
			);
			return finishRemote(stdout);
		} catch (error) {
			if (isTimeout(error)) {
				return failedResult("timeout", null);
			}
			const outcome = parseAcmeDeleteOutput(stdoutOf(error));
			if (outcome.status) {
				return finishRemote(stdoutOf(error));
			}
			return failedResult(
				"no_result",
				outcome.backupFile,
				describeFailure(error, target),
			);
		}
	}

	try {
		const { stdout } = await runOnServer(
			target,
			wrapScript(script("prepare")),
			DELETE_PREPARE_TIMEOUT_MS,
		);
		const outcome = parseAcmeDeleteOutput(stdout);
		if (outcome.status !== "prepared") {
			return failedResult("no_result", outcome.backupFile);
		}
		return await startLocalApply(
			wrapScript(script("apply", LOCAL_APPLY_START_DELAY_SECONDS)),
			timestamp,
			outcome.backupFile,
		);
	} catch (error) {
		if (isTimeout(error)) {
			return failedResult("timeout", null);
		}
		const outcome = parseAcmeDeleteOutput(stdoutOf(error));
		if (outcome.status && outcome.status !== "ok") {
			return failedResult(outcome.status, outcome.backupFile);
		}
		return failedResult(
			"no_result",
			outcome.backupFile,
			describeFailure(error, target),
		);
	}
};

const finishRemote = (stdout: string): DeleteUnusedCertificatesResult => {
	const outcome = parseAcmeDeleteOutput(stdout);
	if (outcome.status === "ok") {
		return {
			status: "deleted",
			code: "ok",
			message: ACME_DELETE_MESSAGES.ok,
			backupFile: outcome.backupFile,
			logFile: null,
		};
	}
	return failedResult(outcome.status ?? "no_result", outcome.backupFile);
};

// The panel is normally served through the Traefik that is about to stop, so
// the request that asked for the deletion would be cut mid-answer. The stop,
// move and start run detached after a short delay and write their result to a
// log file on the panel host.
const startLocalApply = async (
	command: string,
	timestamp: string,
	backupFile: string | null,
): Promise<DeleteUnusedCertificatesResult> => {
	const logFile = `${paths().LOGS_PATH}/acme-delete-${timestamp}.log`;
	await execAsync(
		`mkdir -p ${shellQuote(paths().LOGS_PATH)} && nohup ${command} > ${shellQuote(logFile)} 2>&1 < /dev/null &`,
		{ timeoutMs: 10_000 },
	);
	return {
		status: "restarting",
		code: "ok",
		message:
			"The certificate file was edited and Traefik restarts in a few seconds. The panel may be unreachable for a moment. The result is written to the log file.",
		backupFile,
		logFile,
	};
};

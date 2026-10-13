import { randomBytes } from "node:crypto";
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
import { isServerUpdateRunning } from "@dokploy/server/services/web-server-update";
import { acquireHostStackUpdateLock } from "@dokploy/server/setup/host-stack-lock";
import {
	acquireTraefikOperation,
	runningTraefikOperation,
} from "@dokploy/server/setup/traefik-operation-lock";
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
	ACME_BACKUP_DIR_NAME,
	ACME_DELETE_LOCK_NAME,
	ACME_DELETE_MARKER_NAME,
	ACME_DELETE_MAX_DOMAINS,
	ACME_DELETE_MESSAGES,
	type AcmeDeleteStatus,
	buildAcmeDeleteScript,
	buildClearStaleLockCommand,
	buildDeletionLauncher,
	buildDeletionStatusCommand,
	buildTraefikRecoveryScript,
	type ClearLockOutcome,
	type DeletionState,
	type DeletionStatusFile,
	deletionState,
	deletionTime,
	formatBackupTimestamp,
	isValidCertificateDomain,
	isValidResolverName,
	parseClearLockOutcome,
	parseDeletionStatus,
	parseRecoveryStatus,
	RECOVERY_MESSAGES,
	type RecoveryStatus,
} from "@dokploy/server/utils/domain-overview/acme-delete";
import {
	type DnsRecords,
	type DnsStatus,
	mapDnsStatus,
	resolveDomainRecords,
	resolvedAddresses,
} from "@dokploy/server/utils/domain-overview/dns-status";
import { buildFailureReason } from "@dokploy/server/utils/domain-overview/failure-reason";
import { namesMatchPatterns } from "@dokploy/server/utils/domain-overview/host-patterns";
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
	type DynamicConfigUses,
	parseDynamicConfigUses,
	parseTraefikUses,
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
const SERVER_COMMAND_TIMEOUT_MS = 15_000;
const LAUNCH_TIMEOUT_MS = 30_000;
const LOG_LINE_MAX_LENGTH = 2000;
const LOCAL_APPLY_START_DELAY_SECONDS = 3;

export const deletionTiming = {
	pollIntervalMs: 3_000,
	statusShareMs: 3_000,
	remoteWaitMs: 150_000,
	localWaitMs: 15_000,
	watchMaxMs: 15 * 60_000,
};

export type DeletionStatusView = {
	state: DeletionState;
	code: AcmeDeleteStatus | null;
	time: string | null;
	backupFile: string | null;
	message: string;
};

export type DomainOverviewServer = {
	serverId: string | null;
	name: string;
	addresses: string[];
	isLocal: boolean;
	usageVerified: boolean;
	lastDeletion: DeletionStatusView | null;
	staleLock: boolean;
	traefikLeftStopped: { kind: string; phase: string } | null;
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
	dynamic: DynamicConfigUses | null;
	mentions: string[];
	patterns: string[];
	certificates: AcmeCertificate[];
	logLines: string[];
	logAvailable: boolean;
	usageVerified: boolean;
	deletion: DeletionStatusFile | null;
	deletionRunning: boolean;
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

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

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
// one after the other. A caller that stops waiting must not leave its command
// behind in the queue.
const serverQueues = new Map<string, Promise<unknown>>();

const enqueueForServer = <T>(
	key: string,
	waitMs: number,
	task: () => Promise<T>,
): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		let abandoned = false;
		const timer = setTimeout(() => {
			abandoned = true;
			reject(new OperationTimeoutError(waitMs));
		}, waitMs);
		const run = async () => {
			if (abandoned) {
				return;
			}
			clearTimeout(timer);
			try {
				resolve(await task());
			} catch (error) {
				reject(error);
			}
		};
		const previous = serverQueues.get(key) ?? Promise.resolve();
		const tail = previous.then(run, run);
		serverQueues.set(key, tail);
		void tail.then(() => {
			if (serverQueues.get(key) === tail) {
				serverQueues.delete(key);
			}
		});
	});

const runOnServer = (
	target: ServerTarget,
	command: string,
	timeoutMs = SERVER_COMMAND_TIMEOUT_MS,
) =>
	target.isLocal
		? withTimeout(execAsync(command, { timeoutMs }), timeoutMs + 2_000)
		: enqueueForServer(target.key, timeoutMs * 2, () =>
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

const dynamicPathFor = (target: ServerTarget) =>
	paths(!target.isLocal).DYNAMIC_TRAEFIK_PATH;

const acmeFileFor = (target: ServerTarget) =>
	`${dynamicPathFor(target)}/${ACME_FILE_NAME}`;

const staticConfigFor = (target: ServerTarget) =>
	`${paths(!target.isLocal).MAIN_TRAEFIK_PATH}/traefik.yml`;

const lockFileFor = (target: ServerTarget) =>
	`${paths(!target.isLocal).BASE_PATH}/${ACME_DELETE_LOCK_NAME}`;

const markerFileFor = (target: ServerTarget) =>
	`${paths(!target.isLocal).BASE_PATH}/${ACME_DELETE_MARKER_NAME}`;

// Outside the Traefik tree on purpose: the file editor can open anything
// under it, and the backups hold the same private keys as acme.json.
const backupDirFor = (target: ServerTarget) =>
	`${paths(!target.isLocal).BASE_PATH}/${ACME_BACKUP_DIR_NAME}`;

const logDirFor = (target: ServerTarget) => paths(!target.isLocal).LOGS_PATH;

const readRoutes = async (target: ServerTarget) => {
	const { stdout } = await runOnServer(target, buildTraefikRoutesCommand());
	return parseTraefikUses(stdout);
};

const readDynamicUses = async (target: ServerTarget) => {
	try {
		const { stdout } = await runOnServer(
			target,
			buildDynamicHostsCommand(dynamicPathFor(target), staticConfigFor(target)),
		);
		return parseDynamicConfigUses(stdout);
	} catch (error) {
		if (
			error instanceof ExecError &&
			error.exitCode === DYNAMIC_CONFIG_DIR_MISSING_EXIT_CODE
		) {
			return { hosts: [], mentions: [], patterns: [], unreadable: false };
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

const statusCache = new Map<
	string,
	{ at: number; promise: Promise<DeletionStatusFile> }
>();
const watchedStatus = new Map<
	string,
	{ at: number; status: DeletionStatusFile }
>();

// The watcher of a running deletion and the page both ask for the status.
// Over SSH each answer costs a new connection, so a recent answer is shared.
const readDeletionStatus = (
	target: ServerTarget,
	options: { logFile?: string; fresh?: boolean } = {},
): Promise<DeletionStatusFile> => {
	const now = Date.now();
	if (!options.fresh) {
		const watched = watchedStatus.get(target.key);
		if (watched && now - watched.at < deletionTiming.statusShareMs) {
			return Promise.resolve(watched.status);
		}
		const cached = statusCache.get(target.key);
		if (cached && now - cached.at < deletionTiming.statusShareMs) {
			return cached.promise;
		}
	}
	const promise = runOnServer(
		target,
		buildDeletionStatusCommand({
			logDir: logDirFor(target),
			lockFile: lockFileFor(target),
			markerFile: markerFileFor(target),
			logFile: options.logFile,
		}),
	).then(({ stdout }) => parseDeletionStatus(stdout));
	if (!options.logFile) {
		statusCache.set(target.key, { at: now, promise });
		promise.catch(() => {
			if (statusCache.get(target.key)?.promise === promise) {
				statusCache.delete(target.key);
			}
		});
	}
	return promise;
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

const DELETION_RUNNING_MESSAGE =
	"A certificate deletion is running on this server, so it is not read now.";

const readServer = async (
	target: ServerTarget,
	includeCertificates: boolean,
	ownOperation: boolean,
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

	const empty = {
		target,
		routes: [] as TraefikRoute[],
		dynamic: null,
		mentions: [] as string[],
		patterns: [] as string[],
		certificates: [] as AcmeCertificate[],
		logLines: [] as string[],
		logAvailable: false,
	};

	const inMemory =
		!ownOperation && runningTraefikOperation(target.serverId) !== null;
	const deletion = await stage<DeletionStatusFile | null>(
		"Deletion status",
		null,
		() => readDeletionStatus(target),
		false,
	);
	if (inMemory || deletion?.busy) {
		return {
			...empty,
			usageVerified: false,
			deletion,
			deletionRunning: true,
			errors: [...errors, DELETION_RUNNING_MESSAGE],
		};
	}

	const uses = await stage(
		"Routes",
		{
			routes: [],
			mentions: [],
			patterns: [],
			unreadable: false,
		} as ReturnType<typeof parseTraefikUses>,
		() => readRoutes(target),
		true,
	);
	if (uses.unreadable) {
		usageVerified = false;
		errors.push("Routes: the labels of a container could not be read");
	}
	const dynamic = await stage<DynamicConfigUses | null>(
		"Dynamic config",
		null,
		() => readDynamicUses(target),
		true,
	);
	if (dynamic?.unreadable) {
		usageVerified = false;
		errors.push("Dynamic config: a Traefik config file could not be read");
	}
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
		routes: uses.routes,
		dynamic,
		mentions: [...uses.mentions, ...(dynamic?.mentions ?? [])],
		patterns: [...uses.patterns, ...(dynamic?.patterns ?? [])],
		certificates,
		logLines: logs.status === "ok" ? selectAcmeLogLines(logs.output) : [],
		logAvailable: logs.status === "ok",
		usageVerified,
		deletion,
		deletionRunning: false,
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

const errorsByEntry = new WeakMap<AcmeCertificate, DomainErrorView>();

const certificateInUse = (
	certificate: AcmeCertificate,
	snapshot: ServerReads,
	usedDomains: readonly string[],
) =>
	usedDomains.some((domain) => certificateCovers(certificate.names, domain)) ||
	snapshot.mentions.some((name) =>
		certificateCovers(certificate.names, name),
	) ||
	namesMatchPatterns(certificate.names, snapshot.patterns);

const analyzeServers = async (
	orgId: string,
	serverTargets: ServerTarget[],
	settings: PanelSettings,
	includeCertificates: boolean,
	ownOperation = false,
): Promise<Analysis> => {
	const snapshotsPromise = Promise.all(
		serverTargets.map((target) =>
			readServer(target, includeCertificates, ownOperation),
		),
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
		for (const { host, file } of snapshot.dynamic?.hosts ?? []) {
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
			.filter((certificate) => !certificateInUse(certificate, snapshot, used))
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

const byProblemThenName =
	<T>(daysLeft: (item: T) => number | null, name: (item: T) => string) =>
	(a: T, b: T) =>
		(daysLeft(a) ?? Number.POSITIVE_INFINITY) -
			(daysLeft(b) ?? Number.POSITIVE_INFINITY) ||
		name(a).localeCompare(name(b));

const toDeletionView = (snapshot: ServerReads): DeletionStatusView | null => {
	const parsed = snapshot.deletion;
	const state =
		parsed && deletionState(parsed)
			? deletionState(parsed)
			: snapshot.deletionRunning
				? "in_progress"
				: null;
	if (!state) {
		return null;
	}
	const code = parsed?.status ?? null;
	return {
		state,
		code,
		time: parsed?.logFile ? deletionTime(parsed.logFile) : null,
		backupFile: parsed?.backupFile ?? null,
		message:
			state === "in_progress"
				? "A certificate deletion is running. Traefik restarts during it."
				: state === "interrupted"
					? ACME_DELETE_MESSAGES.interrupted
					: code
						? ACME_DELETE_MESSAGES[code]
						: "",
	};
};

const inflightOverviews = new Map<string, Promise<DomainOverview>>();

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
	// Repeated refetches of the same view share one run instead of queueing
	// more commands behind each other on the same servers.
	const flightKey = `${orgId}|${access.canReadCertificates}|${targets
		.map((target) => target.key)
		.join(",")}`;
	const running = inflightOverviews.get(flightKey);
	if (running) {
		return running;
	}
	const run = buildOverview(orgId, access, targets, settings).finally(() => {
		inflightOverviews.delete(flightKey);
	});
	inflightOverviews.set(flightKey, run);
	return run;
};

const buildOverview = async (
	orgId: string,
	access: DomainOverviewAccess,
	targets: ServerTarget[],
	settings: PanelSettings,
): Promise<DomainOverview> => {
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
				key: `${target.key}|${certificate.resolver}|${name}|${certificate.validTo.getTime()}`,
				main: certificate.main,
				names: certificate.names,
				serverId: target.serverId,
				serverName: target.name,
				isLocal: target.isLocal,
				storagePath: acmeFileFor(target),
				resolver: certificate.resolver,
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
			lastDeletion: toDeletionView(snapshot),
			staleLock: snapshot.deletion?.stale ?? false,
			traefikLeftStopped:
				snapshot.deletion?.marker &&
				!snapshot.deletion.busy &&
				!snapshot.deletionRunning
					? snapshot.deletion.marker
					: null,
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
	if (runningTraefikOperation(target.serverId)) {
		return {
			...base,
			containerFound: true,
			error: DELETION_RUNNING_MESSAGE,
			lines: [],
		};
	}
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
		"The routes, config files or certificate file of this server could not be read, so it cannot be checked that the certificate is unused.",
	not_in_storage: "There is no certificate for this domain in the storage.",
	in_use:
		"A route, a panel domain, a Traefik config file or a matcher still uses it.",
	panel_host: "This is the panel's own domain. It is never deleted here.",
	no_main_domain:
		"This certificate has no main domain, so it cannot be removed.",
	ambiguous: "More than one certificate has this main domain.",
};

export type CertificateRequest = { domain: string; resolver?: string };

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
			status: "deleted" | "started" | "failed";
			code: AcmeDeleteStatus | "no_result";
			message: string;
			backupFile: string | null;
			logFile: string | null;
	  };

const refusal = (domain: string, reason: CertificateRefusalReason) => ({
	domain,
	reason,
	message: REFUSAL_MESSAGES[reason],
});

const wrapScript = (script: string) => `sh -c ${shellQuote(script)}`;

const stdoutOf = (error: unknown) =>
	error instanceof ExecError ? (error.stdout ?? "") : "";

const failedResult = (
	code: AcmeDeleteStatus | "no_result",
	backupFile: string | null,
	logFile: string | null,
	detail?: string,
): DeleteUnusedCertificatesResult => ({
	status: "failed",
	code,
	message:
		code === "no_result"
			? `The command did not report a result${detail ? ` (${detail})` : ""}. Check the server before trying again.`
			: ACME_DELETE_MESSAGES[code],
	backupFile,
	logFile,
});

const normalizeRequests = (requested: (string | CertificateRequest)[]) => {
	const seen = new Set<string>();
	const items: CertificateRequest[] = [];
	for (const entry of requested) {
		const request = typeof entry === "string" ? { domain: entry } : entry;
		const domain = normalizeDomainName(request.domain);
		const key = `${request.resolver ?? ""}|${domain}`;
		if (!seen.has(key)) {
			seen.add(key);
			items.push({ domain, resolver: request.resolver });
		}
	}
	return items;
};

export const deleteUnusedCertificates = async (
	orgId: string,
	serverId: string | null,
	requested: (string | CertificateRequest)[],
): Promise<DeleteUnusedCertificatesResult> => {
	const items = normalizeRequests(requested);
	if (items.length === 0 || items.length > ACME_DELETE_MAX_DOMAINS) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Choose between 1 and ${ACME_DELETE_MAX_DOMAINS} certificates.`,
		});
	}
	const invalid = items.filter(
		(item) =>
			!isValidCertificateDomain(item.domain) ||
			(item.resolver !== undefined && !isValidResolverName(item.resolver)),
	);
	if (invalid.length > 0) {
		return {
			status: "refused",
			refused: invalid.map((item) => refusal(item.domain, "invalid_name")),
		};
	}

	const target = await resolveTarget(orgId, serverId);
	if (target.isLocal && isServerUpdateRunning()) {
		throw new TRPCError({
			code: "CONFLICT",
			message:
				"An update of this panel host is running. Try again when it ends.",
		});
	}
	const releaseOperation = acquireTraefikOperation(
		target.serverId,
		"certificate deletion",
	);
	if (!releaseOperation) {
		throw new TRPCError({
			code: "CONFLICT",
			message: `Traefik is busy on this server (${runningTraefikOperation(target.serverId)}). Try again when it ends.`,
		});
	}
	const releaseHostStack = target.isLocal ? acquireHostStackUpdateLock() : null;
	if (target.isLocal && !releaseHostStack) {
		releaseOperation();
		throw new TRPCError({
			code: "CONFLICT",
			message:
				"An update of this panel host is running. Try again when it ends.",
		});
	}
	let released = false;
	const release = () => {
		if (!released) {
			released = true;
			releaseHostStack?.();
			releaseOperation();
		}
	};
	let handedOver = false;
	try {
		const result = await runDeletion(orgId, target, items, release);
		handedOver = result.status === "started";
		return result;
	} finally {
		if (!handedOver) {
			release();
		}
	}
};

const runDeletion = async (
	orgId: string,
	target: ServerTarget,
	items: CertificateRequest[],
	release: () => void,
): Promise<DeleteUnusedCertificatesResult> => {
	const settings = await readPanelSettings();
	const analysis = await analyzeServers(orgId, [target], settings, true, true);
	const server = analysis.servers[0];
	if (!server?.snapshot.usageVerified) {
		return {
			status: "refused",
			refused: items.map((item) => refusal(item.domain, "usage_unverified")),
		};
	}

	const { certificates } = server.snapshot;
	const refused: ReturnType<typeof refusal>[] = [];
	const chosen: AcmeCertificate[] = [];
	for (const item of items) {
		const matching = certificates.filter(
			(certificate) =>
				certificate.main === item.domain &&
				(item.resolver === undefined || certificate.resolver === item.resolver),
		);
		if (matching.length === 0) {
			refused.push(
				refusal(
					item.domain,
					certificates.some((certificate) =>
						certificate.names.includes(item.domain),
					)
						? "no_main_domain"
						: "not_in_storage",
				),
			);
			continue;
		}
		const certificate = matching[0];
		if (matching.length > 1 || !certificate) {
			refused.push(refusal(item.domain, "ambiguous"));
			continue;
		}
		if (
			target.isLocal &&
			settings.host &&
			certificateCovers(certificate.names, settings.host)
		) {
			refused.push(refusal(item.domain, "panel_host"));
			continue;
		}
		if (!server.unused.some((entry) => entry.certificate === certificate)) {
			refused.push(refusal(item.domain, "in_use"));
			continue;
		}
		chosen.push(certificate);
	}
	if (refused.length > 0) {
		return { status: "refused", refused };
	}

	const timestamp = formatBackupTimestamp(new Date());
	const runId = randomBytes(3).toString("hex");
	const logFile = `acme-delete-${timestamp}-${runId}.log`;
	const script = buildAcmeDeleteScript({
		acmeFile: acmeFileFor(target),
		lockFile: lockFileFor(target),
		markerFile: markerFileFor(target),
		backupDir: backupDirFor(target),
		targets: chosen.map((certificate) => ({
			resolver: certificate.resolver,
			domain: certificate.main ?? "",
		})),
		timestamp,
		startDelaySeconds: target.isLocal ? LOCAL_APPLY_START_DELAY_SECONDS : 0,
	});
	const launcher = buildDeletionLauncher({
		script,
		logDir: logDirFor(target),
		timestamp,
		runId,
	});

	let reported: string | null = null;
	try {
		const { stdout } = await runOnServer(
			target,
			wrapScript(launcher),
			LAUNCH_TIMEOUT_MS,
		);
		reported = stdout;
	} catch (error) {
		const definite = parseDeletionStatus(stdoutOf(error)).status;
		if (definite) {
			return failedResult(definite, null, null, describeFailure(error, target));
		}
	}
	const launched = reported !== null && /^DOKPLOY_LAUNCHED /m.test(reported);
	if (reported !== null && !launched) {
		const definite = parseDeletionStatus(reported).status;
		return failedResult(definite ?? "launch_failed", null, null);
	}

	// A lost answer does not mean the script did not start: it may be running
	// now, so the locks stay until its log says otherwise.
	const outcome = launched
		? await waitForOutcome(target, logFile, target.isLocal)
		: null;
	if (outcome?.status === "ok") {
		return {
			status: "deleted",
			code: "ok",
			message: ACME_DELETE_MESSAGES.ok,
			backupFile: outcome.backupFile,
			logFile,
		};
	}
	if (outcome?.status) {
		return failedResult(outcome.status, outcome.backupFile, logFile);
	}
	void watchDeletion(target, logFile, release);
	return {
		status: "started",
		code: "ok",
		message: launched
			? "The deletion started. Traefik restarts during it and the sites on this server are unavailable for a few seconds. The result appears on this page."
			: "The server did not confirm that the deletion started. It may be running; the result appears on this page.",
		backupFile: outcome?.backupFile ?? null,
		logFile,
	};
};

// On the panel host only the checks before the stop are awaited: the panel is
// normally reached through the Traefik that is about to stop.
const waitForOutcome = async (
	target: ServerTarget,
	logFile: string,
	untilPrecheck: boolean,
) => {
	const deadline =
		Date.now() +
		(untilPrecheck ? deletionTiming.localWaitMs : deletionTiming.remoteWaitMs);
	let last: DeletionStatusFile | null = null;
	while (Date.now() < deadline) {
		try {
			last = await pollDeletion(target, logFile);
		} catch {
			last = null;
		}
		if (last?.status) {
			return last;
		}
		if (untilPrecheck && last?.prechecked) {
			return last;
		}
		await sleep(deletionTiming.pollIntervalMs);
	}
	return last;
};

const pollDeletion = async (target: ServerTarget, logFile: string) => {
	const status = await readDeletionStatus(target, { logFile, fresh: true });
	watchedStatus.set(target.key, { at: Date.now(), status });
	return status;
};

const MISSING_LOG_POLLS = 3;

// The host-side lock is what keeps other deletions out; this keeps the
// in-process locks until the script has written its result, was found dead,
// or turned out never to have started.
const watchDeletion = async (
	target: ServerTarget,
	logFile: string,
	release: () => void,
) => {
	const deadline = Date.now() + deletionTiming.watchMaxMs;
	let missing = 0;
	try {
		while (Date.now() < deadline) {
			await sleep(deletionTiming.pollIntervalMs);
			try {
				const status = await pollDeletion(target, logFile);
				if (status.status) {
					return;
				}
				if (status.logFile) {
					missing = 0;
					if (!status.busy) {
						return;
					}
				} else if (!status.busy) {
					missing += 1;
					if (missing >= MISSING_LOG_POLLS) {
						return;
					}
				}
			} catch {
				// The panel may lose its connection while Traefik restarts.
			}
		}
	} finally {
		watchedStatus.delete(target.key);
		statusCache.delete(target.key);
		release();
	}
};

export type ClearLockResult = {
	status: ClearLockOutcome["status"];
	traefik: ClearLockOutcome["traefik"];
	message: string;
};

const CLEAR_LOCK_MESSAGES: Record<ClearLockOutcome["status"], string> = {
	cleared: "The leftover lock was removed.",
	none: "There is no lock to remove.",
	alive:
		"The process that holds the lock is still running, so the lock was kept.",
	failed: "The lock could not be removed.",
};

const withTraefikLocks = async <T>(
	target: ServerTarget,
	label: string,
	task: () => Promise<T>,
): Promise<T> => {
	if (target.isLocal && isServerUpdateRunning()) {
		throw new TRPCError({
			code: "CONFLICT",
			message:
				"An update of this panel host is running. Try again when it ends.",
		});
	}
	const releaseOperation = acquireTraefikOperation(target.serverId, label);
	if (!releaseOperation) {
		throw new TRPCError({
			code: "CONFLICT",
			message: `Traefik is busy on this server (${runningTraefikOperation(target.serverId)}). Try again when it ends.`,
		});
	}
	const releaseHostStack = target.isLocal ? acquireHostStackUpdateLock() : null;
	if (target.isLocal && !releaseHostStack) {
		releaseOperation();
		throw new TRPCError({
			code: "CONFLICT",
			message:
				"An update of this panel host is running. Try again when it ends.",
		});
	}
	try {
		return await task();
	} finally {
		releaseHostStack?.();
		releaseOperation();
	}
};

export const clearStaleDeletionLock = async (
	orgId: string,
	serverId: string | null,
): Promise<ClearLockResult> => {
	const target = await resolveTarget(orgId, serverId);
	return withTraefikLocks(target, "lock cleanup", async () => {
		const { stdout } = await runOnServer(
			target,
			wrapScript(
				buildClearStaleLockCommand({
					lockFile: lockFileFor(target),
					markerFile: markerFileFor(target),
				}),
			),
			LAUNCH_TIMEOUT_MS,
		);
		statusCache.delete(target.key);
		const outcome = parseClearLockOutcome(stdout);
		return {
			status: outcome.status,
			traefik: outcome.traefik,
			message: CLEAR_LOCK_MESSAGES[outcome.status],
		};
	});
};

export type RecoverTraefikResult = {
	status: RecoveryStatus | "no_result";
	message: string;
};

const RECOVERY_TIMEOUT_MS = 180_000;

export const recoverInterruptedTraefik = async (
	orgId: string,
	serverId: string | null,
): Promise<RecoverTraefikResult> => {
	const target = await resolveTarget(orgId, serverId);
	return withTraefikLocks(target, "traefik recovery", async () => {
		let stdout = "";
		try {
			({ stdout } = await runOnServer(
				target,
				wrapScript(
					buildTraefikRecoveryScript({
						acmeFile: acmeFileFor(target),
						lockFile: lockFileFor(target),
						markerFile: markerFileFor(target),
						backupDir: backupDirFor(target),
					}),
				),
				RECOVERY_TIMEOUT_MS,
			));
		} catch (error) {
			stdout = stdoutOf(error);
			if (!parseRecoveryStatus(stdout)) {
				throw error;
			}
		}
		statusCache.delete(target.key);
		const status = parseRecoveryStatus(stdout);
		return status
			? { status, message: RECOVERY_MESSAGES[status] }
			: {
					status: "no_result",
					message:
						"The server did not report a result. Check docker ps on the server.",
				};
	});
};

// Other Traefik operations (reload, port change, dashboard toggle) must not
// run while a deletion is in flight on the host or has left Traefik stopped.
// The in-process lock is lost when the panel restarts, so the host is asked.
export const assertNoTraefikDeletion = async (serverId: string | null) => {
	const target: ServerTarget = {
		key: serverId ?? LOCAL_KEY,
		serverId,
		name: serverId ?? LOCAL_NAME,
		addresses: [],
		isLocal: serverId === null,
	};
	let status: DeletionStatusFile;
	try {
		status = await readDeletionStatus(target, { fresh: true });
	} catch {
		return;
	}
	if (status.busy) {
		throw new TRPCError({
			code: "CONFLICT",
			message:
				"A certificate deletion is running on this server. Try again when it ends.",
		});
	}
	if (status.marker) {
		throw new TRPCError({
			code: "CONFLICT",
			message:
				"An interrupted certificate deletion left Traefik stopped. Start Traefik again from the Domains page first.",
		});
	}
};

export const warnAboutInterruptedTraefikDeletion = async () => {
	try {
		const status = await readDeletionStatus(
			{
				key: LOCAL_KEY,
				serverId: null,
				name: LOCAL_NAME,
				addresses: [],
				isLocal: true,
			},
			{ fresh: true },
		);
		if (status.marker && !status.busy) {
			console.warn(
				`[domain-overview] An interrupted certificate deletion left Traefik (${status.marker.kind}) stopped on this host. Start it again from the Domains page.`,
			);
		}
	} catch {
		// Nothing to report when the host cannot be asked.
	}
};

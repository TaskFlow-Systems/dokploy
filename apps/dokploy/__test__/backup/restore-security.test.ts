import { REDACTED_SECRET_VALUE } from "@dokploy/server/utils/security/redaction";
import { TRPCError } from "@trpc/server";
import { parse } from "shell-quote";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	maxJsonBuildArrayArgs,
	POSTGRES_MAX_FUNCTION_ARGS,
	relationalQueryDb,
} from "../helpers/postgres-function-args";

const mocks = vi.hoisted(() => ({
	checkPermission: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	createBackup: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	findApplicationById: vi.fn(),
	findBackupById: vi.fn(),
	findComposeByBackupId: vi.fn(),
	findComposeById: vi.fn(),
	findDestinationById: vi.fn(),
	findEnvironmentById: vi.fn(),
	findLibsqlByBackupId: vi.fn(),
	findLibsqlById: vi.fn(),
	findMariadbByBackupId: vi.fn(),
	findMariadbById: vi.fn(),
	findMongoByBackupId: vi.fn(),
	findMongoById: vi.fn(),
	findMySqlByBackupId: vi.fn(),
	findMySqlById: vi.fn(),
	findPostgresByBackupId: vi.fn(),
	findPostgresById: vi.fn(),
	findProjectById: vi.fn(),
	findRedisById: vi.fn(),
	findServerById: vi.fn(),
	findRestoreBackups: vi.fn(),
	findVolumeBackupSchedules: vi.fn(),
	getAccessibleServerIds: vi.fn(),
	getS3Credentials: vi.fn(),
	keepLatestNBackups: vi.fn(),
	normalizeS3Path: vi.fn(),
	paths: vi.fn(),
	removeBackupById: vi.fn(),
	removeJob: vi.fn(),
	removeScheduleBackup: vi.fn(),
	restoreComposeBackup: vi.fn(),
	restoreLibsqlBackup: vi.fn(),
	restoreMariadbBackup: vi.fn(),
	restoreMongoBackup: vi.fn(),
	restoreMySqlBackup: vi.fn(),
	restorePostgresBackup: vi.fn(),
	restoreWebServerBackup: vi.fn(),
	sendDatabaseBackupNotifications: vi.fn(),
	runComposeBackup: vi.fn(),
	runLibsqlBackup: vi.fn(),
	runMariadbBackup: vi.fn(),
	runMongoBackup: vi.fn(),
	runMySqlBackup: vi.fn(),
	runPostgresBackup: vi.fn(),
	runWebServerBackup: vi.fn(),
	schedule: vi.fn(),
	scheduleBackup: vi.fn(),
	updateBackupById: vi.fn(),
	updateJob: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	createBackup: mocks.createBackup,
	findApplicationById: mocks.findApplicationById,
	findBackupById: mocks.findBackupById,
	findComposeByBackupId: mocks.findComposeByBackupId,
	findComposeById: mocks.findComposeById,
	findLibsqlByBackupId: mocks.findLibsqlByBackupId,
	findEnvironmentById: mocks.findEnvironmentById,
	findLibsqlById: mocks.findLibsqlById,
	findMariadbByBackupId: mocks.findMariadbByBackupId,
	findMariadbById: mocks.findMariadbById,
	findMongoByBackupId: mocks.findMongoByBackupId,
	findMongoById: mocks.findMongoById,
	findMySqlByBackupId: mocks.findMySqlByBackupId,
	findMySqlById: mocks.findMySqlById,
	findPostgresByBackupId: mocks.findPostgresByBackupId,
	findPostgresById: mocks.findPostgresById,
	findProjectById: mocks.findProjectById,
	findRedisById: mocks.findRedisById,
	findServerById: mocks.findServerById,
	getAccessibleServerIds: mocks.getAccessibleServerIds,
	keepLatestNBackups: mocks.keepLatestNBackups,
	removeBackupById: mocks.removeBackupById,
	removeScheduleBackup: mocks.removeScheduleBackup,
	runLibsqlBackup: mocks.runLibsqlBackup,
	runMariadbBackup: mocks.runMariadbBackup,
	runMongoBackup: mocks.runMongoBackup,
	runMySqlBackup: mocks.runMySqlBackup,
	runPostgresBackup: mocks.runPostgresBackup,
	runWebServerBackup: mocks.runWebServerBackup,
	scheduleBackup: mocks.scheduleBackup,
	updateBackupById: mocks.updateBackupById,
}));

vi.mock("@dokploy/server/index", () => ({
	IS_CLOUD: false,
	createBackup: mocks.createBackup,
	findApplicationById: mocks.findApplicationById,
	findBackupById: mocks.findBackupById,
	findComposeByBackupId: mocks.findComposeByBackupId,
	findComposeById: mocks.findComposeById,
	findLibsqlByBackupId: mocks.findLibsqlByBackupId,
	findEnvironmentById: mocks.findEnvironmentById,
	findLibsqlById: mocks.findLibsqlById,
	findMariadbByBackupId: mocks.findMariadbByBackupId,
	findMariadbById: mocks.findMariadbById,
	findMongoByBackupId: mocks.findMongoByBackupId,
	findMongoById: mocks.findMongoById,
	findMySqlByBackupId: mocks.findMySqlByBackupId,
	findMySqlById: mocks.findMySqlById,
	findPostgresByBackupId: mocks.findPostgresByBackupId,
	findPostgresById: mocks.findPostgresById,
	findProjectById: mocks.findProjectById,
	findRedisById: mocks.findRedisById,
	findServerById: mocks.findServerById,
	getAccessibleServerIds: mocks.getAccessibleServerIds,
	hasValidLicense: vi.fn().mockResolvedValue(true),
	keepLatestNBackups: mocks.keepLatestNBackups,
	removeBackupById: mocks.removeBackupById,
	removeScheduleBackup: mocks.removeScheduleBackup,
	runLibsqlBackup: mocks.runLibsqlBackup,
	runMariadbBackup: mocks.runMariadbBackup,
	runMongoBackup: mocks.runMongoBackup,
	runMySqlBackup: mocks.runMySqlBackup,
	runPostgresBackup: mocks.runPostgresBackup,
	runWebServerBackup: mocks.runWebServerBackup,
	scheduleBackup: mocks.scheduleBackup,
	updateBackupById: mocks.updateBackupById,
}));

vi.mock("@dokploy/server/constants", () => ({
	IS_CLOUD: false,
	paths: mocks.paths,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			backups: {
				findMany: mocks.findRestoreBackups,
			},
			volumeBackups: {
				findMany: mocks.findVolumeBackupSchedules,
			},
		},
	},
}));

vi.mock("@dokploy/server/services/destination", () => ({
	findDestinationById: mocks.findDestinationById,
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: mocks.checkPermission,
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));

vi.mock("@dokploy/server/utils/backups/compose", () => ({
	runComposeBackup: mocks.runComposeBackup,
}));

vi.mock("@dokploy/server/utils/backups/utils", async () => {
	const { quote } = await import("shell-quote");

	return {
		assertRcloneS3DestinationAllowed: async <T>(destination: T) => destination,
		buildRcloneS3Command: (
			command: string,
			destination: { bucket: string },
			args: string[],
		) =>
			quote([
				"rclone",
				command,
				...mocks.getS3Credentials(destination),
				...args,
			]),
		getComposeContainerCommand: (
			appName: string,
			serviceName: string,
			composeType: "stack" | "docker-compose" | undefined,
		) =>
			composeType === "stack"
				? `docker ps -q --filter "status=running" --filter "label=com.docker.stack.namespace=${appName}" --filter "label=com.docker.swarm.service.name=${appName}_${serviceName}" | head -n 1`
				: `docker ps -q --filter "status=running" --filter "label=com.docker.compose.project=${appName}" --filter "label=com.docker.compose.service=${serviceName}" | head -n 1`,
		getRcloneS3Destination: (destination: { bucket: string }, path?: string) =>
			`:s3:${destination.bucket}${path ? `/${path}` : ""}`,
		getS3Credentials: mocks.getS3Credentials,
		getServiceContainerCommand: (appName: string) =>
			`docker ps -q --filter "status=running" --filter "label=com.docker.swarm.service.name=${appName}" | head -n 1`,
		normalizeS3Path: mocks.normalizeS3Path,
	};
});

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock("@dokploy/server/services/environment", () => ({
	findEnvironmentById: mocks.findEnvironmentById,
}));

vi.mock("@dokploy/server/services/project", () => ({
	findProjectById: mocks.findProjectById,
}));

vi.mock("@dokploy/server/utils/notifications/database-backup", () => ({
	sendDatabaseBackupNotifications: mocks.sendDatabaseBackupNotifications,
}));

vi.mock("@dokploy/server/utils/restore", () => ({
	restoreComposeBackup: mocks.restoreComposeBackup,
	restoreLibsqlBackup: mocks.restoreLibsqlBackup,
	restoreMariadbBackup: mocks.restoreMariadbBackup,
	restoreMongoBackup: mocks.restoreMongoBackup,
	restoreMySqlBackup: mocks.restoreMySqlBackup,
	restorePostgresBackup: mocks.restorePostgresBackup,
	restoreWebServerBackup: mocks.restoreWebServerBackup,
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: mocks.removeJob,
	schedule: mocks.schedule,
	updateJob: mocks.updateJob,
}));

const { ExecError } = await import("@dokploy/server/utils/process/ExecError");
const { backupRouter } = await import("../../server/api/routers/backup");
const { restorePostgresBackup } = await import(
	"@dokploy/server/utils/restore/postgres"
);
const { buildGzipTarArchivePolicyCommand, restoreLibsqlBackup } = await import(
	"@dokploy/server/utils/restore/libsql"
);
const { restoreWebServerBackup, validateWebServerArchiveMembers } =
	await import("@dokploy/server/utils/restore/web-server");
const { getRestoreCommand } = await import(
	"@dokploy/server/utils/restore/utils"
);

const safeDestination = {
	accessKey: "access-key",
	additionalFlags: [],
	bucket: "dokploy-backups",
	endpoint: "https://s3.example.test",
	organizationId: "org-1",
	provider: "AWS",
	region: "us-east-1",
	secretAccessKey: "secret-key",
};

const safePostgresInput = {
	backupFile: "app-one/prefix/appdb-2026-06-22.sql.gz",
	backupType: "database" as const,
	databaseId: "postgres-1",
	databaseName: "appdb",
	databaseType: "postgres" as const,
	destinationId: "destination-1",
};

const safeCreateBackupInput = {
	backupType: "database" as const,
	database: "appdb",
	databaseType: "postgres" as const,
	destinationId: "destination-1",
	enabled: false,
	keepLatestCount: 3,
	metadata: {},
	postgresId: "postgres-1",
	prefix: "daily",
	schedule: "0 0 * * *",
	serviceName: "postgres",
	userId: "user-1",
};

const safeWebServerCreateBackupInput = {
	backupType: "database" as const,
	database: "dokploy",
	databaseType: "web-server" as const,
	destinationId: "destination-1",
	enabled: false,
	keepLatestCount: 3,
	metadata: {},
	prefix: "daily",
	schedule: "0 0 * * *",
	userId: "user-1",
};

const safeUpdateBackupInput = {
	backupId: "backup-1",
	database: "appdb",
	databaseType: "postgres" as const,
	destinationId: "destination-1",
	enabled: false,
	keepLatestCount: 3,
	metadata: {},
	prefix: "daily",
	schedule: "0 0 * * *",
	serviceName: "postgres",
};

const createCaller = (role: "owner" | "admin" | "member" = "admin") =>
	backupRouter.createCaller({
		db: {},
		req: {},
		res: {},
		session: {
			userId: "user-1",
			activeOrganizationId: "org-1",
		},
		user: {
			id: "user-1",
			role,
		},
	} as never);

const runRestoreSubscription = async (
	input: Parameters<
		ReturnType<typeof createCaller>["restoreBackupWithLogs"]
	>[0],
	role: "owner" | "admin" | "member" = "admin",
) => {
	const stream = await createCaller(role).restoreBackupWithLogs(input);
	for await (const _log of stream as AsyncIterable<string>) {
		// Drain the restore subscription so async restore errors surface.
	}
};

const emittedLogs: string[] = [];
const emit = (log: string) => emittedLogs.push(log);

const parseShellArgs = (command: string) =>
	parse(command).filter((part): part is string => typeof part === "string");

describe("backup destination ownership boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
		mocks.checkPermission.mockResolvedValue(undefined);
		mocks.createBackup.mockResolvedValue({ backupId: "backup-1" });
		mocks.findBackupById.mockResolvedValue({
			backupId: "backup-1",
			backupType: "database",
			databaseType: "postgres",
			destinationId: "destination-1",
			enabled: false,
			postgresId: "postgres-1",
			schedule: "0 0 * * *",
		});
		mocks.findDestinationById.mockResolvedValue({
			...safeDestination,
			organizationId: "org-2",
		});
		mocks.updateBackupById.mockResolvedValue({
			backupId: "backup-1",
			destinationId: "destination-1",
		});
	});

	it("rejects cross-organization destinations on backup create before persistence", async () => {
		await expect(
			createCaller().create(safeCreateBackupInput),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.createBackup).not.toHaveBeenCalled();
		expect(mocks.scheduleBackup).not.toHaveBeenCalled();
		expect(mocks.schedule).not.toHaveBeenCalled();
	});

	it("rejects cross-organization destinations on backup update before persistence", async () => {
		await expect(
			createCaller().update(safeUpdateBackupInput),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.updateBackupById).not.toHaveBeenCalled();
		expect(mocks.scheduleBackup).not.toHaveBeenCalled();
		expect(mocks.updateJob).not.toHaveBeenCalled();
	});

	it("allows same-organization destinations on backup create", async () => {
		mocks.findDestinationById.mockResolvedValue({
			...safeDestination,
			organizationId: "org-1",
		});

		await expect(createCaller().create(safeCreateBackupInput)).resolves.toBe(
			undefined,
		);

		expect(mocks.createBackup).toHaveBeenCalledWith(safeCreateBackupInput);
	});

	it("rejects backup creates with mismatched service foreign keys before persistence", async () => {
		await expect(
			createCaller().create({
				...safeCreateBackupInput,
				databaseType: "mysql",
				mysqlId: "mysql-1",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
		expect(mocks.createBackup).not.toHaveBeenCalled();
		expect(mocks.scheduleBackup).not.toHaveBeenCalled();
		expect(mocks.schedule).not.toHaveBeenCalled();
	});

	it("rejects web-server backup creates that include a service foreign key", async () => {
		await expect(
			createCaller("admin").create({
				...safeWebServerCreateBackupInput,
				postgresId: "postgres-1",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
		expect(mocks.createBackup).not.toHaveBeenCalled();
		expect(mocks.scheduleBackup).not.toHaveBeenCalled();
		expect(mocks.schedule).not.toHaveBeenCalled();
	});

	it("requires owner or admin role for service-less web-server backup create", async () => {
		mocks.findDestinationById.mockResolvedValue({
			...safeDestination,
			organizationId: "org-1",
		});

		await expect(
			createCaller("member").create(safeWebServerCreateBackupInput),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.createBackup).not.toHaveBeenCalled();
		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
	});

	it("allows owner or admin to create same-organization web-server backups", async () => {
		mocks.findDestinationById.mockResolvedValue({
			...safeDestination,
			organizationId: "org-1",
		});
		mocks.findBackupById.mockResolvedValue({
			backupId: "backup-1",
			backupType: "database",
			databaseType: "web-server",
			destinationId: "destination-1",
			enabled: false,
			schedule: "0 0 * * *",
		});

		await expect(
			createCaller("admin").create(safeWebServerCreateBackupInput),
		).resolves.toBe(undefined);

		expect(mocks.createBackup).toHaveBeenCalledWith(
			safeWebServerCreateBackupInput,
		);
		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
	});

	it("rejects backup updates that change database type without a service rebind", async () => {
		await expect(
			createCaller().update({
				...safeUpdateBackupInput,
				databaseType: "mysql",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(mocks.updateBackupById).not.toHaveBeenCalled();
		expect(mocks.scheduleBackup).not.toHaveBeenCalled();
		expect(mocks.updateJob).not.toHaveBeenCalled();
	});

	it("allows same-organization destinations on backup update", async () => {
		mocks.findDestinationById.mockResolvedValue({
			...safeDestination,
			organizationId: "org-1",
		});

		await expect(createCaller().update(safeUpdateBackupInput)).resolves.toBe(
			undefined,
		);

		expect(mocks.updateBackupById).toHaveBeenCalledWith(
			"backup-1",
			safeUpdateBackupInput,
		);
	});

	it("rejects cross-organization service-less backup ids before reading", async () => {
		mocks.findBackupById.mockResolvedValue({
			backupId: "backup-1",
			backupType: "database",
			databaseType: "web-server",
			destinationId: "destination-1",
		});
		mocks.findDestinationById.mockResolvedValue({
			...safeDestination,
			organizationId: "org-2",
		});

		await expect(
			createCaller("admin").one({ backupId: "backup-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("rejects non-admin manual web-server backup runs before side effects", async () => {
		mocks.findBackupById.mockResolvedValue({
			backupId: "backup-1",
			backupType: "database",
			databaseType: "web-server",
			destinationId: "destination-1",
		});
		mocks.findDestinationById.mockResolvedValue({
			...safeDestination,
			organizationId: "org-1",
		});

		await expect(
			createCaller("member").manualBackupWebServer({ backupId: "backup-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.runWebServerBackup).not.toHaveBeenCalled();
		expect(mocks.keepLatestNBackups).not.toHaveBeenCalled();
	});

	it("rejects service-less backup ids on database manual routes before side effects", async () => {
		mocks.findBackupById.mockResolvedValue({
			backupId: "backup-1",
			backupType: "database",
			databaseType: "web-server",
			destinationId: "destination-1",
		});

		await expect(
			createCaller("admin").manualBackupPostgres({ backupId: "backup-1" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
		expect(mocks.findPostgresByBackupId).not.toHaveBeenCalled();
		expect(mocks.runPostgresBackup).not.toHaveBeenCalled();
	});

	it("rejects cross-organization manual web-server backup ids before side effects", async () => {
		mocks.findBackupById.mockResolvedValue({
			backupId: "backup-1",
			backupType: "database",
			databaseType: "web-server",
			destinationId: "destination-1",
		});
		mocks.findDestinationById.mockResolvedValue({
			...safeDestination,
			organizationId: "org-2",
		});

		await expect(
			createCaller("admin").manualBackupWebServer({ backupId: "backup-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.runWebServerBackup).not.toHaveBeenCalled();
		expect(mocks.keepLatestNBackups).not.toHaveBeenCalled();
	});
});

describe("backup restore route boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		emittedLogs.length = 0;

		mocks.checkPermission.mockResolvedValue(undefined);
		mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
		mocks.findDestinationById.mockResolvedValue(safeDestination);
		mocks.findPostgresById.mockResolvedValue({
			appName: "app-one",
			databaseUser: "dokploy",
			serverId: null,
		});
		mocks.normalizeS3Path.mockImplementation((prefix: string) =>
			prefix.trim().replace(/^\/+|\/+$/g, "")
				? `${prefix.trim().replace(/^\/+|\/+$/g, "")}/`
				: "",
		);
		mocks.findRestoreBackups.mockResolvedValue([
			{
				appName: "backup-one",
				backupType: "database",
				databaseType: "postgres",
				destinationId: "destination-1",
				prefix: "prefix",
				postgres: {
					appName: "app-one",
				},
				postgresId: "postgres-1",
			},
		]);
		mocks.getS3Credentials.mockReturnValue(["--s3-provider", "AWS"]);
		mocks.restorePostgresBackup.mockResolvedValue(undefined);
		mocks.restoreWebServerBackup.mockResolvedValue(undefined);
	});

	it("requires backup restore permission before restore side effects", async () => {
		mocks.checkPermission.mockRejectedValue(
			new TRPCError({
				code: "UNAUTHORIZED",
				message: "Backup restore denied",
			}),
		);

		await expect(
			runRestoreSubscription(safePostgresInput),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.findDestinationById).not.toHaveBeenCalled();
		expect(mocks.findPostgresById).not.toHaveBeenCalled();
		expect(mocks.restorePostgresBackup).not.toHaveBeenCalled();
	});

	it("rejects cross-organization destinations before restore side effects", async () => {
		mocks.findDestinationById.mockResolvedValue({
			...safeDestination,
			organizationId: "org-2",
		});

		await expect(
			runRestoreSubscription(safePostgresInput),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.findPostgresById).not.toHaveBeenCalled();
		expect(mocks.restorePostgresBackup).not.toHaveBeenCalled();
	});

	it("rejects non-web-server restore without a service id", async () => {
		await expect(
			runRestoreSubscription({
				...safePostgresInput,
				databaseId: "",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
		expect(mocks.findPostgresById).not.toHaveBeenCalled();
		expect(mocks.restorePostgresBackup).not.toHaveBeenCalled();
	});

	it("rejects restore files outside the target backup schedule prefix", async () => {
		await expect(
			runRestoreSubscription({
				...safePostgresInput,
				backupFile: "other-app/prefix/appdb-2026-06-22.sql.gz",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.findPostgresById).not.toHaveBeenCalled();
		expect(mocks.restorePostgresBackup).not.toHaveBeenCalled();
	});

	it("allows restore files bound to the target backup schedule prefix", async () => {
		await expect(runRestoreSubscription(safePostgresInput)).resolves.toBe(
			undefined,
		);

		expect(mocks.restorePostgresBackup).toHaveBeenCalledWith(
			expect.objectContaining({ appName: "app-one" }),
			safeDestination,
			safePostgresInput,
			expect.any(Function),
		);
	});

	it("requires owner or admin role for web-server restore", async () => {
		await expect(
			runRestoreSubscription(
				{
					backupFile: "dokploy/webserver-backup-2026-06-22.zip",
					backupType: "database",
					databaseId: "user-1",
					databaseName: "dokploy",
					databaseType: "web-server",
					destinationId: "destination-1",
				},
				"member",
			),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.restoreWebServerBackup).not.toHaveBeenCalled();
	});

	it("requires a matching web-server backup schedule before restore side effects", async () => {
		mocks.findRestoreBackups.mockResolvedValue([]);

		await expect(
			runRestoreSubscription({
				backupFile: "dokploy/prefix/webserver-backup-2026-06-22.zip",
				backupType: "database",
				databaseId: "",
				databaseName: "dokploy",
				databaseType: "web-server",
				destinationId: "destination-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.restoreWebServerBackup).not.toHaveBeenCalled();
	});

	it("allows web-server restore files bound to a server backup schedule", async () => {
		mocks.findRestoreBackups.mockResolvedValue([
			{
				appName: "dokploy",
				backupType: "database",
				databaseType: "web-server",
				destinationId: "destination-1",
				prefix: "prefix",
			},
		]);
		const input = {
			backupFile: "dokploy/prefix/webserver-backup-2026-06-22.zip",
			backupType: "database" as const,
			databaseId: "",
			databaseName: "dokploy",
			databaseType: "web-server" as const,
			destinationId: "destination-1",
		};

		await expect(runRestoreSubscription(input)).resolves.toBe(undefined);

		expect(mocks.restoreWebServerBackup).toHaveBeenCalledWith(
			safeDestination,
			input.backupFile,
			expect.any(Function),
		);
	});

	it("quotes destination fields when listing backup files", async () => {
		mocks.findDestinationById.mockResolvedValue({
			...safeDestination,
			bucket: "bucket$(id);touch",
		});
		mocks.getS3Credentials.mockReturnValue(["--s3-provider", "AWS"]);
		mocks.normalizeS3Path.mockReturnValue("prefix/");
		mocks.findRestoreBackups.mockResolvedValue([
			{
				appName: "app-one",
				backupType: "database",
				databaseType: "postgres",
				destinationId: "destination-1",
				postgresId: "postgres-1",
				prefix: "prefix",
				postgres: { appName: "app-one" },
			},
		]);
		mocks.findVolumeBackupSchedules.mockResolvedValue([]);
		mocks.execAsync.mockResolvedValue({ stdout: "[]" });

		await expect(
			createCaller().listBackupFiles({
				destinationId: "destination-1",
				search: "app-one/prefix/app",
			}),
		).resolves.toEqual([]);

		const command = mocks.execAsync.mock.calls[0]?.[0] as string;
		expect(command).not.toContain('":s3:bucket$(id);touch/app-one/prefix/"');
		const rcloneCommand = command.replace(/\s+2>\/dev\/null$/, "");
		const args = parseShellArgs(rcloneCommand);

		expect(args.slice(0, 2)).toEqual(["rclone", "lsjson"]);
		expect(args).toContain(":s3:bucket$(id);touch/app-one/prefix/");
		expect(args).toContain("--no-mimetype");
		expect(args).toContain("--no-modtime");
		expect(mocks.checkPermission).not.toHaveBeenCalledWith(expect.anything(), {
			server: ["execute"],
		});
		expect(mocks.checkPermission).not.toHaveBeenCalledWith(expect.anything(), {
			backup: ["create"],
		});
	});

	it("denies backup file listing when no accessible schedule prefix exists", async () => {
		mocks.findDestinationById.mockResolvedValue(safeDestination);
		mocks.getS3Credentials.mockReturnValue(["--s3-provider", "AWS"]);
		mocks.findRestoreBackups.mockResolvedValue([]);
		mocks.findVolumeBackupSchedules.mockResolvedValue([]);

		await expect(
			createCaller().listBackupFiles({
				destinationId: "destination-1",
				search: "",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("keeps backup file listing queries within the Postgres function argument limit", async () => {
		const compiledQueries: string[] = [];
		mocks.findRestoreBackups.mockImplementation(async (config) => {
			compiledQueries.push(
				relationalQueryDb.query.backups.findMany(config).toSQL().sql,
			);
			return [
				{
					appName: "backup-one",
					backupType: "database",
					databaseType: "postgres",
					destinationId: "destination-1",
					postgresId: "postgres-1",
					prefix: "daily",
					postgres: { appName: "app-one" },
				},
			];
		});
		mocks.findVolumeBackupSchedules.mockImplementation(async (config) => {
			compiledQueries.push(
				relationalQueryDb.query.volumeBackups.findMany(config).toSQL().sql,
			);
			return [
				{
					appName: "volume-backup-one",
					applicationId: "application-1",
					prefix: "volumes",
					application: { appName: "web-app" },
				},
			];
		});
		mocks.execAsync.mockResolvedValue({ stdout: "[]" });

		await expect(
			createCaller().listBackupFiles({
				destinationId: "destination-1",
				search: "",
			}),
		).resolves.toEqual([]);

		expect(compiledQueries).toHaveLength(2);
		for (const sqlText of compiledQueries) {
			expect(sqlText).toContain("json_build_array(");
			expect(maxJsonBuildArrayArgs(sqlText)).toBeLessThanOrEqual(
				POSTGRES_MAX_FUNCTION_ARGS,
			);
		}
		const listedArgs = mocks.execAsync.mock.calls.map(([command]) =>
			parseShellArgs((command as string).replace(/\s+2>\/dev\/null$/, "")),
		);
		expect(listedArgs).toHaveLength(2);
		expect(listedArgs[0]).toContain(":s3:dokploy-backups/app-one/daily/");
		expect(listedArgs[1]).toContain(":s3:dokploy-backups/web-app/volumes/");
	});

	it("requires backup management permission before remote backup file listing", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-1"]));
		mocks.checkPermission.mockImplementation(async (_ctx, permissions) => {
			if (
				JSON.stringify(permissions) === JSON.stringify({ backup: ["create"] })
			) {
				throw new TRPCError({ code: "UNAUTHORIZED" });
			}
		});

		await expect(
			createCaller().listBackupFiles({
				destinationId: "destination-1",
				search: "prefix/app",
				serverId: "server-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
			server: ["execute"],
		});
		expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
			backup: ["create"],
		});
		expect(mocks.findDestinationById).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("requires server execute before loading destination credentials for remote backup file listing", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-1"]));
		mocks.checkPermission.mockImplementation(async (_ctx, permissions) => {
			if (
				JSON.stringify(permissions) === JSON.stringify({ server: ["execute"] })
			) {
				throw new TRPCError({ code: "UNAUTHORIZED" });
			}
		});

		await expect(
			createCaller().listBackupFiles({
				destinationId: "destination-1",
				search: "prefix/app",
				serverId: "server-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
			server: ["execute"],
		});
		expect(mocks.checkPermission).not.toHaveBeenCalledWith(expect.anything(), {
			backup: ["create"],
		});
		expect(mocks.findDestinationById).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("denies inaccessible backup listing servers before remote rclone execution", async () => {
		mocks.findDestinationById.mockResolvedValue(safeDestination);
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));
		mocks.getS3Credentials.mockReturnValue(["--s3-provider", "AWS"]);
		mocks.normalizeS3Path.mockReturnValue("prefix/");
		mocks.findRestoreBackups.mockResolvedValue([
			{
				appName: "app-one",
				backupType: "database",
				databaseType: "postgres",
				destinationId: "destination-1",
				postgresId: "postgres-1",
				prefix: "prefix",
				postgres: { appName: "app-one" },
			},
		]);
		mocks.findVolumeBackupSchedules.mockResolvedValue([]);
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "[]" });

		await expect(
			createCaller().listBackupFiles({
				destinationId: "destination-1",
				search: "prefix/app",
				serverId: "server-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});
});

describe("backup restore command safety", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		emittedLogs.length = 0;

		mocks.getS3Credentials.mockReturnValue(["--s3-provider", "AWS"]);
		mocks.paths.mockReturnValue({ BASE_PATH: "/srv/dokploy" });
		mocks.execAsync.mockImplementation(async (command: string) => {
			if (command.includes("ls -la")) {
				return { stdout: "webserver-backup-2026-06-22.zip\n" };
			}
			if (command.startsWith("unzip -Z1")) {
				return {
					stdout: "database.sql\nfilesystem/\nfilesystem/config.json\n",
				};
			}
			if (command.startsWith("unzip -Z -l")) {
				return { stdout: "" };
			}
			if (command.startsWith("find ")) {
				return { stdout: "" };
			}
			if (command.includes("database.sql.gz")) {
				return { stdout: "" };
			}
			if (command.includes("database.sql")) {
				return { stdout: "database.sql\n" };
			}
			if (command.includes("docker ps")) {
				return { stdout: "postgres-container\n" };
			}
			return { stdout: "" };
		});
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "" });
	});

	it("rejects unsafe backup object paths before database restore commands", async () => {
		await expect(
			restorePostgresBackup(
				{
					appName: "app-one",
					databaseUser: "dokploy",
					serverId: null,
				} as never,
				safeDestination as never,
				{
					...safePostgresInput,
					backupFile: "../secret.sql.gz",
				},
				emit,
			),
		).rejects.toThrow("Invalid file path");

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("rejects unsafe web-server backup object paths before commands", async () => {
		await expect(
			restoreWebServerBackup(safeDestination as never, "../server.zip", emit),
		).rejects.toThrow("Invalid file path");

		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("rejects unsafe web-server archive members before extraction", () => {
		expect(() =>
			validateWebServerArchiveMembers([
				"database.sql",
				"filesystem/",
				"filesystem/../escape.txt",
			]),
		).toThrow("Unsafe backup archive member");
	});

	it("rejects unexpected web-server archive roots before extraction", () => {
		expect(() =>
			validateWebServerArchiveMembers([
				"database.sql",
				"filesystem/config.json",
				"etc/passwd",
			]),
		).toThrow("Unexpected backup archive member");
	});

	it("validates web-server backup archives before unzip extraction", async () => {
		mocks.execAsync.mockImplementation(async (command: string) => {
			if (command.includes("ls -la")) {
				return { stdout: "webserver-backup-2026-06-22.zip\n" };
			}
			if (command.startsWith("unzip -Z1")) {
				return { stdout: "database.sql\n../escape.txt\n" };
			}
			return { stdout: "" };
		});

		await expect(
			restoreWebServerBackup(
				safeDestination as never,
				"dokploy/prefix/webserver-backup-2026-06-22.zip",
				emit,
			),
		).rejects.toThrow("Unsafe backup archive member");

		const commands = mocks.execAsync.mock.calls.map(([command]) =>
			String(command),
		);
		expect(commands.some((command) => command.includes("unzip -Z1"))).toBe(
			true,
		);
		expect(commands.some((command) => command.includes("&& unzip "))).toBe(
			false,
		);
	});

	it("rejects unsupported web-server archive member types before unzip extraction", async () => {
		mocks.execAsync.mockImplementation(async (command: string) => {
			if (command.includes("ls -la")) {
				return { stdout: "webserver-backup-2026-06-22.zip\n" };
			}
			if (command.startsWith("unzip -Z1")) {
				return { stdout: "database.sql\nfilesystem/config.json\n" };
			}
			if (command.startsWith("unzip -Z -l")) {
				return {
					stdout:
						"lrwxrwxrwx  3.0 unx        8 bx stor 26-Jun-26 00:00 filesystem/config.json\n",
				};
			}
			return { stdout: "" };
		});

		await expect(
			restoreWebServerBackup(
				safeDestination as never,
				"dokploy/prefix/webserver-backup-2026-06-22.zip",
				emit,
			),
		).rejects.toThrow("unsupported filesystem entries");

		const commands = mocks.execAsync.mock.calls.map(([command]) =>
			String(command),
		);
		expect(commands.some((command) => command.startsWith("unzip -Z -l"))).toBe(
			true,
		);
		expect(commands.some((command) => command.includes("&& unzip "))).toBe(
			false,
		);
	});

	it("builds libsql archive validation for unsafe paths and special members", () => {
		const command = buildGzipTarArchivePolicyCommand(
			"/tmp/dokploy-libsql-restore/backup.sql.gz",
		);

		expect(command).toContain("gzip -dc");
		expect(command).toContain("tar -tf -");
		expect(command).toContain("tar -tvf -");
		expect(command).toContain("Unsafe archive member");
		expect(command).toContain("Unsupported archive member");
	});

	it("validates libsql backup archives before container extraction", async () => {
		await restoreLibsqlBackup(
			{
				appName: "libsql-one",
				serverId: null,
			} as never,
			safeDestination as never,
			{
				backupFile: "libsql-one/prefix/iku-2026-06-22.sql.gz",
				backupType: "database",
				databaseId: "libsql-1",
				databaseName: "iku.db",
				databaseType: "libsql",
				destinationId: "destination-1",
			} as never,
			emit,
		);

		const command = mocks.execAsync.mock.calls.at(-1)?.[0] ?? "";
		expect(command).toContain("rclone copyto");
		expect(command).toContain("Validating libsql backup archive");
		expect(command.indexOf("gzip -dc")).toBeGreaterThan(-1);
		expect(command.indexOf("gzip -dc")).toBeLessThan(
			command.indexOf("tar xzf - -C /var/lib/sqld"),
		);
		expect(command).not.toContain("rclone cat");
	});

	it("rejects unsafe database names before restore command generation", () => {
		expect(() =>
			getRestoreCommand({
				appName: "app-one",
				credentials: {
					database: "prod;id",
					databaseUser: "dokploy",
				},
				rcloneCommand: "printf safe",
				restoreType: "database",
				type: "postgres",
			}),
		).toThrow("Invalid database name");
	});

	it("rejects unsafe compose service names before Docker label filters", () => {
		expect(() =>
			getRestoreCommand({
				appName: "compose-one",
				credentials: {
					database: "appdb",
					databaseUser: "dokploy",
				},
				rcloneCommand: "printf safe",
				restoreType: "docker-compose",
				serviceName: "api;id",
				type: "postgres",
			}),
		).toThrow("Invalid service name");
	});

	it("quotes metadata credentials across outer and inner shell levels", () => {
		const command = getRestoreCommand({
			appName: "compose-one",
			credentials: {
				database: "appdb",
				databasePassword: "`id`",
				databaseUser: "$(id)",
			},
			rcloneCommand: "printf safe",
			restoreType: "docker-compose",
			serviceName: "api",
			type: "mariadb",
		});

		expect(command).toContain(
			"docker exec -e DOKPLOY_DB_PASSWORD=\\`id\\` -i $CONTAINER_ID sh -c ",
		);
		expect(command).not.toContain('sh -c "mariadb');
		expect(command).toContain("\\$\\(id\\)");
		expect(command).toContain("\\`id\\`");
	});

	it("keeps safe prefixed S3 database backups while quoting restore inputs", async () => {
		await restorePostgresBackup(
			{
				appName: "app-one",
				databaseUser: "dokploy",
				serverId: null,
			} as never,
			safeDestination as never,
			safePostgresInput,
			emit,
		);

		const command = mocks.execAsync.mock.calls.at(-1)?.[0] ?? "";
		const unescapedCommand = command.replace(/\\/g, "");
		expect(unescapedCommand).toContain(
			":s3:dokploy-backups/app-one/prefix/appdb-2026-06-22.sql.gz",
		);
		expect(unescapedCommand).toContain("pg_restore");
		expect(unescapedCommand).not.toContain("../");
		expect(unescapedCommand).not.toContain("prod;id");
	});

	it("restores web-server backup objects to a local basename", async () => {
		await restoreWebServerBackup(
			safeDestination as never,
			"dokploy/prefix/webserver-backup-2026-06-22.zip",
			emit,
		);

		const commands = mocks.execAsync.mock.calls
			.map(([command]) => String(command))
			.join("\n");
		const unescapedCommands = commands.replace(/\\/g, "");

		expect(unescapedCommands).toContain(
			":s3:dokploy-backups/dokploy/prefix/webserver-backup-2026-06-22.zip",
		);
		const copyToCommand =
			mocks.execAsync.mock.calls
				.map(([command]) => String(command).replace(/\\/g, ""))
				.find((command) => command.startsWith("rclone copyto")) ?? "";
		expect(copyToCommand).toMatch(
			/\/dokploy-restore-[^/\s]+\/webserver-backup-2026-06-22\.zip/,
		);
		expect(copyToCommand).not.toMatch(
			/\/dokploy-restore-[^/\s]+\/dokploy\/prefix\/webserver-backup-2026-06-22\.zip/,
		);
	});
});

describe("backup read redaction", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	});

	it("redacts the bound compose service and metadata passwords in one", async () => {
		mocks.findBackupById.mockResolvedValue({
			backupId: "backup-1",
			backupType: "compose",
			databaseType: "mariadb",
			destinationId: "destination-1",
			composeId: "compose-1",
			serviceName: "db",
			metadata: {
				mariadb: {
					databaseUser: "app",
					databasePassword: "metadata-password",
				},
			},
			compose: {
				composeId: "compose-1",
				appName: "compose-one",
				env: "COMPOSE_SECRET=compose-env-secret",
				composeFile:
					"services:\n  db:\n    environment:\n      PASS: file-secret",
				customGitUrl: "https://repo-user:repo-token@example.com/org/repo.git",
				refreshToken: "compose-refresh-token",
			},
		});

		const backup = await createCaller().one({ backupId: "backup-1" });

		expect(backup.compose).toMatchObject({
			appName: "compose-one",
			env: REDACTED_SECRET_VALUE,
			composeFile: REDACTED_SECRET_VALUE,
			customGitUrl: `https://${REDACTED_SECRET_VALUE}@example.com/org/repo.git`,
			refreshToken: REDACTED_SECRET_VALUE,
		});
		expect(backup.metadata).toEqual({
			mariadb: { databaseUser: "app", databasePassword: REDACTED_SECRET_VALUE },
		});
		const serialized = JSON.stringify(backup);
		for (const secret of [
			"compose-env-secret",
			"file-secret",
			"repo-token",
			"compose-refresh-token",
			"metadata-password",
		]) {
			expect(serialized).not.toContain(secret);
		}
	});
});

describe("restore failure reporting", () => {
	const drain = async (input: typeof safePostgresInput) => {
		const logs: string[] = [];
		let thrown: unknown;
		try {
			const stream = await createCaller().restoreBackupWithLogs(input);
			for await (const log of stream as AsyncIterable<string>) {
				logs.push(log);
			}
		} catch (error) {
			thrown = error;
		}
		return { logs, thrown };
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkPermission.mockResolvedValue(undefined);
		mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
		mocks.findDestinationById.mockResolvedValue(safeDestination);
		mocks.findPostgresById.mockResolvedValue({
			name: "main-db",
			environmentId: "env-1",
			appName: "app-one",
			databaseUser: "dokploy",
			serverId: "server-1",
		});
		mocks.normalizeS3Path.mockImplementation((prefix: string) => `${prefix}/`);
		mocks.findRestoreBackups.mockResolvedValue([
			{
				appName: "backup-one",
				backupType: "database",
				databaseType: "postgres",
				destinationId: "destination-1",
				prefix: "prefix",
				postgres: { appName: "app-one" },
				postgresId: "postgres-1",
			},
		]);
		mocks.findEnvironmentById.mockResolvedValue({ projectId: "project-1" });
		mocks.findProjectById.mockResolvedValue({
			name: "shop",
			organizationId: "org-1",
		});
		mocks.sendDatabaseBackupNotifications.mockResolvedValue(undefined);
	});

	it("ends the stream with the remote stderr, once, and notifies", async () => {
		mocks.restorePostgresBackup.mockRejectedValue(
			new ExecError("Remote command failed with exit code 1", {
				command: "docker exec ...",
				stderr:
					'pg_restore: error: connection to server failed: database "x" does not exist\nPGPASSWORD=hunter2 failed',
				exitCode: 1,
				serverId: "server-1",
			}),
		);

		const { logs, thrown } = await drain(safePostgresInput);

		expect(logs.filter((log) => log.startsWith("Error:"))).toHaveLength(1);
		expect(logs.at(-1)).toContain('database "x" does not exist');
		expect(logs.join("\n")).not.toContain("hunter2");
		expect(thrown).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
		expect((thrown as Error).message).toContain("exit code 1");
		expect((thrown as Error).message).toContain('database "x" does not exist');
		expect((thrown as Error).message).not.toContain("hunter2");

		await vi.waitFor(() =>
			expect(mocks.sendDatabaseBackupNotifications).toHaveBeenCalledTimes(1),
		);
		const notification = mocks.sendDatabaseBackupNotifications.mock.calls[0]![0];
		expect(notification).toMatchObject({
			operation: "restore",
			type: "error",
			applicationName: "main-db",
			projectName: "shop",
			organizationId: "org-1",
			databaseType: "postgres",
			databaseName: "appdb",
		});
		expect(notification.errorMessage).toContain('database "x" does not exist');
		expect(notification.errorMessage).not.toContain("hunter2");
	});

	it("reports a local failure that the restore function already logged only once", async () => {
		mocks.restorePostgresBackup.mockImplementation(
			async (_db, _dest, _input, emit: (log: string) => void) => {
				emit("Starting restore...");
				emit("Error: gzip: stdin: not in gzip format");
				throw new Error("gzip: stdin: not in gzip format");
			},
		);

		const { logs, thrown } = await drain(safePostgresInput);

		expect(logs).toEqual([
			"Starting restore...",
			"Error: gzip: stdin: not in gzip format",
		]);
		expect(thrown).toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "gzip: stdin: not in gzip format",
		});
		await vi.waitFor(() =>
			expect(mocks.sendDatabaseBackupNotifications).toHaveBeenCalledTimes(1),
		);
	});

	it("still fails the stream when the notification cannot be sent", async () => {
		mocks.restorePostgresBackup.mockRejectedValue(new Error("boom"));
		mocks.sendDatabaseBackupNotifications.mockRejectedValue(new Error("down"));

		const { thrown } = await drain(safePostgresInput);

		expect(thrown).toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "boom",
		});
	});

	it("does not notify and does not throw for a successful restore", async () => {
		mocks.restorePostgresBackup.mockResolvedValue(undefined);

		const { thrown } = await drain(safePostgresInput);

		expect(thrown).toBeUndefined();
		expect(mocks.sendDatabaseBackupNotifications).not.toHaveBeenCalled();
	});

	it("keeps the real postgres restore error text for remote and local runs", async () => {
		const { formatRestoreError } = await import(
			"@dokploy/server/utils/restore/failure"
		);
		const postgres = {
			appName: "app-one",
			databaseUser: "dokploy",
			serverId: "server-1",
		};
		const logs: string[] = [];

		mocks.execAsyncRemote.mockRejectedValue(
			new ExecError("Remote command failed with exit code 1", {
				command: "x",
				stderr: "pg_restore: error: could not connect",
				exitCode: 1,
				serverId: "server-1",
			}),
		);
		await expect(
			restorePostgresBackup(
				postgres as never,
				safeDestination as never,
				safePostgresInput,
				(log) => logs.push(log),
			),
		).rejects.toBeInstanceOf(ExecError);
		expect(logs.at(-1)).toBe(
			"Error: Remote command failed with exit code 1\npg_restore: error: could not connect",
		);

		logs.length = 0;
		mocks.execAsync.mockRejectedValue(
			new ExecError("Command execution failed: exit code 2", {
				command: "x",
				stderr:
					"NOTICE: Config file \"/root/.config/rclone/rclone.conf\" not found - using defaults\ngzip: stdin: not in gzip format\n",
				exitCode: 2,
			}),
		);
		await expect(
			restorePostgresBackup(
				{ ...postgres, serverId: null } as never,
				safeDestination as never,
				safePostgresInput,
				(log) => logs.push(log),
			),
		).rejects.toBeInstanceOf(ExecError);
		expect(logs.at(-1)).toBe(
			"Error: Command execution failed: exit code 2\ngzip: stdin: not in gzip format",
		);
		expect(formatRestoreError("plain")).toBe("plain");
	});
});

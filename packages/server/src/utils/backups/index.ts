import { CLEANUP_CRON_JOB } from "@dokploy/server/constants";
import { member } from "@dokploy/server/db/schema";
import type { BackupSchedule } from "@dokploy/server/services/backup";
import { findDestinationById } from "@dokploy/server/services/destination";
import { getAllServers } from "@dokploy/server/services/server";
import { getWebServerSettings } from "@dokploy/server/services/web-server-settings";
import { eq } from "drizzle-orm";
import { scheduleJob } from "node-schedule";
import { db } from "../../db/index";
import { startLogCleanup } from "../access-log/handler";
import { cleanupAll } from "../docker/utils";
import { sendDockerCleanupNotifications } from "../notifications/docker-cleanup";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import { quoteShellArgument } from "../shell";
import { redactRcloneCredentials } from "./redact";
import {
	assertRcloneS3DestinationAllowed,
	buildRcloneS3Command,
	buildRcloneS3DeleteXargsCommand,
	getBackupFolder,
	getRcloneS3Destination,
	scheduleBackup,
	shouldRunBackupRetention,
} from "./utils";

export const initCronJobs = async () => {
	console.log("Setting up cron jobs....");

	const webServerSettings = await getWebServerSettings();

	if (webServerSettings?.enableDockerCleanup) {
		try {
			scheduleJob("docker-cleanup", CLEANUP_CRON_JOB, async () => {
				console.log(
					`Docker Cleanup ${new Date().toLocaleString()}]  Running docker cleanup`,
				);

				await cleanupAll();

				const owner = await db.query.member.findFirst({
					where: eq(member.role, "owner"),
				});
				if (owner) {
					await sendDockerCleanupNotifications(owner.organizationId);
				}
			});
		} catch (error) {
			console.error("[Backup] Docker Cleanup Error", error);
		}
	}

	const servers = await getAllServers();

	for (const server of servers) {
		const { serverId, enableDockerCleanup, name, organizationId } = server;
		if (enableDockerCleanup) {
			try {
				scheduleJob(serverId, CLEANUP_CRON_JOB, async () => {
					console.log(
						`SERVER-BACKUP[${new Date().toLocaleString()}] Running Cleanup ${name}`,
					);

					await cleanupAll(serverId);

					await sendDockerCleanupNotifications(
						organizationId,
						`Docker cleanup for Server ${name} (${serverId})`,
					);
				});
			} catch (error) {
				console.error(`[Backup] ${error}`);
			}
		}
	}

	const backups = await db.query.backups.findMany({
		with: {
			destination: true,
			postgres: true,
			mariadb: true,
			mysql: true,
			mongo: true,
			libsql: true,
			user: true,
			compose: true,
		},
	});

	for (const backup of backups) {
		try {
			if (backup.enabled) {
				scheduleBackup(backup);
				console.log(
					`[Backup] ${backup.databaseType} Enabled with cron: [${backup.schedule}]`,
				);
			}
		} catch (error) {
			console.error(`[Backup] ${backup.databaseType} Error`, error);
		}
	}

	if (webServerSettings?.logCleanupCron) {
		try {
			console.log(
				"Starting log requests cleanup",
				webServerSettings.logCleanupCron,
			);
			await startLogCleanup(webServerSettings.logCleanupCron);
		} catch (error) {
			console.error("[Backup] Log Cleanup Error", error);
		}
	}
};

export const keepLatestNBackups = async (
	backup: BackupSchedule,
	serverId?: string | null,
) => {
	// 0 also immediately returns which is good as the empty "keep latest" field in the UI
	// is saved as 0 in the database
	if (!shouldRunBackupRetention(backup.keepLatestCount)) {
		return;
	}

	try {
		const destination = await assertRcloneS3DestinationAllowed(
			await findDestinationById(backup.destinationId),
		);
		const backupFilesPath = getRcloneS3Destination(
			destination,
			getBackupFolder(backup),
		);
		const includePattern = `*${
			backup.databaseType === "web-server" ? ".zip" : ".{sql.gz,bson.gz}"
		}`;

		// --include "*.bson.gz" or "*.sql.gz" or "*.zip" ensures nothing else other than the dokploy backup files are touched by rclone
		// sort by server mtime: custom names break lexical order
		const rcloneList = buildRcloneS3Command("lsf", destination, [
			"--include",
			includePattern,
			"--format",
			"tp",
			"--use-server-modtime",
			backupFilesPath,
		]);
		// when we pipe the above command with this one, we only get the list of files we want to delete
		const sortAndPickUnwantedBackups = `sort -r | tail -n +$((${backup.keepLatestCount}+1)) | cut -d';' -f2- | xargs -I{}`;
		// this command deletes the files
		// the object name from xargs is passed as $1, not interpolated into shell code
		const rcloneDelete = buildRcloneS3DeleteXargsCommand(
			destination,
			backupFilesPath,
		);

		const rcloneCommand = `${rcloneList} | ${sortAndPickUnwantedBackups} sh -c ${quoteShellArgument(rcloneDelete)} _ {}`;

		if (serverId) {
			await execAsyncRemote(serverId, rcloneCommand);
		} else {
			await execAsync(rcloneCommand);
		}
	} catch (error) {
		console.error(redactRcloneCredentials(String(error)));
	}
};

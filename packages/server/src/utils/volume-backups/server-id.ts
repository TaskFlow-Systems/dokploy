import type { findVolumeBackupById } from "@dokploy/server/services/volume-backups";

// A volume backup belongs to exactly one service. Every place that runs
// something for it (the log file, the backup, the cleanup) has to use the
// server of that service, whatever its type.
export const resolveVolumeBackupServerId = (
	volumeBackup: Pick<
		Awaited<ReturnType<typeof findVolumeBackupById>>,
		| "application"
		| "compose"
		| "postgres"
		| "mysql"
		| "mariadb"
		| "mongo"
		| "redis"
		| "libsql"
	>,
) =>
	volumeBackup.application?.serverId ||
	volumeBackup.compose?.serverId ||
	volumeBackup.postgres?.serverId ||
	volumeBackup.mysql?.serverId ||
	volumeBackup.mariadb?.serverId ||
	volumeBackup.mongo?.serverId ||
	volumeBackup.redis?.serverId ||
	volumeBackup.libsql?.serverId;

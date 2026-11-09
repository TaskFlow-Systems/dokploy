import { findEnvironmentById } from "@dokploy/server/services/environment";
import { findProjectById } from "@dokploy/server/services/project";
import { notifyInBackground } from "@dokploy/server/utils/notifications/background";
import { sendDatabaseBackupNotifications } from "../notifications/database-backup";
import { ExecError } from "../process/ExecError";
import { redactSensitiveText } from "../security/redaction";

const MAX_STDERR_CHARS = 2000;
const RCLONE_NO_CONFIG_NOTICE = /^.*NOTICE: Config file .* not found.*$/gim;

// The exit code alone ("exit code 1") never says why a restore failed; the
// output of the command does. Commands run with their output captured, so it
// only exists on the error.
export const formatRestoreError = (error: unknown): string => {
	if (error instanceof ExecError) {
		const stderr = (error.stderr ?? "")
			.replace(RCLONE_NO_CONFIG_NOTICE, "")
			.trim();
		const tail =
			stderr.length > MAX_STDERR_CHARS
				? `...${stderr.slice(-MAX_STDERR_CHARS)}`
				: stderr;
		const message = error.message;
		return redactSensitiveText(
			tail && !message.includes(tail) ? `${message}\n${tail}` : message,
		);
	}
	return redactSensitiveText(
		error instanceof Error ? error.message : String(error),
	);
};

const notificationDatabaseType = (databaseType: string) =>
	databaseType === "mongo" ? "mongodb" : databaseType;

export const reportRestoreFailure = async (input: {
	service: { name: string; environmentId: string } | undefined;
	databaseType: string;
	databaseName: string;
	message: string;
}) => {
	const { service } = input;
	if (!service || input.databaseType === "web-server") {
		return;
	}
	try {
		const environment = await findEnvironmentById(service.environmentId);
		const project = await findProjectById(environment.projectId);
		notifyInBackground("database backup", () =>
			sendDatabaseBackupNotifications({
				operation: "restore",
				applicationName: service.name,
				projectName: project.name,
				databaseType: notificationDatabaseType(input.databaseType) as
					| "postgres"
					| "mysql"
					| "mongodb"
					| "mariadb"
					| "libsql",
				type: "error",
				errorMessage: input.message,
				organizationId: project.organizationId,
				databaseName: input.databaseName,
			}),
		);
	} catch (notificationError) {
		console.error("Failed to send the restore failure notification", {
			error: formatRestoreError(notificationError),
		});
	}
};

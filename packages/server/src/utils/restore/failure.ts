import { findEnvironmentById } from "@dokploy/server/services/environment";
import { findProjectById } from "@dokploy/server/services/project";
import { notifyInBackground } from "@dokploy/server/utils/notifications/background";
import { sendDatabaseBackupNotifications } from "../notifications/database-backup";
import { formatCommandFailure } from "../process/failure-message";

// Same text as every other failed command: error text plus the redacted
// tail of stderr.
export const formatRestoreError = formatCommandFailure;

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

import type { findDeploymentById } from "@dokploy/server/services/deployment";

type ServiceServerFields = {
	application?: { serverId?: string | null } | null;
	compose?: { serverId?: string | null } | null;
	libsql?: { serverId?: string | null } | null;
	mariadb?: { serverId?: string | null } | null;
	mongo?: { serverId?: string | null } | null;
	mysql?: { serverId?: string | null } | null;
	postgres?: { serverId?: string | null } | null;
	redis?: { serverId?: string | null } | null;
	serverId?: string | null;
};

const getServiceServerId = (owner?: ServiceServerFields | null) =>
	owner?.serverId ||
	owner?.application?.serverId ||
	owner?.compose?.serverId ||
	owner?.postgres?.serverId ||
	owner?.mysql?.serverId ||
	owner?.mariadb?.serverId ||
	owner?.mongo?.serverId ||
	owner?.redis?.serverId ||
	owner?.libsql?.serverId ||
	null;

// Only a server's setup and hardening runs have deployment.serverId. The panel
// drives them over SSH and writes their log to its own disk.
export const getDeploymentLogServerId = (
	deployment: Awaited<ReturnType<typeof findDeploymentById>>,
) => {
	if (deployment.serverId) {
		return null;
	}
	return (
		deployment.buildServerId ||
		deployment.application?.serverId ||
		deployment.compose?.serverId ||
		deployment.previewDeployment?.application?.serverId ||
		getServiceServerId(deployment.backup) ||
		getServiceServerId(deployment.volumeBackup) ||
		getServiceServerId(deployment.schedule) ||
		null
	);
};

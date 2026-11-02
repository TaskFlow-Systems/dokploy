import type { findDeploymentById } from "@dokploy/server";

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

export const getDeploymentLogServerId = (
	deployment: Awaited<ReturnType<typeof findDeploymentById>>,
) =>
	deployment.serverId ||
	deployment.buildServerId ||
	deployment.application?.serverId ||
	deployment.compose?.serverId ||
	deployment.previewDeployment?.application?.serverId ||
	getServiceServerId(deployment.backup) ||
	getServiceServerId(deployment.volumeBackup) ||
	getServiceServerId(deployment.schedule) ||
	null;

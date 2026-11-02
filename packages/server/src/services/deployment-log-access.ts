import { TRPCError } from "@trpc/server";
import type { Schedule } from "../db/schema/schedule";
import {
	checkPermission,
	checkServicePermissionAndAccess,
	type PermissionCtx,
} from "./permission";
import { assertHostScheduleAccess } from "./schedule";

type ServiceOwnerFields = {
	applicationId?: string | null;
	composeId?: string | null;
	libsqlId?: string | null;
	mariadbId?: string | null;
	mongoId?: string | null;
	mysqlId?: string | null;
	postgresId?: string | null;
	redisId?: string | null;
};

export type DeploymentOwnerCandidate = {
	applicationId?: string | null;
	backup?: ServiceOwnerFields | null;
	composeId?: string | null;
	previewDeployment?: {
		applicationId?: string | null;
	} | null;
	serverId?: string | null;
	schedule?: {
		applicationId?: string | null;
		composeId?: string | null;
		organizationId?: string | null;
		scheduleType?: Schedule["scheduleType"] | null;
		serverId?: string | null;
	} | null;
	volumeBackup?: ServiceOwnerFields | null;
};

const getServiceId = (owner?: ServiceOwnerFields | null) =>
	owner?.applicationId ||
	owner?.composeId ||
	owner?.postgresId ||
	owner?.mysqlId ||
	owner?.mariadbId ||
	owner?.mongoId ||
	owner?.redisId ||
	owner?.libsqlId ||
	null;

export const getDeploymentServiceId = (deployment: DeploymentOwnerCandidate) =>
	deployment.applicationId ||
	deployment.composeId ||
	deployment.previewDeployment?.applicationId ||
	getServiceId(deployment.backup) ||
	getServiceId(deployment.volumeBackup);

// A host-level schedule runs as root on the host, so a service id on its row
// must not turn the check into a service check (see assertHostScheduleAccess).
const getDeploymentLogServiceId = (deployment: DeploymentOwnerCandidate) => {
	const { schedule } = deployment;
	const scheduleServiceId =
		schedule?.scheduleType === "server"
			? null
			: schedule?.applicationId || schedule?.composeId;
	return getDeploymentServiceId(deployment) || scheduleServiceId;
};

/**
 * Checks read access to a deployment log owned by a service or by the panel.
 * Returns false when it has neither owner, so the caller decides about a log
 * bound to a server and refuses the rest.
 */
export const checkDeploymentLogOwnerAccess = async (
	ctx: PermissionCtx,
	deployment: DeploymentOwnerCandidate,
) => {
	const { schedule } = deployment;
	if (schedule?.scheduleType === "dokploy-server") {
		if (schedule.organizationId !== ctx.session.activeOrganizationId) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You are not authorized to access this deployment",
			});
		}
		await checkPermission(ctx, { deployment: ["read"] });
		await assertHostScheduleAccess(
			ctx,
			schedule.scheduleType,
			schedule.serverId,
		);
		return true;
	}

	const serviceId = getDeploymentLogServiceId(deployment);
	if (!serviceId) {
		return false;
	}
	await checkServicePermissionAndAccess(ctx, serviceId, {
		deployment: ["read"],
	});
	return true;
};

import { db } from "@dokploy/server/db";
import { applications, compose } from "@dokploy/server/db/schema";
import {
	findMemberByUserId,
	hasPermission,
} from "@dokploy/server/services/permission";
import { eq } from "drizzle-orm";

export interface DeployFreezeEnvironmentLike {
	environmentId: string;
	applications?: Array<{ applicationId: string }>;
	compose?: Array<{ composeId: string }>;
}

interface DeployFreezeAccessCtx {
	user: { id: string; role: string };
	session: { activeOrganizationId: string };
}

type MemberRecordLike = {
	role?: string;
	accessedEnvironments?: string[];
	accessedServices?: string[];
};

const getDeployableServiceIdsForEnvironment = async (
	environment: DeployFreezeEnvironmentLike,
): Promise<string[]> => {
	if (
		Array.isArray(environment.applications) &&
		Array.isArray(environment.compose)
	) {
		return [
			...environment.applications.map((app) => app.applicationId),
			...environment.compose.map((comp) => comp.composeId),
		];
	}

	const [appRows, composeRows] = await Promise.all([
		db
			.select({ id: applications.applicationId })
			.from(applications)
			.where(eq(applications.environmentId, environment.environmentId)),
		db
			.select({ id: compose.composeId })
			.from(compose)
			.where(eq(compose.environmentId, environment.environmentId)),
	]);

	return [...appRows.map((row) => row.id), ...composeRows.map((row) => row.id)];
};

export const canUserManageEnvironmentDeployFreeze = async (
	ctx: DeployFreezeAccessCtx,
	environment: DeployFreezeEnvironmentLike,
	prefetchedMember?: MemberRecordLike,
): Promise<boolean> => {
	if (ctx.user.role === "owner" || ctx.user.role === "admin") {
		return true;
	}

	if (!environment.environmentId) {
		return false;
	}

	const allowedByRole = await hasPermission(ctx, {
		environment: ["update"],
		deployment: ["create"],
	});
	if (!allowedByRole) {
		return false;
	}

	const memberRecord =
		prefetchedMember ??
		(await findMemberByUserId(ctx.user.id, ctx.session.activeOrganizationId));

	if (!memberRecord) {
		return false;
	}

	if (memberRecord.role === "owner" || memberRecord.role === "admin") {
		return true;
	}

	if (
		!(memberRecord.accessedEnvironments ?? []).includes(
			environment.environmentId,
		)
	) {
		return false;
	}

	const deployableIds =
		await getDeployableServiceIdsForEnvironment(environment);
	const accessedServices = new Set(memberRecord.accessedServices ?? []);
	return deployableIds.every((id) => accessedServices.has(id));
};

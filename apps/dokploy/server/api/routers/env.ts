import type { AuditResourceType, EnvScope } from "@dokploy/server/db/schema";
import {
	apiEnvApply,
	apiEnvApplyResponse,
	apiEnvKeys,
	apiEnvKeysResponse,
} from "@dokploy/server/db/schema";
import {
	applyEnvVariableChanges,
	findEnvVariablesOwner,
	listEnvVariableKeys,
} from "@dokploy/server/services/env-variables";
import {
	checkEnvironmentAccess,
	checkPermission,
	checkProjectAccess,
	checkServicePermissionAndAccess,
	findMemberByUserId,
} from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";

type EnvAccessCtx = {
	user: { id: string; role: string };
	session: { activeOrganizationId: string };
};

const auditResourceType = (scope: EnvScope): AuditResourceType =>
	scope === "application" ||
	scope === "compose" ||
	scope === "project" ||
	scope === "environment"
		? scope
		: "service";

const assertEnvAccess = async (
	ctx: EnvAccessCtx,
	scope: EnvScope,
	id: string,
	action: "read" | "write",
) => {
	const owner = await findEnvVariablesOwner(scope, id);

	if (owner.organizationId !== ctx.session.activeOrganizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: `You are not authorized to access this ${scope}`,
		});
	}

	if (scope === "project") {
		if (action === "write") {
			await checkProjectAccess(ctx, "update", id);
		}
		if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
			const { accessedProjects } = await findMemberByUserId(
				ctx.user.id,
				ctx.session.activeOrganizationId,
			);
			if (!accessedProjects.includes(id)) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You don't have access to this project",
				});
			}
		}
		await checkPermission(ctx, { projectEnvVars: [action] });
	} else if (scope === "environment") {
		await checkEnvironmentAccess(
			ctx,
			id,
			action === "write" ? "update" : "read",
		);
		await checkPermission(ctx, { environmentEnvVars: [action] });
	} else {
		await checkServicePermissionAndAccess(ctx, id, { envVars: [action] });
	}

	return owner;
};

export const envRouter = createTRPCRouter({
	keys: protectedProcedure
		.input(apiEnvKeys)
		.output(apiEnvKeysResponse)
		.query(async ({ input, ctx }) => {
			await assertEnvAccess(ctx, input.scope, input.id, "read");
			return await listEnvVariableKeys(input);
		}),
	applyChanges: protectedProcedure
		// tRPC reserves `apply` as a procedure name, so the REST route and its
		// operation id are pinned here to keep the HTTP API at POST /env.apply.
		.meta({
			openapi: {
				method: "POST",
				path: "/env.apply",
				operationId: "env-apply",
				tags: ["env"],
				override: true,
			},
		})
		.input(apiEnvApply)
		.output(apiEnvApplyResponse)
		.mutation(async ({ input, ctx }) => {
			const owner = await assertEnvAccess(ctx, input.scope, input.id, "write");

			const sources = new Map(
				Object.values(input.copy ?? {}).map(({ fromScope, fromId }) => [
					`${fromScope}:${fromId}`,
					{ scope: fromScope, id: fromId },
				]),
			);
			for (const source of sources.values()) {
				await assertEnvAccess(ctx, source.scope, source.id, "read");
			}

			const result = await applyEnvVariableChanges(input);

			if (!result.dryRun && result.changed) {
				await audit(ctx, {
					action: "update",
					resourceType: auditResourceType(input.scope),
					resourceId: input.id,
					resourceName: owner.resourceName,
				});
			}

			return result;
		}),
});

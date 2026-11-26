import type {
	DeployFreezeState,
	DeploymentFreezeScopeType,
} from "@dokploy/server/utils/deployments/deploy-freeze-shared";
import { isApiKeySession } from "@/server/api/utils/api-key-session";

interface ForcedDeployCtx {
	user: { id: string };
	session: {
		authMethod?: string | null;
		apiKeyId?: string | null;
	};
}

export function resolveDeployFreezeChangeAuditMetadata(input: {
	scopeType: Exclude<DeploymentFreezeScopeType, "project">;
	scopeId: string;
	frozen: boolean;
	durationMinutes?: number | null;
	ctx: ForcedDeployCtx;
}): Record<string, unknown> {
	const authMethod = isApiKeySession(input.ctx.session) ? "api-key" : "session";
	return {
		deployFreeze: input.frozen,
		freezeScopeType: input.scopeType,
		freezeScopeId: input.scopeId,
		durationMinutes: input.durationMinutes ?? null,
		authMethod,
		apiKeyId: input.ctx.session.apiKeyId ?? null,
	};
}

export function resolveForcedDeployAuditMetadata(
	operation: string,
	serviceId: string,
	ctx: ForcedDeployCtx,
	bypassedFreeze: DeployFreezeState | null,
): Record<string, unknown> | undefined {
	if (!bypassedFreeze) {
		return undefined;
	}
	const authMethod = isApiKeySession(ctx.session) ? "api-key" : "session";
	console.warn(`[deploy-freeze] Forced ${operation}`, {
		serviceId,
		userId: ctx.user.id,
		authMethod,
		apiKeyId: ctx.session.apiKeyId ?? null,
		freezeScopeType: bypassedFreeze.scopeType,
		freezeScopeId: bypassedFreeze.scopeId,
	});
	return {
		forcedDuringDeployFreeze: true,
		freezeScopeType: bypassedFreeze.scopeType,
		freezeScopeId: bypassedFreeze.scopeId,
		authMethod,
		apiKeyId: ctx.session.apiKeyId ?? null,
	};
}

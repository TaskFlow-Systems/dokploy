import type { DeployFreezeState } from "@dokploy/server/utils/deployments/deploy-freeze-shared";
import { isApiKeySession } from "@/server/api/utils/api-key-session";

interface ForcedDeployCtx {
	user: { id: string };
	session: {
		authMethod?: string | null;
		apiKeyId?: string | null;
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
	});
	return {
		forcedDuringDeployFreeze: true,
		authMethod,
		apiKeyId: ctx.session.apiKeyId ?? null,
	};
}

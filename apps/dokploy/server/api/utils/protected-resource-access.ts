import { TRPCError } from "@trpc/server";
import { isApiKeySession } from "@/server/api/utils/api-key-session";
import { assertLocalHostAccess } from "@/server/api/utils/local-host-access";

type ProtectedResourceCtx = {
	user: { id: string };
	session: { authMethod?: string | null; activeOrganizationId: string };
};

// Traefik TLS files and the panel's own containers and volumes hold private
// keys and the panel database, so only an owner or admin reaches them, and
// never through an API key: that is what scripts and AI agents hold.
export const assertProtectedResourceAccess = async (
	ctx: ProtectedResourceCtx,
) => {
	if (isApiKeySession(ctx.session)) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "This action is only available from a browser session.",
		});
	}
	await assertLocalHostAccess(ctx);
};

export const hasProtectedResourceAccess = async (ctx: ProtectedResourceCtx) => {
	try {
		await assertProtectedResourceAccess(ctx);
		return true;
	} catch {
		return false;
	}
};

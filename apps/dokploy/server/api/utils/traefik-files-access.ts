import { getAccessibleServerIds } from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { assertLocalHostAccess } from "@/server/api/utils/local-host-access";

type ServerAccessCtx = {
	session: {
		userId: string;
		activeOrganizationId: string;
	};
};

type TraefikFilesHostCtx = ServerAccessCtx & {
	user: { id: string };
};

export const assertSettingsServerAccess = async (
	ctx: ServerAccessCtx,
	serverId?: string,
) => {
	if (!serverId) {
		return;
	}

	const accessibleIds = await getAccessibleServerIds(ctx.session);
	if (!accessibleIds.has(serverId)) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this server",
		});
	}
};

export const assertTraefikFilesHostAccess = async (
	ctx: TraefikFilesHostCtx,
	serverId?: string,
) => {
	if (!serverId) {
		await assertLocalHostAccess(ctx);
		return;
	}

	await assertSettingsServerAccess(ctx, serverId);
};

export const hasTraefikFilesHostAccess = async (
	ctx: TraefikFilesHostCtx,
	serverId?: string,
) => {
	try {
		await assertTraefikFilesHostAccess(ctx, serverId);
		return true;
	} catch {
		return false;
	}
};

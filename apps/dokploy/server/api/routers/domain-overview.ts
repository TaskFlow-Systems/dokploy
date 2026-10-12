import {
	getDomainOverview,
	getTraefikLogs,
} from "@dokploy/server/services/domain-overview";
import { checkPermission } from "@dokploy/server/services/permission";
import { z } from "zod";
import { hasProtectedResourceAccess } from "@/server/api/utils/super-session";
import {
	assertTraefikFilesHostAccess,
	hasTraefikFilesHostAccess,
} from "@/server/api/utils/traefik-files-access";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const domainOverviewRouter = createTRPCRouter({
	list: protectedProcedure.query(async ({ ctx }) => {
		await checkPermission(ctx, { traefikFiles: ["read"] });
		return getDomainOverview(ctx.session.activeOrganizationId, {
			canReadHost: (serverId) =>
				hasTraefikFilesHostAccess(ctx, serverId ?? undefined),
			canReadCertificates: await hasProtectedResourceAccess(ctx),
		});
	}),
	traefikLogs: protectedProcedure
		.input(z.object({ serverId: z.string().min(1).nullish() }))
		.query(async ({ ctx, input }) => {
			const serverId = input.serverId ?? null;
			await checkPermission(ctx, { traefikFiles: ["read"] });
			await assertTraefikFilesHostAccess(ctx, serverId ?? undefined);
			return getTraefikLogs(ctx.session.activeOrganizationId, serverId);
		}),
});

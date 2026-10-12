import {
	deleteUnusedCertificates,
	getDomainOverview,
	getTraefikLogs,
} from "@dokploy/server/services/domain-overview";
import { checkPermission } from "@dokploy/server/services/permission";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	assertProtectedResourceAccess,
	hasProtectedResourceAccess,
} from "@/server/api/utils/super-session";
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
	deleteUnusedCertificates: protectedProcedure
		.input(
			z.object({
				serverId: z.string().min(1).nullable(),
				domains: z.array(z.string().min(1).max(253)).min(1).max(50),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await checkPermission(ctx, { traefikFiles: ["read"] });
			await assertTraefikFilesHostAccess(ctx, input.serverId ?? undefined);
			await assertProtectedResourceAccess(ctx);

			const record = (result: string, backupFile: string | null) => {
				console.info(
					`[domain-overview] certificate deletion by ${ctx.user.id} on ${input.serverId ?? "local"}: ${result}`,
				);
				return audit(ctx, {
					action: "delete",
					resourceType: "certificate",
					resourceId: input.serverId ?? "local",
					resourceName: input.domains.join(", ").slice(0, 500),
					metadata: {
						serverId: input.serverId,
						domains: input.domains,
						result,
						backupFile,
					},
				});
			};

			try {
				const result = await deleteUnusedCertificates(
					ctx.session.activeOrganizationId,
					input.serverId,
					input.domains,
				);
				await record(
					result.status === "refused" ? "refused" : result.status,
					result.status === "refused" ? null : result.backupFile,
				);
				return result;
			} catch (error) {
				await record("error", null);
				throw error;
			}
		}),
});

import {
	clearStaleDeletionLock,
	deleteUnusedCertificates,
	getDomainOverview,
	getTraefikLogs,
	recoverInterruptedTraefik,
} from "@dokploy/server/services/domain-overview";
import { checkPermission } from "@dokploy/server/services/permission";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	assertProtectedResourceAccess,
	hasProtectedResourceAccess,
} from "@/server/api/utils/protected-resource-access";
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
				domains: z
					.array(
						z.union([
							z.string().min(1).max(253),
							z.object({
								domain: z.string().min(1).max(253),
								resolver: z.string().min(1).max(64).optional(),
							}),
						]),
					)
					.min(1)
					.max(50),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await checkPermission(ctx, { traefikFiles: ["write"] });
			await assertTraefikFilesHostAccess(ctx, input.serverId ?? undefined);
			await assertProtectedResourceAccess(ctx);

			const names = input.domains.map((item) =>
				typeof item === "string" ? item : item.domain,
			);
			const record = async (result: string, backupFile: string | null) => {
				console.info(
					`[domain-overview] certificate deletion by ${ctx.user.id} on ${input.serverId ?? "local"}: ${result}`,
				);
				try {
					await audit(ctx, {
						action: "delete",
						resourceType: "certificate",
						resourceId: input.serverId ?? "local",
						resourceName: names.join(", ").slice(0, 500),
						metadata: {
							serverId: input.serverId,
							domains: names,
							result,
							backupFile,
						},
					});
				} catch (error) {
					console.error("[domain-overview] audit entry failed:", error);
				}
			};

			let result: Awaited<ReturnType<typeof deleteUnusedCertificates>>;
			try {
				result = await deleteUnusedCertificates(
					ctx.session.activeOrganizationId,
					input.serverId,
					input.domains,
				);
			} catch (error) {
				await record("error", null);
				throw error;
			}
			await record(
				result.status,
				result.status === "refused" ? null : result.backupFile,
			);
			return result;
		}),
	clearStaleDeletionLock: protectedProcedure
		.input(z.object({ serverId: z.string().min(1).nullable() }))
		.mutation(async ({ ctx, input }) => {
			await checkPermission(ctx, { traefikFiles: ["write"] });
			await assertTraefikFilesHostAccess(ctx, input.serverId ?? undefined);
			await assertProtectedResourceAccess(ctx);
			const result = await clearStaleDeletionLock(
				ctx.session.activeOrganizationId,
				input.serverId,
			);
			console.info(
				`[domain-overview] stale deletion lock cleanup by ${ctx.user.id} on ${input.serverId ?? "local"}: ${result.status}`,
			);
			return result;
		}),
	recoverTraefik: protectedProcedure
		.input(z.object({ serverId: z.string().min(1).nullable() }))
		.mutation(async ({ ctx, input }) => {
			await checkPermission(ctx, { traefikFiles: ["write"] });
			await assertTraefikFilesHostAccess(ctx, input.serverId ?? undefined);
			await assertProtectedResourceAccess(ctx);
			const result = await recoverInterruptedTraefik(
				ctx.session.activeOrganizationId,
				input.serverId,
			);
			console.info(
				`[domain-overview] Traefik recovery by ${ctx.user.id} on ${input.serverId ?? "local"}: ${result.status}`,
			);
			try {
				await audit(ctx, {
					action: "update",
					resourceType: "settings",
					resourceName: "traefik-recovery",
					metadata: { serverId: input.serverId, result: result.status },
				});
			} catch (error) {
				console.error("[domain-overview] audit entry failed:", error);
			}
			return result;
		}),
});

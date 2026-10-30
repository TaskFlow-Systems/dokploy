import {
	deleteVolumeFile,
	findServerById,
	getVolumeConfig,
	getVolumes,
	getVolumesSize,
	listVolumeFiles,
	readVolumeFile,
	removeVolume,
	writeVolumeFile,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { isLocalSystemDockerVolume } from "@/server/api/utils/local-docker-access";
import { assertProtectedResourceAccess } from "@/server/api/utils/protected-resource-access";
import { createTRPCRouter, withPermission } from "../trpc";
import { assertDockerServerAccess } from "./docker";

export const volumeNameRegex = /^[a-zA-Z0-9.\-_]+$/;

const volumePathSchema = z
	.string()
	.min(1)
	.max(4096)
	.refine(
		(path) => path.startsWith("/") && !path.includes("\0"),
		"Path must be absolute.",
	);

const assertVolumeFileAccess = async (
	ctx: Parameters<typeof assertDockerServerAccess>[0] &
		Parameters<typeof assertProtectedResourceAccess>[0],
	volumeName: string,
	serverId?: string,
) => {
	await assertDockerServerAccess(ctx, serverId);
	// Volumes of the panel's own containers hold its database and keys.
	if (!serverId && (await isLocalSystemDockerVolume(volumeName))) {
		await assertProtectedResourceAccess(ctx);
	}
};

export const dockerVolumeRouter = createTRPCRouter({
	getVolumes: withPermission("docker", "read")
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			if (input.serverId) {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({ code: "UNAUTHORIZED" });
				}
			}
			return await getVolumes(input.serverId);
		}),

	getVolumesSize: withPermission("docker", "read")
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			if (input.serverId) {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({ code: "UNAUTHORIZED" });
				}
			}
			return await getVolumesSize(input.serverId);
		}),

	listVolumeFiles: withPermission("docker", "read")
		.input(
			z.object({
				volumeName: z
					.string()
					.min(1)
					.regex(volumeNameRegex, "Invalid volume name."),
				path: volumePathSchema,
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertVolumeFileAccess(ctx, input.volumeName, input.serverId);
			return await listVolumeFiles(
				input.volumeName,
				input.path,
				input.serverId,
			);
		}),

	readVolumeFile: withPermission("docker", "read")
		.input(
			z.object({
				volumeName: z
					.string()
					.min(1)
					.regex(volumeNameRegex, "Invalid volume name."),
				path: volumePathSchema,
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertVolumeFileAccess(ctx, input.volumeName, input.serverId);
			return await readVolumeFile(input.volumeName, input.path, input.serverId);
		}),

	writeVolumeFile: withPermission("docker", "write")
		.input(
			z.object({
				volumeName: z
					.string()
					.min(1)
					.regex(volumeNameRegex, "Invalid volume name."),
				path: volumePathSchema,
				content: z.string(),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertVolumeFileAccess(ctx, input.volumeName, input.serverId);
			await writeVolumeFile(
				input.volumeName,
				input.path,
				input.content,
				input.serverId,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "docker",
				resourceId: input.volumeName,
				resourceName: `${input.volumeName}:${input.path}`,
			});
		}),

	deleteVolumeFile: withPermission("docker", "delete")
		.input(
			z.object({
				volumeName: z
					.string()
					.min(1)
					.regex(volumeNameRegex, "Invalid volume name."),
				path: volumePathSchema.refine(
					(path) => path !== "/",
					"Cannot delete the volume root.",
				),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertVolumeFileAccess(ctx, input.volumeName, input.serverId);
			await deleteVolumeFile(input.volumeName, input.path, input.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "docker",
				resourceId: input.volumeName,
				resourceName: `${input.volumeName}:${input.path}`,
			});
		}),

	getVolumeConfig: withPermission("docker", "read")
		.input(
			z.object({
				volumeName: z
					.string()
					.min(1)
					.regex(volumeNameRegex, "Invalid volume name."),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			if (input.serverId) {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({ code: "UNAUTHORIZED" });
				}
			}
			return await getVolumeConfig(input.volumeName, input.serverId);
		}),

	removeVolume: withPermission("docker", "delete")
		.input(
			z.object({
				volumeName: z
					.string()
					.min(1)
					.regex(volumeNameRegex, "Invalid volume name."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertDockerServerAccess(ctx, input.serverId);
			await removeVolume(input.volumeName, input.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "docker",
				resourceId: input.volumeName,
				resourceName: input.volumeName,
			});
		}),
});

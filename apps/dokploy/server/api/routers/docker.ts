import {
	containerKill,
	containerRemove,
	containerRestart,
	containerStart,
	containerStop,
	deleteContainerFile,
	findServerById,
	getAccessibleServerIds,
	getConfig,
	getContainers,
	getContainersByAppLabel,
	getContainersByAppNameMatch,
	getDockerEvents,
	getServerHealth as getServerHealthData,
	getServiceContainersByAppName,
	getStackContainersByAppName,
	listContainerFiles,
	readContainerFile,
	uploadFileToContainer,
	writeContainerFile,
} from "@dokploy/server";
import {
	checkPermission,
	findMemberByUserId,
} from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	assertLocalDockerContainerAccess,
	assertLocalDockerContainerOrSystemAccess,
	type LocalDockerPermission,
} from "@/server/api/utils/local-docker-access";
import { assertProtectedResourceAccess } from "@/server/api/utils/protected-resource-access";
import { uploadFileToContainerSchema } from "@/utils/schema";
import { createTRPCRouter, protectedProcedure, withPermission } from "../trpc";

export const containerIdRegex = /^[a-zA-Z0-9.\-_]+$/;

export const assertDockerServerAccess = async (
	ctx: {
		session: {
			userId: string;
			activeOrganizationId: string;
		};
		user: {
			id: string;
		};
	},
	serverId?: string,
) => {
	const member = await findMemberByUserId(
		ctx.user.id,
		ctx.session.activeOrganizationId,
	);
	if (member.role !== "owner" && member.role !== "admin") {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "Docker host operations require owner or admin access",
		});
	}

	if (!serverId) {
		return;
	}

	const accessibleIds = await getAccessibleServerIds(ctx.session);
	if (!accessibleIds.has(serverId)) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
};

const resolveAuthorizedContainerId = async (
	ctx: {
		session: {
			activeOrganizationId: string;
		};
		user: {
			id: string;
		};
	},
	containerId: string,
	serverId: string | undefined,
	permission: LocalDockerPermission,
) => {
	if (serverId) {
		return containerId;
	}

	const config = await assertLocalDockerContainerAccess(
		ctx,
		containerId,
		permission,
	);

	return config?.Id || containerId;
};

// The file manager may also open the panel's own containers (dokploy, its
// postgres and redis, traefik), but only for an owner or admin in a browser.
const resolveAuthorizedFileContainerId = async (
	ctx: Parameters<typeof assertProtectedResourceAccess>[0],
	containerId: string,
	serverId: string | undefined,
	permission: LocalDockerPermission,
) => {
	if (serverId) {
		return containerId;
	}

	const config = await assertLocalDockerContainerOrSystemAccess(
		ctx,
		containerId,
		permission,
		() => assertProtectedResourceAccess(ctx),
	);

	return config?.Id || containerId;
};

const containerPathSchema = z
	.string()
	.min(1)
	.max(4096)
	.refine(
		(path) => path.startsWith("/") && !path.includes("\0"),
		"Path must be absolute.",
	);

export const dockerRouter = createTRPCRouter({
	getContainers: withPermission("docker", "read")
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertDockerServerAccess(ctx, input.serverId);
			return await getContainers(input.serverId);
		}),

	// Host-level diagnostics, so this requires docker.read AND server.read.
	getServerHealth: protectedProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
				sinceHours: z.number().int().min(1).max(168).optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkPermission(ctx, { docker: ["read"], server: ["read"] });
			if (input.serverId) {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({ code: "UNAUTHORIZED" });
				}
			}
			return await getServerHealthData(
				ctx.session.activeOrganizationId,
				input.serverId,
				input.sinceHours,
			);
		}),

	restartContainer: withPermission("docker", "execute")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertDockerServerAccess(ctx, input.serverId);
			const containerId = await resolveAuthorizedContainerId(
				ctx,
				input.containerId,
				input.serverId,
				"execute",
			);
			await containerRestart(containerId, input.serverId);
			await audit(ctx, {
				action: "start",
				resourceType: "docker",
				resourceId: containerId,
				resourceName: containerId,
			});
		}),

	startContainer: withPermission("docker", "execute")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertDockerServerAccess(ctx, input.serverId);
			const containerId = await resolveAuthorizedContainerId(
				ctx,
				input.containerId,
				input.serverId,
				"execute",
			);
			await containerStart(containerId, input.serverId);
			await audit(ctx, {
				action: "start",
				resourceType: "docker",
				resourceId: containerId,
				resourceName: containerId,
			});
		}),

	stopContainer: withPermission("docker", "execute")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertDockerServerAccess(ctx, input.serverId);
			const containerId = await resolveAuthorizedContainerId(
				ctx,
				input.containerId,
				input.serverId,
				"execute",
			);
			await containerStop(containerId, input.serverId);
			await audit(ctx, {
				action: "stop",
				resourceType: "docker",
				resourceId: containerId,
				resourceName: containerId,
			});
		}),

	killContainer: withPermission("docker", "execute")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertDockerServerAccess(ctx, input.serverId);
			const containerId = await resolveAuthorizedContainerId(
				ctx,
				input.containerId,
				input.serverId,
				"execute",
			);
			await containerKill(containerId, input.serverId);
			await audit(ctx, {
				action: "stop",
				resourceType: "docker",
				resourceId: containerId,
				resourceName: containerId,
			});
		}),

	removeContainer: withPermission("docker", "delete")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertDockerServerAccess(ctx, input.serverId);
			const containerId = await resolveAuthorizedContainerId(
				ctx,
				input.containerId,
				input.serverId,
				"delete",
			);
			await containerRemove(containerId, input.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "docker",
				resourceId: containerId,
				resourceName: containerId,
			});
		}),

	getConfig: withPermission("docker", "inspect")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertDockerServerAccess(ctx, input.serverId);
			if (!input.serverId) {
				return await assertLocalDockerContainerAccess(
					ctx,
					input.containerId,
					"inspect",
				);
			}
			return await getConfig(input.containerId, input.serverId);
		}),

	getContainersByAppNameMatch: withPermission("service", "read")
		.input(
			z.object({
				appType: z.enum(["stack", "docker-compose"]).optional(),
				appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertDockerServerAccess(ctx, input.serverId);
			return await getContainersByAppNameMatch(
				input.appName,
				input.appType,
				input.serverId,
			);
		}),

	getContainersByAppLabel: withPermission("docker", "read")
		.input(
			z.object({
				appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
				serverId: z.string().optional(),
				type: z.enum(["standalone", "swarm"]),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertDockerServerAccess(ctx, input.serverId);
			return await getContainersByAppLabel(
				input.appName,
				input.type,
				input.serverId,
			);
		}),

	getStackContainersByAppName: withPermission("docker", "read")
		.input(
			z.object({
				appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertDockerServerAccess(ctx, input.serverId);
			return await getStackContainersByAppName(input.appName, input.serverId);
		}),

	getServiceContainersByAppName: withPermission("docker", "read")
		.input(
			z.object({
				appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertDockerServerAccess(ctx, input.serverId);
			return await getServiceContainersByAppName(input.appName, input.serverId);
		}),

	uploadFileToContainer: withPermission("docker", "write")
		.input(uploadFileToContainerSchema)
		.mutation(async ({ input, ctx }) => {
			await assertDockerServerAccess(ctx, input.serverId);
			const containerId = await resolveAuthorizedContainerId(
				ctx,
				input.containerId,
				input.serverId,
				"write",
			);

			const file = input.file;
			if (!(file instanceof File)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid file provided",
				});
			}

			// Convert File to Buffer
			const arrayBuffer = await file.arrayBuffer();
			const fileBuffer = Buffer.from(arrayBuffer);

			await uploadFileToContainer(
				containerId,
				fileBuffer,
				file.name,
				input.destinationPath,
				input.serverId || null,
			);

			return { success: true, message: "File uploaded successfully" };
		}),

	listContainerFiles: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				path: containerPathSchema,
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertDockerServerAccess(ctx, input.serverId);
			const containerId = await resolveAuthorizedFileContainerId(
				ctx,
				input.containerId,
				input.serverId,
				"read",
			);
			return await listContainerFiles(containerId, input.path, input.serverId);
		}),

	readContainerFile: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				path: containerPathSchema,
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertDockerServerAccess(ctx, input.serverId);
			const containerId = await resolveAuthorizedFileContainerId(
				ctx,
				input.containerId,
				input.serverId,
				"read",
			);
			return await readContainerFile(containerId, input.path, input.serverId);
		}),

	writeContainerFile: withPermission("docker", "write")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				path: containerPathSchema,
				content: z.string(),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertDockerServerAccess(ctx, input.serverId);
			const containerId = await resolveAuthorizedFileContainerId(
				ctx,
				input.containerId,
				input.serverId,
				"write",
			);
			await writeContainerFile(
				containerId,
				input.path,
				input.content,
				input.serverId,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "docker",
				resourceId: containerId,
				resourceName: `${containerId}:${input.path}`,
			});
		}),

	deleteContainerFile: withPermission("docker", "delete")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				path: containerPathSchema.refine(
					(path) => path !== "/",
					"Cannot delete the container root.",
				),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await assertDockerServerAccess(ctx, input.serverId);
			const containerId = await resolveAuthorizedFileContainerId(
				ctx,
				input.containerId,
				input.serverId,
				"delete",
			);
			await deleteContainerFile(containerId, input.path, input.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "docker",
				resourceId: containerId,
				resourceName: `${containerId}:${input.path}`,
			});
		}),

	getEvents: withPermission("docker", "read")
		.input(
			z.object({
				serverId: z.string().optional(),
				minutes: z.number().min(1).max(1440).default(15),
			}),
		)
		.query(async ({ input, ctx }) => {
			await assertDockerServerAccess(ctx, input.serverId);
			return await getDockerEvents(input.serverId, input.minutes);
		}),
});

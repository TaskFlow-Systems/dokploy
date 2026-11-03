import {
	execAsync,
	execAsyncRemote,
	findAllDeploymentsByApplicationId,
	findAllDeploymentsByComposeId,
	findAllDeploymentsByServerId,
	findAllDeploymentsCentralized,
	findBackupById,
	findComposeById,
	findComposeDeploymentOperation,
	findDeploymentById,
	findPreviewDeploymentById,
	findScheduleById,
	findVolumeBackupById,
	getAccessibleServerIds,
	IS_CLOUD,
	markDeploymentOperationDispatched,
	removeDeployment,
	resolveServicePath,
	updateDeploymentStatus,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
	checkDeploymentLogOwnerAccess,
	type DeploymentOwnerCandidate,
	getDeploymentServiceId,
} from "@dokploy/server/services/deployment-log-access";
import {
	checkPermission,
	checkServicePermissionAndAccess,
	findMemberByUserId,
} from "@dokploy/server/services/permission";
import { assertHostScheduleAccess } from "@dokploy/server/services/schedule";
import { getDeploymentLogServerId } from "@dokploy/server/utils/deployments/log-server";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { assertTargetServerAccess } from "@/server/api/utils/placement-access";
import {
	apiFindAllByApplication,
	apiFindAllByCompose,
	apiFindAllByServer,
	apiFindAllByType,
	apiReconcileDeployment,
	apiReconcileDeploymentResponse,
	deployments,
	server,
} from "@/server/db/schema";
import type { DeploymentJob } from "@/server/queues/queue-types";
import { myQueue } from "@/server/queues/queueSetup";
import {
	deploy,
	fetchDeployApiJobs,
	fetchDeployApiJobsResult,
	type QueueJobRow,
} from "@/server/utils/deploy";
import { createTRPCRouter, protectedProcedure, withPermission } from "../trpc";

type DeploymentPermissionAction = "cancel" | "read";

const assertDeploymentActionAccess = async (
	ctx: Parameters<typeof assertTargetServerAccess>[0],
	deployment: DeploymentOwnerCandidate,
	action: DeploymentPermissionAction,
) => {
	if (
		action === "read" &&
		(await checkDeploymentLogOwnerAccess(ctx, deployment))
	) {
		return;
	}

	const serviceId = getDeploymentServiceId(deployment);
	if (serviceId) {
		await checkServicePermissionAndAccess(ctx, serviceId, {
			deployment: [action],
		});
		return;
	}

	const deploymentServerId =
		deployment.serverId || deployment.schedule?.serverId;
	if (deploymentServerId) {
		await checkPermission(ctx, { deployment: [action] });
		await assertTargetServerAccess(ctx, deploymentServerId);
		return;
	}

	throw new TRPCError({
		code: "UNAUTHORIZED",
		message: "You are not authorized to access this deployment",
	});
};

// A panel schedule runs as root on the host, so a service id on its row must
// not turn this into a service check (see assertHostScheduleAccess).
const assertPanelScheduleDeploymentAccess = async (
	ctx: Parameters<typeof assertTargetServerAccess>[0],
	schedule: Pick<
		Awaited<ReturnType<typeof findScheduleById>>,
		"organizationId" | "scheduleType" | "serverId"
	>,
	action: DeploymentPermissionAction,
) => {
	if (schedule.organizationId !== ctx.session.activeOrganizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this schedule deployment",
		});
	}
	await checkPermission(ctx, { deployment: [action] });
	await assertHostScheduleAccess(ctx, schedule.scheduleType, schedule.serverId);
};

const assertScheduleDeploymentReadAccess = async (
	ctx: Parameters<typeof assertTargetServerAccess>[0],
	schedule: Awaited<ReturnType<typeof findScheduleById>>,
) => {
	if (schedule.scheduleType === "dokploy-server") {
		await assertPanelScheduleDeploymentAccess(ctx, schedule, "read");
		return;
	}

	const serviceId = schedule.applicationId || schedule.composeId;
	if (serviceId) {
		await checkServicePermissionAndAccess(ctx, serviceId, {
			deployment: ["read"],
		});
		return;
	}

	if (schedule.serverId) {
		await checkPermission(ctx, { deployment: ["read"] });
		await assertTargetServerAccess(ctx, schedule.serverId);
		return;
	}

	throw new TRPCError({
		code: "UNAUTHORIZED",
		message: "You are not authorized to access this schedule deployment",
	});
};

type DeploymentRow = Awaited<ReturnType<typeof findDeploymentById>>;
type ScheduleRunOwner = NonNullable<DeploymentRow["schedule"]>;

// Follows runCommand by scheduleType, so the check and the kill always look at
// the same owner, whatever else is left on the row.
const assertScheduleRunCancelAccess = async (
	ctx: Parameters<typeof assertTargetServerAccess>[0],
	schedule: ScheduleRunOwner,
) => {
	if (schedule.scheduleType === "dokploy-server") {
		await assertPanelScheduleDeploymentAccess(ctx, schedule, "cancel");
		return;
	}

	const serviceId =
		schedule.scheduleType === "application"
			? schedule.applicationId
			: schedule.scheduleType === "compose"
				? schedule.composeId
				: null;
	if (serviceId) {
		await checkServicePermissionAndAccess(ctx, serviceId, {
			deployment: ["cancel"],
		});
		return;
	}

	if (schedule.scheduleType === "server" && schedule.serverId) {
		await checkPermission(ctx, { deployment: ["cancel"] });
		await assertTargetServerAccess(ctx, schedule.serverId);
		return;
	}

	throw new TRPCError({
		code: "UNAUTHORIZED",
		message: "You are not authorized to access this deployment",
	});
};

const assertDeploymentCancelAccess = async (
	ctx: Parameters<typeof assertTargetServerAccess>[0],
	deployment: DeploymentRow,
) => {
	if (deployment.schedule) {
		await assertScheduleRunCancelAccess(ctx, deployment.schedule);
		return;
	}
	await assertDeploymentActionAccess(ctx, deployment, "cancel");
};

// A service schedule has no serverId of its own: its command runs on the
// service's server, and a PID from there means another process on the panel.
const getScheduleRunServerId = (schedule: ScheduleRunOwner) => {
	switch (schedule.scheduleType) {
		case "application":
			return schedule.application?.serverId;
		case "compose":
			return schedule.compose?.serverId;
		case "server":
			return schedule.serverId;
		case "dokploy-server":
			return null;
	}
};

export const deploymentRouter = createTRPCRouter({
	reconcile: protectedProcedure
		.meta({
			openapi: {
				path: "/deployment/reconcile",
				method: "POST",
			},
		})
		.input(apiReconcileDeployment)
		.output(apiReconcileDeploymentResponse)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["read"],
			});
			if (input.repair) {
				await checkServicePermissionAndAccess(ctx, input.composeId, {
					deployment: ["create"],
				});
			}

			let operation = await findComposeDeploymentOperation(
				input.composeId,
				input.operationId,
			);
			const compose = await findComposeById(input.composeId);
			let queue: {
				state: "queued" | "active" | "queue-empty" | "queue-unavailable";
				reasonCode?:
					| "not-configured"
					| "network-error"
					| "remote-error"
					| "invalid-response";
			};

			if (IS_CLOUD && compose.serverId) {
				const result = await fetchDeployApiJobsResult(compose.serverId);
				if (!result.available) {
					queue = {
						state: "queue-unavailable",
						reasonCode: result.reasonCode,
					};
				} else {
					const matching = result.jobs.find(
						(job) => job.data?.operationId === input.operationId,
					);
					queue = matching
						? {
								state:
									matching.state === "active" || matching.state === "running"
										? "active"
										: "queued",
							}
						: { state: "queue-empty" };
				}
			} else {
				const jobs = await myQueue.getJobs(["waiting", "active"]);
				const matching = jobs.find(
					(job) =>
						job.data.applicationType === "compose" &&
						"operationId" in job.data &&
						job.data.operationId === input.operationId,
				);
				queue = matching
					? {
							state:
								(await matching.getState()) === "active" ? "active" : "queued",
						}
					: { state: "queue-empty" };
			}

			let repairPerformed = false;
			const isFinal =
				operation.status === "succeeded" || operation.status === "failed";
			if (
				input.repair &&
				queue.state === "queue-empty" &&
				!isFinal &&
				operation.status !== "running" &&
				!operation.deploymentId
			) {
				const jobData: DeploymentJob = {
					composeId: input.composeId,
					titleLog: "Exact deployment repair",
					descriptionLog: "Redispatched immutable source recovery deployment",
					type: "deploy",
					applicationType: "compose",
					server: !!compose.serverId,
					serverId: compose.serverId ?? undefined,
					operationId: operation.operationId,
					expectedRevision: operation.sourceRevision,
				};
				try {
					if (IS_CLOUD && compose.serverId) {
						await deploy(jobData);
					} else {
						await myQueue.add("deployments", jobData, {
							jobId: operation.operationId,
							removeOnComplete: true,
							removeOnFail: true,
						});
					}
					await markDeploymentOperationDispatched(
						operation.operationId,
						"queued",
					);
					repairPerformed = true;
					queue = { state: "queued" };
				} catch {
					await markDeploymentOperationDispatched(
						operation.operationId,
						"dispatch_unknown",
					);
					queue = { state: "queue-unavailable", reasonCode: "network-error" };
				}
				operation = await findComposeDeploymentOperation(
					input.composeId,
					input.operationId,
				);
			}

			return {
				composeId: operation.composeId,
				operationId: operation.operationId,
				sourceRevision: operation.sourceRevision,
				resolvedRevision: operation.resolvedRevision,
				operationStatus: operation.status,
				deployment: operation.deployment
					? {
							deploymentId: operation.deployment.deploymentId,
							status: operation.deployment.status,
							startedAt: operation.deployment.startedAt,
							finishedAt: operation.deployment.finishedAt,
						}
					: null,
				queue,
				repairPerformed,
				createdAt: operation.createdAt,
				updatedAt: operation.updatedAt,
				checkedAt: new Date().toISOString(),
			};
		}),
	all: protectedProcedure
		.input(apiFindAllByApplication)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["read"],
			});
			return await findAllDeploymentsByApplicationId(input.applicationId);
		}),

	allByCompose: protectedProcedure
		.input(apiFindAllByCompose)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["read"],
			});
			return await findAllDeploymentsByComposeId(input.composeId);
		}),
	allByServer: withPermission("deployment", "read")
		.input(apiFindAllByServer)
		.query(async ({ input, ctx }) => {
			await assertTargetServerAccess(ctx, input.serverId);
			return await findAllDeploymentsByServerId(input.serverId);
		}),
	allCentralized: withPermission("deployment", "read").query(
		async ({ ctx }) => {
			const orgId = ctx.session.activeOrganizationId;
			const accessedServices =
				ctx.user.role !== "owner" && ctx.user.role !== "admin"
					? (await findMemberByUserId(ctx.user.id, orgId)).accessedServices
					: null;
			if (accessedServices !== null && accessedServices.length === 0) {
				return [];
			}
			return findAllDeploymentsCentralized(orgId, accessedServices);
		},
	),

	queueList: withPermission("deployment", "read").query(async ({ ctx }) => {
		const orgId = ctx.session.activeOrganizationId;
		let rows: QueueJobRow[];

		if (IS_CLOUD) {
			const accessibleIds = await getAccessibleServerIds(ctx.session);
			const servers = await db.query.server.findMany({
				where: eq(server.organizationId, orgId),
				columns: { serverId: true },
			});
			const serverRowsArrays = await Promise.all(
				servers
					.filter(({ serverId }) => accessibleIds.has(serverId))
					.map(({ serverId }) => fetchDeployApiJobs(serverId)),
			);
			rows = serverRowsArrays.flat();
			rows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
		} else {
			const jobs = await myQueue.getJobs();
			const jobRows = await Promise.all(
				jobs.map(async (job) => {
					const state = await job.getState();
					return {
						id: String(job.id),
						name: job.name ?? undefined,
						data: job.data as Record<string, unknown>,
						timestamp: job.timestamp,
						processedOn: job.processedOn,
						finishedOn: job.finishedOn,
						failedReason: job.failedReason ?? undefined,
						state,
					};
				}),
			);
			jobRows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
			rows = jobRows;
		}

		const rowsWithServicePath = await Promise.all(
			rows.map(async (row) => {
				const servicePath = await resolveServicePath(
					orgId,
					(row.data ?? {}) as Record<string, unknown>,
				);
				return {
					...row,
					servicePath,
				};
			}),
		);

		if (IS_CLOUD) {
			return rowsWithServicePath;
		}

		return rowsWithServicePath.filter((row) => row.servicePath.href !== null);
	}),

	allByType: protectedProcedure
		.input(apiFindAllByType)
		.query(async ({ input, ctx }) => {
			if (input.type === "schedule") {
				const schedule = await findScheduleById(input.id);
				await assertScheduleDeploymentReadAccess(ctx, schedule);
			} else if (input.type === "server") {
				const accessibleServerIds = await getAccessibleServerIds(ctx.session);
				if (!accessibleServerIds.has(input.id)) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You don't have access to this server.",
					});
				}
				await checkPermission(ctx, { deployment: ["read"] });
			} else {
				let serviceId: string | null | undefined = input.id;
				if (input.type === "backup") {
					const backup = await findBackupById(input.id);
					serviceId =
						backup.postgresId ||
						backup.mysqlId ||
						backup.mariadbId ||
						backup.mongoId ||
						backup.libsqlId ||
						backup.composeId;
				} else if (input.type === "volumeBackup") {
					const volumeBackup = await findVolumeBackupById(input.id);
					serviceId =
						volumeBackup.applicationId ||
						volumeBackup.composeId ||
						volumeBackup.postgresId ||
						volumeBackup.mysqlId ||
						volumeBackup.mariadbId ||
						volumeBackup.mongoId ||
						volumeBackup.redisId ||
						volumeBackup.libsqlId;
				} else if (input.type === "previewDeployment") {
					const preview = await findPreviewDeploymentById(input.id);
					serviceId = preview.applicationId;
				}
				if (serviceId) {
					await checkServicePermissionAndAccess(ctx, serviceId, {
						deployment: ["read"],
					});
				} else {
					await checkPermission(ctx, { deployment: ["read"] });
				}
			}
			return await db.query.deployments.findMany({
				where: eq(deployments[`${input.type}Id`], input.id),
				orderBy: desc(deployments.createdAt),
				with: {
					rollback: {
						columns: {
							fullContext: false,
						},
					},
				},
			});
		}),
	killProcess: protectedProcedure
		.input(
			z.object({
				deploymentId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const deployment = await findDeploymentById(input.deploymentId);
			await assertDeploymentCancelAccess(ctx, deployment);

			// The PID stays on the row after the run ends and may belong to another
			// process by now.
			if (!deployment.pid || deployment.status !== "running") {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Deployment is not running",
				});
			}

			const serverId = deployment.schedule
				? getScheduleRunServerId(deployment.schedule)
				: deployment.serverId;
			if (!serverId && IS_CLOUD) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message:
						"Processes on the panel cannot be killed in the cloud version.",
				});
			}

			const command = `kill -9 ${deployment.pid}`;
			if (serverId) {
				await execAsyncRemote(serverId, command);
			} else {
				await execAsync(command);
			}

			await updateDeploymentStatus(deployment.deploymentId, "error");
			await audit(ctx, {
				action: "cancel",
				resourceType: "deployment",
				resourceId: deployment.deploymentId,
			});
		}),

	removeDeployment: protectedProcedure
		.input(
			z.object({
				deploymentId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const deployment = await findDeploymentById(input.deploymentId);
			await assertDeploymentCancelAccess(ctx, deployment);
			const result = await removeDeployment(input.deploymentId);
			await audit(ctx, {
				action: "delete",
				resourceType: "deployment",
				resourceId: deployment.deploymentId,
			});
			return result;
		}),

	readLogs: protectedProcedure
		.input(
			z.object({
				deploymentId: z.string().min(1),
				tail: z.number().int().min(1).max(10000).default(100),
			}),
		)
		.query(async ({ input, ctx }) => {
			const deployment = await findDeploymentById(input.deploymentId);
			const deploymentServerId = getDeploymentLogServerId(deployment);
			await assertDeploymentActionAccess(ctx, deployment, "read");

			if (!deployment.logPath) {
				return "";
			}

			const command = `tail -n ${input.tail} "${deployment.logPath}" 2>/dev/null || echo ""`;
			if (deploymentServerId) {
				const { stdout } = await execAsyncRemote(deploymentServerId, command);
				return stdout;
			}

			if (IS_CLOUD) {
				return "";
			}

			const { stdout } = await execAsync(command);
			return stdout;
		}),
});

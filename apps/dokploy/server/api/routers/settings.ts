import {
	acquireHostStackUpdateLock,
	CLEANUP_CRON_JOB,
	COMPONENTS_UPDATE_FAILED,
	checkGPUStatus,
	checkPortInUse,
	checkPostgresHealth,
	checkTraefikHealth,
	cleanupAll,
	cleanupAllBackground,
	cleanupBuilders,
	cleanupContainers,
	cleanupImages,
	cleanupSystem,
	cleanupVolumes,
	DEFAULT_UPDATE_DATA,
	DOKPLOY_KEEP_IMAGES_MAX,
	DOKPLOY_KEEP_IMAGES_MIN,
	diskHistoryInputSchema,
	dockerDiskUsageDetailLimitSchema,
	dockerRow,
	filterProtectedTraefikEntries,
	findServerById,
	getAgentHitsUpdateCommand,
	getAgentHitsUpdateImage,
	getDiskUsageHistory,
	getDockerDiskUsage,
	getDockerResourceType,
	getDokployImageKeepCount,
	getDokployImages,
	getDokployImageTag,
	getDokployVersionData,
	getLogCleanupStatus,
	getOfficialUpdateCommand,
	getOfficialUpdateImage,
	getServerUpdateStatus,
	getTraefikOverview,
	getUpdateData,
	getUpdateDiskSpace,
	getWebServerSettings,
	HOST_STACK_COMPONENTS,
	hostStackRefusals,
	IS_CLOUD,
	isHostDockerUpgradeActive,
	isHostStackUiComponent,
	isHostStackUpdateRunning,
	isServerUpdateRunning,
	parseRawConfig,
	paths,
	prepareEnvironmentVariables,
	processLogs,
	pullTraefikImage,
	readConfig,
	readConfigInPath,
	readDirectory,
	readEnvironmentVariableList,
	readEnvironmentVariables,
	readHostDockerUpgradeStatus,
	readHostDockerVersion,
	readHostStackRows,
	readMainConfig,
	readMonitoringConfig,
	readPorts,
	recreateDirectory,
	redactWebServerSettings,
	refreshDiskUsage,
	reloadDockerResource,
	removeOldDokployImages,
	resolveDockerDiskUsageDetailLimit,
	sendDockerCleanupNotifications,
	setupGPUSupport,
	startHostDockerUpgrade,
	startLogCleanup,
	startServerUpdate,
	stopLogCleanup,
	updateHostStackComponents,
	updateLetsEncryptEmail,
	updateServerById,
	updateServerTraefik,
	updateWebServerSettings,
	writeConfig,
	writeMainConfig,
	writeTraefikConfigInPath,
	writeTraefikSetup,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { assertNoTraefikDeletion } from "@dokploy/server/services/domain-overview";
import { checkPermission } from "@dokploy/server/services/permission";
import {
	acquireTraefikOperation,
	runningTraefikOperation,
} from "@dokploy/server/setup/traefik-operation-lock";
import { isProtectedTraefikPath } from "@dokploy/server/utils/traefik/application";
import { generateOpenApiDocument } from "@dokploy/trpc-openapi";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { eq, sql } from "drizzle-orm";
import { scheduledJobs, scheduleJob } from "node-schedule";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { assertLocalHostAccess } from "@/server/api/utils/local-host-access";
import { logPanelRestart } from "@/server/api/utils/panel-restart-log";
import {
	assertProtectedResourceAccess,
	hasProtectedResourceAccess,
} from "@/server/api/utils/super-session";
import {
	assertSettingsServerAccess,
	assertTraefikFilesHostAccess,
} from "@/server/api/utils/traefik-files-access";
import {
	apiAssignDomain,
	apiEnableDashboard,
	apiModifyTraefikConfig,
	apiReadStatsLogs,
	apiReadTraefikConfig,
	apiSaveSSHKey,
	apiServerSchema,
	apiTraefikConfig,
	apiUpdateDockerCleanup,
	apiUpdateWebServerBuildsConcurrency,
	projects,
	server,
} from "@/server/db/schema";
import { cleanAllDeploymentQueue } from "@/server/queues/queueSetup";
import { removeJob, schedule } from "@/server/utils/backup";
import packageInfo from "../../../package.json";
import { appRouter } from "../root";
import {
	adminProcedure,
	createTRPCRouter,
	enterpriseOwnerProcedure,
	protectedProcedure,
	publicProcedure,
	withPermission,
} from "../trpc";

const beginTraefikOperation = async (
	serverId: string | null | undefined,
	label: string,
) => {
	const key = serverId ?? null;
	const release = acquireTraefikOperation(key, label);
	if (!release) {
		throw new TRPCError({
			code: "CONFLICT",
			message: `Traefik is busy on this server (${runningTraefikOperation(key)}). Try again when it ends.`,
		});
	}
	try {
		await assertNoTraefikDeletion(key);
	} catch (error) {
		release();
		throw error;
	}
	return release;
};

const traefikUpdateLocks = new Map<string, symbol>();
const traefikUpdateErrors = new Map<string, string>();

const assertTraefikAccess = async (
	serverId: string | undefined,
	organizationId: string,
) => {
	if (serverId) {
		const server = await findServerById(serverId);
		if (server.organizationId !== organizationId) {
			throw new TRPCError({ code: "UNAUTHORIZED" });
		}
	} else if (IS_CLOUD) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
};

export const settingsRouter = createTRPCRouter({
	getWebServerSettings: protectedProcedure.query(async () => {
		if (IS_CLOUD) {
			return null;
		}
		const settings = await getWebServerSettings();
		return redactWebServerSettings(settings);
	}),
	reloadServer: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}
		logPanelRestart("Reload", ctx);
		await reloadDockerResource("dokploy", undefined, packageInfo.version);
		await audit(ctx, {
			action: "reload",
			resourceType: "settings",
			resourceName: "dokploy",
		});
		return true;
	}),
	cleanAllDeploymentQueue: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}
		const result = cleanAllDeploymentQueue();
		await audit(ctx, {
			action: "update",
			resourceType: "settings",
			resourceName: "clean-deployment-queue",
		});
		return result;
	}),
	reloadTraefik: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await assertSettingsServerAccess(ctx, input?.serverId);

			const releaseTraefikOperation = await beginTraefikOperation(
				input?.serverId,
				"reload",
			);
			// Run in background so the request returns immediately; avoids proxy timeouts.
			void reloadDockerResource("dokploy-traefik", input?.serverId)
				.catch((err) => {
					console.error("reloadTraefik background:", err);
				})
				.finally(releaseTraefikOperation);
			await audit(ctx, {
				action: "reload",
				resourceType: "settings",
				resourceName: "dokploy-traefik",
			});
			return true;
		}),
	hostStack: adminProcedure.query(async ({ ctx }) => {
		await assertLocalHostAccess(ctx);
		if (IS_CLOUD) {
			return null;
		}
		return await readHostStackRows(packageInfo.version);
	}),
	updateHostStack: adminProcedure
		.meta({
			openapi: {
				path: "/settings/update-host-stack",
				method: "POST",
				override: true,
				enabled: false,
			},
		})
		.input(
			z.object({
				components: z.array(z.enum(HOST_STACK_COMPONENTS)).min(1),
			}),
		)
		.subscription(async ({ input, ctx }) => {
			await assertLocalHostAccess(ctx);
			if (IS_CLOUD) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "The panel host components are not managed here.",
				});
			}
			const refusals = hostStackRefusals(input.components);
			if (refusals.length > 0) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: refusals.join(" "),
				});
			}
			if (isHostDockerUpgradeActive(await readHostDockerUpgradeStatus())) {
				throw new TRPCError({
					code: "CONFLICT",
					message:
						"Docker Engine is being upgraded on this host. Try again when it finishes.",
				});
			}
			const releaseHostStackLock = isServerUpdateRunning()
				? null
				: acquireHostStackUpdateLock();
			if (!releaseHostStackLock) {
				throw new TRPCError({
					code: "CONFLICT",
					message:
						"Another update of this panel host is running. Try again when it finishes.",
				});
			}
			const components = input.components.filter(isHostStackUiComponent);
			try {
				await audit(ctx, {
					action: "update",
					resourceType: "settings",
					resourceName: "panel-host",
					metadata: { components },
				});
			} catch (error) {
				releaseHostStackLock();
				throw error;
			}
			return observable<string>((emit) => {
				updateHostStackComponents(components, (log) => {
					emit.next(log);
				})
					.catch((error) => {
						emit.next(
							`${error instanceof Error ? error.message : error}\n${COMPONENTS_UPDATE_FAILED}\n`,
						);
					})
					.finally(() => {
						releaseHostStackLock();
						emit.complete();
					});
			});
		}),
	hostDockerUpgrade: adminProcedure.query(async ({ ctx }) => {
		await assertLocalHostAccess(ctx);
		if (IS_CLOUD) {
			return null;
		}
		return await readHostDockerUpgradeStatus();
	}),
	upgradeHostDocker: adminProcedure
		.meta({
			openapi: {
				path: "/settings/upgrade-host-docker",
				method: "POST",
				override: true,
				enabled: false,
			},
		})
		.mutation(async ({ ctx }) => {
			await assertLocalHostAccess(ctx);
			if (IS_CLOUD) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "The panel host components are not managed here.",
				});
			}
			const docker = dockerRow(await readHostDockerVersion());
			if (!docker.outdated) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						docker.installed === null
							? "The installed Docker Engine version could not be read on the panel host."
							: `Docker Engine already runs ${docker.installed}.`,
				});
			}
			const releaseHostStackLock = isServerUpdateRunning()
				? null
				: acquireHostStackUpdateLock();
			if (!releaseHostStackLock) {
				throw new TRPCError({
					code: "CONFLICT",
					message:
						"Another update of this panel host is running. Try again when it finishes.",
				});
			}
			try {
				if (isHostDockerUpgradeActive(await readHostDockerUpgradeStatus())) {
					throw new TRPCError({
						code: "CONFLICT",
						message: "Docker Engine is already being upgraded on this host.",
					});
				}
				await audit(ctx, {
					action: "update",
					resourceType: "settings",
					resourceName: "panel-host",
					metadata: { components: ["docker"] },
				});
				await startHostDockerUpgrade(docker.installed);
			} catch (error) {
				if (error instanceof TRPCError) {
					throw error;
				}
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: error instanceof Error ? error.message : String(error),
				});
			} finally {
				releaseHostStackLock();
			}
			return await readHostDockerUpgradeStatus();
		}),
	toggleDashboard: adminProcedure
		.input(apiEnableDashboard)
		.mutation(async ({ input, ctx }) => {
			await assertSettingsServerAccess(ctx, input.serverId);
			const releaseTraefikOperation = await beginTraefikOperation(
				input.serverId,
				"dashboard toggle",
			);
			let handedOver = false;
			try {
				const ports = await readPorts("dokploy-traefik", input.serverId);
				const env = await readEnvironmentVariables(
					"dokploy-traefik",
					input.serverId,
				);
				const preparedEnv = prepareEnvironmentVariables(env);
				let newPorts = ports;
				// If receive true, add 8080 to ports
				if (input.enableDashboard) {
					// Check if port 8080 is already in use before enabling dashboard
					const portCheck = await checkPortInUse(8080, input.serverId);
					if (portCheck.isInUse) {
						const conflictInfo = portCheck.conflictingContainer
							? ` by ${portCheck.conflictingContainer}`
							: "";
						throw new TRPCError({
							code: "CONFLICT",
							message: `Port 8080 is already in use${conflictInfo}. Please stop the conflicting service or use a different port for the Traefik dashboard.`,
						});
					}
					newPorts.push({
						targetPort: 8080,
						publishedPort: 8080,
						protocol: "tcp",
					});
				} else {
					newPorts = ports.filter((port) => port.targetPort !== 8080);
				}

				// Run in background so the request returns immediately; client polls /api/health.
				// Avoids proxy timeouts (520) while Traefik is recreated.
				void writeTraefikSetup({
					env: preparedEnv,
					additionalPorts: newPorts,
					serverId: input.serverId,
				})
					.catch((err) => {
						console.error("toggleDashboard background writeTraefikSetup:", err);
					})
					.finally(releaseTraefikOperation);
				handedOver = true;
				await audit(ctx, {
					action: "update",
					resourceType: "settings",
					resourceName: "toggle-dashboard",
				});
				return true;
			} finally {
				if (!handedOver) {
					releaseTraefikOperation();
				}
			}
		}),
	cleanUnusedImages: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await assertSettingsServerAccess(ctx, input?.serverId);

			await cleanupImages(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-unused-images",
			});
			return true;
		}),
	cleanUnusedVolumes: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await assertSettingsServerAccess(ctx, input?.serverId);

			await cleanupVolumes(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-unused-volumes",
			});
			return true;
		}),
	cleanStoppedContainers: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await assertSettingsServerAccess(ctx, input?.serverId);

			await cleanupContainers(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-stopped-containers",
			});
			return true;
		}),
	cleanDockerBuilder: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await assertSettingsServerAccess(ctx, input?.serverId);

			await cleanupBuilders(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-docker-builder",
			});
		}),
	cleanDockerPrune: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await assertSettingsServerAccess(ctx, input?.serverId);

			await cleanupSystem(input?.serverId);
			await cleanupBuilders(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-docker-prune",
			});
			return true;
		}),
	cleanAll: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await assertSettingsServerAccess(ctx, input?.serverId);

			// Execute cleanup in background and return immediately to avoid gateway timeouts
			const result = await cleanupAllBackground(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-all",
			});
			return result;
		}),
	cleanMonitoring: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}
		const { MONITORING_PATH } = paths();
		await recreateDirectory(MONITORING_PATH);
		await audit(ctx, {
			action: "delete",
			resourceType: "settings",
			resourceName: "clean-monitoring",
		});
		return true;
	}),
	getDockerDiskUsage: withPermission("docker", "read")
		.input(
			z
				.object({
					detailLimit: dockerDiskUsageDetailLimitSchema,
				})
				.optional(),
		)
		.query(async ({ input }) => {
			if (IS_CLOUD) {
				return [];
			}
			return getDockerDiskUsage(
				resolveDockerDiskUsageDetailLimit(input?.detailLimit),
			);
		}),
	getDiskUsageHistory: adminProcedure
		.input(diskHistoryInputSchema)
		.query(async ({ input }) => {
			if (IS_CLOUD) {
				return null;
			}
			return await getDiskUsageHistory(input.period, input.utcOffsetMinutes);
		}),
	saveSSHPrivateKey: adminProcedure
		.input(apiSaveSSHKey)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			await updateWebServerSettings({
				sshPrivateKey: input.sshPrivateKey,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "ssh-private-key",
			});
			return true;
		}),
	assignDomainServer: adminProcedure
		.input(apiAssignDomain)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			const settings = await updateWebServerSettings({
				host: input.host,
				letsEncryptEmail: input.letsEncryptEmail,
				certificateType: input.certificateType,
				https: input.https,
			});

			if (!settings) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Web server settings not found",
				});
			}

			updateServerTraefik(settings, input.host);
			if (input.letsEncryptEmail) {
				updateLetsEncryptEmail(input.letsEncryptEmail);
			}

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "assign-domain-server",
			});
			return redactWebServerSettings(settings);
		}),
	cleanSSHPrivateKey: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}
		await updateWebServerSettings({
			sshPrivateKey: null,
		});
		await audit(ctx, {
			action: "delete",
			resourceType: "settings",
			resourceName: "ssh-private-key",
		});
		return true;
	}),
	updateDockerCleanup: adminProcedure
		.input(apiUpdateDockerCleanup)
		.mutation(async ({ input, ctx }) => {
			await assertSettingsServerAccess(ctx, input.serverId);

			if (input.serverId) {
				await updateServerById(input.serverId, {
					enableDockerCleanup: input.enableDockerCleanup,
				});

				const server = await findServerById(input.serverId);

				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this server",
					});
				}

				if (server.enableDockerCleanup) {
					const server = await findServerById(input.serverId);
					if (server.serverStatus === "inactive") {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "Server is inactive",
						});
					}
					if (IS_CLOUD) {
						await schedule({
							cronSchedule: CLEANUP_CRON_JOB,
							serverId: input.serverId,
							type: "server",
						});
					} else {
						scheduleJob(server.serverId, CLEANUP_CRON_JOB, async () => {
							console.log(
								`Docker Cleanup ${new Date().toLocaleString()}] Running...`,
							);

							await cleanupAll(server.serverId);

							await sendDockerCleanupNotifications(server.organizationId);
						});
					}
				} else {
					if (IS_CLOUD) {
						await removeJob({
							cronSchedule: CLEANUP_CRON_JOB,
							serverId: input.serverId,
							type: "server",
						});
					} else {
						const currentJob = scheduledJobs[server.serverId];
						currentJob?.cancel();
					}
				}
			} else if (!IS_CLOUD) {
				const settingsUpdated = await updateWebServerSettings({
					enableDockerCleanup: input.enableDockerCleanup,
				});

				if (settingsUpdated?.enableDockerCleanup) {
					scheduleJob("docker-cleanup", CLEANUP_CRON_JOB, async () => {
						console.log(
							`Docker Cleanup ${new Date().toLocaleString()}] Running...`,
						);

						await cleanupAll();

						await sendDockerCleanupNotifications(
							ctx.session.activeOrganizationId,
						);
					});
				} else {
					const currentJob = scheduledJobs["docker-cleanup"];
					currentJob?.cancel();
				}
			}

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "docker-cleanup",
			});
			return true;
		}),

	updateRemoteServersOnly: enterpriseOwnerProcedure
		.input(z.object({ remoteServersOnly: z.boolean() }))
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This feature is only available for self-hosted instances",
				});
			}

			await updateWebServerSettings({
				remoteServersOnly: input.remoteServersOnly,
			});

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "remote-servers-only",
			});
			return true;
		}),

	updateBuildsConcurrency: adminProcedure
		.input(apiUpdateWebServerBuildsConcurrency)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This feature is only available for self-hosted instances",
				});
			}

			await updateWebServerSettings({
				buildsConcurrency: input.buildsConcurrency,
			});

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "builds-concurrency",
			});
			return true;
		}),

	updateEnforceSSO: enterpriseOwnerProcedure
		.input(z.object({ enforceSSO: z.boolean() }))
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This feature is only available for self-hosted instances",
				});
			}

			await updateWebServerSettings({
				enforceSSO: input.enforceSSO,
			});

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "enforce-sso",
			});
			return true;
		}),

	readTraefikConfig: adminProcedure.query(() => {
		if (IS_CLOUD) {
			return true;
		}
		const traefikConfig = readMainConfig();
		return traefikConfig;
	}),

	updateTraefikConfig: adminProcedure
		.input(apiTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			writeMainConfig(input.traefikConfig);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "traefik-config",
			});
			return true;
		}),

	readWebServerTraefikConfig: adminProcedure.query(() => {
		if (IS_CLOUD) {
			return true;
		}
		const traefikConfig = readConfig("dokploy");
		return traefikConfig;
	}),
	updateWebServerTraefikConfig: adminProcedure
		.input(apiTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			writeConfig("dokploy", input.traefikConfig);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "web-server-traefik-config",
			});
			return true;
		}),

	readMiddlewareTraefikConfig: adminProcedure.query(() => {
		if (IS_CLOUD) {
			return true;
		}
		const traefikConfig = readConfig("middlewares");
		return traefikConfig;
	}),

	updateMiddlewareTraefikConfig: adminProcedure
		.input(apiTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			writeConfig("middlewares", input.traefikConfig);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "middleware-traefik-config",
			});
			return true;
		}),
	getUpdateData: protectedProcedure.mutation(async () => {
		if (IS_CLOUD) {
			return DEFAULT_UPDATE_DATA;
		}

		return await getUpdateData(packageInfo.version);
	}),
	updateServer: adminProcedure
		.input(
			z
				.object({
					keepImages: z
						.number()
						.int()
						.min(DOKPLOY_KEEP_IMAGES_MIN)
						.max(DOKPLOY_KEEP_IMAGES_MAX)
						.nullable(),
				})
				.optional(),
		)
		.mutation(async ({ ctx, input }) => {
			if (IS_CLOUD) {
				return true;
			}

			const resourceType = await getDockerResourceType("dokploy");
			if (resourceType !== "service") {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"Dokploy is not running as a Docker service, so in-panel updates are unavailable here. Update manually instead.",
				});
			}

			const keepImages = input?.keepImages;
			const data = await getUpdateData(packageInfo.version);
			// After the await: a host-stack update can start while the update check runs.
			if (
				isHostStackUpdateRunning() ||
				isHostDockerUpgradeActive(await readHostDockerUpgradeStatus())
			) {
				throw new TRPCError({
					code: "CONFLICT",
					message:
						"The panel host components are being updated. Try again when they finish.",
				});
			}
			if (data.updateAvailable) {
				const started = startServerUpdate(
					data.updateSource === "agenthits"
						? getAgentHitsUpdateCommand(
								packageInfo.version,
								data.latestVersion,
								data.latestOfficialVersion,
								keepImages,
							)
						: getOfficialUpdateCommand(data.latestVersion ?? "", keepImages),
					data.updateSource === "agenthits"
						? getAgentHitsUpdateImage()
						: getOfficialUpdateImage(data.latestVersion ?? ""),
				);
				if (started) {
					logPanelRestart(
						`Update to ${data.latestVersion ?? "the latest version"}`,
						ctx,
					);
				}
				await audit(ctx, {
					action: "update",
					resourceType: "settings",
					resourceName: "dokploy-version",
				});
			}

			return true;
		}),

	getServerUpdateStatus: adminProcedure.query(() => {
		return getServerUpdateStatus();
	}),

	getUpdateDiskSpace: adminProcedure.query(async () => {
		if (IS_CLOUD) {
			return null;
		}
		return await getUpdateDiskSpace();
	}),

	freeUpdateDiskSpace: adminProcedure
		.input(z.object({ buildCache: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			if (IS_CLOUD) {
				return null;
			}
			// The update script holds the image it is pulling; let it finish first.
			if (isServerUpdateRunning()) {
				throw new TRPCError({
					code: "CONFLICT",
					message: "An update is running. Wait until it finishes.",
				});
			}
			await removeOldDokployImages();
			if (input.buildCache) {
				await cleanupBuilders();
			}
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: input.buildCache
					? "free-update-disk-space-with-build-cache"
					: "free-update-disk-space",
			});
			// The page asks for the history right after this; without a new
			// sample it would still show the space as taken.
			await refreshDiskUsage({ force: true }).catch((error) => {
				console.error("Disk usage: sampling after the cleanup failed", error);
			});
			return await getUpdateDiskSpace();
		}),

	getDokployVersion: protectedProcedure.query(() => {
		return packageInfo.version;
	}),
	getDokployVersionData: protectedProcedure.query(() => {
		return getDokployVersionData(packageInfo.version);
	}),
	getReleaseTag: protectedProcedure.query(() => {
		return getDokployImageTag();
	}),
	getDokployImageKeepCount: adminProcedure.query(() => {
		return getDokployImageKeepCount();
	}),
	getDokployImages: adminProcedure.query(async () => {
		if (IS_CLOUD) {
			return [];
		}
		return await getDokployImages();
	}),
	readDirectories: protectedProcedure
		.input(apiServerSchema)
		.query(async ({ ctx, input }) => {
			try {
				await checkPermission(ctx, { traefikFiles: ["read"] });
				await assertTraefikFilesHostAccess(ctx, input?.serverId);
				const { MAIN_TRAEFIK_PATH } = paths(!!input?.serverId);
				const result = await readDirectory(MAIN_TRAEFIK_PATH, input?.serverId);
				if (await hasProtectedResourceAccess(ctx)) {
					return result || [];
				}
				return filterProtectedTraefikEntries(result || [], input?.serverId);
			} catch (error) {
				throw error;
			}
		}),

	updateTraefikFile: protectedProcedure
		.input(apiModifyTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			await checkPermission(ctx, { traefikFiles: ["write"] });
			await assertTraefikFilesHostAccess(ctx, input?.serverId);
			const allowProtected = isProtectedTraefikPath(
				input.path,
				input?.serverId,
			);
			if (allowProtected) {
				await assertProtectedResourceAccess(ctx);
			}
			await writeTraefikConfigInPath(
				input.path,
				input.traefikConfig,
				input?.serverId,
				{ allowProtected },
			);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "traefik-file",
			});
			return true;
		}),

	readTraefikFile: protectedProcedure
		.input(apiReadTraefikConfig)
		.query(async ({ input, ctx }) => {
			await checkPermission(ctx, { traefikFiles: ["read"] });
			await assertTraefikFilesHostAccess(ctx, input.serverId);
			const allowProtected = isProtectedTraefikPath(input.path, input.serverId);
			if (allowProtected) {
				await assertProtectedResourceAccess(ctx);
			}

			return readConfigInPath(input.path, input.serverId, { allowProtected });
		}),
	getIp: protectedProcedure.query(async () => {
		if (IS_CLOUD) {
			return "";
		}
		const settings = await getWebServerSettings();
		return settings?.serverIp || "";
	}),
	updateServerIp: adminProcedure
		.input(
			z.object({
				serverIp: z.string(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			const settings = await updateWebServerSettings({
				serverIp: input.serverIp,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "server-ip",
			});
			return redactWebServerSettings(settings);
		}),

	getOpenApiDocument: protectedProcedure.query(
		async ({ ctx }): Promise<unknown> => {
			await checkPermission(ctx, { api: ["read"] });
			const protocol = ctx.req.headers["x-forwarded-proto"];
			const url = `${protocol}://${ctx.req.headers.host}/api`;
			const openApiDocument = generateOpenApiDocument(appRouter, {
				title: "tRPC OpenAPI",
				version: packageInfo.version,
				baseUrl: url,
				docsUrl: `${url}/settings.getOpenApiDocument`,
				tags: [
					"admin",
					"docker",
					"compose",
					"registry",
					"cluster",
					"user",
					"domain",
					"destination",
					"backup",
					"deployment",
					"mounts",
					"certificates",
					"settings",
					"security",
					"redirects",
					"port",
					"project",
					"application",
					"mysql",
					"postgres",
					"redis",
					"mongo",
					"libsql",
					"mariadb",
					"sshRouter",
					"gitProvider",
					"bitbucket",
					"ai",
					"github",
					"gitlab",
					"gitea",
					"tag",
					"patch",
					"server",
					"volumeBackups",
					"environment",
					"auditLog",
					"customRole",
					"whitelabeling",
					"sso",
					"licenseKey",
					"organization",
					"previewDeployment",
				],
			});

			openApiDocument.info = {
				title: "Dokploy API",
				description: "Endpoints for dokploy",
				version: packageInfo.version,
			};

			// Add security schemes configuration
			openApiDocument.components = {
				...openApiDocument.components,
				securitySchemes: {
					apiKey: {
						type: "apiKey",
						in: "header",
						name: "x-api-key",
						description: "API key authentication",
					},
				},
			};

			// Apply security globally to all endpoints
			openApiDocument.security = [
				{
					apiKey: [],
				},
			];
			return openApiDocument;
		},
	),
	readTraefikEnv: adminProcedure
		.input(apiServerSchema)
		.query(async ({ input, ctx }) => {
			await assertSettingsServerAccess(ctx, input?.serverId);
			const envVars = await readEnvironmentVariables(
				"dokploy-traefik",
				input?.serverId,
			);
			return envVars;
		}),

	writeTraefikEnv: adminProcedure
		.input(z.object({ env: z.string(), serverId: z.string().optional() }))
		.mutation(async ({ input, ctx }) => {
			await assertSettingsServerAccess(ctx, input?.serverId);
			const envs = prepareEnvironmentVariables(input.env);
			const ports = await readPorts("dokploy-traefik", input?.serverId);

			// Run in background so the request returns immediately; client polls /api/health.
			void writeTraefikSetup({
				env: envs,
				additionalPorts: ports,
				serverId: input.serverId,
			}).catch((err) => {
				console.error("writeTraefikEnv background writeTraefikSetup:", err);
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "traefik-env",
			});
			return true;
		}),
	haveTraefikDashboardPortEnabled: adminProcedure
		.input(apiServerSchema)
		.query(async ({ input, ctx }) => {
			await assertSettingsServerAccess(ctx, input?.serverId);
			const ports = await readPorts("dokploy-traefik", input?.serverId);
			return ports.some((port) => port.targetPort === 8080);
		}),

	readStatsLogs: adminProcedure
		.meta({
			openapi: {
				path: "/read-stats-logs",
				method: "POST",
				override: true,
				enabled: false,
			},
		})
		.input(apiReadStatsLogs)
		.query(async ({ input }) => {
			if (IS_CLOUD) {
				return {
					data: [],
					totalCount: 0,
				};
			}
			const rawConfig = await readMonitoringConfig(
				!!input.dateRange?.start && !!input.dateRange?.end,
			);

			const parsedConfig = parseRawConfig(
				rawConfig as string,
				input.page,
				input.sort,
				input.search,
				input.status,
				input.dateRange,
			);

			return parsedConfig;
		}),
	readStats: adminProcedure
		.meta({
			openapi: {
				path: "/read-stats",
				method: "POST",
				override: true,
				enabled: false,
			},
		})
		.input(
			z
				.object({
					dateRange: z
						.object({
							start: z.string().optional(),
							end: z.string().optional(),
						})
						.optional(),
				})
				.optional(),
		)
		.query(async ({ input }) => {
			if (IS_CLOUD) {
				return [];
			}
			const rawConfig = await readMonitoringConfig(
				!!input?.dateRange?.start || !!input?.dateRange?.end,
			);
			const processedLogs = processLogs(rawConfig as string, input?.dateRange);
			return processedLogs || [];
		}),
	haveActivateRequests: adminProcedure.query(async () => {
		if (IS_CLOUD) {
			return true;
		}
		const config = readMainConfig();

		if (!config) return false;
		const parsedConfig = parse(config) as {
			accessLog?: {
				filePath: string;
			};
		};

		return !!parsedConfig?.accessLog?.filePath;
	}),
	toggleRequests: adminProcedure
		.input(
			z.object({
				enable: z.boolean(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			const mainConfig = readMainConfig();
			if (!mainConfig) return false;

			const currentConfig = parse(mainConfig) as {
				accessLog?: {
					filePath: string;
				};
			};

			if (input.enable) {
				const config = {
					accessLog: {
						filePath: "/etc/dokploy/traefik/dynamic/access.log",
						format: "json",
						bufferingSize: 100,
					},
				};
				currentConfig.accessLog = config.accessLog;
			} else {
				currentConfig.accessLog = undefined;
			}

			writeMainConfig(stringify(currentConfig));
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "toggle-requests",
			});
			return true;
		}),
	isCloud: publicProcedure.query(async () => {
		return IS_CLOUD;
	}),
	isUserSubscribed: protectedProcedure.query(async ({ ctx }) => {
		const haveServers = await db.query.server.findMany({
			where: eq(server.organizationId, ctx.session?.activeOrganizationId || ""),
		});
		const haveProjects = await db.query.projects.findMany({
			where: eq(
				projects.organizationId,
				ctx.session?.activeOrganizationId || "",
			),
		});
		return haveServers.length > 0 || haveProjects.length > 0;
	}),
	health: publicProcedure.query(async () => {
		try {
			await db.execute(sql`SELECT 1`);
			return { status: "ok" };
		} catch (error) {
			console.error("Database connection error:", error);
			throw error;
		}
	}),
	checkInfrastructureHealth: adminProcedure.query(async () => {
		if (IS_CLOUD) {
			return {
				postgres: { status: "healthy" as const },
				traefik: { status: "healthy" as const },
			};
		}

		const [postgres, traefik] = await Promise.all([
			checkPostgresHealth(),
			checkTraefikHealth(),
		]);

		return { postgres, traefik };
	}),
	setupGPU: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD && !input.serverId) {
				throw new Error("Select a server to enable the GPU Setup");
			}
			await assertSettingsServerAccess(ctx, input.serverId);

			try {
				await setupGPUSupport(input.serverId);
				await audit(ctx, {
					action: "update",
					resourceType: "settings",
					resourceName: "setup-gpu",
				});
				return { success: true };
			} catch (error) {
				console.error("GPU Setup Error:", error);
				throw error;
			}
		}),
	checkGPUStatus: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			if (IS_CLOUD && !input.serverId) {
				return {
					driverInstalled: false,
					driverVersion: undefined,
					gpuModel: undefined,
					runtimeInstalled: false,
					runtimeConfigured: false,
					cudaSupport: undefined,
					cudaVersion: undefined,
					memoryInfo: undefined,
					availableGPUs: 0,
					swarmEnabled: false,
					gpuResources: 0,
				};
			}
			await assertSettingsServerAccess(ctx, input.serverId);

			try {
				return await checkGPUStatus(input.serverId || "");
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Failed to check GPU status";
				throw new TRPCError({
					code: "BAD_REQUEST",
					message,
				});
			}
		}),
	updateTraefikPorts: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
				additionalPorts: z.array(
					z.object({
						targetPort: z.number(),
						publishedPort: z.number(),
						protocol: z.enum(["tcp", "udp", "sctp"]),
					}),
				),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD && !input.serverId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "Please set a serverId to update Traefik ports",
				});
			}
			await assertSettingsServerAccess(ctx, input.serverId);
			if (input.additionalPorts.some((port) => port.publishedPort === 80)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"Port 80 cannot be published. Certificates renew only over port 443.",
				});
			}

			const releaseTraefikOperation = await beginTraefikOperation(
				input.serverId,
				"port change",
			);
			let handedOver = false;
			try {
				const env = await readEnvironmentVariables(
					"dokploy-traefik",
					input?.serverId,
				);

				for (const port of input.additionalPorts) {
					const portCheck = await checkPortInUse(
						port.publishedPort,
						input.serverId,
					);
					if (portCheck.isInUse) {
						throw new TRPCError({
							code: "CONFLICT",
							message: `Port ${port.targetPort} is already in use by ${portCheck.conflictingContainer}`,
						});
					}
				}
				const preparedEnv = prepareEnvironmentVariables(env);

				// Run in background so the request returns immediately; client polls /api/health.
				void writeTraefikSetup({
					env: preparedEnv,
					additionalPorts: input.additionalPorts,
					serverId: input.serverId,
				})
					.catch((err) => {
						console.error(
							"updateTraefikPorts background writeTraefikSetup:",
							err,
						);
					})
					.finally(releaseTraefikOperation);
				handedOver = true;
				await audit(ctx, {
					action: "update",
					resourceType: "settings",
					resourceName: "traefik-ports",
				});
				return true;
			} catch (error) {
				if (error instanceof TRPCError) {
					throw error;
				}
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? error.message
							: "Error updating Traefik ports",
					cause: error,
				});
			} finally {
				if (!handedOver) {
					releaseTraefikOperation();
				}
			}
		}),
	getTraefikPorts: adminProcedure
		.input(apiServerSchema)
		.query(async ({ input, ctx }) => {
			await assertSettingsServerAccess(ctx, input?.serverId);
			const ports = await readPorts("dokploy-traefik", input?.serverId);
			return ports;
		}),
	getTraefikOverview: adminProcedure
		.input(apiServerSchema)
		.query(async ({ input, ctx }) => {
			await assertTraefikAccess(
				input?.serverId,
				ctx.session.activeOrganizationId,
			);
			const key = input?.serverId ?? "local";
			const overview = await getTraefikOverview(input?.serverId);
			return {
				...overview,
				isUpdating: traefikUpdateLocks.has(key),
				lastUpdateError: traefikUpdateErrors.get(key) ?? null,
			};
		}),
	updateTraefik: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			const serverId = input?.serverId;
			await assertTraefikAccess(serverId, ctx.session.activeOrganizationId);

			const lockKey = serverId ?? "local";
			if (traefikUpdateLocks.has(lockKey)) {
				throw new TRPCError({
					code: "CONFLICT",
					message: "A Traefik update is already running on this server",
				});
			}
			// Port changes, reloads and removals share this lock with the update.
			const releaseTraefikOperation = await beginTraefikOperation(
				serverId,
				"version update",
			);
			const lock = Symbol(lockKey);
			traefikUpdateLocks.set(lockKey, lock);
			traefikUpdateErrors.delete(lockKey);
			// The lock can expire mid-update; never touch a newer update's lock.
			const ownsKey = () => {
				const holder = traefikUpdateLocks.get(lockKey);
				return holder === undefined || holder === lock;
			};
			const release = () => {
				if (traefikUpdateLocks.get(lockKey) === lock) {
					traefikUpdateLocks.delete(lockKey);
				}
				releaseTraefikOperation();
			};

			let recreate: Promise<void>;
			try {
				const overview = await getTraefikOverview(serverId);
				if (overview.versionStatus !== "outdated") {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: `Traefik is not older than the recommended version v${overview.recommendedVersion}`,
					});
				}
				// A stopped container reports no published ports, so they would be lost.
				if (overview.state !== "running") {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"Traefik is not running. Start it with Reload, then update it.",
					});
				}
				// Not re-parsed as dotenv, which would cut values at "#".
				const env = await readEnvironmentVariableList(
					"dokploy-traefik",
					serverId,
				);
				const ports = await readPorts("dokploy-traefik", serverId);

				try {
					await pullTraefikImage(serverId);
				} catch (error) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: `Failed to pull Traefik v${overview.recommendedVersion}: ${error instanceof Error ? error.message : error}`,
						cause: error,
					});
				}

				recreate = writeTraefikSetup({
					env,
					additionalPorts: ports,
					serverId,
				});
			} catch (error) {
				release();
				throw error;
			}

			// Expires in case a Docker call hangs.
			const lockTimer = setTimeout(release, 5 * 60_000);
			void recreate
				.catch((err) => {
					if (ownsKey()) {
						traefikUpdateErrors.set(
							lockKey,
							err instanceof Error ? err.message : String(err),
						);
					}
					console.error("updateTraefik background recreate:", err);
				})
				.finally(() => {
					clearTimeout(lockTimer);
					release();
				});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "traefik-version",
			});
			return true;
		}),
	updateLogCleanup: adminProcedure
		.input(
			z.object({
				cronExpression: z.string().nullable(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			let result: boolean;
			if (input.cronExpression) {
				result = await startLogCleanup(input.cronExpression);
			} else {
				result = await stopLogCleanup();
			}
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "log-cleanup",
			});
			return result;
		}),

	getLogCleanupStatus: adminProcedure.query(async () => {
		return getLogCleanupStatus();
	}),

	getDokployCloudIps: adminProcedure.query(async () => {
		if (!IS_CLOUD) {
			return [];
		}
		const ips = process.env.DOKPLOY_CLOUD_IPS?.split(",");
		return ips;
	}),
});

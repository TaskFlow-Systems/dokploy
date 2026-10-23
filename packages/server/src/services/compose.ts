import { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	type apiCreateCompose,
	type apiUpsertComposeEnv,
	buildAppName,
	cleanAppName,
	compose,
} from "@dokploy/server/db/schema";
import { getBuildComposeCommand } from "@dokploy/server/utils/builders/compose";
import { randomizeSpecificationFile } from "@dokploy/server/utils/docker/compose";
import { extractComposeVariables } from "@dokploy/server/utils/docker/compose-variables";
import {
	cloneCompose,
	loadDockerCompose,
	loadDockerComposeRemote,
} from "@dokploy/server/utils/docker/domain";
import type { ComposeSpecification } from "@dokploy/server/utils/docker/types";
import {
	normalizeRelativeFilePath,
	quoteShellArg,
} from "@dokploy/server/utils/filesystem/safe-path";
import { sendBuildErrorNotifications } from "@dokploy/server/utils/notifications/build-error";
import { getBuildErrorMessage } from "@dokploy/server/utils/notifications/build-error-message";
import { sendBuildSuccessNotifications } from "@dokploy/server/utils/notifications/build-success";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { cloneBitbucketRepository } from "@dokploy/server/utils/providers/bitbucket";
import {
	cloneGitRepository,
	getGitCommitInfo,
} from "@dokploy/server/utils/providers/git";
import { cloneGiteaRepository } from "@dokploy/server/utils/providers/gitea";
import { cloneGithubRepository } from "@dokploy/server/utils/providers/github";
import { cloneGitlabRepository } from "@dokploy/server/utils/providers/gitlab";
import { getCreateComposeFileCommand } from "@dokploy/server/utils/providers/raw";
import { quoteShellArgs } from "@dokploy/server/utils/shell";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { encodeBase64 } from "../utils/docker/utils";
import {
	assertNoRedactedSecretPlaceholders,
	getComposeEnvRevision,
	upsertEnvVariables,
} from "../utils/env-upsert";
import { getDokployUrl } from "./admin";
import {
	createDeploymentCompose,
	finalizeDeploymentOperation,
	findComposeDeploymentOperation,
	linkDeploymentOperation,
	resolveDeploymentOperationRevision,
	updateDeployment,
	updateDeploymentStatus,
} from "./deployment";
import { generateApplyPatchesCommand } from "./patch";
import { validUniqueServerAppName } from "./project";

export type Compose = typeof compose.$inferSelect;

export class ExactDeploymentFinalizationError extends Error {
	constructor(operationId: string, cause: unknown) {
		super(`Exact deployment ${operationId} terminal state is ambiguous`, {
			cause,
		});
		this.name = "ExactDeploymentFinalizationError";
	}
}

const normalizeComposeFilePath = (composePath: string) =>
	normalizeRelativeFilePath(composePath);

export const createCompose = async (
	input: z.infer<typeof apiCreateCompose>,
) => {
	const appName = buildAppName("compose", input.appName);

	const valid = await validUniqueServerAppName(appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Service with this 'AppName' already exists",
		});
	}

	const newDestination = await db
		.insert(compose)
		.values({
			...input,
			composeFile: input.composeFile || "",
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newDestination) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting compose",
		});
	}

	return newDestination;
};

export const createComposeByTemplate = async (
	input: typeof compose.$inferInsert,
) => {
	const appName = cleanAppName(input.appName);
	if (appName) {
		const valid = await validUniqueServerAppName(appName);

		if (!valid) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Service with this 'AppName' already exists",
			});
		}
	}
	const newDestination = await db
		.insert(compose)
		.values({
			...input,
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newDestination) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting compose",
		});
	}

	return newDestination;
};

export const findComposeById = async (composeId: string) => {
	const result = await db.query.compose.findFirst({
		where: eq(compose.composeId, composeId),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
			deployments: true,
			mounts: true,
			domains: true,
			github: {
				columns: {
					githubClientSecret: false,
					githubPrivateKey: false,
					githubWebhookSecret: false,
				},
			},
			gitlab: {
				columns: { secret: false, accessToken: false, refreshToken: false },
			},
			bitbucket: { columns: { appPassword: false, apiToken: false } },
			gitea: {
				columns: {
					clientSecret: false,
					accessToken: false,
					refreshToken: false,
				},
			},
			server: true,
			backups: {
				with: {
					destination: {
						columns: {
							accessKey: false,
							secretAccessKey: false,
						},
					},
					deployments: true,
				},
			},
		},
	});
	if (!result) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Compose not found",
		});
	}
	return result;
};

export const loadServices = async (
	composeId: string,
	type: "fetch" | "cache" = "fetch",
) => {
	const compose = await findComposeById(composeId);

	if (type === "fetch") {
		const command = await cloneCompose(compose);
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, command);
		} else {
			await execAsync(command);
		}
	}

	let composeData: ComposeSpecification | null;

	if (compose.serverId) {
		composeData = await loadDockerComposeRemote(compose);
	} else {
		composeData = await loadDockerCompose(compose);
	}

	if (compose.randomize && composeData) {
		const randomizedCompose = randomizeSpecificationFile(
			composeData,
			compose.suffix,
		);
		composeData = randomizedCompose;
	}

	if (!composeData?.services) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Services not found",
		});
	}

	const services = Object.keys(composeData.services);

	return [...services];
};

const getComposeBranch = (compose: Compose) => {
	switch (compose.sourceType) {
		case "github":
			return compose.branch;
		case "gitlab":
			return compose.gitlabBranch;
		case "bitbucket":
			return compose.bitbucketBranch;
		case "gitea":
			return compose.giteaBranch;
		case "git":
			return compose.customGitBranch;
		default:
			return null;
	}
};

export const loadComposeVariables = async (composeId: string) => {
	const compose = await findComposeById(composeId);

	// Fetching replaces the code directory that a running build reads from.
	if (compose.composeStatus === "running") {
		throw new TRPCError({
			code: "CONFLICT",
			message: "A deployment is running. Try again when it finishes.",
		});
	}

	try {
		const command = await cloneCompose(compose);
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, command);
		} else {
			await execAsync(command);
		}
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Could not fetch the source of this compose service",
			cause: error,
		});
	}

	let composeData: ComposeSpecification | null;
	try {
		composeData = compose.serverId
			? await loadDockerComposeRemote(compose)
			: await loadDockerCompose(compose);
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "The compose file is not valid YAML",
			cause: error,
		});
	}

	if (!composeData) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Compose file not found",
		});
	}

	return {
		composePath:
			compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath,
		branch: getComposeBranch(compose),
		variables: extractComposeVariables(composeData),
	};
};

export const updateCompose = async (
	composeId: string,
	composeData: Partial<Compose>,
) => {
	const { appName, ...rest } = composeData;
	const composeResult = await db
		.update(compose)
		.set({
			...rest,
		})
		.where(eq(compose.composeId, composeId))
		.returning();

	return composeResult[0];
};

export const upsertComposeEnvironment = async (
	input: z.infer<typeof apiUpsertComposeEnv>,
) => {
	try {
		assertNoRedactedSecretPlaceholders(input.variables);
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				error instanceof Error
					? error.message
					: "Invalid environment variables",
		});
	}

	return await db.transaction(async (tx) => {
		// compose.env is encrypted with a random IV, so it can't be compared in
		// SQL; the row lock is what makes the revision check and write atomic.
		const [row] = await tx
			.select({ env: compose.env })
			.from(compose)
			.where(eq(compose.composeId, input.composeId))
			.for("update");

		if (!row) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Compose not found",
			});
		}

		const capturedEnv = row.env;
		const currentRevision = getComposeEnvRevision(input.composeId, capturedEnv);

		if (input.expectedRevision && input.expectedRevision !== currentRevision) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Compose environment revision does not match",
			});
		}

		const result = upsertEnvVariables(capturedEnv, input.variables);
		const dryRun = input.dryRun ?? false;
		if (dryRun || !result.changed) {
			return {
				composeId: input.composeId,
				changed: result.changed,
				revision: currentRevision,
				dryRun,
				variables: result.variables,
			};
		}

		await tx
			.update(compose)
			.set({ env: result.env })
			.where(eq(compose.composeId, input.composeId));

		return {
			composeId: input.composeId,
			changed: true,
			revision: getComposeEnvRevision(input.composeId, result.env),
			dryRun: false,
			variables: result.variables,
		};
	});
};

export const deployCompose = async ({
	composeId,
	titleLog = "Manual deployment",
	descriptionLog = "",
	operationId,
	expectedRevision,
	freshVolumes = false,
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
	operationId?: string;
	expectedRevision?: string;
	freshVolumes?: boolean;
}) => {
	const compose = await findComposeById(composeId);
	const isExact = operationId !== undefined || expectedRevision !== undefined;
	if (isExact && (!operationId || !expectedRevision)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Exact deployment requires an operation id and source revision",
		});
	}
	if (isExact && compose.sourceType === "raw") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Exact deployment requires a Git-based Compose source",
		});
	}
	const operation =
		operationId && expectedRevision
			? await findComposeDeploymentOperation(composeId, operationId)
			: null;
	if (operation && operation.sourceRevision !== expectedRevision) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Exact deployment revision does not match its operation",
		});
	}

	const buildLink = `${await getDokployUrl()}/dashboard/project/${
		compose.environment.projectId
	}/environment/${compose.environmentId}/services/compose/${compose.composeId}?tab=deployments`;
	let deployment: Awaited<ReturnType<typeof createDeploymentCompose>> | null =
		null;
	if (!isExact) {
		deployment = await createDeploymentCompose({
			composeId,
			title: titleLog,
			description: descriptionLog,
		});
	}

	try {
		const entity = {
			...compose,
			type: "compose" as const,
			checkoutRevision: operation ? expectedRevision : undefined,
		};
		let command = "set -e;";
		if (compose.sourceType === "github") {
			command += await cloneGithubRepository(entity);
		} else if (compose.sourceType === "gitlab") {
			command += await cloneGitlabRepository(entity);
		} else if (compose.sourceType === "bitbucket") {
			command += await cloneBitbucketRepository(entity);
		} else if (compose.sourceType === "git") {
			command += await cloneGitRepository(entity);
		} else if (compose.sourceType === "gitea") {
			command += await cloneGiteaRepository(entity);
		} else if (compose.sourceType === "raw") {
			command += getCreateComposeFileCommand(entity);
		}

		let commandWithLog = deployment
			? `(${command}) >> ${deployment.logPath} 2>&1`
			: command;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		if (operationId && expectedRevision && operation) {
			const { COMPOSE_PATH } = paths(!!compose.serverId);
			const checkoutPath = join(COMPOSE_PATH, compose.appName, "code");
			const revParseCommand = quoteShellArgs([
				"git",
				"-C",
				checkoutPath,
				"rev-parse",
				"HEAD",
			]);
			const resolved = compose.serverId
				? await execAsyncRemote(compose.serverId, revParseCommand)
				: await execAsync(revParseCommand);
			const resolvedRevision = resolved.stdout.trim().split(/\s+/).at(-1) ?? "";
			if (resolvedRevision !== expectedRevision) {
				throw new TRPCError({
					code: "CONFLICT",
					message: "Cloned Git revision does not match the requested revision",
				});
			}
			await resolveDeploymentOperationRevision(operationId, resolvedRevision);
			const currentCompose = await findComposeById(composeId);
			if (
				getComposeEnvRevision(composeId, currentCompose.env) !==
				operation.envRevision
			) {
				throw new TRPCError({
					code: "CONFLICT",
					message: "Compose environment changed after deployment acceptance",
				});
			}
		}

		deployment ??= await createDeploymentCompose({
			composeId,
			title: titleLog,
			description: descriptionLog,
		});
		if (operationId) {
			await linkDeploymentOperation(operationId, deployment.deploymentId);
		}
		if (compose.sourceType !== "raw") {
			if (operation) {
				const currentCompose = await findComposeById(composeId);
				if (
					getComposeEnvRevision(composeId, currentCompose.env) !==
					operation.envRevision
				) {
					throw new TRPCError({
						code: "CONFLICT",
						message: "Compose environment changed before patch application",
					});
				}
			}
			command = "set -e;";
			command += await generateApplyPatchesCommand({
				id: compose.composeId,
				type: "compose",
				serverId: compose.serverId,
			});
			commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, commandWithLog);
			} else {
				await execAsync(commandWithLog);
			}
		}

		if (freshVolumes && compose.composeType === "docker-compose") {
			const downCommand = `set -e; env -i PATH="$PATH" docker compose -p ${compose.appName} down --volumes 2>&1 || true;`;
			const downWithLog = `(${downCommand}) >> ${deployment.logPath} 2>&1`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, downWithLog);
			} else {
				await execAsync(downWithLog);
			}
		}

		command = "set -e;";
		if (operation) {
			const currentCompose = await findComposeById(composeId);
			if (
				getComposeEnvRevision(composeId, currentCompose.env) !==
				operation.envRevision
			) {
				throw new TRPCError({
					code: "CONFLICT",
					message: "Compose environment changed before build",
				});
			}
		}
		command += await getBuildComposeCommand(entity);
		commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateCompose(composeId, {
			composeStatus: "done",
		});
		const sendSuccessNotification = () =>
			sendBuildSuccessNotifications({
				projectName: compose.environment.project.name,
				applicationName: compose.name,
				applicationType: "compose",
				buildLink,
				organizationId: compose.environment.project.organizationId,
				domains: compose.domains,
				environmentName: compose.environment.name,
			});
		if (operationId) {
			try {
				await finalizeDeploymentOperation(operationId, "succeeded");
			} catch (error) {
				throw new ExactDeploymentFinalizationError(operationId, error);
			}
			await sendSuccessNotification().catch((error) => {
				console.error("Exact deployment success notification failed:", error);
			});
		} else {
			await sendSuccessNotification();
		}
	} catch (error) {
		if (error instanceof ExactDeploymentFinalizationError) {
			throw error;
		}
		// Without a deployment there is no build log to tail.
		const errorMessage = deployment
			? await getBuildErrorMessage(error, deployment.logPath, compose.serverId)
			: (error instanceof Error && error.message) || "Error building";
		let command = "";

		// Only log details for non-ExecError errors when a deployment log exists.
		if (deployment && !(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `echo "${encodedMessage}" | base64 -d >> "${deployment.logPath}";`;
		}

		if (deployment) {
			command += `echo "\nError occurred ❌, check the logs for details." >> ${deployment.logPath};`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, command);
			} else {
				await execAsync(command);
			}
			await updateDeploymentStatus(deployment.deploymentId, "error");
		}
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		if (operationId) {
			await finalizeDeploymentOperation(operationId, "failed");
		}
		await sendBuildErrorNotifications({
			projectName: compose.environment.project.name,
			applicationName: compose.name,
			applicationType: "compose",
			errorMessage,
			buildLink,
			organizationId: compose.environment.project.organizationId,
		});
		throw error;
	} finally {
		if (deployment && compose.sourceType !== "raw") {
			const commitInfo = await getGitCommitInfo({
				...compose,
				type: "compose",
			});
			if (commitInfo) {
				await updateDeployment(deployment.deploymentId, {
					title: commitInfo.message,
					description: `Commit: ${commitInfo.hash}`,
				});
			}
		}
	}
};

export const rebuildCompose = async ({
	composeId,
	titleLog = "Rebuild deployment",
	descriptionLog = "",
	freshVolumes = false,
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
	freshVolumes?: boolean;
}) => {
	const compose = await findComposeById(composeId);

	const deployment = await createDeploymentCompose({
		composeId: composeId,
		title: titleLog,
		description: descriptionLog,
	});

	try {
		let command = "set -e;";
		if (compose.sourceType === "raw") {
			command += getCreateComposeFileCommand(compose);
		}

		let commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		if (compose.sourceType !== "raw") {
			command = "set -e;";
			command += await generateApplyPatchesCommand({
				id: compose.composeId,
				type: "compose",
				serverId: compose.serverId,
			});
			commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, commandWithLog);
			} else {
				await execAsync(commandWithLog);
			}
		}

		if (freshVolumes && compose.composeType === "docker-compose") {
			const downCommand = `set -e; env -i PATH="$PATH" docker compose -p ${compose.appName} down --volumes 2>&1 || true;`;
			const downWithLog = `(${downCommand}) >> ${deployment.logPath} 2>&1`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, downWithLog);
			} else {
				await execAsync(downWithLog);
			}
		}

		command = "set -e;";
		command += await getBuildComposeCommand(compose);
		commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateCompose(composeId, {
			composeStatus: "done",
		});
	} catch (error) {
		let command = "";

		// Only log details for non-ExecError errors
		if (!(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `echo "${encodedMessage}" | base64 -d >> "${deployment.logPath}";`;
		}

		command += `echo "\nError occurred ❌, check the logs for details." >> ${deployment.logPath};`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, command);
		} else {
			await execAsync(command);
		}
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		throw error;
	}

	return true;
};

export const removeCompose = async (
	compose: Compose,
	deleteVolumes: boolean,
) => {
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);
		const projectPath = join(COMPOSE_PATH, compose.appName);
		const quotedAppName = quoteShellArg(compose.appName);
		const quotedProjectPath = quoteShellArg(projectPath);

		if (compose.composeType === "stack") {
			const command = `
			docker network disconnect ${quotedAppName} dokploy-traefik;
			docker stack rm ${quotedAppName};
			rm -rf -- ${quotedProjectPath}`;

			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, command);
			} else {
				await execAsync(command);
			}
		} else {
			const command = `
			docker network disconnect ${quotedAppName} dokploy-traefik;
			env -i PATH="$PATH" ${quoteShellArgs(["docker", "compose", "-p", compose.appName, "down"])} ${
				deleteVolumes ? "--volumes" : ""
			};
			rm -rf -- ${quotedProjectPath}`;

			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, command);
			} else {
				await execAsync(command);
			}
		}
	} catch (error) {
		throw error;
	}

	return true;
};

export const startCompose = async (composeId: string) => {
	const compose = await findComposeById(composeId);
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);

		const projectPath = join(COMPOSE_PATH, compose.appName, "code");
		const path = normalizeComposeFilePath(
			compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath,
		);
		const baseCommand = `env -i PATH="$PATH" ${quoteShellArgs(["docker", "compose", "-p", compose.appName, "-f", path, "up", "-d"])}`;
		const quotedProjectPath = quoteShellArg(projectPath);
		if (compose.composeType === "docker-compose") {
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`cd ${quotedProjectPath} && ${baseCommand}`,
				);
			} else {
				await execAsync(baseCommand, {
					cwd: projectPath,
				});
			}
		}

		await updateCompose(composeId, {
			composeStatus: "done",
		});
	} catch (error) {
		await updateCompose(composeId, {
			composeStatus: "idle",
		});
		throw error;
	}

	return true;
};

export const stopCompose = async (composeId: string) => {
	const compose = await findComposeById(composeId);
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);
		const projectPath = join(COMPOSE_PATH, compose.appName);
		const quotedProjectPath = quoteShellArg(projectPath);
		const quotedAppName = quoteShellArg(compose.appName);
		if (compose.composeType === "docker-compose") {
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`cd ${quotedProjectPath} && env -i PATH="$PATH" ${quoteShellArgs(["docker", "compose", "-p", compose.appName, "stop"])}`,
				);
			} else {
				await execAsync(
					`env -i PATH="$PATH" ${quoteShellArgs(["docker", "compose", "-p", compose.appName, "stop"])}`,
					{
						cwd: projectPath,
					},
				);
			}
		}

		if (compose.composeType === "stack") {
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`docker stack rm ${quotedAppName}`,
				);
			} else {
				await execAsync(`docker stack rm ${quotedAppName}`);
			}
		}

		await updateCompose(composeId, {
			composeStatus: "idle",
		});
	} catch (error) {
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		throw error;
	}

	return true;
};

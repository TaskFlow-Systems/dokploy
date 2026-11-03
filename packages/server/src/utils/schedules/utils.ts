import { createWriteStream } from "node:fs";
import { IS_CLOUD, paths } from "@dokploy/server/constants";
import type { Schedule } from "@dokploy/server/db/schema/schedule";
import {
	createDeploymentSchedule,
	updateDeployment,
	updateDeploymentStatus,
} from "@dokploy/server/services/deployment";
import {
	findScheduleById,
	getScheduleDirectory,
	getScheduleScriptPath,
} from "@dokploy/server/services/schedule";
import { scheduledJobs, scheduleJob as scheduleJobNode } from "node-schedule";
import { quote } from "shell-quote";
import { getComposeContainer, getServiceContainer } from "../docker/utils";
import { quoteShellArg } from "../filesystem/safe-path";
import { execAsyncRemote } from "../process/execAsync";
import { spawnAsync } from "../process/spawnAsync";
import { quoteShellArgs } from "../shell";
import { buildServerScheduleCommand } from "./run-process";

export const scheduleJob = (schedule: Schedule) => {
	const { cronExpression, scheduleId, timezone } = schedule;

	// Use timezone from schedule, default to UTC if not specified
	const tz = timezone || "UTC";

	scheduleJobNode(
		scheduleId,
		{
			tz,
			rule: cronExpression,
		},
		async () => {
			await runCommand(scheduleId);
		},
	);
};

export const removeScheduleJob = (scheduleId: string) => {
	const currentJob = scheduledJobs[scheduleId];
	currentJob?.cancel();
};

export const runCommand = async (scheduleId: string) => {
	const {
		application,
		command,
		shellType,
		scheduleType,
		compose,
		serviceName,
		appName,
		serverId,
	} = await findScheduleById(scheduleId);

	const deployment = await createDeploymentSchedule({
		scheduleId,
		title: "Schedule",
		description: "Schedule",
	});

	try {
		if (scheduleType === "application" || scheduleType === "compose") {
			let containerId = "";
			let serverId = "";
			if (scheduleType === "application" && application) {
				const container = await getServiceContainer(
					application.appName,
					application.serverId,
				);
				containerId = container?.Id || "";
				serverId = application.serverId || "";
			}
			if (scheduleType === "compose" && compose) {
				const container = await getComposeContainer(compose, serviceName || "");
				containerId = container?.Id || "";
				serverId = compose.serverId || "";
			}

			if (!containerId) {
				const target =
					scheduleType === "compose"
						? `service '${serviceName}' of compose '${compose?.name}'`
						: `application '${application?.appName}'`;
				const message = `Container not found for ${target}, make sure the service is running`;
				if (serverId) {
					await execAsyncRemote(
						serverId,
						`echo ${quote([`❌ ${message}`])} >> ${quote([deployment.logPath])}`,
					);
				} else {
					const writeStream = createWriteStream(deployment.logPath, {
						flags: "a",
					});
					writeStream.write(`❌ ${message}\n`);
					writeStream.end();
				}
				throw new Error(message);
			}

			if (serverId) {
				try {
					const dockerExecCommand = quoteShellArgs([
						"docker",
						"exec",
						containerId,
						shellType,
						"-c",
						command,
					]);
					const quotedLogPath = quoteShellArg(deployment.logPath);
					await execAsyncRemote(
						serverId,
						`
					set -e
					echo ${quoteShellArg(
						`Running schedule command for ${scheduleType} container ${containerId}`,
					)} >> ${quotedLogPath};
					${dockerExecCommand} >> ${quotedLogPath} 2>> ${quotedLogPath} || { 
						echo "❌ Command failed" >> ${quotedLogPath};
						exit 1;
					}
					echo "✅ Command executed successfully" >> ${quotedLogPath};
					`,
					);
				} catch (error) {
					await updateDeploymentStatus(deployment.deploymentId, "error");
					throw error;
				}
			} else {
				const writeStream = createWriteStream(deployment.logPath, {
					flags: "a",
				});

				try {
					if (IS_CLOUD) {
						writeStream.write(
							"This feature is not available in the cloud version.",
						);
						writeStream.end();
						await updateDeploymentStatus(deployment.deploymentId, "error");
						return { ...deployment, status: "error" as const };
					}
					writeStream.write(
						`docker exec ${containerId} ${shellType} -c ${command}\n`,
					);
					await spawnAsync(
						"docker",
						["exec", containerId, shellType, "-c", command],
						(data) => {
							if (writeStream.writable) {
								writeStream.write(data);
							}
						},
					);

					writeStream.write("✅ Command executed successfully\n");
					writeStream.end();
				} catch (error) {
					writeStream.write("❌ Command failed\n");
					writeStream.write(
						error instanceof Error ? error.message : "Unknown error",
					);
					writeStream.end();
					throw error;
				}
			}
		} else if (scheduleType === "dokploy-server") {
			const writeStream = createWriteStream(deployment.logPath, { flags: "a" });
			const { SCHEDULES_PATH } = paths();
			const fullPath = getScheduleDirectory(SCHEDULES_PATH, appName);

			await spawnAsync(
				"bash",
				["-c", "./script.sh"],
				async (data) => {
					if (writeStream.writable) {
						// we need to extract the PID and Schedule ID from the data
						const pid = data?.match(/PID: (\d+)/)?.[1];

						if (pid) {
							await updateDeployment(deployment.deploymentId, {
								pid,
							});
						}
						writeStream.write(data);
					}
				},
				{
					cwd: fullPath,
				},
			);
		} else if (scheduleType === "server") {
			const { SCHEDULES_PATH } = paths(true);
			const scriptPath = getScheduleScriptPath(SCHEDULES_PATH, appName);
			const command = buildServerScheduleCommand(
				scriptPath,
				deployment.logPath,
			);
			await execAsyncRemote(serverId, command, async (data) => {
				// we need to extract the PID and Schedule ID from the data
				const pid = data?.match(/PID: (\d+)/)?.[1];
				if (pid) {
					await updateDeployment(deployment.deploymentId, {
						pid,
					});
				}
			});
		}
		await updateDeploymentStatus(deployment.deploymentId, "done");
		return { ...deployment, status: "done" as const };
	} catch {
		await updateDeploymentStatus(deployment.deploymentId, "error");
		return { ...deployment, status: "error" as const };
	}
};

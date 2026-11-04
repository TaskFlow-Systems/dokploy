import { db } from "@dokploy/server/db";
import {
	DEFAULT_BUILD_TIMEOUT_MINUTES,
	deployments,
	server,
} from "@dokploy/server/db/schema";
import { getWebServerSettings } from "@dokploy/server/services/web-server-settings";
import { quoteShellArgument } from "@dokploy/server/utils/shell";
import { eq } from "drizzle-orm";
import { encodeBase64 } from "../docker/utils";
import { ExecError } from "./ExecError";
import { execAsync, execAsyncRemote } from "./execAsync";

const TIMEOUT_KILL_AFTER_SECONDS = 30;
// The build server's own `timeout` reports first. The panel's timer is for a
// server that cannot stop the build by itself.
const PANEL_TIMEOUT_GRACE_MS = 60_000;

export class BuildTimeoutError extends Error {
	constructor(timeoutMinutes: number) {
		super(`Build timed out after ${timeoutMinutes} minutes`);
		this.name = "BuildTimeoutError";
	}
}

const escapePkillPattern = (value: string) =>
	value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

// shell-quote turns `!` into `\!` inside double quotes, which breaks a script
// with `if ! command`.
const singleQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// pkill -f reads only the first 4 KB of a command line, so the marker has to
// open the script. The bracket keeps pkill's own shell from matching itself.
const buildMarkerPattern = (appName: string) =>
	`[:] dokploy-build:${escapePkillPattern(appName)};`;

const runOnBuildServer = (serverId: string | null, command: string) =>
	serverId ? execAsyncRemote(serverId, command) : execAsync(command);

// The interpreter a plain command gets on each path: the login shell over ssh,
// /bin/sh from child_process.
const REMOTE_SHELL = '"${SHELL:-sh}"';
const LOCAL_SHELL = "/bin/sh";

// `timeout` runs on the build server, so the build stops there even after the
// panel lost the connection, and it signals the whole process group. A server
// without a usable `timeout` still builds and relies on the panel's timer.
export const wrapBuildCommand = (
	command: string,
	appName: string,
	timeoutSeconds: number,
	shell: string = REMOTE_SHELL,
) =>
	[
		`if timeout -k 1 1 true 2>/dev/null; then set -- timeout -k ${TIMEOUT_KILL_AFTER_SECONDS} ${timeoutSeconds}; fi`,
		`"$@" ${shell} -c ${singleQuote(`: dokploy-build:${appName}; ${command}`)}`,
	].join("; ");

export const killDockerBuild = async (
	type: "application" | "compose",
	serverId: string | null,
	appName: string,
) => {
	try {
		const tool = type === "application" ? "docker build" : "docker compose";
		const pattern = `${tool}.*${escapePkillPattern(appName)}|${buildMarkerPattern(appName)}`;
		await runOnBuildServer(
			serverId,
			`pkill -2 -f ${quoteShellArgument(pattern)}`,
		);
	} catch (error) {
		console.error(error);
	}
};

// The queue runs one build per service at a time, so a process with this marker
// is a build the panel lost when the connection dropped or the panel restarted.
// It would keep writing to the same code directory and push over the new image.
const stopOrphanedBuild = async (serverId: string | null, appName: string) => {
	try {
		await runOnBuildServer(
			serverId,
			`pkill -f ${quoteShellArgument(buildMarkerPattern(appName))} || true`,
		);
	} catch (error) {
		console.error(error);
	}
};

const resolveBuildTimeoutMinutes = async (serverId: string | null) => {
	try {
		const settings = serverId
			? await db.query.server.findFirst({
					where: eq(server.serverId, serverId),
					columns: { buildTimeoutMinutes: true },
				})
			: await getWebServerSettings();
		return settings?.buildTimeoutMinutes ?? DEFAULT_BUILD_TIMEOUT_MINUTES;
	} catch (error) {
		console.error("Failed to resolve the build timeout", error);
		return DEFAULT_BUILD_TIMEOUT_MINUTES;
	}
};

/**
 * Returns a function that runs the commands of one build on `serverId`. They
 * share one time budget, taken from the setting of the server that builds.
 */
export const createBuildRunner = async (
	type: "application" | "compose",
	serverId: string | null,
	appName: string,
) => {
	const timeoutMinutes = await resolveBuildTimeoutMinutes(serverId);
	const deadline = Date.now() + timeoutMinutes * 60_000;
	await stopOrphanedBuild(serverId, appName);

	return async (command: string) => {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			throw new BuildTimeoutError(timeoutMinutes);
		}
		const wrapped = wrapBuildCommand(
			command,
			appName,
			Math.ceil(remainingMs / 1000),
			serverId ? REMOTE_SHELL : LOCAL_SHELL,
		);
		const timeoutMs = remainingMs + PANEL_TIMEOUT_GRACE_MS;
		try {
			return serverId
				? await execAsyncRemote(serverId, wrapped, undefined, { timeoutMs })
				: await execAsync(wrapped, { timeoutMs });
		} catch (error) {
			if (Date.now() < deadline) {
				throw error;
			}
			await killDockerBuild(type, serverId, appName);
			throw new BuildTimeoutError(timeoutMinutes);
		}
	};
};

/**
 * Adds a line of the panel's own to the build log. The log is only a report, so
 * a server out of reach must not change how the deployment ends.
 */
export const appendToBuildLog = async (
	serverId: string | null,
	logPath: string,
	line: string,
) => {
	try {
		await runOnBuildServer(
			serverId,
			`echo "${encodeBase64(`${line}\n`)}" | base64 -d >> "${logPath}";`,
		);
	} catch (error) {
		console.error("Failed to write to the build log", error);
	}
};

/**
 * Writes the failure to the build log. The build server may be out of reach,
 * often the very reason the build failed, so this keeps the reason on the
 * deployment instead and never stops the caller from marking the build failed.
 */
export const recordBuildFailure = async ({
	deploymentId,
	logPath,
	serverId,
	error,
}: {
	deploymentId: string;
	logPath: string;
	serverId: string | null;
	error: unknown;
}) => {
	const message = error instanceof Error ? error.message : String(error);
	let command = "";

	// A command that finished wrote its output to the log. After a lost connection
	// the log may end with a healthy build, so the reason has to go there as well.
	if (!(error instanceof ExecError) || !error.didCommandFinish()) {
		command += `echo "${encodeBase64(message)}" | base64 -d >> "${logPath}";`;
	}
	command += `echo "\nError occurred ❌, check the logs for details." >> ${logPath};`;

	try {
		await runOnBuildServer(serverId, command);
	} catch (logError) {
		console.error("Failed to write the build failure to its log", logError);
		await db
			.update(deployments)
			.set({ errorMessage: message })
			.where(eq(deployments.deploymentId, deploymentId));
	}
};

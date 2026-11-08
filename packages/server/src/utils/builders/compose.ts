import { dirname, join } from "node:path";
import { paths } from "@dokploy/server/constants";
import type { InferResultType } from "@dokploy/server/types/with";
import boxen from "boxen";
import { parse } from "shell-quote";
import { writeDomainsToCompose } from "../docker/domain";
import {
	encodeBase64,
	getEnvironmentVariablesObject,
	prepareEnvironmentVariables,
	prepareEnvironmentVariablesForFile,
} from "../docker/utils";
import { normalizeRelativeFilePath } from "../filesystem/safe-path";
import {
	quoteEnvironmentAssignment,
	quoteShellArgs,
	quoteShellArgument,
} from "../shell";
import { withResolvedVaultRefs } from "../vault";

export type ComposeNested = InferResultType<
	"compose",
	{ environment: { with: { project: true } }; mounts: true; domains: true }
>;

export const getBuildComposeCommand = async (rawCompose: ComposeNested) => {
	const compose = await withResolvedVaultRefs(rawCompose);
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const { sourceType, appName, mounts, composeType, domains } = compose;
	const projectPath = join(COMPOSE_PATH, compose.appName, "code");
	normalizeRelativeFilePath(
		sourceType === "raw" ? "docker-compose.yml" : compose.composePath,
	);
	const quotedProjectPath = quoteShellArgument(projectPath);
	const quotedAppName = quoteShellArgument(compose.appName);
	const command = createCommand(
		compose,
		mounts.length > 0 ? projectPath : undefined,
	);
	const envCommand =
		compose.createEnvFile === false ? "" : getCreateEnvFileCommand(compose);
	const exportEnvCommand = getExportEnvCommand(compose);

	const newCompose = await writeDomainsToCompose(compose, domains);
	const logContent = `
App Name: ${appName}
Build Compose 🐳
Detected: ${mounts.length} mounts 📂
Command: docker ${command}
Source Type: docker ${sourceType} ✅
Compose Type: ${composeType} ✅`;

	const logBox = boxen(logContent, {
		padding: {
			left: 1,
			right: 1,
			bottom: 1,
		},
		width: 80,
		borderStyle: "double",
	});

	const bashCommand = `
	set -e
	{
		echo ${quoteShellArgument(logBox)};

		${newCompose}

		${envCommand}

		cd ${quotedProjectPath};

		${compose.isolatedDeployment ? `docker network inspect ${quotedAppName} >/dev/null 2>&1 || docker network create ${compose.composeType === "stack" ? "--driver overlay" : ""} --attachable ${quotedAppName}` : ""}
		env -i PATH="$PATH" HOME="$HOME" ${exportEnvCommand} docker ${command} 2>&1 || { echo "Error: ❌ Docker command failed"; exit 1; }
		${compose.isolatedDeployment ? `docker network connect ${quotedAppName} $(docker ps --filter "name=dokploy-traefik" -q) >/dev/null 2>&1` : ""}

		echo "Docker Compose Deployed: ✅";
	} || {
		echo "Error: ❌ Script execution failed";
		exit 1
	}
	`;

	return bashCommand;
};

// Shell control characters that must never appear in a user-provided compose
// command: they would let it break out of the `docker ${command}` invocation
// into arbitrary host commands. Chaining with `&&` is allowed; every chained
// segment after the first one must be a docker compose invocation.
const UNSAFE_CUSTOM_DOCKER_COMMAND_PATTERN = /[`$;|(){}<>\n\\]/;

const throwInvalidCustomDockerCommand = (): never => {
	throw new Error("Invalid docker compose command");
};

const throwInvalidCustomDockerCharacters = (reason?: string): never => {
	throw new Error(
		"Invalid docker compose command: Invalid characters in compose command" +
			(reason ? ` (${reason})` : ""),
	);
};

const getLongOptionValue = (argument: string, option: string) => {
	if (argument === option) {
		return undefined;
	}
	if (argument.startsWith(`${option}=`)) {
		return argument.slice(option.length + 1);
	}
	return undefined;
};

const composeValueOptions = new Set([
	"-f",
	"--file",
	"--project-directory",
	"--env-file",
	"--profile",
]);

const assertComposeProjectNameBound = (args: string[], appName: string) => {
	let hasProjectName = false;
	let subcommand: string | undefined;
	for (let index = 1; index < args.length; index += 1) {
		const current = args[index];
		if (!current) {
			continue;
		}
		if (current === "-p" || current === "--project-name") {
			const projectName = args[index + 1];
			if (!projectName || projectName !== appName) {
				throwInvalidCustomDockerCommand();
			}
			hasProjectName = true;
			index += 1;
			continue;
		}
		if (current === "--project-name") {
			const projectName = args[index + 1];
			if (!projectName || projectName !== appName) {
				throwInvalidCustomDockerCommand();
			}
			hasProjectName = true;
			index += 1;
			continue;
		}
		const longProjectName = getLongOptionValue(current, "--project-name");
		if (longProjectName !== undefined) {
			if (longProjectName !== appName) {
				throwInvalidCustomDockerCommand();
			}
			hasProjectName = true;
			continue;
		}
		if (composeValueOptions.has(current) && !current.includes("=")) {
			index += 1;
			continue;
		}
		if (!subcommand && !current.startsWith("-")) {
			subcommand = current;
		}
	}
	if (!hasProjectName && subcommand === "up") {
		throwInvalidCustomDockerCommand();
	}
};

const assertStackNameBound = (args: string[], appName: string) => {
	if (args[1] !== "deploy") {
		throwInvalidCustomDockerCommand();
	}

	const valueOptions = new Set([
		"-c",
		"-f",
		"--compose-file",
		"--resolve-image",
	]);
	const operands: string[] = [];
	for (let index = 2; index < args.length; index += 1) {
		const current = args[index];
		if (!current) {
			continue;
		}
		if (current.startsWith("--")) {
			if (valueOptions.has(current) && !current.includes("=")) {
				index += 1;
			}
			continue;
		}
		if (current.startsWith("-")) {
			if (valueOptions.has(current)) {
				index += 1;
			}
			continue;
		}
		operands.push(current);
	}

	const stackName = operands.at(-1);
	if (!stackName || stackName !== appName) {
		throwInvalidCustomDockerCommand();
	}
};

const splitComposeChainSegments = (command: string): string[][] => {
	let parsed: Array<string | { op?: string }>;
	try {
		parsed = parse(command) as Array<string | { op?: string }>;
	} catch {
		throwInvalidCustomDockerCommand();
	}
	const segments: string[][] = [[]];
	for (const part of parsed!) {
		if (typeof part === "string") {
			segments[segments.length - 1]!.push(part);
			continue;
		}
		if (
			part &&
			typeof part === "object" &&
			(part as { op?: string }).op === "&&"
		) {
			segments.push([]);
			continue;
		}
		throwInvalidCustomDockerCommand();
	}
	return segments;
};

const createCustomDockerCommand = (command: string, appName: string) => {
	const sanitizedCommand = command.trim();
	if (!sanitizedCommand) {
		throwInvalidCustomDockerCommand();
	}
	if (
		UNSAFE_CUSTOM_DOCKER_COMMAND_PATTERN.test(sanitizedCommand) ||
		/(?<!&)&(?!&)/.test(sanitizedCommand) ||
		sanitizedCommand.includes("&&&")
	) {
		throwInvalidCustomDockerCharacters(
			"Single '&' is not allowed; use '&&' for chaining",
		);
	}
	const segments = splitComposeChainSegments(sanitizedCommand);
	const rendered = segments.map((args, index) => {
		if (args.length === 0) {
			throwInvalidCustomDockerCommand();
		}
		const head = args[0] as string;
		if (index === 0) {
			if (head === "compose" || head === "docker-compose") {
				assertComposeProjectNameBound(args, appName);
			} else if (head === "stack") {
				assertStackNameBound(args, appName);
			} else {
				throwInvalidCustomDockerCommand();
			}
		} else {
			const isDockerCompose =
				(head === "docker" && args[1] === "compose") ||
				head === "docker-compose";
			if (!isDockerCompose) {
				throw new Error(
					"Invalid docker compose command: chained commands must strictly start with 'docker compose '",
				);
			}
		}
		return quoteShellArgs(args);
	});
	return rendered.join(" && ");
};

export const createCommand = (compose: ComposeNested, projectPath?: string) => {
	const { composeType, appName, sourceType } = compose;
	if (compose.command) {
		return createCustomDockerCommand(compose.command, appName);
	}

	const path =
		sourceType === "raw" ? "docker-compose.yml" : compose.composePath;

	if (composeType === "docker-compose") {
		return quoteShellArgs([
			"compose",
			"-p",
			appName,
			...(projectPath ? ["--project-directory", projectPath] : []),
			...(compose.createEnvFile
				? [
						"--env-file",
						join(dirname(compose.composePath || "docker-compose.yml"), ".env"),
					]
				: []),
			"-f",
			path,
			"up",
			"-d",
			"--build",
			"--remove-orphans",
			...(compose.pullImages ? ["--pull", "always"] : []),
		]);
	}
	if (composeType === "stack") {
		return quoteShellArgs([
			"stack",
			"deploy",
			"-c",
			path,
			appName,
			"--prune",
			"--with-registry-auth",
		]);
	}

	return "";
};

export const getStackStartCommand = async (rawCompose: ComposeNested) => {
	const compose = await withResolvedVaultRefs(rawCompose);
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const projectPath = join(COMPOSE_PATH, compose.appName, "code");
	const path = normalizeRelativeFilePath(
		compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath,
	);
	const quotedAppName = quoteShellArgument(compose.appName);
	const deployCommand = quoteShellArgs([
		"docker",
		"stack",
		"deploy",
		"-c",
		path,
		compose.appName,
		"--prune",
		"--with-registry-auth",
	]);

	return `
set -e
cd ${quoteShellArgument(projectPath)}
${compose.isolatedDeployment ? `docker network inspect ${quotedAppName} >/dev/null 2>&1 || docker network create --driver overlay --attachable ${quotedAppName}` : ""}
env -i PATH="$PATH" HOME="$HOME" ${getExportEnvCommand(compose)} ${deployCommand}
${compose.isolatedDeployment ? `docker network connect ${quotedAppName} $(docker ps --filter "name=dokploy-traefik" -q) >/dev/null 2>&1 || true` : ""}
`;
};

export const getCreateEnvFileCommand = (compose: ComposeNested) => {
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const { env, composePath, appName } = compose;
	const safeComposePath = normalizeRelativeFilePath(
		composePath || "docker-compose.yml",
	);
	const composeFilePath = join(COMPOSE_PATH, appName, "code", safeComposePath);

	const envFilePath = join(dirname(composeFilePath), ".env");

	let envContent = `APP_NAME=${appName}\n`;
	envContent += `COMPOSE_PROJECT_NAME=${appName}\n`;
	envContent += env || "";
	if (!envContent.includes("DOCKER_CONFIG")) {
		envContent += "\nDOCKER_CONFIG=/root/.docker";
	}

	if (compose.randomize) {
		envContent += `\nCOMPOSE_PREFIX=${compose.suffix}`;
	}

	const envFileContent = (
		compose.composeType === "stack"
			? prepareEnvironmentVariables(
					envContent,
					compose.environment.project.env,
					compose.environment.env,
				)
			: prepareEnvironmentVariablesForFile(
					envContent,
					compose.environment.project.env,
					compose.environment.env,
				)
	).join("\n");

	const encodedContent = encodeBase64(envFileContent);
	const quotedEnvFilePath = quoteShellArgument(envFilePath);
	return `
touch ${quotedEnvFilePath};
printf %s ${quoteShellArgument(encodedContent)} | base64 -d > ${quotedEnvFilePath};
		`;
};

const getExportEnvCommand = (compose: ComposeNested) => {
	if (compose.composeType !== "stack") return "";

	const envVars = getEnvironmentVariablesObject(
		compose.env,
		compose.environment.project.env,
		compose.environment.env,
	);
	const exports = Object.entries(envVars)
		.map(([key, value]) => quoteEnvironmentAssignment(key, value))
		.join(" ");

	return exports ? `${exports}` : "";
};

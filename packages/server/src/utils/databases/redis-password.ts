import { setTimeout as sleep } from "node:timers/promises";
import { TRPCError } from "@trpc/server";
import type { ContainerSpec, Service } from "dockerode";
import {
	getMissingServiceContainerCommand,
	getServiceContainerCommand,
} from "../backups/utils";
import { quoteShellArg } from "../filesystem/safe-path";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import { getRemoteDocker } from "../servers/remote-docker";
import {
	hasRedisStartScript,
	passwordInOldRedisStart,
	type RedisNested,
	usesDefaultRedisStart,
	withRedisPassword,
} from "./redis";

// Stop grace period, the load of the data and Swarm's 5 s watch of the new task.
const ROLLOUT_WAIT_MS = 90_000;
const POLL_INTERVAL_MS = 1_000;
const UPDATE_ATTEMPTS = 5;

// redis-cli exits with 0 when Redis refuses a command, so only the reply says
// whether it worked.
const redisCliReply = async (
	{ appName, serverId }: Pick<RedisNested, "appName" | "serverId">,
	password: string,
	args: string,
) => {
	const command = `
		CONTAINER_ID=$(${getServiceContainerCommand(appName)})
		if [ -z "$CONTAINER_ID" ]; then
			${getMissingServiceContainerCommand(appName)}
			exit 1
		fi
		docker exec "$CONTAINER_ID" redis-cli --no-auth-warning -a ${quoteShellArg(password)} ${args}
	`;
	const { stdout } = serverId
		? await execAsyncRemote(serverId, command)
		: await execAsync(command, { shell: "/bin/bash" });
	return stdout.trim();
};

// The old start command leaves a shell as PID 1, which never passes SIGTERM on,
// so its stop ends in SIGKILL with no final save. The row can be ahead of what
// that command started with, after a change that a restart then undid.
const saveBeforeOldStop = async (redis: RedisNested, spec: ContainerSpec) => {
	let reply = "";
	for (const password of [
		redis.databasePassword,
		passwordInOldRedisStart(spec),
	]) {
		if (password === undefined) continue;
		reply = await redisCliReply(redis, password, "SAVE");
		if (reply === "OK") return;
	}
	throw new TRPCError({
		code: "INTERNAL_SERVER_ERROR",
		message: `Redis could not save its data before the restart, so nothing changed: ${reply}. A deploy also applies the stored password.`,
	});
};

const updateContainerSpec = async (
	service: Service,
	change: (spec: ContainerSpec) => ContainerSpec,
) => {
	for (let attempt = 1; ; attempt++) {
		const { Spec, Version } = await service.inspect();
		const before = Spec.TaskTemplate.ContainerSpec;
		const after = change(before);
		// Swarm reports no rollout for a spec that stays the same.
		if (JSON.stringify(after) === JSON.stringify(before)) return false;
		try {
			await service.update({
				version: Number.parseInt(Version.Index, 10),
				...Spec,
				TaskTemplate: { ...Spec.TaskTemplate, ContainerSpec: after },
			});
			return true;
		} catch (error) {
			// Version.Index moves while a service converges.
			const outOfSequence =
				error instanceof Error && /out of sequence/i.test(error.message);
			if (!outOfSequence || attempt >= UPDATE_ATTEMPTS) throw error;
			await sleep(POLL_INTERVAL_MS);
		}
	}
};

// Failing the change is right only when Swarm went back to the old spec. Past the
// deadline the new spec is still in place, so the row has to follow it.
const waitForRollout = async (service: Service) => {
	const deadline = Date.now() + ROLLOUT_WAIT_MS;
	while (Date.now() < deadline) {
		const state: string | undefined = await service
			.inspect()
			.then(({ UpdateStatus }) => UpdateStatus?.State)
			.catch(() => undefined);
		if (state === "completed") return;
		if (state?.startsWith("rollback")) {
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message:
					"Redis did not start with the new password, so Docker Swarm went back to the old one. Its logs say why.",
			});
		}
		await sleep(POLL_INTERVAL_MS);
	}
};

// `CONFIG SET requirepass` lives in memory and Swarm restarts a task from the
// service spec, so a password that has to outlast a restart goes into the spec,
// and Swarm does not change a spec without replacing the task. Nothing is sent to
// Redis first: it would hold a password nobody stored if the spec update failed.
export const changeRedisPassword = async (
	redis: RedisNested,
	password: string,
) => {
	const { appName, databasePassword, env, serverId } = redis;

	// The custom command decides what a restart brings back, and restarting now
	// could undo the change at once.
	if (!usesDefaultRedisStart(redis)) {
		const reply = await redisCliReply(
			redis,
			databasePassword,
			`CONFIG SET requirepass ${quoteShellArg(password)}`,
		);
		if (reply !== "OK") {
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: `Redis refused the new password: ${reply}`,
			});
		}
		return;
	}

	const docker = await getRemoteDocker(serverId);
	const service = docker.getService(appName);
	const { Spec } = await service.inspect().catch((error) => {
		throw error?.statusCode === 404
			? new TRPCError({
					code: "NOT_FOUND",
					message: `No running container found for ${appName}`,
				})
			: error;
	});
	const stopped = Spec.Mode?.Replicated?.Replicas === 0;

	if (!stopped && !hasRedisStartScript(Spec.TaskTemplate.ContainerSpec)) {
		await saveBeforeOldStop(redis, Spec.TaskTemplate.ContainerSpec);
	}

	const updated = await updateContainerSpec(service, (spec) =>
		withRedisPassword(spec, env, password),
	);
	if (updated && !stopped) {
		await waitForRollout(service);
	}
};

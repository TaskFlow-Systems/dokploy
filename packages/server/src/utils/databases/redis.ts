import type { InferResultType } from "@dokploy/server/types/with";
import type { ContainerSpec, CreateServiceOptions } from "dockerode";
import { parse } from "dotenv";
import { resolveServiceNetworks } from "../../services/network";
import { buildDokployLabels } from "../docker/dokploy-labels";
import {
	calculateResources,
	generateBindMounts,
	generateConfigContainer,
	generateFileMounts,
	generateVolumeMounts,
	prepareEnvironmentVariables,
} from "../docker/utils";
import { createOrUpdateSwarmService } from "../docker/swarm-service";
import { getRemoteDocker } from "../servers/remote-docker";
import { withResolvedVaultRefs } from "../vault";

// The password stays out of the text so the shell never parses it. Redis takes an
// empty one as no password at all, so `:?` stops the start instead. `--port` keeps
// the password from being the last argument, where a lone `-` means "read the
// config from stdin". Without `exec`, dash in the Debian image stays PID 1 and
// never passes SIGTERM on, so a stop ends in SIGKILL with no final save.
const REDIS_START_SCRIPT =
	'exec redis-server --requirepass "${DOKPLOY_DB_PASSWORD:?no password to start Redis with}" --port 6379';

const OLD_REDIS_START_PREFIX = "redis-server --requirepass ";

export type RedisNested = InferResultType<
	"redis",
	{ mounts: true; environment: { with: { project: true } } }
>;

// The custom command form saves an empty string and an empty list when it is
// left empty, and neither is an override.
export const usesDefaultRedisStart = ({
	command,
	args,
}: Pick<RedisNested, "command" | "args">) => !command && !args?.length;

export const hasRedisStartScript = ({ Args }: ContainerSpec) =>
	Args?.[1] === REDIS_START_SCRIPT;

export const passwordInOldRedisStart = ({ Args }: ContainerSpec) =>
	Args?.[1]?.startsWith(OLD_REDIS_START_PREFIX)
		? Args[1].slice(OLD_REDIS_START_PREFIX.length)
		: undefined;

// Only the password lines change, so a password change does not also apply env
// edits that wait for the next deploy. REDIS_PASSWORD set in the service env
// stays, as it does on a deploy.
export const withRedisPassword = (
	spec: ContainerSpec,
	serviceEnv: string | null,
	password: string,
): ContainerSpec => {
	const keepsRedisPassword = "REDIS_PASSWORD" in parse(serviceEnv ?? "");
	return {
		...spec,
		Command: ["/bin/sh"],
		Args: ["-c", REDIS_START_SCRIPT],
		Env: [
			...(spec.Env ?? [])
				.filter((line) => !line.startsWith("DOKPLOY_DB_PASSWORD="))
				.map((line) =>
					!keepsRedisPassword && line.startsWith("REDIS_PASSWORD=")
						? `REDIS_PASSWORD=${password}`
						: line,
				),
			`DOKPLOY_DB_PASSWORD=${password}`,
		],
	};
};

export const buildRedis = async (rawRedis: RedisNested) => {
	const redis = await withResolvedVaultRefs(rawRedis);
	const {
		appName,
		env,
		externalPort,
		dockerImage,
		memoryLimit,
		memoryReservation,
		databasePassword,
		cpuLimit,
		cpuReservation,
		command,
		args,
		mounts,
	} = redis;

	const defaultRedisEnv = `REDIS_PASSWORD="${databasePassword}"${
		env ? `\n${env}` : ""
	}`;
	const usesDefaultStart = usesDefaultRedisStart(redis);

	const resolvedNetworks = await resolveServiceNetworks(redis);

	const {
		HealthCheck,
		RestartPolicy,
		Placement,
		Labels,
		Mode,
		RollbackConfig,
		UpdateConfig,
		StopGracePeriod,
		EndpointSpec,
		Ulimits,
	} = generateConfigContainer(redis);
	const resources = calculateResources({
		memoryLimit,
		memoryReservation,
		cpuLimit,
		cpuReservation,
	});
	const envVariables = prepareEnvironmentVariables(
		defaultRedisEnv,
		redis.environment.project.env,
		redis.environment.env,
	);
	const volumesMount = generateVolumeMounts(mounts);
	const bindsMount = generateBindMounts(mounts, {
		appName,
		serverId: redis.serverId,
		serviceType: "redis",
	});
	const filesMount = generateFileMounts(appName, redis);

	const docker = await getRemoteDocker(redis.serverId);

	const settings: CreateServiceOptions = {
		Name: appName,
		TaskTemplate: {
			ContainerSpec: {
				HealthCheck,
				Image: dockerImage,
				// Not REDIS_PASSWORD: the service env can set that name, and dotenv
				// would change a password an old row holds.
				Env: usesDefaultStart
					? [...envVariables, `DOKPLOY_DB_PASSWORD=${databasePassword}`]
					: envVariables,
				Mounts: [...volumesMount, ...bindsMount, ...filesMount],
				...(StopGracePeriod !== null &&
					StopGracePeriod !== undefined && { StopGracePeriod }),
				...(usesDefaultStart
					? {
							Command: ["/bin/sh"],
							Args: ["-c", REDIS_START_SCRIPT],
						}
					: {
							...(command && {
								Command: command.split(" "),
							}),
							...(args &&
								args.length > 0 && {
									Args: args,
								}),
						}),
				...(Ulimits && { Ulimits }),
				Labels: {
					...Labels,
					...buildDokployLabels({
						organizationId: redis.environment.project.organizationId,
						projectId: redis.environment.projectId,
						projectName: redis.environment.project.name,
						environmentId: redis.environmentId,
						environmentName: redis.environment.name,
						applicationId: redis.redisId,
						applicationName: redis.name,
					}),
				},
			},
			Networks: resolvedNetworks,
			RestartPolicy,
			Placement,
			Resources: {
				...resources,
			},
		},
		Mode,
		RollbackConfig,
		EndpointSpec: EndpointSpec
			? EndpointSpec
			: {
					Mode: "dnsrr" as const,
					Ports: externalPort
						? [
								{
									Protocol: "tcp" as const,
									TargetPort: 6379,
									PublishedPort: externalPort,
									PublishMode: "host" as const,
								},
							]
						: [],
				},
		UpdateConfig: redis.updateConfigSwarm ?? {
			Parallelism: 1,
			Order: "stop-first" as const,
			FailureAction: "rollback" as const,
		},
	};

	await createOrUpdateSwarmService({ docker, appName, settings });
};

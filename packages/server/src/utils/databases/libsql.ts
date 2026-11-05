import type { InferResultType } from "@dokploy/server/types/with";
import type { CreateServiceOptions, PortConfig } from "dockerode";
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
import {
	getCustomLibsqlCommand,
	getLibsqlPrimaryUrlProblem,
} from "./libsql-primary-url";

export type LibsqlNested = InferResultType<
	"libsql",
	{
		mounts: true;
		environment: { with: { project: true } };
	}
>;

const PRIMARY_COMMAND =
	"sqld --db-path iku.db --http-listen-addr 0.0.0.0:8080 --grpc-listen-addr 0.0.0.0:5001 --admin-listen-addr 0.0.0.0:5000";

// No --grpc-listen-addr: sqld refuses it together with a primary URL.
// A replica deployed while its primary URL never reached sqld ran as a primary of
// its own, and sqld overwrites such data without a word on its first request after
// reaching the real primary. Only a node that has replicated has client_wal_index.
const REPLICA_COMMAND = `if ls iku.db/dbs/*/data >/dev/null 2>&1 && ! ls iku.db/dbs/*/client_wal_index >/dev/null 2>&1; then
	kept="iku.db.before-replica-$(date +%s)"
	mv iku.db "$kept" || exit 1
	echo "This node's own data is kept in $kept: sqld would overwrite it with the primary's."
fi
exec sqld --db-path iku.db --http-listen-addr 0.0.0.0:8080 --admin-listen-addr 0.0.0.0:5000`;

// These fail here, with the running service left as it is.
const assertReplicaCanConnect = ({
	sqldPrimaryUrl,
	command,
}: Pick<LibsqlNested, "sqldPrimaryUrl" | "command">) => {
	const problem = getLibsqlPrimaryUrlProblem(sqldPrimaryUrl, command);
	if (problem) {
		throw new Error(problem);
	}
	// sqld exits at once, and Swarm rolls the update back.
	if (command?.includes("--grpc-listen-addr")) {
		throw new Error(
			"A libSQL replica cannot listen for gRPC: remove --grpc-listen-addr from the custom command",
		);
	}
};

export const buildLibsql = async (rawLibsql: LibsqlNested) => {
	const libsql = await withResolvedVaultRefs(rawLibsql);
	const {
		appName,
		env,
		externalPort,
		externalGRPCPort,
		externalAdminPort,
		memoryLimit,
		memoryReservation,
		databaseUser,
		databasePassword,
		sqldNode,
		sqldPrimaryUrl,
		cpuLimit,
		cpuReservation,
		command,
		mounts,
		enableNamespaces,
	} = libsql;

	const isReplica = sqldNode === "replica";
	if (isReplica) {
		assertReplicaCanConnect(libsql);
	}

	const basicAuth = Buffer.from(
		`${databaseUser}:${databasePassword}`,
		"utf-8",
	).toString("base64");

	// sqld reads SQLD_PRIMARY_GRPC_URL by itself, so this free text stays out of the
	// shell and a custom command gets it too. Only the image's entrypoint reads
	// SQLD_PRIMARY_URL, and a custom command may refer to it.
	const defaultLibsqlEnv = `SQLD_NODE="${sqldNode}"\nSQLD_HTTP_AUTH="basic:${basicAuth}"${
		env ? `\n${env}` : ""
	}${
		isReplica
			? `\nSQLD_PRIMARY_URL="${sqldPrimaryUrl}"\nSQLD_PRIMARY_GRPC_URL="${sqldPrimaryUrl}"`
			: ""
	}`;

	const resolvedNetworks = await resolveServiceNetworks(libsql);

	const {
		HealthCheck,
		RestartPolicy,
		Placement,
		Labels,
		Mode,
		RollbackConfig,
		UpdateConfig,
	} = generateConfigContainer(libsql);
	const resources = calculateResources({
		memoryLimit,
		memoryReservation,
		cpuLimit,
		cpuReservation,
	});
	const envVariables = prepareEnvironmentVariables(
		defaultLibsqlEnv,
		libsql.environment.project.env,
		libsql.environment.env,
	);
	const volumesMount = generateVolumeMounts(mounts);
	const bindsMount = generateBindMounts(mounts, {
		appName,
		serverId: libsql.serverId,
		serviceType: "libsql",
	});
	const filesMount = generateFileMounts(appName, libsql);

	const docker = await getRemoteDocker(libsql.serverId);

	let finalCommand =
		getCustomLibsqlCommand(command) ??
		(isReplica ? REPLICA_COMMAND : PRIMARY_COMMAND);
	if (enableNamespaces) {
		finalCommand += " --enable-namespaces";
	}

	const settings: CreateServiceOptions = {
		Name: appName,
		TaskTemplate: {
			ContainerSpec: {
				HealthCheck,
				Image: "ghcr.io/tursodatabase/libsql-server:v0.24.32",
				Env: envVariables,
				Mounts: [...volumesMount, ...bindsMount, ...filesMount],
				Command: ["/bin/sh"],
				Args: ["-c", finalCommand],
				Labels: {
					...Labels,
					...buildDokployLabels({
						organizationId: libsql.environment.project.organizationId,
						projectId: libsql.environment.projectId,
						projectName: libsql.environment.project.name,
						environmentId: libsql.environmentId,
						environmentName: libsql.environment.name,
						applicationId: libsql.libsqlId,
						applicationName: libsql.name,
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
		EndpointSpec: {
			Mode: "dnsrr",
			Ports: [
				...(externalPort
					? [
							{
								Protocol: "tcp",
								TargetPort: 8080,
								PublishedPort: externalPort,
								PublishMode: "host",
							} as PortConfig,
						]
					: []),
				...(externalGRPCPort
					? [
							{
								Protocol: "tcp",
								TargetPort: 5001,
								PublishedPort: externalGRPCPort,
								PublishMode: "host",
							} as PortConfig,
						]
					: []),
				...(externalAdminPort
					? [
							{
								Protocol: "tcp",
								TargetPort: 5000,
								PublishedPort: externalAdminPort,
								PublishMode: "host",
							} as PortConfig,
						]
					: []),
			],
		},
		UpdateConfig: libsql.updateConfigSwarm ?? {
			Parallelism: 1,
			Order: "stop-first" as const,
			FailureAction: "rollback" as const,
		},
	};
	await createOrUpdateSwarmService({
		docker,
		appName,
		settings,
		getUpdate: (spec) => spec,
	});
};

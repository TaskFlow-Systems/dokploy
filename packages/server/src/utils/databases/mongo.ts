import type { InferResultType } from "@dokploy/server/types/with";
import type { CreateServiceOptions } from "dockerode";
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

export type MongoNested = InferResultType<
	"mongo",
	{ mounts: true; environment: { with: { project: true } } }
>;

// Runs on every start. The credentials and the member address come from Env, so
// the script holds no value that needs quoting. hello needs no sign-in, and with
// access control on and no user yet, the localhost exception allows rs.initiate
// and the first createUser.
const REPLICA_SET_SETUP = `
const admin = db.getSiblingDB("admin");
const user = process.env.DOKPLOY_DB_USER;
const pwd = process.env.DOKPLOY_DB_PASSWORD;
const roles = [{ role: "root", db: "admin" }];

let signedIn = true;
try {
	admin.auth(user, pwd);
} catch {
	signedIn = false;
}

for (let i = 0; i < 120 && !db.hello().isWritablePrimary; i++) {
	if (!db.hello().setName) {
		try {
			rs.initiate({
				_id: "rs0",
				members: [{ _id: 0, host: process.env.DOKPLOY_REPLICA_MEMBER, priority: 1 }]
			});
		} catch (error) {
			print("[dokploy] rs.initiate: " + error.message);
		}
	}
	sleep(1000);
}
if (!db.hello().isWritablePrimary) {
	throw new Error("this member did not become primary");
}

if (!signedIn) {
	try {
		admin.createUser({ user, pwd, roles });
	} catch (error) {
		const userExists = error.code === 51003;
		if (!userExists) throw error;
		admin.updateUser(user, { pwd, roles });
	}
}
print("[dokploy] Replica set is ready.");
`;

// The key file lives next to the data: a volume backup carries it, and a rebuild
// that drops the volume replaces both. With one member it only has to exist,
// since --replSet with --auth refuses to start without it.
const REPLICA_SET_STARTUP_SCRIPT = `
#!/bin/bash
KEY_FILE=/data/db/.dokploy-keyfile

start_mongod() {
	mongod --port 27017 --replSet rs0 --bind_ip_all "$@" &
	MONGOD_PID=$!
}

stop_mongod() {
	kill -TERM "$MONGOD_PID" 2>/dev/null
	wait "$MONGOD_PID"
}

wait_for_mongod() {
	until mongosh --quiet --eval "db.adminCommand('ping')" > /dev/null 2>&1; do
		kill -0 "$MONGOD_PID" 2>/dev/null || exit 1
		sleep 1
	done
}

create_key_file() {
	rm -f "$KEY_FILE.tmp"
	(umask 077; head -c 756 /dev/urandom | base64 > "$KEY_FILE.tmp")
	chmod 400 "$KEY_FILE.tmp"
	mv "$KEY_FILE.tmp" "$KEY_FILE"
}

set_up_replica_set() {
	mongosh --quiet --eval '${REPLICA_SET_SETUP}'
}

# bash as PID 1 ignores the stop signal unless it traps it, and mongod would then
# be killed at the end of the grace period instead of shutting down.
trap 'stop_mongod; exit 0' TERM INT

if [ ! -f "$KEY_FILE" ]; then
	if [ -e /data/db/WiredTiger ]; then
		# Data from before access control. The stored password was never enforced
		# and may differ from the user's, so one more open start makes the stored
		# credentials valid before the database starts refusing everyone else.
		echo "[dokploy] Turning on access control for this replica set. Clients without credentials are refused from now on."
		start_mongod
		wait_for_mongod
		if set_up_replica_set; then
			mongosh --quiet --eval 'print("[dokploy] Users that keep access, check for unknown ones: " + db.adminCommand({ usersInfo: { forAllDBs: true } }).users.map((u) => u.db + "." + u.user).join(", "))'
			stop_mongod
			create_key_file
		else
			echo "[dokploy] ERROR: could not set up the stored user. Access control stays off, the next deploy tries again."
		fi
	else
		create_key_file
	fi
fi

if [ -f "$KEY_FILE" ]; then
	start_mongod --auth --keyFile "$KEY_FILE"
	wait_for_mongod
	set_up_replica_set || echo "[dokploy] Setup did not finish, see the error above. A rejected sign-in is expected after a password change until the next deploy; otherwise check the stored username and password."
fi
`;

export const buildMongo = async (rawMongo: MongoNested) => {
	const mongo = await withResolvedVaultRefs(rawMongo);
	const {
		appName,
		env,
		externalPort,
		dockerImage,
		memoryLimit,
		memoryReservation,
		cpuLimit,
		cpuReservation,
		databaseUser,
		databasePassword,
		command,
		args,
		mounts,
		replicaSets,
	} = mongo;

	const defaultMongoEnv = `MONGO_INITDB_ROOT_USERNAME="${databaseUser}"\nMONGO_INITDB_ROOT_PASSWORD="${databasePassword}"${replicaSets ? "\nMONGO_INITDB_DATABASE=admin" : ""}${
		env ? `\n${env}` : ""
	}`;

	const resolvedNetworks = await resolveServiceNetworks(mongo);

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
	} = generateConfigContainer(mongo);

	const resources = calculateResources({
		memoryLimit,
		memoryReservation,
		cpuLimit,
		cpuReservation,
	});

	const envVariables = prepareEnvironmentVariables(
		defaultMongoEnv,
		mongo.environment.project.env,
		mongo.environment.env,
	);
	const volumesMount = generateVolumeMounts(mounts);
	const bindsMount = generateBindMounts(mounts, {
		appName,
		serverId: mongo.serverId,
		serviceType: "mongo",
	});
	const filesMount = generateFileMounts(appName, mongo);

	const docker = await getRemoteDocker(mongo.serverId);

	const settings: CreateServiceOptions = {
		Name: appName,
		TaskTemplate: {
			ContainerSpec: {
				HealthCheck,
				Image: dockerImage,
				Env: replicaSets
					? [
							...envVariables,
							`DOKPLOY_DB_USER=${databaseUser}`,
							`DOKPLOY_DB_PASSWORD=${databasePassword}`,
							`DOKPLOY_REPLICA_MEMBER=${appName}:27017`,
						]
					: envVariables,
				Mounts: [...volumesMount, ...bindsMount, ...filesMount],
				...(StopGracePeriod !== null &&
					StopGracePeriod !== undefined && { StopGracePeriod }),
				...(replicaSets
					? {
							Command: ["/bin/bash"],
							Args: [
								"-c",
								`${REPLICA_SET_STARTUP_SCRIPT}\n${command ?? 'wait "$MONGOD_PID"'}`,
							],
						}
					: {}),
				...(command &&
					!replicaSets && {
						Command: command.split(" "),
					}),
				...(args &&
					args.length > 0 &&
					!replicaSets && {
						Args: args,
					}),
				...(Ulimits && { Ulimits }),
				Labels: {
					...Labels,
					...buildDokployLabels({
						organizationId: mongo.environment.project.organizationId,
						projectId: mongo.environment.projectId,
						projectName: mongo.environment.project.name,
						environmentId: mongo.environmentId,
						environmentName: mongo.environment.name,
						applicationId: mongo.mongoId,
						applicationName: mongo.name,
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
									TargetPort: 27017,
									PublishedPort: externalPort,
									PublishMode: "host" as const,
								},
							]
						: [],
				},
		UpdateConfig: mongo.updateConfigSwarm ?? {
			Parallelism: 1,
			Order: "stop-first" as const,
			FailureAction: "rollback" as const,
		},
	};

	await createOrUpdateSwarmService({ docker, appName, settings });
};

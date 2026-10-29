import { getDokployVersionData, getUpdateData } from "../services/settings";
import { execAsync } from "../utils/process/execAsync";
import { spawnAsync } from "../utils/process/spawnAsync";
import { PINNED_VERSIONS } from "./component-versions";
import {
	buildHostStackRows,
	HOST_STACK_UI_COMPONENTS,
	type HostStackRow,
	type HostStackUiComponent,
} from "./host-stack-rows";
import {
	buildComponentUpdateSteps,
	wrapComponentUpdateSteps,
} from "./server-components";

const REDIS_IMAGE = `redis:${PINNED_VERSIONS.redis}`;

const UPDATE_CHECK_TIMEOUT_MS = 15_000;

const readCommand = async (command: string) => {
	try {
		const { stdout } = await execAsync(command);
		return stdout.trim() || null;
	} catch {
		return null;
	}
};

const checkPanelUpdate = async (currentVersion: string) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), UPDATE_CHECK_TIMEOUT_MS);
	});
	try {
		return await Promise.race([
			getUpdateData(currentVersion).catch(() => null),
			timeout,
		]);
	} finally {
		clearTimeout(timer);
	}
};

export const readHostDockerVersion = () =>
	readCommand("docker version --format '{{.Server.Version}}'");

export const readHostStackRows = async (
	currentVersion: string,
): Promise<HostStackRow[]> => {
	const [docker, traefikImage, postgresImage, redisImage, update] =
		await Promise.all([
			readHostDockerVersion(),
			readCommand("docker inspect -f '{{.Config.Image}}' dokploy-traefik"),
			readCommand(
				"docker service inspect dokploy-postgres --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'",
			),
			readCommand(
				"docker service inspect dokploy-redis --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'",
			),
			checkPanelUpdate(currentVersion),
		]);

	return buildHostStackRows({
		docker,
		traefikImage,
		postgresImage,
		redisImage,
		panel: {
			installed: getDokployVersionData(currentVersion).forkVersion,
			latest: update?.latestVersion ?? null,
			updateAvailable: update?.latestVersion ? update.updateAvailable : null,
		},
	});
};

const redisPullStep = () => `
redis_image="${REDIS_IMAGE}"
redis_pull() {
	local attempt=1
	while [ "$attempt" -le 3 ]; do
		if $SUDO_CMD docker pull "$redis_image"; then
			return 0
		fi
		attempt=$((attempt + 1))
		sleep 5
	done
	return 1
}
echo "Downloading $redis_image before anything is changed"
if ! redis_pull; then
	echo "Pre-download failed: $redis_image. Nothing was changed." >&2
	exit 1
fi
`;

const redisServiceStep = () => `
echo "Updating Redis to ${PINNED_VERSIONS.redis}"
redis_timeout="\${DOKPLOY_REDIS_TIMEOUT:-240}"
redis_previous_image="$($SUDO_CMD docker service inspect dokploy-redis --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null || true)"
redis_previous_index="$($SUDO_CMD docker service inspect dokploy-redis --format '{{.Version.Index}}' 2>/dev/null || true)"
redis_update_needed=1
if [ "\${redis_previous_image%%@*}" = "$redis_image" ]; then
	redis_update_needed=0
	echo "Redis already runs $redis_image"
elif ! $SUDO_CMD docker service update --detach --update-order stop-first --update-failure-action rollback --image "$redis_image" dokploy-redis >/dev/null; then
	echo "Error: docker service update was refused for dokploy-redis. Redis was not changed." >&2
	exit 1
fi
redis_ready() {
	local container=""
	container="$($SUDO_CMD docker ps -q --no-trunc --filter label=com.docker.swarm.service.name=dokploy-redis --filter status=running --filter "ancestor=$redis_image" | head -n1)"
	[ -n "$container" ] && [ "$($SUDO_CMD docker exec "$container" redis-cli ping 2>/dev/null)" = "PONG" ]
}
redis_settled() {
	if [ "$redis_update_needed" = 1 ]; then
		[ "\${redis_index:-0}" -gt "\${redis_previous_index:-0}" ] && [ "$redis_state" = "completed" ] || return 1
	fi
	redis_ready
}
redis_deadline=$(( $(date +%s) + $redis_timeout ))
while :; do
	redis_index="$($SUDO_CMD docker service inspect dokploy-redis --format '{{.Version.Index}}' 2>/dev/null || true)"
	redis_state="$($SUDO_CMD docker service inspect dokploy-redis --format '{{.UpdateStatus.State}}' 2>/dev/null || true)"
	if [ "$redis_update_needed" = 1 ] && [ "\${redis_index:-0}" -gt "\${redis_previous_index:-0}" ]; then
		case "$redis_state" in
			rollback_*)
				echo "Error: dokploy-redis did not start on $redis_image (swarm state: $redis_state). Previous image: $redis_previous_image." >&2
				exit 1
				;;
			paused)
				echo "Error: dokploy-redis is paused after its update to $redis_image. Previous image: $redis_previous_image." >&2
				exit 1
				;;
		esac
	fi
	if redis_settled; then
		break
	fi
	if [ "$(date +%s)" -ge "$redis_deadline" ]; then
		echo "Error: dokploy-redis was not ready on $redis_image within $redis_timeout seconds: the update did not finish or redis-cli ping did not return PONG. Previous image: $redis_previous_image. Check with: docker service ps dokploy-redis --no-trunc" >&2
		exit 1
	fi
	sleep 2
done
echo "Redis version ${PINNED_VERSIONS.redis} installed ✅"
`;

const hostStackSteps = (components: HostStackUiComponent[]) => {
	const selected = HOST_STACK_UI_COMPONENTS.filter((component) =>
		components.includes(component),
	);
	const steps: string[] = [];
	if (selected.includes("redis")) {
		steps.push(redisPullStep());
	}
	if (selected.includes("traefik")) {
		steps.push(buildComponentUpdateSteps(["traefik"]));
	}
	if (selected.includes("redis")) {
		steps.push(redisServiceStep());
	}
	return steps.join("\n");
};

export const buildHostStackUpdateScript = (
	components: HostStackUiComponent[],
) => wrapComponentUpdateSteps(hostStackSteps(components));

// Callers hold the lock from acquireHostStackUpdateLock for the whole run.
export const updateHostStackComponents = async (
	components: HostStackUiComponent[],
	onData?: (data: string) => void,
) => {
	try {
		await spawnAsync(
			"bash",
			["-c", buildHostStackUpdateScript(components)],
			onData,
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		throw new Error(
			typeof code === "number"
				? `Panel host update failed with exit code ${code}`
				: `Panel host update could not start: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
};

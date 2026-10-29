import {
	appendFile,
	chmod,
	mkdir,
	readFile,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawnAsync } from "../utils/process/spawnAsync";
import { PINNED_VERSIONS } from "./component-versions";
import { buildDockerEngineUpgradeSteps } from "./server-components";

// The panel and the host share /etc/dokploy, so the panel writes the script and
// reads its log and status here while the script itself runs on the host.
export const HOST_UPDATES_DIR = "/etc/dokploy/host-updates";
export const DOCKER_UPGRADE_UNIT = "dokploy-docker-engine-upgrade";

const SCRIPT_NAME = "docker-engine-upgrade.sh";
const LOG_NAME = "docker-engine-upgrade.log";
const STATUS_NAME = "docker-engine-upgrade.json";
const LOG_TAIL_BYTES = 64 * 1024;
// The longest silent stretch of a run is the health wait after the restart and
// the same wait after a rollback; a run quiet for longer than this has died.
const STALE_AFTER_MS = 30 * 60 * 1000;

export type HostDockerUpgradeState =
	| "starting"
	| "running"
	| "succeeded"
	| "failed"
	| "interrupted";

export type HostDockerUpgradeStatus = {
	state: HostDockerUpgradeState;
	from: string | null;
	to: string;
	startedAt: string;
	finishedAt: string | null;
	exitCode: number | null;
	log: string;
};

type StoredStatus = Omit<HostDockerUpgradeStatus, "log">;

const STATES: readonly HostDockerUpgradeState[] = [
	"starting",
	"running",
	"succeeded",
	"failed",
	"interrupted",
];

export const isHostDockerUpgradeActive = (
	status: Pick<HostDockerUpgradeStatus, "state"> | null,
) => status?.state === "starting" || status?.state === "running";

const filesIn = (dir: string) => ({
	script: path.join(dir, SCRIPT_NAME),
	log: path.join(dir, LOG_NAME),
	status: path.join(dir, STATUS_NAME),
});

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const HOST_READY_CHECK = `
	DOCKER_NOT_READY="this node is not an active swarm node"
	[ "$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)" = "active" ] || return 1
	local service="" container="" health=""
	for service in dokploy dokploy-postgres dokploy-redis; do
		DOCKER_NOT_READY="$service has no running task"
		container="$(docker ps -q --no-trunc --filter "label=com.docker.swarm.service.name=$service" --filter status=running | head -n1)"
		[ -n "$container" ] || return 1
		case "$service" in
			dokploy)
				health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null)"
				DOCKER_NOT_READY="the panel container is \${health:-not inspectable}"
				case "$health" in
					healthy | none) ;;
					*) return 1 ;;
				esac
				;;
			dokploy-postgres)
				DOCKER_NOT_READY="Postgres does not accept connections"
				docker exec "$container" pg_isready -U dokploy -d dokploy >/dev/null 2>&1 || return 1
				;;
			dokploy-redis)
				DOCKER_NOT_READY="Redis does not answer PING"
				[ "$(docker exec "$container" redis-cli ping 2>/dev/null)" = "PONG" ] || return 1
				;;
		esac
	done
	DOCKER_NOT_READY=""`;

export const buildHostDockerUpgradeScript = (dir = HOST_UPDATES_DIR) => {
	const files = filesIn(dir);
	return `#!/usr/bin/env bash
# Runs on the panel host as a transient systemd unit, outside Docker, so the
# daemon restart below does not stop it the way it stops the panel.
STATUS_FILE=${shellQuote(files.status)}
LOG_FILE=${shellQuote(files.log)}
TARGET_VERSION=${shellQuote(PINNED_VERSIONS.docker)}
exec >>"$LOG_FILE" 2>&1
export DEBIAN_FRONTEND=noninteractive
# needrestart would otherwise restart unrelated host services after apt-get.
export NEEDRESTART_MODE=l
DOKPLOY_DOCKER_VERIFY_TIMEOUT="\${DOKPLOY_DOCKER_VERIFY_TIMEOUT:-300}"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
previous_version="$(docker version --format '{{.Server.Version}}' 2>/dev/null | tr -cd '0-9A-Za-z.+~-' || true)"
write_status() {
	local finished="null" from="null"
	if [ -n "$3" ]; then
		finished="\\"$3\\""
	fi
	if [ -n "$previous_version" ]; then
		from="\\"$previous_version\\""
	fi
	printf '{"state":"%s","from":%s,"to":"%s","startedAt":"%s","finishedAt":%s,"exitCode":%s}\\n' "$1" "$from" "$TARGET_VERSION" "$started_at" "$finished" "$2" >"$STATUS_FILE.tmp" && mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}
finish_status() {
	local code=$?
	if [ "$code" = 0 ]; then
		write_status succeeded 0 "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	else
		write_status failed "$code" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	fi
}
write_status running null ""
trap finish_status EXIT
echo "Docker Engine upgrade started on the host at $started_at: \${previous_version:-unknown} -> $TARGET_VERSION"
set -e
SUDO_CMD=""
${buildDockerEngineUpgradeSteps(HOST_READY_CHECK)}
echo "Docker Engine upgrade finished ✅"
`;
};

// Runs inside a one-off privileged container that enters the host's
// namespaces, so systemd-run starts the script as a host unit that outlives
// both that container and the Docker daemon restart.
export const buildDockerUpgradeLauncherArgs = (
	image: string,
	dir = HOST_UPDATES_DIR,
) => {
	const script = filesIn(dir).script;
	const hostCommand = [
		`[ -f ${shellQuote(script)} ] || { echo "The upgrade script is not on the host at ${script}: the panel's /etc/dokploy is not mounted from the host." >&2; exit 4; }`,
		`[ -d /run/systemd/system ] && command -v systemd-run >/dev/null 2>&1 || { echo "This host does not run systemd, so the upgrade cannot run outside Docker from the panel." >&2; exit 3; }`,
		`exec systemd-run --quiet --collect --unit=${DOCKER_UPGRADE_UNIT} --description="Dokploy Docker Engine upgrade" /bin/bash ${shellQuote(script)}`,
	].join("\n");
	return [
		"run",
		"--rm",
		"--pull=never",
		"--privileged",
		"--pid=host",
		"--network=host",
		"--user=0:0",
		"--label=com.dokploy.host-update=docker-engine",
		"--entrypoint=nsenter",
		image,
		"--target=1",
		"--mount",
		"--uts",
		"--ipc",
		"--net",
		"--pid",
		"--",
		"/bin/sh",
		"-c",
		hostCommand,
	];
};

const parseStoredStatus = (raw: string): StoredStatus | null => {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const state = STATES.find((candidate) => candidate === record.state);
	if (!state || typeof record.to !== "string") {
		return null;
	}
	return {
		state,
		from: typeof record.from === "string" ? record.from : null,
		to: record.to,
		startedAt: typeof record.startedAt === "string" ? record.startedAt : "",
		finishedAt:
			typeof record.finishedAt === "string" ? record.finishedAt : null,
		exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
	};
};

const readIfExists = async (file: string) => {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
};

const lastModified = async (file: string) => {
	try {
		return (await stat(file)).mtimeMs;
	} catch {
		return 0;
	}
};

const writeStoredStatus = async (dir: string, status: StoredStatus) => {
	const file = filesIn(dir).status;
	await writeFile(`${file}.tmp`, `${JSON.stringify(status)}\n`, {
		mode: 0o600,
	});
	await rename(`${file}.tmp`, file);
};

export const readHostDockerUpgradeStatus = async (
	dir = HOST_UPDATES_DIR,
	now = Date.now(),
): Promise<HostDockerUpgradeStatus | null> => {
	const files = filesIn(dir);
	const raw = await readIfExists(files.status);
	const stored = raw === null ? null : parseStoredStatus(raw);
	if (!stored) {
		return null;
	}
	const log = (await readIfExists(files.log)) ?? "";
	const status: HostDockerUpgradeStatus = {
		...stored,
		log: log.length > LOG_TAIL_BYTES ? log.slice(-LOG_TAIL_BYTES) : log,
	};
	if (isHostDockerUpgradeActive(status)) {
		const touched = Math.max(
			await lastModified(files.status),
			await lastModified(files.log),
		);
		if (now - touched > STALE_AFTER_MS) {
			return { ...status, state: "interrupted" };
		}
	}
	return status;
};

const readPanelImage = async () => {
	const output = await spawnAsync("docker", [
		"service",
		"inspect",
		"dokploy",
		"--format",
		"{{.Spec.TaskTemplate.ContainerSpec.Image}}",
	]);
	const image = output.toString().trim();
	if (!image) {
		throw new Error("The image of the dokploy service could not be read.");
	}
	return image;
};

const errorText = (error: unknown) => {
	const stderr = (error as { stderr?: { toString(): string } }).stderr;
	const text = stderr?.toString().trim();
	if (text) {
		return text;
	}
	return error instanceof Error ? error.message : String(error);
};

// Callers check that no run is active and hold the host-stack lock until this
// returns; the run itself goes on in the host unit after that.
export const startHostDockerUpgrade = async (
	from: string | null,
	{
		dir = HOST_UPDATES_DIR,
		readImage = readPanelImage,
		launch = (args: string[]) => spawnAsync("docker", args),
	}: {
		dir?: string;
		readImage?: () => Promise<string>;
		launch?: (args: string[]) => Promise<unknown>;
	} = {},
) => {
	const files = filesIn(dir);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await writeFile(files.script, buildHostDockerUpgradeScript(dir), {
		mode: 0o700,
	});
	await chmod(files.script, 0o700);
	const startedAt = new Date().toISOString();
	await writeFile(
		files.log,
		`Starting the Docker Engine upgrade to ${PINNED_VERSIONS.docker} from the panel at ${startedAt}\n`,
		{ mode: 0o600 },
	);
	const starting: StoredStatus = {
		state: "starting",
		from,
		to: PINNED_VERSIONS.docker,
		startedAt,
		finishedAt: null,
		exitCode: null,
	};
	await writeStoredStatus(dir, starting);
	try {
		const image = await readImage();
		await launch(buildDockerUpgradeLauncherArgs(image, dir));
	} catch (error) {
		const message = `The upgrade could not start on the host: ${errorText(error)}`;
		await appendFile(files.log, `Error: ${message}\nNothing was changed.\n`);
		await writeStoredStatus(dir, {
			...starting,
			state: "failed",
			finishedAt: new Date().toISOString(),
		});
		throw new Error(message);
	}
};

import { PINNED_VERSIONS } from "./component-versions";
import { rcloneInstallCommand } from "./server-setup";
import { runSshCommand } from "./ssh-command";
import {
	buildTraefikCreateWithImage,
	buildTraefikTlsMigrationStep,
	TRAEFIK_VERSION,
} from "./traefik-setup";

export const COMPONENT_NAMES = [
	"docker",
	"traefik",
	"nixpacks",
	"railpack",
	"buildpacks",
	"rclone",
] as const;

export type ComponentName = (typeof COMPONENT_NAMES)[number];

export const UPDATABLE_COMPONENTS = [
	"docker",
	"traefik",
	"rclone",
	"nixpacks",
	"railpack",
	"buildpacks",
] as const;

export type UpdatableComponent = (typeof UPDATABLE_COMPONENTS)[number];

export const COMPONENTS_UPDATE_DONE = "Components update finished ✅";
export const COMPONENTS_UPDATE_FAILED = "Components update failed ❌";

const componentTargets: Record<ComponentName, string | null> = {
	docker: PINNED_VERSIONS.docker,
	traefik: TRAEFIK_VERSION,
	nixpacks: PINNED_VERSIONS.nixpacks,
	railpack: PINNED_VERSIONS.railpack,
	buildpacks: PINNED_VERSIONS.buildpacks,
	rclone: PINNED_VERSIONS.rclone,
};

export const COMPONENT_CHECK_SCRIPT = `
if [ "$(id -u)" -eq 0 ]; then SUDO_CMD=""; else SUDO_CMD="sudo"; fi
echo "docker=$($SUDO_CMD docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
echo "traefik=$($SUDO_CMD docker inspect -f '{{.Config.Image}}' dokploy-traefik 2>/dev/null || true)"
echo "nixpacks=$(nixpacks --version 2>/dev/null || true)"
echo "railpack=$(railpack --version 2>/dev/null || true)"
echo "buildpacks=$(pack --version 2>/dev/null || true)"
echo "rclone=$(rclone --version 2>/dev/null | head -n 1 || true)"
`;

const SEMVER = /\d+\.\d+\.\d+/;

const isComponentName = (value: string): value is ComponentName =>
	(COMPONENT_NAMES as readonly string[]).includes(value);

export const parseComponentVersions = (output: string) => {
	const versions: Partial<Record<ComponentName, string | null>> = {};
	for (const line of output.split("\n")) {
		const separator = line.indexOf("=");
		if (separator < 0) {
			continue;
		}
		const name = line.slice(0, separator).trim();
		if (!isComponentName(name)) {
			continue;
		}
		versions[name] = line.slice(separator + 1).match(SEMVER)?.[0] ?? null;
	}
	return versions;
};

export type ComponentStatus = {
	name: ComponentName;
	installed: string | null;
	target: string | null;
	outdated: boolean;
};

export const buildComponentStatuses = (
	installed: Partial<Record<ComponentName, string | null>>,
): ComponentStatus[] =>
	COMPONENT_NAMES.map((name) => {
		const current = installed[name] ?? null;
		const target = componentTargets[name];
		return {
			name,
			installed: current,
			target,
			outdated: target !== null && current !== target,
		};
	});

export const DOCKER_UPGRADE_SKIPPED_MESSAGE =
	"Docker Engine not upgraded: it restarts every container on this server. Enable it explicitly to upgrade.";

export const filterDockerUpgrade = (
	components: UpdatableComponent[],
	upgradeDocker: boolean,
) => {
	if (upgradeDocker || !components.includes("docker")) {
		return { components, skippedDocker: false };
	}
	return {
		components: components.filter((component) => component !== "docker"),
		skippedDocker: true,
	};
};

const dockerVersionPattern = PINNED_VERSIONS.docker.replace(/\./g, "\\.");

const dockerHelpers = () => `
DOKPLOY_BACKUP_DIR="\${DOKPLOY_BACKUP_DIR:-/var/backups/dokploy}"
DOKPLOY_OS_RELEASE="\${DOKPLOY_OS_RELEASE:-/etc/os-release}"
DOKPLOY_APT_SOURCES_DIR="\${DOKPLOY_APT_SOURCES_DIR:-/etc/apt/sources.list.d}"
DOKPLOY_DOCKER_KEYRING="\${DOKPLOY_DOCKER_KEYRING:-/etc/apt/keyrings/docker.asc}"
DOCKER_SKIPPED=0
DOCKER_SKIP_REASON=""
DOCKER_PACKAGE_VERSION=""
DOCKER_ROLLBACK_DIR=""
DOCKER_KEY_WRITTEN=0
DOCKER_SOURCE_WRITTEN=0
DOCKER_KEYDIR_CREATED=0
DOCKER_ROLLBACK_DIR_CREATED=0

docker_skip() {
	DOCKER_SKIPPED=1
	DOCKER_SKIP_REASON="$1"
}

docker_installed_version() {
	if [ "$(dpkg-query -W -f='\${db:Status-Status}' "$1" 2>/dev/null)" = "installed" ]; then
		dpkg-query -W -f='\${Version}' "$1"
	fi
}

docker_candidate_version() {
	apt-cache policy "$1" 2>/dev/null | awk '/^  Candidate:/ { print $2; exit }'
}

docker_repo_codenames() {
	local file=""
	for file in "$DOKPLOY_APT_SOURCES_DIR"/*.list; do
		[ -f "$file" ] || continue
		awk '/download\\.docker\\.com/ && !/^[[:space:]]*#/ { for (i = 2; i < NF; i++) if ($i ~ /download\\.docker\\.com/) { print $(i + 1); break } }' "$file"
	done
	for file in "$DOKPLOY_APT_SOURCES_DIR"/*.sources; do
		[ -f "$file" ] || continue
		awk 'BEGIN { RS = ""; FS = "\\n" } /download\\.docker\\.com/ { for (i = 1; i <= NF; i++) if ($i ~ /^Suites:/) { split($i, suite, /[ \\t]+/); print suite[2] } }' "$file"
	done
}

docker_check_repo_codename() {
	local repo_codenames="" repo_codename="" host_codename=""
	repo_codenames="$(docker_repo_codenames)"
	if [ -z "$repo_codenames" ]; then
		return 0
	fi
	host_codename="$( (. "$DOKPLOY_OS_RELEASE" && printf '%s' "\${VERSION_CODENAME:-}") 2>/dev/null || true)"
	for repo_codename in $repo_codenames; do
		if [ -z "$host_codename" ] || [ "$repo_codename" != "$host_codename" ]; then
			docker_skip "the Docker apt repository in $DOKPLOY_APT_SOURCES_DIR is for $repo_codename, but this host runs \${host_codename:-an unknown release}; fix that source file yourself and run the update again"
			return 1
		fi
	done
	return 0
}

docker_pinned_candidate() {
	apt-cache madison docker-ce | awk -F'|' '{ gsub(/ /, "", $2); print $2 }' | grep -m1 -E '^([0-9]+:)?${dockerVersionPattern}-' || true
}

docker_undo_repo() {
	if [ "$DOCKER_SOURCE_WRITTEN" = 1 ]; then
		$SUDO_CMD rm -f "$DOKPLOY_APT_SOURCES_DIR/docker.list" || true
		DOCKER_SOURCE_WRITTEN=0
	fi
	if [ "$DOCKER_KEY_WRITTEN" = 1 ]; then
		$SUDO_CMD rm -f "$DOKPLOY_DOCKER_KEYRING" || true
		DOCKER_KEY_WRITTEN=0
	fi
	if [ "$DOCKER_KEYDIR_CREATED" = 1 ]; then
		$SUDO_CMD rmdir "$(dirname "$DOKPLOY_DOCKER_KEYRING")" 2>/dev/null || true
		DOCKER_KEYDIR_CREATED=0
	fi
}

docker_remove_rollback_dir() {
	if [ "$DOCKER_ROLLBACK_DIR_CREATED" = 1 ]; then
		$SUDO_CMD rm -rf "$DOCKER_ROLLBACK_DIR" || true
		DOCKER_ROLLBACK_DIR_CREATED=0
	fi
}

docker_add_apt_repository() {
	local id="" codename="" arch="" key=""
	if [ -n "$(docker_repo_codenames)" ] || [ -e "$DOKPLOY_APT_SOURCES_DIR/docker.list" ]; then
		docker_skip "Docker ${PINNED_VERSIONS.docker} is not offered by the Docker apt repository configured on this host"
		return 1
	fi
	id="$( (. "$DOKPLOY_OS_RELEASE" && printf '%s' "\${ID:-}") 2>/dev/null || true)"
	codename="$( (. "$DOKPLOY_OS_RELEASE" && printf '%s' "\${VERSION_CODENAME:-}") 2>/dev/null || true)"
	case "$id" in
		ubuntu | debian) ;;
		*)
			docker_skip "Docker ${PINNED_VERSIONS.docker} is not in the apt sources, and Docker's repository is only added automatically on ubuntu and debian (this host is '$id')"
			return 1
			;;
	esac
	if [ -z "$codename" ]; then
		docker_skip "VERSION_CODENAME is not set in $DOKPLOY_OS_RELEASE, so Docker's repository cannot be added"
		return 1
	fi
	if [ ! -e "$DOKPLOY_DOCKER_KEYRING" ]; then
		if [ ! -d "$(dirname "$DOKPLOY_DOCKER_KEYRING")" ]; then
			DOCKER_KEYDIR_CREATED=1
		fi
		if ! key="$(mktemp)"; then
			docker_undo_repo
			docker_skip "a temporary file for Docker's apt key could not be created"
			return 1
		fi
		if ! download_with_retry curl -fsSL "https://download.docker.com/linux/$id/gpg" -o "$key"; then
			rm -f "$key"
			docker_undo_repo
			docker_skip "Docker's apt key could not be downloaded"
			return 1
		fi
		DOCKER_KEY_WRITTEN=1
		if ! $SUDO_CMD install -d -m 0755 "$(dirname "$DOKPLOY_DOCKER_KEYRING")" || ! $SUDO_CMD install -m 0644 "$key" "$DOKPLOY_DOCKER_KEYRING"; then
			rm -f "$key"
			docker_undo_repo
			docker_skip "Docker's apt key could not be installed"
			return 1
		fi
		rm -f "$key"
	fi
	if ! arch="$(dpkg --print-architecture)"; then
		docker_undo_repo
		docker_skip "the architecture could not be read for Docker's apt source"
		return 1
	fi
	DOCKER_SOURCE_WRITTEN=1
	if ! printf 'deb [arch=%s signed-by=%s] https://download.docker.com/linux/%s %s stable\\n' "$arch" "$DOKPLOY_DOCKER_KEYRING" "$id" "$codename" | $SUDO_CMD tee "$DOKPLOY_APT_SOURCES_DIR/docker.list" >/dev/null; then
		docker_undo_repo
		docker_skip "Docker's apt source could not be written"
		return 1
	fi
	return 0
}

docker_save_rollback_packages() {
	local package="" installed="" candidate=""
	if [ -z "$(docker_installed_version docker-ce)" ]; then
		docker_skip "docker-ce is not installed, so there is no Docker Engine to roll back to"
		return 1
	fi
	DOCKER_ROLLBACK_DIR="$DOKPLOY_BACKUP_DIR/docker-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
	if ! $SUDO_CMD mkdir -p "$DOKPLOY_BACKUP_DIR" || ! $SUDO_CMD chmod 700 "$DOKPLOY_BACKUP_DIR" || ! $SUDO_CMD sh -c 'umask 077 && mkdir "$1"' sh "$DOCKER_ROLLBACK_DIR"; then
		docker_skip "the current Docker packages could not be saved for rollback"
		return 1
	fi
	DOCKER_ROLLBACK_DIR_CREATED=1
	for package in docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras; do
		installed="$(docker_installed_version "$package")"
		if [ -z "$installed" ]; then
			continue
		fi
		case "$package" in
			docker-ce | docker-ce-cli) ;;
			*)
				candidate="$(docker_candidate_version "$package")"
				if [ "$candidate" = "$installed" ]; then
					continue
				fi
				;;
		esac
		if ! $SUDO_CMD sh -c 'umask 077 && cd "$1" && apt-get download "$2" >/dev/null' sh "$DOCKER_ROLLBACK_DIR" "$package=$installed"; then
			docker_skip "the current Docker packages could not be saved for rollback"
			return 1
		fi
	done
	return 0
}

docker_prepare_apt() {
	if ! $SUDO_CMD apt-get update -qq; then
		abort_before_change "Pre-download failed: the apt package lists could not be refreshed."
	fi
	DOCKER_PACKAGE_VERSION="$(docker_pinned_candidate)"
	if [ -z "$DOCKER_PACKAGE_VERSION" ]; then
		if ! docker_add_apt_repository; then
			return 1
		fi
		if ! $SUDO_CMD apt-get update -qq; then
			docker_undo_repo
			docker_skip "the apt package lists could not be refreshed after adding Docker's repository"
			return 1
		fi
		DOCKER_PACKAGE_VERSION="$(docker_pinned_candidate)"
		if [ -z "$DOCKER_PACKAGE_VERSION" ]; then
			docker_undo_repo
			docker_skip "Docker ${PINNED_VERSIONS.docker} is not in the apt sources, even after adding Docker's repository"
			return 1
		fi
	fi
	if ! docker_save_rollback_packages; then
		docker_undo_repo
		return 1
	fi
	if ! download_with_retry $SUDO_CMD apt-get install -y -qq --download-only "docker-ce=$DOCKER_PACKAGE_VERSION" "docker-ce-cli=$DOCKER_PACKAGE_VERSION" containerd.io docker-buildx-plugin docker-compose-plugin; then
		docker_undo_repo
		docker_remove_rollback_dir
		abort_before_change "Pre-download failed: the Docker packages."
	fi
	return 0
}

docker_ready_on() {
	[ "$($SUDO_CMD docker version --format '{{.Server.Version}}' 2>/dev/null)" = "$1" ] || return 1
	if [ "$2" = 1 ]; then
		[ "$($SUDO_CMD docker inspect -f '{{.State.Running}}' dokploy-traefik 2>/dev/null)" = "true" ] || return 1
	fi
}

docker_wait_ready() {
	local attempt=0
	until docker_ready_on "$1" "$2"; do
		attempt=$((attempt + 1))
		if [ "$attempt" -ge 30 ]; then
			return 1
		fi
		sleep 1
	done
}

docker_roll_back() {
	local previous="$1"
	local traefik_existed="$2"
	echo "Rolling Docker back to $previous from $DOCKER_ROLLBACK_DIR" >&2
	if $SUDO_CMD sh -c 'apt-get install -y --allow-downgrades --no-download "$1"/*.deb' sh "$DOCKER_ROLLBACK_DIR"; then
		if ! $SUDO_CMD docker info >/dev/null 2>&1; then
			$SUDO_CMD systemctl start docker >/dev/null 2>&1 || true
		fi
		if [ "$traefik_existed" = 1 ]; then
			$SUDO_CMD docker update --restart always dokploy-traefik >/dev/null 2>&1 || true
		fi
		if [ "$traefik_existed" = 1 ] && [ "$($SUDO_CMD docker inspect -f '{{.State.Running}}' dokploy-traefik 2>/dev/null)" != "true" ]; then
			$SUDO_CMD docker start dokploy-traefik >/dev/null 2>&1 || true
		fi
		if docker_wait_ready "$previous" "$traefik_existed"; then
			echo "Docker was rolled back to $previous. The packages it used are in $DOCKER_ROLLBACK_DIR." >&2
			exit 1
		fi
	fi
	echo "Error: the Docker rollback did not finish. Finish it by hand (the Engine should report $previous):" >&2
	echo "  apt-get install -y --allow-downgrades --no-download $DOCKER_ROLLBACK_DIR/*.deb" >&2
	echo "  systemctl start docker" >&2
	echo "  docker start dokploy-traefik" >&2
	echo "  docker version --format '{{.Server.Version}}'" >&2
	exit 1
}

docker_update_from_apt() {
	local previous="" traefik_existed=0
	previous="$($SUDO_CMD docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
	if $SUDO_CMD docker inspect dokploy-traefik >/dev/null 2>&1; then
		traefik_existed=1
	fi
	if ! $SUDO_CMD apt-get install -y --no-download "docker-ce=$DOCKER_PACKAGE_VERSION" "docker-ce-cli=$DOCKER_PACKAGE_VERSION" containerd.io docker-buildx-plugin docker-compose-plugin; then
		echo "Error: installing the pre-downloaded Docker packages failed." >&2
		docker_roll_back "$previous" "$traefik_existed"
	fi
	if ! docker_wait_ready "${PINNED_VERSIONS.docker}" "$traefik_existed"; then
		echo "Error: Docker ${PINNED_VERSIONS.docker} did not come up healthy after the install." >&2
		docker_roll_back "$previous" "$traefik_existed"
	fi
}
`;

const dockerPredownload = () => `
if ! command -v apt-get >/dev/null 2>&1; then
	docker_skip "this host has no apt-get, so the Docker packages cannot be pre-downloaded or rolled back"
elif docker_check_repo_codename; then
	docker_prepare_apt || true
fi
if [ "$DOCKER_SKIPPED" = 1 ]; then
	docker_remove_rollback_dir
fi
`;

// Runs before any step: a failed download stops the update while nothing
// running has been touched. Only Docker and Traefik replace running services;
// the other components are plain binaries with no running state to protect.
const predownloadGate = (components: UpdatableComponent[]) => {
	const downloads: string[] = [];
	if (components.includes("traefik")) {
		downloads.push(
			`download_with_retry $SUDO_CMD docker pull traefik:v${TRAEFIK_VERSION} || abort_before_change "Pre-download failed: traefik:v${TRAEFIK_VERSION}."`,
		);
	}
	if (components.includes("docker")) {
		downloads.push(dockerPredownload());
	}
	if (downloads.length === 0) {
		return "";
	}
	return `
abort_before_change() {
	echo "$1 Nothing was changed." >&2
	exit 1
}
download_with_retry() {
	local attempt=1
	while [ "$attempt" -le 3 ]; do
		if "$@"; then
			return 0
		fi
		attempt=$((attempt + 1))
		sleep 5
	done
	return 1
}
${components.includes("docker") ? dockerHelpers() : ""}
echo "Downloading update artifacts before anything is changed"
${downloads.join("\n")}
`;
};

const updateStepFor = (component: UpdatableComponent) => {
	switch (component) {
		case "docker":
			return `
if [ "$DOCKER_SKIPPED" = 1 ]; then
	echo "Docker not updated: $DOCKER_SKIP_REASON. The other components continue."
else
	echo "Updating Docker to ${PINNED_VERSIONS.docker}"
	docker_update_from_apt
	echo "Docker version ${PINNED_VERSIONS.docker} installed ✅"
fi
`;
		case "rclone":
			return `
${rcloneInstallCommand()}
`;
		case "traefik":
			return `
echo "Updating Traefik to ${TRAEFIK_VERSION}"
traefik_existed=0
traefik_old_stopped=0
traefik_old_image=""
traefik_extra_networks=""
traefik_acme_backup=""
traefik_tls_converted=""
if $SUDO_CMD docker inspect dokploy-traefik >/dev/null 2>&1; then
	traefik_existed=1
	traefik_old_image="$($SUDO_CMD docker inspect -f '{{.Config.Image}}' dokploy-traefik 2>/dev/null || true)"
	traefik_extra_networks="$($SUDO_CMD docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' dokploy-traefik 2>/dev/null || true)"
fi
traefik_keep_bridge=1
if [ "$traefik_existed" = 1 ] && ! echo " $traefik_extra_networks " | grep -q " bridge "; then
	traefik_keep_bridge=0
fi
traefik_create() {
${buildTraefikCreateWithImage('"$1"')}
}
traefik_connect() {
	$SUDO_CMD docker network connect dokploy-network dokploy-traefik || return 1
	local traefik_network=""
	for traefik_network in $1; do
		case "$traefik_network" in
			bridge | dokploy-network) continue ;;
		esac
		if $SUDO_CMD docker network inspect "$traefik_network" >/dev/null 2>&1; then
			$SUDO_CMD docker network connect "$traefik_network" dokploy-traefik >/dev/null || return 1
		fi
	done
}
traefik_check_running() {
	[ "$($SUDO_CMD docker inspect -f '{{.State.Running}} {{.RestartCount}}' dokploy-traefik 2>/dev/null)" = "true 0" ]
}
traefik_wait_settled() {
	local second=0
	while [ "$second" -lt "\${TRAEFIK_SETTLE_SECONDS:-10}" ]; do
		sleep 1
		if ! traefik_check_running; then
			return 1
		fi
		second=$((second + 1))
	done
	traefik_check_running
}
traefik_restore() {
	local failed_step="$1"
	trap - HUP INT TERM
	echo "Error: Traefik update failed while $failed_step." >&2
	if [ "$traefik_tls_converted" = 1 ]; then echo "Kept the converted Traefik config (tlsChallenge). Port 443 is published, so the restored container works with it. Previous config saved to $traefik_acme_backup." >&2; fi
	if [ "$traefik_old_stopped" = 1 ]; then
		echo "Restoring the previous Traefik container from $traefik_old_image." >&2
		$SUDO_CMD docker rm -f dokploy-traefik >/dev/null 2>&1 || true
		if traefik_create "$traefik_old_image" && traefik_connect "$traefik_extra_networks" && $SUDO_CMD docker update --restart always dokploy-traefik >/dev/null && $SUDO_CMD docker start dokploy-traefik >/dev/null && traefik_check_running; then
			echo "The previous Traefik container is running again." >&2
		else
			echo "Error: restoring the previous Traefik container failed as well. Check with: docker ps -a --filter name=dokploy-traefik" >&2
		fi
	fi
	exit 1
}
if [ "$traefik_existed" = 1 ] && [ "\${traefik_old_image%%@*}" = "traefik:v${TRAEFIK_VERSION}" ] && traefik_check_running && ! $SUDO_CMD grep -q '^[[:space:]]*httpChallenge:' /etc/dokploy/traefik/traefik.yml 2>/dev/null && ! $SUDO_CMD docker inspect -f '{{json .HostConfig.PortBindings}}' dokploy-traefik 2>/dev/null | grep -q '"80/tcp"'; then
	echo "Traefik already runs traefik:v${TRAEFIK_VERSION}"
else
	trap 'traefik_restore "being interrupted"' HUP INT TERM
	if ! {
${buildTraefikTlsMigrationStep()}
	}; then
		traefik_restore "converting the Traefik config to tlsChallenge"
	fi
	$SUDO_CMD docker rm -f dokploy-traefik-previous >/dev/null 2>&1 || true
	if [ "$traefik_existed" = 1 ]; then
		if ! $SUDO_CMD docker stop dokploy-traefik >/dev/null; then
			traefik_restore "stopping the running Traefik container"
		fi
		traefik_old_stopped=1
		if ! $SUDO_CMD docker rm dokploy-traefik >/dev/null; then
			traefik_restore "removing the stopped Traefik container"
		fi
	fi
	if ! traefik_create "traefik:v${TRAEFIK_VERSION}"; then
		traefik_restore "creating the new Traefik container"
	fi
	if ! traefik_connect "$traefik_extra_networks"; then
		traefik_restore "connecting the new Traefik container to its networks"
	fi
	if ! $SUDO_CMD docker start dokploy-traefik >/dev/null; then
		traefik_restore "starting the new Traefik container"
	fi
	if ! traefik_wait_settled; then
		traefik_restore "checking the new Traefik container (running, with no restarts)"
	fi
	if [ "$traefik_keep_bridge" = 0 ]; then
		$SUDO_CMD docker network disconnect bridge dokploy-traefik >/dev/null 2>&1 || true
	fi
	if ! $SUDO_CMD docker update --restart always dokploy-traefik >/dev/null; then
		traefik_restore "setting the restart policy of the new Traefik container"
	fi
	trap - HUP INT TERM
	echo "Traefik version ${TRAEFIK_VERSION} installed ✅"
fi
`;
		case "nixpacks":
			return `
echo "Updating Nixpacks to ${PINNED_VERSIONS.nixpacks}"
nixpacks_installer="$(mktemp)"
if ! curl -fsSL https://nixpacks.com/install.sh -o "$nixpacks_installer" || [ ! -s "$nixpacks_installer" ] || ! bash -n "$nixpacks_installer"; then
	rm -f "$nixpacks_installer"
	echo "Error: the Nixpacks install script could not be downloaded or checked; Nixpacks was not changed." >&2
	exit 1
fi
if ! $SUDO_CMD env NIXPACKS_VERSION=${PINNED_VERSIONS.nixpacks} bash "$nixpacks_installer"; then
	rm -f "$nixpacks_installer"
	echo "Error: the Nixpacks install script failed." >&2
	exit 1
fi
rm -f "$nixpacks_installer"
echo "Nixpacks version ${PINNED_VERSIONS.nixpacks} installed ✅"
`;
		case "railpack":
			return `
echo "Updating Railpack to ${PINNED_VERSIONS.railpack}"
railpack_installer="$(mktemp)"
if ! curl -fsSL https://railpack.com/install.sh -o "$railpack_installer" || [ ! -s "$railpack_installer" ] || ! bash -n "$railpack_installer"; then
	rm -f "$railpack_installer"
	echo "Error: the Railpack install script could not be downloaded or checked; Railpack was not changed." >&2
	exit 1
fi
if ! $SUDO_CMD env RAILPACK_VERSION=${PINNED_VERSIONS.railpack} bash "$railpack_installer"; then
	rm -f "$railpack_installer"
	echo "Error: the Railpack install script failed." >&2
	exit 1
fi
rm -f "$railpack_installer"
echo "Railpack version ${PINNED_VERSIONS.railpack} installed ✅"
`;
		case "buildpacks":
			return `
SYS_ARCH=$(uname -m)
SUFFIX=""
if [ "$SYS_ARCH" = "aarch64" ] || [ "$SYS_ARCH" = "arm64" ]; then
	SUFFIX="-arm64"
fi
echo "Updating Buildpacks (pack) to ${PINNED_VERSIONS.buildpacks}"
curl -sSL "https://github.com/buildpacks/pack/releases/download/v${PINNED_VERSIONS.buildpacks}/pack-v${PINNED_VERSIONS.buildpacks}-linux$SUFFIX.tgz" | $SUDO_CMD tar -C /usr/local/bin/ --no-same-owner -xz pack
echo "Buildpacks version ${PINNED_VERSIONS.buildpacks} installed ✅"
`;
	}
};

export const buildComponentUpdateSteps = (components: UpdatableComponent[]) => `
${predownloadGate(components)}
${components.map(updateStepFor).join("\n")}
`;

export const wrapComponentUpdateSteps = (steps: string) => `
set -e
if [ "$(id -u)" -eq 0 ]; then SUDO_CMD=""; else SUDO_CMD="sudo"; fi
${steps}
echo "${COMPONENTS_UPDATE_DONE}"
`;

export const buildComponentUpdateScript = (components: UpdatableComponent[]) =>
	wrapComponentUpdateSteps(buildComponentUpdateSteps(components));

export const serverComponentsStatus = async (serverId: string) => {
	const { stdout } = await runSshCommand(serverId, COMPONENT_CHECK_SCRIPT);
	return buildComponentStatuses(parseComponentVersions(stdout));
};

export const updateServerComponents = async (
	serverId: string,
	components: UpdatableComponent[],
	onData?: (data: string) => void,
	upgradeDocker = false,
) => {
	const plan = filterDockerUpgrade(components, upgradeDocker);
	if (plan.skippedDocker) {
		onData?.(`${DOCKER_UPGRADE_SKIPPED_MESSAGE}\n`);
	}
	const { exitCode } = await runSshCommand(
		serverId,
		buildComponentUpdateScript(plan.components),
		onData,
	);
	if (exitCode !== 0) {
		throw new Error(`Component update failed with exit code ${exitCode}`);
	}
};

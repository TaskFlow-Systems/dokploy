#!/bin/bash
set -euo pipefail

DOKPLOY_IMAGE="${DOKPLOY_IMAGE:-ghcr.io/agenthits/dokploy:agenthits-dev}"
DOKPLOY_RELEASE_TAG="${DOKPLOY_RELEASE_TAG:-agenthits-dev}"
DOKPLOY_OFFICIAL_VERSION="${DOKPLOY_OFFICIAL_VERSION:-v0.29.8}"
TRAEFIK_IMAGE="${TRAEFIK_IMAGE:-traefik:v3.7.16}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:18.6}"
REDIS_IMAGE="${REDIS_IMAGE:-redis:8.10.2}"
POSTGRES_DATA_TARGET="${POSTGRES_DATA_TARGET:-}"
AGENTHITS_SCRIPT_BASE_URL="${AGENTHITS_SCRIPT_BASE_URL:-https://raw.githubusercontent.com/agentHits/dokploy/AgentHits-Dev}"
DOCKER_VERSION="${DOCKER_VERSION:-29.9.2}"
NIXPACKS_VERSION="${NIXPACKS_VERSION:-1.41.0}"
RAILPACK_VERSION="${RAILPACK_VERSION:-0.42.0}"
BUILDPACKS_VERSION="${BUILDPACKS_VERSION:-0.40.10}"
RCLONE_VERSION="${RCLONE_VERSION:-1.75.2}"
DOKPLOY_MACHINE="${DOKPLOY_MACHINE:-dokploy}"
DOKPLOY_MACHINE_DISTRO="${DOKPLOY_MACHINE_DISTRO:-ubuntu:noble}"
PASSTHROUGH_VARS=(
	DOKPLOY_IMAGE
	DOKPLOY_RELEASE_TAG
	DOKPLOY_OFFICIAL_VERSION
	DOKPLOY_FORK_VERSION
	TRAEFIK_IMAGE
	POSTGRES_IMAGE
	REDIS_IMAGE
	POSTGRES_DATA_TARGET
	AGENTHITS_SCRIPT_BASE_URL
	DOCKER_VERSION
	DOCKER_SWARM_INIT_ARGS
	ADVERTISE_ADDR
	PUBLIC_IP
	DOKPLOY_SERVER_HARDENING
	HARDEN_SSH
	HARDEN_UFW
	HARDEN_FAIL2BAN
	DOCKER_ENGINE_UPGRADE
	DOKPLOY_BACKUP_DIR
	DOKPLOY_HEALTH_TIMEOUT
	DOKPLOY_DOCKER_VERIFY_TIMEOUT
	DOKPLOY_HEALTH_INTERVAL
	DOKPLOY_TRAEFIK_SETTLE
	AGENTHITS_PULL_RETRY_DELAY
)
ORB=""
HARDEN_UFW="${HARDEN_UFW:-0}"
HARDEN_SSH="${HARDEN_SSH:-0}"
HARDEN_FAIL2BAN="${HARDEN_FAIL2BAN:-0}"
DOCKER_ENGINE_UPGRADE="${DOCKER_ENGINE_UPGRADE:-0}"
DOKPLOY_BACKUP_DIR="${DOKPLOY_BACKUP_DIR:-/var/backups/dokploy}"
DOKPLOY_HEALTH_TIMEOUT="${DOKPLOY_HEALTH_TIMEOUT:-240}"
DOKPLOY_DOCKER_VERIFY_TIMEOUT="${DOKPLOY_DOCKER_VERIFY_TIMEOUT:-120}"
DOKPLOY_HEALTH_INTERVAL="${DOKPLOY_HEALTH_INTERVAL:-3}"
DOKPLOY_TRAEFIK_SETTLE="${DOKPLOY_TRAEFIK_SETTLE:-10}"
AGENTHITS_PULL_RETRY_DELAY="${AGENTHITS_PULL_RETRY_DELAY:-10}"
DOKPLOY_APT_SOURCES_DIR="${DOKPLOY_APT_SOURCES_DIR:-/etc/apt/sources.list.d}"
DOKPLOY_OS_RELEASE="${DOKPLOY_OS_RELEASE:-/etc/os-release}"
TRAEFIK_CONFIG_FILE="${TRAEFIK_CONFIG_FILE:-/etc/dokploy/traefik/traefik.yml}"
DOCKER_PACKAGE_VERSION=""
DOCKER_ENGINE_UPGRADE_NEEDED=0
DOCKER_ENGINE_PREVIOUS_VERSION=""
DOCKER_ROLLBACK_DIR=""
DOCKER_ROLLBACK_DIR_CREATED=0
TRAEFIK_EXTRA_NETWORKS=""
TRAEFIK_OLD_IMAGE=""
TRAEFIK_OLD_STOPPED=0
POSTGRES_KEPT=0

command_exists() {
	command -v "$@" >/dev/null 2>&1
}

is_proxmox_lxc() {
	if [ -n "${container:-}" ] && [ "$container" = "lxc" ]; then
		return 0
	fi

	if grep -q "container=lxc" /proc/1/environ 2>/dev/null; then
		return 0
	fi

	return 1
}

generate_random_secret() {
	if command_exists openssl; then
		openssl rand -base64 48 | tr -d "=+/" | cut -c1-48
	elif [ -r /dev/urandom ]; then
		tr -dc "A-Za-z0-9" </dev/urandom | head -c 48 || true
	else
		echo "$(date +%s%N)-$(hostname)-$$-$RANDOM" | sha256sum | cut -c1-48
	fi
}

create_secret_if_missing() {
	local name="$1"
	local value="$2"

	if docker secret inspect "$name" >/dev/null 2>&1; then
		echo "Docker secret $name already exists"
	else
		echo "$value" | docker secret create "$name" - >/dev/null
		echo "Docker secret $name created"
	fi
}

get_postgres_major_version() {
	local image="${1:-$POSTGRES_IMAGE}"
	local tag="${image##*:}"
	tag="${tag%%-*}"
	tag="${tag%%.*}"

	case "$tag" in
		"" | *[!0-9]*)
			return 1
			;;
		*)
			echo "$tag"
			;;
	esac
}

get_postgres_data_target() {
	if [ -n "$POSTGRES_DATA_TARGET" ]; then
		echo "$POSTGRES_DATA_TARGET"
		return 0
	fi

	local major=""
	if major="$(get_postgres_major_version)" && [ "$major" -ge 18 ]; then
		echo "/var/lib/postgresql"
	else
		echo "/var/lib/postgresql/data"
	fi
}

create_default_traefik_files() {
	mkdir -p /etc/dokploy/traefik/dynamic

	if [ -d "$TRAEFIK_CONFIG_FILE" ]; then
		case "$TRAEFIK_CONFIG_FILE" in
			/etc/dokploy/traefik/traefik.yml | */traefik.yml)
				rm -rf "$TRAEFIK_CONFIG_FILE"
				;;
			*)
				echo "Error: $TRAEFIK_CONFIG_FILE is a directory, not the Traefik config file. Remove it by hand, then run the installer again." >&2
				exit 1
				;;
		esac
	fi

	if [ ! -f "$TRAEFIK_CONFIG_FILE" ]; then
		cat >"$TRAEFIK_CONFIG_FILE" <<'EOF'
global:
  sendAnonymousUsage: false
providers:
  swarm:
    exposedByDefault: false
    watch: true
  docker:
    exposedByDefault: false
    watch: true
    network: dokploy-network
  file:
    directory: /etc/dokploy/traefik/dynamic
    watch: true
entryPoints:
  web:
    address: :80
  websecure:
    address: :443
    http3:
      advertisedPort: 443
    http:
      tls:
        certResolver: letsencrypt
api:
  insecure: true
certificatesResolvers:
  letsencrypt:
    acme:
      email: test@localhost.com
      storage: /etc/dokploy/traefik/dynamic/acme.json
      tlsChallenge: {}
EOF
	fi

	if [ ! -f /etc/dokploy/traefik/dynamic/middlewares.yml ]; then
		cat >/etc/dokploy/traefik/dynamic/middlewares.yml <<'EOF'
http:
  middlewares:
    redirect-to-https:
      redirectScheme:
        scheme: https
        permanent: true
EOF
	fi

	if [ ! -f /etc/dokploy/traefik/dynamic/dokploy.yml ]; then
		cat >/etc/dokploy/traefik/dynamic/dokploy.yml <<'EOF'
http:
  routers:
    dokploy-router-app:
      rule: Host(`dokploy.docker.localhost`) && PathPrefix(`/`)
      service: dokploy-service-app
      entryPoints:
        - web
  services:
    dokploy-service-app:
      loadBalancer:
        servers:
          - url: http://dokploy:3000
        passHostHeader: true
EOF
	fi

	touch /etc/dokploy/traefik/dynamic/acme.json
	chmod 600 /etc/dokploy/traefik/dynamic/acme.json
}

get_public_ip() {
	local ip=""
	ip=$(curl -4s --connect-timeout 5 https://ifconfig.io 2>/dev/null || true)
	if [ -z "$ip" ]; then
		ip=$(curl -4s --connect-timeout 5 https://icanhazip.com 2>/dev/null || true)
	fi
	if [ -z "$ip" ]; then
		ip=$(curl -4s --connect-timeout 5 https://ipecho.net/plain 2>/dev/null || true)
	fi
	if [ -z "$ip" ]; then
		ip=$(curl -6s --connect-timeout 5 https://ifconfig.io 2>/dev/null || true)
	fi
	if [ -z "$ip" ]; then
		ip=$(curl -6s --connect-timeout 5 https://icanhazip.com 2>/dev/null || true)
	fi
	if [ -z "$ip" ]; then
		ip=$(curl -6s --connect-timeout 5 https://ipecho.net/plain 2>/dev/null || true)
	fi

	if [ -z "$ip" ]; then
		echo "Error: could not determine public IP. Set ADVERTISE_ADDR manually." >&2
		exit 1
	fi

	echo "$ip"
}

get_private_ip() {
	ip addr show | grep -E "inet (192\.168\.|10\.|172\.1[6-9]\.|172\.2[0-9]\.|172\.3[0-1]\.)" | head -n1 | awk '{print $2}' | cut -d/ -f1
}

format_ip_for_url() {
	local ip="$1"
	if echo "$ip" | grep -q ":"; then
		echo "[${ip}]"
	else
		echo "$ip"
	fi
}

require_root_linux_host() {
	if [ "$(id -u)" != "0" ]; then
		echo "This script must be run as root" >&2
		exit 1
	fi

	if [ "$(uname)" = "Darwin" ] || [ -f /.dockerenv ]; then
		echo "This script must be run on a Linux host, not macOS or inside Docker" >&2
		exit 1
	fi
}

require_free_port() {
	local port="$1"
	if ss -tulnp | grep ":${port} " >/dev/null; then
		echo "Error: something is already running on port ${port}" >&2
		exit 1
	fi
}

os_release_value() {
	(
		# shellcheck disable=SC1091
		. /etc/os-release 2>/dev/null || exit 0
		eval "echo \"\${$1:-}\""
	)
}

start_docker_service() {
	if command_exists systemctl && [ -d /run/systemd/system ]; then
		systemctl enable --now docker
	elif command_exists rc-service; then
		rc-update add docker default >/dev/null 2>&1 || true
		rc-service docker start
	elif command_exists service; then
		service docker start
	fi
}

ensure_docker_running() {
	if docker info >/dev/null 2>&1; then
		return 0
	fi

	start_docker_service

	local i=0
	while [ "$i" -lt 30 ]; do
		if docker info >/dev/null 2>&1; then
			return 0
		fi
		sleep 1
		i=$((i + 1))
	done
	echo "Docker is installed but the daemon is not running." >&2
	exit 1
}

# New distro releases (e.g. Fedora 44) have no package for the pinned version,
# so fall back to the latest Docker there.
install_docker_with_get_docker() {
	local script=""
	script="$(mktemp)"
	curl -fsSL https://get.docker.com -o "$script"
	if ! sh "$script" --version "$DOCKER_VERSION"; then
		echo "Docker $DOCKER_VERSION is not packaged for this release; installing the latest Docker."
		sh "$script"
	fi
	rm -f "$script"
}

# get.docker.com only knows a few distro IDs; derivatives and other families
# go through their own package managers.
install_docker_if_missing() {
	if command_exists docker; then
		echo "Docker already installed"
		ensure_docker_running
		return 0
	fi

	local id=""
	local like=""
	id="$(os_release_value ID)"
	like="$(os_release_value ID_LIKE)"

	case "$id" in
		ubuntu | debian | raspbian | centos | rhel | fedora)
			install_docker_with_get_docker
			;;
		rocky | almalinux | ol)
			dnf -y install dnf-plugins-core
			dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
			dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
			;;
		arch | archarm | manjaro | endeavouros)
			pacman -Sy --noconfirm --needed docker docker-buildx docker-compose
			;;
		opensuse* | sles)
			zypper --non-interactive install docker docker-compose
			;;
		alpine)
			apk add --no-cache docker docker-cli-compose
			;;
		*)
			case " $like " in
				*" debian "* | *" ubuntu "*)
					apt-get update
					DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io
					;;
				*" rhel "* | *" fedora "* | *" centos "*)
					dnf -y install dnf-plugins-core
					dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
					dnf -y install docker-ce docker-ce-cli containerd.io
					;;
				*)
					echo "Unsupported Linux distribution '$id'. Install Docker yourself and run this script again." >&2
					exit 1
					;;
			esac
			;;
	esac

	ensure_docker_running
}

tool_version_matches() {
	local expected="$1"
	shift
	command_exists "$1" && "$@" 2>/dev/null | grep -q -- "$expected"
}

# A failed download must stop the install: piping the script into bash, or running it
# inside $(...), runs nothing when the download fails and still reports success.
run_install_script() {
	local url="$1"
	local label="$2"
	local assignment="$3"
	local script=""
	script="$(mktemp)"
	if ! curl -fsSL "$url" -o "$script" || [ ! -s "$script" ] || ! bash -n "$script"; then
		rm -f "$script"
		echo "Error: the $label install script could not be downloaded or checked; $label was not installed." >&2
		exit 1
	fi
	if ! env "$assignment" bash "$script"; then
		rm -f "$script"
		echo "Error: the $label install script failed." >&2
		exit 1
	fi
	rm -f "$script"
}

install_toolchain() {
	local arch="" pack_suffix=""
	case "$(uname -m)" in
		x86_64 | amd64)
			arch=amd64
			;;
		aarch64 | arm64)
			arch=arm64
			pack_suffix="-arm64"
			;;
		*)
			echo "Unsupported architecture for the toolchain: $(uname -m)" >&2
			exit 1
			;;
	esac

	if ! tool_version_matches "$NIXPACKS_VERSION" nixpacks --version; then
		run_install_script https://nixpacks.com/install.sh Nixpacks "NIXPACKS_VERSION=$NIXPACKS_VERSION"
	fi
	if ! tool_version_matches "$RAILPACK_VERSION" railpack --version; then
		run_install_script https://railpack.com/install.sh Railpack "RAILPACK_VERSION=$RAILPACK_VERSION"
	fi
	if ! tool_version_matches "$BUILDPACKS_VERSION" pack --version; then
		curl -sSL "https://github.com/buildpacks/pack/releases/download/v${BUILDPACKS_VERSION}/pack-v${BUILDPACKS_VERSION}-linux${pack_suffix}.tgz" | tar -C /usr/local/bin/ --no-same-owner -xz pack
	fi
	if ! tool_version_matches "$RCLONE_VERSION" rclone --version; then
		if ! command_exists unzip; then
			apt-get update -qq
			DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unzip >/dev/null
		fi
		local rclone_dir=""
		rclone_dir="$(mktemp -d)"
		curl -fsSL "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${arch}.zip" -o "$rclone_dir/rclone.zip"
		unzip -q "$rclone_dir/rclone.zip" -d "$rclone_dir"
		install -m 0755 "$rclone_dir/rclone-v${RCLONE_VERSION}-linux-${arch}/rclone" /usr/bin/rclone
		rm -rf "$rclone_dir"
	fi
}

has_amd64_binfmt() {
	# Without systemd (e.g. Alpine) binfmt_misc is often not mounted, which
	# hides handlers the kernel already has.
	if [ ! -e /proc/sys/fs/binfmt_misc/status ]; then
		mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc 2>/dev/null || true
	fi
	[ -e /proc/sys/fs/binfmt_misc/qemu-x86_64 ] && return 0
	local f=""
	for f in /proc/sys/fs/binfmt_misc/rosetta*; do
		[ -e "$f" ] && return 0
	done
	return 1
}

# The Dokploy image is published for linux/amd64 only.
ensure_amd64_support() {
	case "$(uname -m)" in
		x86_64 | amd64)
			return 0
			;;
	esac
	if has_amd64_binfmt; then
		return 0
	fi

	echo "This host is $(uname -m); the Dokploy image is amd64 only. Setting up amd64 emulation."
	if command_exists apt-get; then
		apt-get update
		DEBIAN_FRONTEND=noninteractive apt-get install -y qemu-user-static binfmt-support
	elif command_exists dnf; then
		dnf -y install qemu-user-static
	elif command_exists pacman; then
		pacman -Sy --noconfirm --needed qemu-user-static qemu-user-static-binfmt
	fi

	if ! has_amd64_binfmt; then
		# Not persistent across reboots, unlike the distro packages above.
		docker run --privileged --rm tonistiigi/binfmt --install amd64
	fi
	if ! has_amd64_binfmt; then
		echo "Could not enable amd64 emulation on this host." >&2
		exit 1
	fi
}

ensure_wsl_systemd() {
	if [ "$(ps -p 1 -o comm= 2>/dev/null)" = "systemd" ]; then
		return 0
	fi

	if grep -qE '^[[:space:]]*systemd[[:space:]]*=' /etc/wsl.conf 2>/dev/null; then
		sed -i -E 's/^[[:space:]]*systemd[[:space:]]*=.*/systemd=true/' /etc/wsl.conf
	elif grep -q '^\[boot\]' /etc/wsl.conf 2>/dev/null; then
		sed -i '/^\[boot\]/a systemd=true' /etc/wsl.conf
	else
		printf '\n[boot]\nsystemd=true\n' >>/etc/wsl.conf
	fi

	echo "systemd was off in this WSL distro; it is now enabled in /etc/wsl.conf." >&2
	echo "In Windows run 'wsl --shutdown', open the distro again and rerun this script." >&2
	# install-agenthits.ps1 restarts the distro and reruns on this code.
	exit 3
}

prepare_wsl() {
	ensure_wsl_systemd

	local docker_path=""
	docker_path="$(command -v docker || true)"
	if [ -n "$docker_path" ] && readlink -f "$docker_path" | grep -q '/mnt/wsl/docker-desktop'; then
		echo "The docker command here comes from Docker Desktop." >&2
		echo "Turn off Docker Desktop > Settings > Resources > WSL integration for this distro, then rerun." >&2
		exit 1
	fi

	if command_exists wslinfo && [ "$(wslinfo --networking-mode 2>/dev/null)" != "mirrored" ]; then
		echo "WARNING: WSL networking is not 'mirrored'; other devices in your network will not reach the panel."
		echo "Set networkingMode=mirrored under [wsl2] in %UserProfile%\\.wslconfig (install-agenthits.ps1 does this)."
	fi

	# Under WSL the private address is the one people open; the public IP is
	# the router's.
	if [ -z "${PUBLIC_IP:-}" ]; then
		PUBLIC_IP="${ADVERTISE_ADDR:-$(get_private_ip || true)}"
	fi
}

detect_platform() {
	case "$(uname -s)" in
		Darwin)
			echo macos
			;;
		Linux)
			if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then
				echo wsl
			else
				echo linux
			fi
			;;
		MINGW* | MSYS* | CYGWIN*)
			echo windows
			;;
		*)
			echo unknown
			;;
	esac
}

passthrough_env() {
	local name=""
	for name in "${PASSTHROUGH_VARS[@]}"; do
		if [ -n "${!name:-}" ]; then
			printf '%s=%s\n' "$name" "${!name}"
		fi
	done
}

# Prints the path of this script, downloading it when it was piped into bash.
script_file() {
	local self="${BASH_SOURCE[0]:-}"
	if [ -n "$self" ] && [ -f "$self" ]; then
		echo "$(cd "$(dirname "$self")" >/dev/null 2>&1 && pwd)/$(basename "$self")"
		return 0
	fi

	local tmp=""
	tmp="$(mktemp "${TMPDIR:-/tmp}/install-agenthits.XXXXXX")"
	curl -fsSL "$AGENTHITS_SCRIPT_BASE_URL/install-agenthits.sh" -o "$tmp"
	echo "$tmp"
}

reexec_as_root() {
	if [ "$(id -u)" = "0" ]; then
		return 0
	fi
	if ! command_exists sudo; then
		echo "Run this script as root." >&2
		exit 1
	fi

	local script=""
	script="$(script_file)"
	# macOS ships bash 3.2, where an empty array is "unbound" under set -u.
	local env_args=()
	local line=""
	while IFS= read -r line; do
		env_args+=("$line")
	done < <(passthrough_env)

	echo "Root is required; re-running with sudo."
	exec sudo env ${env_args[@]+"${env_args[@]}"} bash "$script" "$@"
}

find_orb() {
	if command_exists orb; then
		ORB="$(command -v orb)"
	elif [ -x "$HOME/.orbstack/bin/orb" ]; then
		ORB="$HOME/.orbstack/bin/orb"
	else
		return 1
	fi
}

install_orbstack_if_missing() {
	if find_orb; then
		return 0
	fi
	if ! command_exists brew; then
		echo "OrbStack is required on macOS. Install it from https://orbstack.dev and run this script again." >&2
		exit 1
	fi

	echo "Installing OrbStack with Homebrew..."
	brew install --cask orbstack
	open -a OrbStack || true

	local i=0
	while [ "$i" -lt 120 ]; do
		if find_orb && "$ORB" status 2>/dev/null | grep -qi running; then
			return 0
		fi
		sleep 2
		i=$((i + 1))
	done
	echo "OrbStack did not start. Open the OrbStack app once, finish its setup and run this script again." >&2
	exit 1
}

orb_machine_exists() {
	"$ORB" list -q 2>/dev/null | grep -qx "$DOKPLOY_MACHINE"
}

in_orb_machine() {
	"$ORB" -m "$DOKPLOY_MACHINE" -u root "$@"
}

# The default route can point at a VPN tunnel, so take the address of the
# first physical interface that has one.
get_macos_lan_ip() {
	if [ -n "${LAN_IP:-}" ]; then
		echo "$LAN_IP"
		return 0
	fi

	local iface=""
	for iface in en0 en1 en2 en3 en4 en5; do
		if ipconfig getifaddr "$iface" 2>/dev/null; then
			return 0
		fi
	done
	return 1
}

# The script goes in on stdin: when it was piped from curl its temp copy
# lives under /var/folders, which OrbStack machines cannot see.
run_in_orb_machine() {
	local mode="$1"
	shift

	local script=""
	script="$(script_file)"
	local env_args=()
	local line=""
	while IFS= read -r line; do
		env_args+=("$line")
	done < <(passthrough_env)
	if [ "$#" -gt 0 ]; then
		env_args+=("$@")
	fi

	in_orb_machine env ${env_args[@]+"${env_args[@]}"} bash -s "$mode" <"$script"
}

warn_if_firewall_blocks_orbstack() {
	local fw=/usr/libexec/ApplicationFirewall/socketfilterfw
	if ! "$fw" --getglobalstate 2>/dev/null | grep -q "enabled"; then
		return 0
	fi
	if "$fw" --getappblocked /Applications/OrbStack.app 2>/dev/null | grep -q "permitted"; then
		return 0
	fi

	echo ""
	echo "The macOS firewall is on and does not list OrbStack as allowed."
	echo "Other devices in your network will not reach the panel until you allow it:"
	echo "  sudo $fw --add /Applications/OrbStack.app"
	echo "  sudo $fw --unblockapp /Applications/OrbStack.app"
}

# On macOS the Linux installer runs inside a dedicated OrbStack machine: it
# needs Linux and recreates the Docker Swarm, and the machine's own Docker
# engine keeps the Mac's Docker (and any swarm on it) untouched.
install_on_macos() {
	install_orbstack_if_missing

	if orb_machine_exists && in_orb_machine docker service inspect dokploy >/dev/null 2>&1; then
		echo "Dokploy is already installed in OrbStack machine '$DOKPLOY_MACHINE'." >&2
		echo "Run this script with 'update' to update it, or '$ORB delete $DOKPLOY_MACHINE' to start over." >&2
		exit 1
	fi

	if ! orb_machine_exists; then
		echo "Creating OrbStack machine '$DOKPLOY_MACHINE' ($DOKPLOY_MACHINE_DISTRO)..."
		"$ORB" create "$DOKPLOY_MACHINE_DISTRO" "$DOKPLOY_MACHINE"
	fi
	"$ORB" start "$DOKPLOY_MACHINE" >/dev/null 2>&1 || true

	local lan_ip=""
	lan_ip="$(get_macos_lan_ip || true)"
	if [ -z "$lan_ip" ]; then
		lan_ip="127.0.0.1"
	fi

	# The machine's own address is internal to OrbStack; its ports are
	# forwarded to the Mac, so the Mac's address is the one to print.
	run_in_orb_machine install "PUBLIC_IP=$lan_ip"

	warn_if_firewall_blocks_orbstack

	echo ""
	echo "On this Mac:          http://localhost:3000"
	echo "From your network:    http://${lan_ip}:3000"
	echo "Shell in the machine: $ORB -m $DOKPLOY_MACHINE -u root"
}

harden_on_macos() {
	if ! find_orb || ! orb_machine_exists; then
		echo "OrbStack machine '$DOKPLOY_MACHINE' does not exist. Run this script with 'install' first." >&2
		exit 1
	fi
	"$ORB" start "$DOKPLOY_MACHINE" >/dev/null 2>&1 || true
	run_in_orb_machine harden
}

update_on_macos() {
	if ! find_orb || ! orb_machine_exists; then
		echo "OrbStack machine '$DOKPLOY_MACHINE' does not exist. Run this script with 'install' first." >&2
		exit 1
	fi
	"$ORB" start "$DOKPLOY_MACHINE" >/dev/null 2>&1 || true
	run_in_orb_machine update
}

# Hardening flags (opt-in). They close the findings from Dokploy's
# Setup Server > Security tab: UFW, SSH password login and Fail2Ban.
ssh_listen_port() {
	local port=""
	port="$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2; exit }')"
	echo "${port:-22}"
}

require_root_public_key() {
	local keys_file=/root/.ssh/authorized_keys
	if [ ! -s "$keys_file" ] || ! ssh-keygen -l -f "$keys_file" >/dev/null 2>&1; then
		echo "Refusing to turn off password login: $keys_file has no valid public key." >&2
		echo "Add your public key to that file first, then run again." >&2
		exit 1
	fi
}

harden_ssh_keys_only() {
	require_root_public_key

	# The Security tab reads the main sshd_config, not drop-ins, and sshd keeps
	# the first value it sees, so the options go on the first line of that file.
	local config=/etc/ssh/sshd_config
	local backup=/etc/ssh/sshd_config.agenthits-backup
	if [ ! -f "$backup" ]; then
		cp -p "$config" "$backup"
	fi
	local option=""
	local key=""
	for option in "PubkeyAuthentication yes" "PasswordAuthentication no" "KbdInteractiveAuthentication no" "PermitRootLogin prohibit-password" "UsePAM no"; do
		key="${option%% *}"
		sed -i -E "/^[#[:space:]]*${key}[[:space:]]/Id" "$config"
		sed -i "1i ${option}" "$config"
	done
	if ! sshd -t; then
		cp -p "$backup" "$config"
		echo "sshd rejected the hardened config, the original was restored." >&2
		exit 1
	fi
	systemctl reload ssh 2>/dev/null || systemctl reload sshd
	echo "SSH: password login is off, keys only."
}

harden_ufw() {
	if ! command_exists apt-get; then
		echo "UFW: the --ufw flag supports Debian and Ubuntu only; skipped." >&2
		return 0
	fi

	DEBIAN_FRONTEND=noninteractive apt-get install -y ufw >/dev/null
	local ssh_port=""
	ssh_port="$(ssh_listen_port)"

	ufw default deny incoming >/dev/null
	ufw default allow outgoing >/dev/null
	# ufw drops forwarded traffic by default, which cuts container networking.
	sed -i 's/^DEFAULT_FORWARD_POLICY=.*/DEFAULT_FORWARD_POLICY="ACCEPT"/' /etc/default/ufw
	# SSH must be allowed before enabling, or the next login fails.
	ufw allow "${ssh_port}/tcp" comment 'SSH' >/dev/null
	ufw allow 443/tcp comment 'HTTPS' >/dev/null
	ufw allow 443/udp comment 'HTTP/3' >/dev/null
	ufw allow 3000/tcp comment 'Dokploy panel' >/dev/null
	ufw --force enable >/dev/null
	echo "UFW: enabled. Incoming is denied except SSH (${ssh_port}), 443 and 3000."
}

harden_fail2ban() {
	if ! command_exists apt-get; then
		echo "Fail2Ban: the --fail2ban flag supports Debian and Ubuntu only; skipped." >&2
		return 0
	fi

	DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban >/dev/null
	if [ ! -f /etc/fail2ban/jail.local ]; then
		cat >/etc/fail2ban/jail.local <<'EOF'
[sshd]
enabled = true
backend = auto
mode = aggressive
maxretry = 5
findtime = 10m
bantime = 1h
EOF
	fi
	systemctl enable --now fail2ban >/dev/null 2>&1
	systemctl restart fail2ban
	echo "Fail2Ban: sshd jail is active in aggressive mode."
}

hardening_requested() {
	[ "$HARDEN_SSH" = "1" ] || [ "$HARDEN_UFW" = "1" ] || [ "$HARDEN_FAIL2BAN" = "1" ]
}

traefik_version_from_image() {
	case "$1" in
		traefik:v*) echo "${1#traefik:v}" ;;
	esac
}

# The panel hardens every server it sets up. An explicit DOKPLOY_SERVER_HARDENING
# wins; otherwise it follows the host flags so one install flag covers both.
panel_server_hardening() {
	if [ -n "${DOKPLOY_SERVER_HARDENING:-}" ]; then
		echo "$DOKPLOY_SERVER_HARDENING"
		return 0
	fi
	local items=""
	if [ "$HARDEN_SSH" = "1" ]; then
		items="ssh"
	fi
	if [ "$HARDEN_UFW" = "1" ]; then
		items="${items:+$items,}ufw"
	fi
	if [ "$HARDEN_FAIL2BAN" = "1" ]; then
		items="${items:+$items,}fail2ban"
	fi
	echo "$items"
}

apply_hardening() {
	if [ "$HARDEN_SSH" = "1" ]; then
		if command_exists sshd; then
			harden_ssh_keys_only
		else
			echo "SSH: no sshd on this host, skipped."
		fi
	fi
	if [ "$HARDEN_UFW" = "1" ]; then
		harden_ufw
	fi
	if [ "$HARDEN_FAIL2BAN" = "1" ]; then
		harden_fail2ban
	fi
}

install_agenthits_dokploy() {
	require_root_linux_host
	# Check the key before anything is changed, so a missing key cannot
	# leave a half-installed server behind.
	if [ "$HARDEN_SSH" = "1" ] && command_exists sshd; then
		require_root_public_key
	fi
	require_free_port 443
	require_free_port 3000
	install_docker_if_missing
	install_toolchain
	ensure_amd64_support

	local endpoint_mode=""
	if is_proxmox_lxc; then
		echo "Detected Proxmox LXC. Using Docker service endpoint-mode dnsrr."
		endpoint_mode="--endpoint-mode dnsrr"
	fi

	docker swarm leave --force 2>/dev/null || true

	local detected_private_ip=""
	if [ -z "${ADVERTISE_ADDR:-}" ]; then
		detected_private_ip="$(get_private_ip || true)"
	fi
	local advertise_addr="${ADVERTISE_ADDR:-$detected_private_ip}"
	if [ -z "$advertise_addr" ]; then
		echo "ERROR: private IP was not detected. Set ADVERTISE_ADDR manually." >&2
		echo "Example: ADVERTISE_ADDR=192.168.1.100 bash install-agenthits.sh" >&2
		exit 1
	fi

	local swarm_init_args="${DOCKER_SWARM_INIT_ARGS:-}"
	if [ -n "$swarm_init_args" ]; then
		docker swarm init --advertise-addr "$advertise_addr" $swarm_init_args
	else
		docker swarm init --advertise-addr "$advertise_addr"
	fi

	docker network rm -f dokploy-network 2>/dev/null || true
	docker network create --driver overlay --attachable dokploy-network

	mkdir -p /etc/dokploy
	chmod 755 /etc/dokploy
	create_default_traefik_files
	if ! migrate_traefik_acme_to_tls "$TRAEFIK_CONFIG_FILE"; then echo "Error: could not convert the Traefik config to tlsChallenge. Check the file named above, then run the installer again." >&2; exit 1; fi

	create_secret_if_missing dokploy_postgres_password "$(generate_random_secret)"
	create_secret_if_missing dokploy_auth_secret "$(generate_random_secret)"
	create_secret_if_missing dokploy_schedules_signing_key "$(generate_random_secret)"
	create_secret_if_missing dokploy_deployments_signing_key "$(generate_random_secret)"

	local postgres_data_target
	postgres_data_target="$(get_postgres_data_target)"
	local fork_version_env_args=()
	if [ -n "${DOKPLOY_FORK_VERSION:-}" ]; then
		fork_version_env_args=(-e "DOKPLOY_FORK_VERSION=$DOKPLOY_FORK_VERSION")
	fi
	local panel_hardening=""
	panel_hardening="$(panel_server_hardening)"
	local traefik_version=""
	traefik_version="$(traefik_version_from_image "$TRAEFIK_IMAGE")"

	docker service create \
		--name dokploy-postgres \
		--constraint 'node.role==manager' \
		--network dokploy-network \
		--env POSTGRES_USER=dokploy \
		--env POSTGRES_DB=dokploy \
		--secret source=dokploy_postgres_password,target=/run/secrets/postgres_password \
		--env POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
		--mount type=volume,source=dokploy-postgres,target="$postgres_data_target" \
		$endpoint_mode \
		"$POSTGRES_IMAGE"

	docker service create \
		--name dokploy-redis \
		--constraint 'node.role==manager' \
		--network dokploy-network \
		--mount type=volume,source=dokploy-redis,target=/data \
		$endpoint_mode \
		"$REDIS_IMAGE"

	docker service create \
		--name dokploy \
		--replicas 1 \
		--network dokploy-network \
		--mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
		--mount type=bind,source=/etc/dokploy,target=/etc/dokploy \
		--mount type=volume,source=dokploy,target=/root/.docker \
		--secret source=dokploy_postgres_password,target=/run/secrets/postgres_password \
		--secret source=dokploy_auth_secret,target=/run/secrets/dokploy_auth_secret \
		--secret source=dokploy_schedules_signing_key,target=/run/secrets/dokploy_schedules_signing_key \
		--secret source=dokploy_deployments_signing_key,target=/run/secrets/dokploy_deployments_signing_key \
		--publish published=3000,target=3000,mode=host \
		--update-parallelism 1 \
		--update-order stop-first \
		--constraint 'node.role == manager' \
		$endpoint_mode \
		-e RELEASE_TAG="$DOKPLOY_RELEASE_TAG" \
		-e DOKPLOY_SERVER_HARDENING="$panel_hardening" \
		-e TRAEFIK_VERSION="$traefik_version" \
		-e DOKPLOY_OFFICIAL_VERSION="$DOKPLOY_OFFICIAL_VERSION" \
		"${fork_version_env_args[@]}" \
		-e ADVERTISE_ADDR="$advertise_addr" \
		-e API_KEY="$(generate_random_secret)" \
		-e POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
		-e BETTER_AUTH_SECRET_FILE=/run/secrets/dokploy_auth_secret \
		-e SCHEDULES_SIGNING_KEY_FILE=/run/secrets/dokploy_schedules_signing_key \
		-e DEPLOYMENTS_SIGNING_KEY_FILE=/run/secrets/dokploy_deployments_signing_key \
		"$DOKPLOY_IMAGE"

	run_dokploy_traefik "$TRAEFIK_IMAGE"

	apply_hardening

	local public_ip="${PUBLIC_IP:-${ADVERTISE_ADDR:-$(get_public_ip)}}"
	local formatted_addr
	formatted_addr="$(format_ip_for_url "$public_ip")"

	echo ""
	echo "AgentHits Dokploy is installed."
	echo "Image: $DOKPLOY_IMAGE"
	echo "Wait about 15 seconds, then open:"
	echo "http://${formatted_addr}:3000"
}

download_with_retry() {
	local attempt=1
	while [ "$attempt" -le 3 ]; do
		if "$@"; then
			return 0
		fi
		if [ "$attempt" -lt 3 ]; then
			sleep "$AGENTHITS_PULL_RETRY_DELAY"
		fi
		attempt=$((attempt + 1))
	done
	return 1
}

# Docker's packages are pinned by version string; the epoch and the
# distribution suffix come from the repository.
docker_package_version() {
	apt-cache madison docker-ce | awk -F'|' '{ gsub(/ /, "", $2); print $2 }' | grep -m1 -E "^([0-9]+:)?${DOCKER_VERSION//./\\.}-" || true
}

docker_engine_version() {
	docker version --format '{{.Server.Version}}' 2>/dev/null || true
}

docker_package_installed_version() {
	if [ "$(dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null)" = "installed" ]; then
		dpkg-query -W -f='${Version}' "$1"
	fi
}

docker_package_candidate_version() {
	apt-cache policy "$1" 2>/dev/null | awk '/^  Candidate:/ { print $2; exit }'
}

# Packages from another release would replace the Engine with ones built for it.
docker_source_codenames() {
	local file=""
	for file in "$DOKPLOY_APT_SOURCES_DIR"/*.list; do
		[ -f "$file" ] || continue
		awk '/download\.docker\.com/ && !/^[[:space:]]*#/ { for (i = 2; i < NF; i++) if ($i ~ /download\.docker\.com/) { print $(i + 1); break } }' "$file"
	done
	for file in "$DOKPLOY_APT_SOURCES_DIR"/*.sources; do
		[ -f "$file" ] || continue
		awk 'BEGIN { RS = ""; FS = "\n" } /download\.docker\.com/ { for (i = 1; i <= NF; i++) if ($i ~ /^Suites:/) { split($i, suite, /[ \t]+/); print suite[2] } }' "$file"
	done
}

check_docker_repo_codename() {
	local repo_codenames=""
	local repo_codename=""
	local host_codename=""
	repo_codenames="$(docker_source_codenames)"
	if [ -z "$repo_codenames" ]; then
		return 0
	fi
	# shellcheck disable=SC1090
	host_codename="$( (. "$DOKPLOY_OS_RELEASE" && printf '%s' "${VERSION_CODENAME:-}") 2>/dev/null || true)"
	if [ -z "$host_codename" ]; then
		echo "Pre-download failed: VERSION_CODENAME is not set in $DOKPLOY_OS_RELEASE, so the Docker apt repository cannot be checked. Nothing was changed." >&2
		exit 1
	fi
	for repo_codename in $repo_codenames; do
		if [ "$repo_codename" != "$host_codename" ]; then
			echo "Pre-download failed: the Docker apt repository in $DOKPLOY_APT_SOURCES_DIR is for $repo_codename, but this host runs $host_codename. Point it at $host_codename yourself and run the update again. Nothing was changed." >&2
			exit 1
		fi
	done
}

# Saved before the Engine is touched, so a failed upgrade can install them back.
remove_docker_rollback_dir() {
	if [ "$DOCKER_ROLLBACK_DIR_CREATED" = "1" ]; then
		rm -rf "$DOCKER_ROLLBACK_DIR"
		DOCKER_ROLLBACK_DIR_CREATED=0
	fi
}

save_docker_rollback_packages() {
	local package=""
	local installed=""
	local candidate=""
	if [ -z "$(docker_package_installed_version docker-ce)" ]; then
		echo "Pre-download failed: current Docker packages for rollback (docker-ce is not installed). Nothing was changed." >&2
		exit 1
	fi
	DOCKER_ROLLBACK_DIR="$DOKPLOY_BACKUP_DIR/docker-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
	mkdir -p "$DOKPLOY_BACKUP_DIR"
	chmod 700 "$DOKPLOY_BACKUP_DIR"
	if ! (umask 077 && mkdir "$DOCKER_ROLLBACK_DIR"); then
		echo "Pre-download failed: current Docker packages for rollback. Nothing was changed." >&2
		exit 1
	fi
	DOCKER_ROLLBACK_DIR_CREATED=1
	for package in docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras; do
		installed="$(docker_package_installed_version "$package")"
		if [ -z "$installed" ]; then
			continue
		fi
		case "$package" in
			docker-ce | docker-ce-cli) ;;
			*)
				candidate="$(docker_package_candidate_version "$package")"
				if [ "$candidate" = "$installed" ]; then
					continue
				fi
				;;
		esac
		if ! (umask 077 && cd "$DOCKER_ROLLBACK_DIR" && apt-get download "$package=$installed"); then
			remove_docker_rollback_dir
			echo "Pre-download failed: current Docker packages for rollback. Nothing was changed." >&2
			exit 1
		fi
	done
}

predownload_docker_packages() {
	if ! command_exists apt-get; then
		echo "Pre-download failed: DOCKER_ENGINE_UPGRADE=1 needs apt-get on this host. Nothing was changed." >&2
		exit 1
	fi
	check_docker_repo_codename
	if ! download_with_retry apt-get update -qq; then
		echo "Pre-download failed: the apt package lists could not be refreshed. Nothing was changed." >&2
		exit 1
	fi
	DOCKER_PACKAGE_VERSION="$(docker_package_version)"
	if [ -z "$DOCKER_PACKAGE_VERSION" ]; then
		echo "Pre-download failed: Docker $DOCKER_VERSION is not in the apt sources. Nothing was changed." >&2
		exit 1
	fi
	save_docker_rollback_packages
	if ! download_with_retry apt-get install -y -qq --download-only "docker-ce=$DOCKER_PACKAGE_VERSION" "docker-ce-cli=$DOCKER_PACKAGE_VERSION" containerd.io docker-buildx-plugin docker-compose-plugin; then
		remove_docker_rollback_dir
		echo "Pre-download failed: the Docker packages. Nothing was changed." >&2
		exit 1
	fi
}

# update.sh runs from this checkout when it is present; otherwise it is
# downloaded here, so the panel step cannot fail on a download mid-update.
resolve_panel_update_script() {
	local script_dir=""
	script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
	if [ -f "$script_dir/update.sh" ]; then
		PANEL_UPDATE_SCRIPT="$script_dir/update.sh"
		PANEL_UPDATE_IS_TEMP=0
		return 0
	fi
	PANEL_UPDATE_SCRIPT="$(mktemp)"
	PANEL_UPDATE_IS_TEMP=1
	if ! download_with_retry curl -fsSL "$AGENTHITS_SCRIPT_BASE_URL/update.sh" -o "$PANEL_UPDATE_SCRIPT"; then
		rm -f "$PANEL_UPDATE_SCRIPT"
		echo "Pre-download failed: update.sh. Nothing was changed." >&2
		exit 1
	fi
}

# The one pre-download gate of the operator update. Every image and package
# the update needs is local before any service, container or daemon is touched.
predownload_update_artifacts() {
	resolve_panel_update_script
	local image=""
	local images=("$REDIS_IMAGE" "$TRAEFIK_IMAGE" "$DOKPLOY_IMAGE")
	if [ "$POSTGRES_KEPT" = "0" ]; then
		images=("$POSTGRES_IMAGE" "${images[@]}")
	fi
	for image in "${images[@]}"; do
		if ! download_with_retry docker pull "$image"; then
			echo "Pre-download failed: $image. Nothing was changed." >&2
			exit 1
		fi
	done
	DOCKER_ENGINE_UPGRADE_NEEDED=0
	DOCKER_ENGINE_PREVIOUS_VERSION="$(docker_engine_version)"
	if [ "$DOCKER_ENGINE_UPGRADE" = "1" ] && [ "$DOCKER_ENGINE_PREVIOUS_VERSION" != "$DOCKER_VERSION" ]; then
		DOCKER_ENGINE_UPGRADE_NEEDED=1
		predownload_docker_packages
	fi
}

image_without_digest() {
	echo "${1%%@*}"
}

service_image() {
	docker service inspect "$1" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null || true
}

# The running task container of a swarm service; with an image, only one that runs it.
task_container() {
	local service="$1"
	local image="${2:-}"
	if [ -n "$image" ]; then
		docker ps -q --no-trunc --filter "label=com.docker.swarm.service.name=$service" --filter status=running --filter "ancestor=$(image_without_digest "$image")" | head -n1 || true
	else
		docker ps -q --no-trunc --filter "label=com.docker.swarm.service.name=$service" --filter status=running | head -n1 || true
	fi
}

redis_ready() {
	local container=""
	container="$(task_container dokploy-redis "$REDIS_IMAGE")"
	[ -n "$container" ] && [ "$(docker exec "$container" redis-cli ping 2>/dev/null)" = "PONG" ]
}

# A kept Postgres runs its installed major, so readiness follows the service's image, not the pinned one.
postgres_ready() {
	local container=""
	container="$(task_container dokploy-postgres "$(service_image dokploy-postgres)")"
	[ -n "$container" ] && docker exec "$container" pg_isready -U dokploy -d dokploy >/dev/null 2>&1
}

panel_ready() {
	local container=""
	container="$(task_container dokploy)"
	[ -n "$container" ] && [ "$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null)" = "healthy" ]
}

docker_daemon_running() {
	docker info >/dev/null 2>&1
}

swarm_node_active() {
	[ "$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)" = "active" ]
}

traefik_running() {
	[ "$(docker inspect --format '{{.State.Running}}' dokploy-traefik 2>/dev/null)" = "true" ]
}

docker_stack_ready() {
	[ "$(docker_engine_version)" = "$1" ] && swarm_node_active && panel_ready && postgres_ready && redis_ready && traefik_running
}

wait_within() {
	local seconds="$1"
	local check="$2"
	shift 2
	local deadline=$(($(date +%s) + seconds))
	until "$check" "$@"; do
		if [ "$(date +%s)" -ge "$deadline" ]; then
			return 1
		fi
		sleep "$DOKPLOY_HEALTH_INTERVAL"
	done
}

# Swarm reports a failed update as paused or rolled back. Those states are read
# only once the update is registered (Version.Index has moved), so a state left
# over from an earlier update is not taken for this one.
swap_swarm_service() {
	local service="$1"
	local image="$2"
	local ready="$3"
	local previous_image=""
	local previous_index=""
	local index=""
	local state=""
	previous_image="$(service_image "$service")"
	previous_index="$(docker service inspect "$service" --format '{{.Version.Index}}' 2>/dev/null || true)"

	if ! docker service update --detach --update-order stop-first --update-failure-action rollback --image "$image" "$service" >/dev/null; then
		echo "Error: docker service update was refused for $service; it was not changed." >&2
		exit 1
	fi

	local deadline=$(($(date +%s) + DOKPLOY_HEALTH_TIMEOUT))
	while :; do
		index="$(docker service inspect "$service" --format '{{.Version.Index}}' 2>/dev/null || true)"
		state="$(docker service inspect "$service" --format '{{.UpdateStatus.State}}' 2>/dev/null || true)"
		if [ "${index:-0}" -gt "${previous_index:-0}" ]; then
			case "$state" in
				rollback_*)
					echo "Error: $service did not start on $image (swarm state: $state). Previous image: $previous_image. Check with: docker service ps $service --no-trunc" >&2
					exit 1
					;;
				paused)
					echo "Error: $service is paused after its update to $image (swarm state: paused). Previous image: $previous_image. Roll back with: docker service update --image $previous_image $service" >&2
					exit 1
					;;
			esac
			if [ "$state" = "completed" ] && "$ready"; then
				echo "$service runs $image (previous image kept: $previous_image)"
				return 0
			fi
		fi
		if [ "$(date +%s)" -ge "$deadline" ]; then
			echo "Error: $service was not ready on $image within $DOKPLOY_HEALTH_TIMEOUT seconds. Roll back with: docker service update --image $previous_image $service" >&2
			exit 1
		fi
		sleep "$DOKPLOY_HEALTH_INTERVAL"
	done
}

backup_postgres() {
	local container=""
	local file=""
	container="$(task_container dokploy-postgres)"
	if [ -z "$container" ]; then
		echo "Error: no running dokploy-postgres task to back up. Nothing was changed." >&2
		exit 1
	fi
	# The dump holds the data and the role password hashes, so it stays private.
	mkdir -p "$DOKPLOY_BACKUP_DIR"
	chmod 700 "$DOKPLOY_BACKUP_DIR"
	file="$DOKPLOY_BACKUP_DIR/postgres-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
	if ! (umask 077 && docker exec "$container" pg_dumpall -U dokploy | gzip >"$file") || [ ! -s "$file" ]; then
		rm -f "$file"
		echo "Error: the Postgres backup failed. Nothing was changed." >&2
		exit 1
	fi
	echo "Postgres backup written to $file"
}

# The networks the running Traefik is attached to, minus the two that are handled
# separately: bridge is the default and dokploy-network is always connected.
traefik_extra_networks() {
	local networks=""
	local network=""
	networks="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' dokploy-traefik 2>/dev/null || true)"
	for network in $networks; do
		case "$network" in
			bridge | dokploy-network) ;;
			*) echo "$network" ;;
		esac
	done
}

# Created but not started, with the given restart policy, and connected to all its
# networks before it starts, so the time without a running Traefik stays short.
create_dokploy_traefik() {
	local image="$1"
	local restart="$2"
	docker create \
		--name dokploy-traefik \
		--restart "$restart" \
		-v "$TRAEFIK_CONFIG_FILE:/etc/traefik/traefik.yml" \
		-v /etc/dokploy/traefik/dynamic:/etc/dokploy/traefik/dynamic \
		-v /var/run/docker.sock:/var/run/docker.sock:ro \
		-p 443:443/tcp \
		-p 443:443/udp \
		"$image" >/dev/null || return 1

	docker network connect dokploy-network dokploy-traefik || return 1
	local network=""
	for network in $TRAEFIK_EXTRA_NETWORKS; do
		if docker network inspect "$network" >/dev/null 2>&1; then
			docker network connect "$network" dokploy-traefik || return 1
		fi
	done
}

run_dokploy_traefik() {
	create_dokploy_traefik "$1" always
	docker start dokploy-traefik >/dev/null
}

traefik_check_running() {
	[ "$(docker inspect --format '{{.State.Running}} {{.RestartCount}}' dokploy-traefik 2>/dev/null)" = "true 0" ]
}

# Names the step that failed. Once the old container is stopped, it is created again
# from its image with the same networks and started, before the script exits.
traefik_wait_settled() {
	local second=0
	while [ "$second" -lt "$DOKPLOY_TRAEFIK_SETTLE" ]; do
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
	if [ -n "${TRAEFIK_ACME_BACKUP:-}" ] && [ -f "$TRAEFIK_ACME_BACKUP" ]; then echo "Kept the converted Traefik config (tlsChallenge). Previous config saved to $TRAEFIK_ACME_BACKUP." >&2; fi
	if [ "$TRAEFIK_OLD_STOPPED" = "1" ]; then
		echo "Restoring the previous Traefik container from $TRAEFIK_OLD_IMAGE." >&2
		docker rm -f dokploy-traefik >/dev/null 2>&1 || true
		if create_dokploy_traefik "$TRAEFIK_OLD_IMAGE" no && docker update --restart always dokploy-traefik >/dev/null && docker start dokploy-traefik >/dev/null && traefik_check_running; then
			echo "The previous Traefik container is running again." >&2
		else
			echo "Error: restoring the previous Traefik container failed as well. Check with: docker ps -a --filter name=dokploy-traefik" >&2
		fi
	fi
	exit 1
}

# HTTP-01 needs port 80, which the Traefik container does not publish, so renewal
# runs over 443 with tlsChallenge.
migrate_traefik_acme_to_tls() {
	local config="${1:-$TRAEFIK_CONFIG_FILE}"
	if [ ! -f "$config" ] || ! grep -q '^[[:space:]]*httpChallenge:' "$config"; then
		return 0
	fi

	local backup=""
	backup="$config.bak-$(date -u +%Y%m%d%H%M%S)"
	if ! cp -p "$config" "$backup"; then
		rm -f "$backup"
		return 1
	fi

	local awk_status=0
	awk '
		/^[[:space:]]*httpChallenge:[[:space:]]*$/ { match($0, /[^[:space:]]/); indent = RSTART - 1; print substr($0, 1, indent) "tlsChallenge: {}"; skipping = 1; next }
		/^[[:space:]]*httpChallenge:[[:space:]]*\{.*\}[[:space:]]*$/ { match($0, /[^[:space:]]/); print substr($0, 1, RSTART - 1) "tlsChallenge: {}"; next }
		skipping && /^[[:space:]]*$/ { print; next }
		skipping && /^[[:space:]]*#/ { next }
		skipping { if (match($0, /[^[:space:]]/) && RSTART - 1 > indent) next; skipping = 0 }
		{ print }
	' "$config" >"$config.tmp" || awk_status=$?
	if [ "$awk_status" -ne 0 ] || grep -q 'httpChallenge' "$config.tmp" || ! grep -q 'tlsChallenge: {}' "$config.tmp"; then
		rm -f "$config.tmp"
		echo "Error: could not convert $config to tlsChallenge. The previous config is saved at $backup." >&2
		return 1
	fi

	local orphan_line=""
	orphan_line="$(awk '
		/^[[:space:]]*tlsChallenge:[[:space:]]*\{\}[[:space:]]*$/ { match($0, /[^[:space:]]/); level = RSTART - 1; armed = 1; next }
		armed && /^[[:space:]]*(#.*)?$/ { next }
		armed { armed = 0; match($0, /[^[:space:]]/); if (RSTART - 1 > level) { print NR; exit } }
	' "$config.tmp")"
	if [ -n "$orphan_line" ]; then
		rm -f "$config.tmp"
		echo "Error: converting $config would leave output line $orphan_line indented under tlsChallenge. The config is unchanged; the previous config is saved at $backup." >&2
		return 1
	fi

	if ! cat "$config.tmp" >"$config"; then
		rm -f "$config.tmp"
		if cat "$backup" >"$config"; then
			echo "Error: could not write $config. The previous config was restored from $backup." >&2
		else
			echo "Error: could not write $config, and restoring it from $backup failed. Copy $backup back over $config." >&2
		fi
		return 1
	fi
	rm -f "$config.tmp"
	TRAEFIK_ACME_BACKUP="$backup"
	echo "Certificate renewal now uses port 443 (tlsChallenge). Previous config saved to $backup"
}

swap_dokploy_traefik() {
	TRAEFIK_ACME_BACKUP=""
	local current=""
	current="$(docker inspect --format '{{.Config.Image}}' dokploy-traefik 2>/dev/null || true)"
	if [ "$(image_without_digest "$current")" = "$(image_without_digest "$TRAEFIK_IMAGE")" ] &&
		! grep -q '^[[:space:]]*httpChallenge:' "$TRAEFIK_CONFIG_FILE" 2>/dev/null &&
		! docker inspect -f '{{json .HostConfig.PortBindings}}' dokploy-traefik 2>/dev/null | grep -q '"80/tcp"'; then
		echo "Traefik already runs $TRAEFIK_IMAGE"
		return 0
	fi

	local existed=0
	if docker inspect dokploy-traefik >/dev/null 2>&1; then
		existed=1
	fi
	TRAEFIK_OLD_IMAGE="$current"
	TRAEFIK_EXTRA_NETWORKS="$(traefik_extra_networks)"
	TRAEFIK_OLD_STOPPED=0
	trap 'traefik_restore "being interrupted"' HUP INT TERM
	if ! migrate_traefik_acme_to_tls; then traefik_restore "converting the Traefik config to tlsChallenge"; fi
	docker rm -f dokploy-traefik-previous >/dev/null 2>&1 || true
	if [ "$existed" = "1" ]; then
		if ! docker stop dokploy-traefik >/dev/null; then
			traefik_restore "stopping the running Traefik container"
		fi
		TRAEFIK_OLD_STOPPED=1
		if ! docker rm dokploy-traefik >/dev/null; then
			traefik_restore "removing the stopped Traefik container"
		fi
	fi
	if ! create_dokploy_traefik "$TRAEFIK_IMAGE" no; then
		traefik_restore "creating the new Traefik container and connecting its networks"
	fi
	if ! docker start dokploy-traefik >/dev/null; then
		traefik_restore "starting the new Traefik container"
	fi
	if ! traefik_wait_settled; then
		traefik_restore "checking the new Traefik container (running, with no restarts)"
	fi
	if ! docker update --restart always dokploy-traefik >/dev/null; then
		traefik_restore "setting the restart policy of the new Traefik container"
	fi
	trap - HUP INT TERM
	echo "Traefik runs $TRAEFIK_IMAGE"
}

require_update_services() {
	local service=""
	for service in dokploy dokploy-postgres dokploy-redis; do
		if ! docker service inspect "$service" >/dev/null 2>&1; then
			echo "Error: Docker service '$service' was not found. Run install first." >&2
			exit 1
		fi
	done
	if ! docker inspect dokploy-traefik >/dev/null 2>&1; then
		echo "Error: container 'dokploy-traefik' was not found. Run install first." >&2
		exit 1
	fi
}

run_panel_update() {
	local status=0
	bash "$PANEL_UPDATE_SCRIPT" || status=$?
	if [ "$PANEL_UPDATE_IS_TEMP" = "1" ]; then
		rm -f "$PANEL_UPDATE_SCRIPT"
	fi
	return "$status"
}

print_docker_manual_rollback() {
	cat >&2 <<EOF
Roll Docker Engine back by hand (the Engine should report $DOCKER_ENGINE_PREVIOUS_VERSION):
  apt-get install -y --allow-downgrades --no-download $DOCKER_ROLLBACK_DIR/*.deb
  systemctl start docker
  docker start dokploy-traefik
  docker version --format '{{.Server.Version}}'
EOF
}

rollback_docker_engine() {
	echo "Rolling Docker Engine back to $DOCKER_ENGINE_PREVIOUS_VERSION from $DOCKER_ROLLBACK_DIR" >&2
	if ! apt-get install -y --allow-downgrades --no-download "$DOCKER_ROLLBACK_DIR"/*.deb; then
		return 1
	fi
	if ! docker_daemon_running; then
		start_docker_service || true
	fi
	if ! wait_within "$DOKPLOY_DOCKER_VERIFY_TIMEOUT" docker_daemon_running; then
		return 1
	fi
	if docker inspect dokploy-traefik >/dev/null 2>&1; then
		docker update --restart always dokploy-traefik >/dev/null || true
		if ! traefik_running; then
			docker start dokploy-traefik >/dev/null || true
		fi
	fi
	wait_within "$DOKPLOY_DOCKER_VERIFY_TIMEOUT" docker_stack_ready "$DOCKER_ENGINE_PREVIOUS_VERSION"
}

fail_docker_engine_upgrade() {
	echo "$1" >&2
	if rollback_docker_engine; then
		echo "Error: Docker Engine was rolled back to $DOCKER_ENGINE_PREVIOUS_VERSION. The packages it used are in $DOCKER_ROLLBACK_DIR." >&2
		exit 1
	fi
	echo "Error: the Docker Engine rollback did not finish. The saved packages are in $DOCKER_ROLLBACK_DIR." >&2
	print_docker_manual_rollback
	exit 1
}

# Docker Engine restarts dockerd, and live-restore does not cover swarm services,
# so every service on the host restarts here. It runs last, on pre-downloaded packages.
upgrade_docker_engine() {
	if [ "$DOCKER_ENGINE_UPGRADE_NEEDED" != "1" ]; then
		return 0
	fi
	echo "Upgrading Docker Engine from $DOCKER_ENGINE_PREVIOUS_VERSION to $DOCKER_VERSION; the daemon restarts and the swarm services on this host restart with it."
	if ! apt-get install -y -qq --no-download "docker-ce=$DOCKER_PACKAGE_VERSION" "docker-ce-cli=$DOCKER_PACKAGE_VERSION" containerd.io docker-buildx-plugin docker-compose-plugin; then
		fail_docker_engine_upgrade "Error: installing the pre-downloaded Docker packages failed."
	fi
	if ! docker_daemon_running; then
		start_docker_service || true
	fi
	if ! wait_within "$DOKPLOY_DOCKER_VERIFY_TIMEOUT" docker_stack_ready "$DOCKER_VERSION"; then
		fail_docker_engine_upgrade "Error: the host was not healthy on Docker Engine $DOCKER_VERSION within $DOKPLOY_DOCKER_VERIFY_TIMEOUT seconds."
	fi
	echo "Docker Engine is $DOCKER_VERSION"
}

# Order: Redis, Traefik, Postgres, then the panel. A failed Redis or Traefik swap
# stops before the database changes. Postgres follows its backup and comes
# before the panel, because the new panel migrates the database when it starts.
# The panel is last, so its dependencies are already on their pinned versions
# and healthy when its rollback-protected update runs.
update_agenthits_dokploy() {
	require_update_services

	local current_postgres=""
	local current_postgres_major=""
	current_postgres="$(image_without_digest "$(service_image dokploy-postgres)")"
	current_postgres_major="$(get_postgres_major_version "$current_postgres" || true)"
	if [ "$current_postgres_major" != "$(get_postgres_major_version || true)" ]; then
		POSTGRES_KEPT=1
		echo "Postgres ${current_postgres_major:-$current_postgres} stays. A major upgrade is a separate migration; this update does not change it."
	fi

	predownload_update_artifacts

	local postgres_swap=0
	if [ "$POSTGRES_KEPT" = "0" ] && [ "$(image_without_digest "$(service_image dokploy-postgres)")" != "$(image_without_digest "$POSTGRES_IMAGE")" ]; then
		postgres_swap=1
		backup_postgres
	fi
	if [ "$(image_without_digest "$(service_image dokploy-redis)")" != "$(image_without_digest "$REDIS_IMAGE")" ]; then
		swap_swarm_service dokploy-redis "$REDIS_IMAGE" redis_ready
	fi
	swap_dokploy_traefik
	if [ "$postgres_swap" = "1" ]; then
		swap_swarm_service dokploy-postgres "$POSTGRES_IMAGE" postgres_ready
	fi
	run_panel_update
	upgrade_docker_engine
	echo "Panel host update finished."
}

parse_hardening_flags() {
	local arg=""
	for arg in "$@"; do
		case "$arg" in
			install | update | harden) ;;
			--harden)
				HARDEN_UFW=1
				HARDEN_SSH=1
				HARDEN_FAIL2BAN=1
				;;
			--ufw)
				HARDEN_UFW=1
				;;
			--ssh-keys-only)
				HARDEN_SSH=1
				;;
			--fail2ban)
				HARDEN_FAIL2BAN=1
				;;
			*)
				echo "Unknown argument: $arg" >&2
				exit 1
				;;
		esac
	done
}

main() {
	local mode="install"
	if [ "$#" -gt 0 ]; then
		case "$1" in
			install | update | harden)
				mode="$1"
				;;
			--*) ;;
			*)
				echo "Usage: $0 [install|update|harden] [--harden] [--ufw] [--ssh-keys-only] [--fail2ban]" >&2
				exit 1
				;;
		esac
	fi
	parse_hardening_flags "$@"
	if [ "$mode" = "update" ] && hardening_requested; then
		echo "Hardening flags work with install and harden, not with update." >&2
		exit 1
	fi
	if [ "$mode" = "harden" ] && ! hardening_requested; then
		echo "harden needs at least one flag: --harden, --ufw, --ssh-keys-only or --fail2ban." >&2
		exit 1
	fi

	local platform=""
	platform="$(detect_platform)"
	case "$platform" in
		macos)
			if [ "$(id -u)" = "0" ]; then
				echo "On macOS run this script as your own user, without sudo." >&2
				exit 1
			fi
			case "$mode" in
				install) install_on_macos ;;
				harden) harden_on_macos ;;
				*) update_on_macos ;;
			esac
			;;
		linux | wsl)
			reexec_as_root "$@"
			if [ "$platform" = "wsl" ]; then
				prepare_wsl
			fi
			case "$mode" in
				install) install_agenthits_dokploy ;;
				harden) apply_hardening ;;
				*) update_agenthits_dokploy ;;
			esac
			;;
		windows)
			echo "On Windows run install-agenthits.ps1 in PowerShell (as administrator):" >&2
			echo "  irm $AGENTHITS_SCRIPT_BASE_URL/install-agenthits.ps1 | iex" >&2
			exit 1
			;;
		*)
			echo "Unsupported OS: $(uname -s)" >&2
			exit 1
			;;
	esac
}

main "$@"

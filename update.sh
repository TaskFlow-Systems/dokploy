#!/bin/bash
set -euo pipefail

DOKPLOY_IMAGE="${DOKPLOY_IMAGE:-ghcr.io/agenthits/dokploy:agenthits-dev}"
DOKPLOY_RELEASE_TAG="${DOKPLOY_RELEASE_TAG:-agenthits-dev}"
DOKPLOY_OFFICIAL_VERSION_OVERRIDE="${DOKPLOY_OFFICIAL_VERSION:-}"
DOKPLOY_FORK_VERSION_OVERRIDE="${DOKPLOY_FORK_VERSION:-}"
DOKPLOY_OFFICIAL_VERSION="${DOKPLOY_OFFICIAL_VERSION_OVERRIDE:-v0.29.8}"
DOKPLOY_FORK_VERSION="${DOKPLOY_FORK_VERSION_OVERRIDE:-}"
DOKPLOY_HEALTH_TIMEOUT="${DOKPLOY_HEALTH_TIMEOUT:-240}"
DOKPLOY_HEALTH_INTERVAL="${DOKPLOY_HEALTH_INTERVAL:-3}"
DOCKER_VERSION="${DOCKER_VERSION:-29.9.2}"

command_exists() {
	command -v "$@" >/dev/null 2>&1
}

require_root_linux_host() {
	if [ "${AGENTHITS_SKIP_HOST_CHECK:-}" = "1" ]; then
		return 0
	fi

	if [ "$(id -u)" != "0" ]; then
		echo "This script must be run as root" >&2
		exit 1
	fi

	if [ "$(uname)" = "Darwin" ] || [ -f /.dockerenv ]; then
		echo "This script must be run on a Linux host, not macOS or inside Docker" >&2
		exit 1
	fi
}

install_docker_if_missing() {
	if command_exists docker; then
		echo "Docker already installed"
	else
		curl -sSL https://get.docker.com | sh -s -- --version "$DOCKER_VERSION"
	fi
}

# The service updates stop-first, so a pull that fails after the old task has
# stopped leaves Dokploy down; pulling first keeps it running on failure.
pull_update_image() {
	local attempt=1
	while [ "$attempt" -le 3 ]; do
		if docker pull "$DOKPLOY_IMAGE"; then
			return 0
		fi
		if [ "$attempt" -lt 3 ]; then
			echo "docker pull failed (attempt $attempt of 3), retrying in 10 seconds" >&2
			sleep "${AGENTHITS_PULL_RETRY_DELAY:-10}"
		fi
		attempt=$((attempt + 1))
	done
	echo "Error: could not pull $DOKPLOY_IMAGE; the running Dokploy service was left unchanged." >&2
	exit 1
}

get_service_image() {
	docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
}

get_service_env() {
	docker service inspect dokploy --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}'
}

extract_digest() {
	local image="$1"
	case "$image" in
		*@sha256:*)
			echo "sha256:${image##*@sha256:}"
			;;
		*)
			return 1
			;;
	esac
}

image_reference_matches_update_target() {
	local image="$1"
	case "$image" in
		"$DOKPLOY_IMAGE"|"$DOKPLOY_IMAGE"@sha256:*)
			return 0
			;;
		*)
			return 1
			;;
	esac
}

get_remote_image_digests() {
	local inspect_output=""
	if ! inspect_output="$(docker buildx imagetools inspect "$DOKPLOY_IMAGE" 2>/dev/null)"; then
		return 1
	fi

	local index_digest=""
	index_digest="$(printf '%s\n' "$inspect_output" | awk '/^[[:space:]]*Digest:/ {print $2; exit}')"

	local platform_digest=""
	platform_digest="$(
		printf '%s\n' "$inspect_output" | awk '
			/^[[:space:]]*Name:/ && /@sha256:/ {
				sub(/^.*@/, "", $0)
				candidate = $1
			}
			/^[[:space:]]*Platform:/ && /linux\/amd64/ {
				print candidate
				exit
			}
		'
	)"

	if [ -z "$platform_digest" ]; then
		platform_digest="$index_digest"
	fi

	if [ -z "$index_digest" ] && [ -z "$platform_digest" ]; then
		return 1
	fi

	printf '%s %s\n' "$index_digest" "$platform_digest"
}

extract_json_string_value() {
	local key="$1"
	sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n1
}

extract_config_env_value() {
	local name="$1"
	tr ',' '\n' | sed -n "s/.*\"${name}=\\([^\"]*\\)\".*/\\1/p" | head -n1
}

get_ghcr_repository() {
	case "$DOKPLOY_IMAGE" in
		ghcr.io/*)
			local without_registry="${DOKPLOY_IMAGE#ghcr.io/}"
			echo "${without_registry%%:*}"
			;;
		*)
			return 1
			;;
	esac
}

get_remote_image_metadata() {
	local platform_digest="$1"
	local repository=""
	repository="$(get_ghcr_repository)" || return 1

	if ! command_exists curl; then
		return 1
	fi

	local token_response=""
	token_response="$(curl -fsSL "https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull")" || return 1

	local token=""
	token="$(printf '%s\n' "$token_response" | extract_json_string_value token)"
	if [ -z "$token" ]; then
		return 1
	fi

	local manifest=""
	manifest="$(
		curl -fsSL \
			-H "Authorization: Bearer $token" \
			-H "Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
			"https://ghcr.io/v2/${repository}/manifests/${platform_digest}"
	)" || return 1

	local config_digest=""
	config_digest="$(printf '%s\n' "$manifest" | tr ',' '\n' | extract_json_string_value digest)"
	if [ -z "$config_digest" ]; then
		return 1
	fi

	local config=""
	config="$(
		curl -fsSL \
			-H "Authorization: Bearer $token" \
			"https://ghcr.io/v2/${repository}/blobs/${config_digest}"
	)" || return 1

	local official_version=""
	local fork_version=""
	official_version="$(printf '%s\n' "$config" | extract_config_env_value DOKPLOY_OFFICIAL_VERSION)"
	fork_version="$(printf '%s\n' "$config" | extract_config_env_value DOKPLOY_FORK_VERSION)"

	if [ -z "$official_version" ] && [ -z "$fork_version" ]; then
		return 1
	fi

	printf '%s\n%s\n' "$official_version" "$fork_version"
}

metadata_matches() {
	local service_env="$1"

	printf '%s\n' "$service_env" | grep -qx "RELEASE_TAG=$DOKPLOY_RELEASE_TAG" || return 1
	printf '%s\n' "$service_env" | grep -qx "DOKPLOY_OFFICIAL_VERSION=$DOKPLOY_OFFICIAL_VERSION" || return 1

	if [ -n "${DOKPLOY_FORK_VERSION:-}" ]; then
		printf '%s\n' "$service_env" | grep -qx "DOKPLOY_FORK_VERSION=$DOKPLOY_FORK_VERSION" || return 1
	fi

	return 0
}

panel_container_healthy() {
	local container=""
	container="$(docker ps -q --no-trunc --filter label=com.docker.swarm.service.name=dokploy --filter status=running | head -n1 || true)"
	if [ -z "$container" ]; then
		return 1
	fi
	[ "$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null)" = "healthy" ]
}

# Swarm rolls a failed update back, and the attached CLI still exits 0 then,
# so the outcome is read from the service instead.
wait_for_panel_update() {
	local previous_index="$1"
	local deadline=$(($(date +%s) + DOKPLOY_HEALTH_TIMEOUT))
	local index=""
	local state=""
	while :; do
		index="$(docker service inspect dokploy --format '{{.Version.Index}}' 2>/dev/null || true)"
		state="$(docker service inspect dokploy --format '{{.UpdateStatus.State}}' 2>/dev/null || true)"
		if [ "${index:-0}" -gt "$previous_index" ]; then
			case "$state" in
				paused | rollback_*)
					echo "Error: the Dokploy panel update did not succeed (swarm state: $state). See: docker service ps dokploy --no-trunc" >&2
					exit 1
					;;
			esac
			if [ "$state" = "completed" ] && panel_container_healthy; then
				return 0
			fi
		fi
		if [ "$(date +%s)" -ge "$deadline" ]; then
			echo "Error: the Dokploy panel was not healthy after ${DOKPLOY_HEALTH_TIMEOUT} seconds (swarm state: ${state:-unknown})." >&2
			exit 1
		fi
		sleep "$DOKPLOY_HEALTH_INTERVAL"
	done
}

update_agenthits_dokploy() {
	require_root_linux_host
	install_docker_if_missing

	local current_image=""
	if ! current_image="$(get_service_image 2>/dev/null)"; then
		echo "Error: Docker service 'dokploy' was not found. Run install first." >&2
		exit 1
	fi

	local current_digest=""
	current_digest="$(extract_digest "$current_image" 2>/dev/null || true)"

	local service_env=""
	service_env="$(get_service_env 2>/dev/null || true)"

	local latest_index_digest=""
	local latest_platform_digest=""
	local remote_digests=""
	if remote_digests="$(get_remote_image_digests)"; then
		latest_index_digest="${remote_digests%% *}"
		latest_platform_digest="${remote_digests#* }"
	fi

	local remote_metadata=""
	local remote_metadata_loaded="0"
	if [ -n "$latest_platform_digest" ] && remote_metadata="$(get_remote_image_metadata "$latest_platform_digest")"; then
		remote_metadata_loaded="1"
		local latest_official_version=""
		local latest_fork_version=""
		latest_official_version="$(printf '%s\n' "$remote_metadata" | sed -n '1p')"
		latest_fork_version="$(printf '%s\n' "$remote_metadata" | sed -n '2p')"

		if [ -z "$DOKPLOY_OFFICIAL_VERSION_OVERRIDE" ] && [ -n "$latest_official_version" ]; then
			DOKPLOY_OFFICIAL_VERSION="$latest_official_version"
		fi
		if [ -z "$DOKPLOY_FORK_VERSION_OVERRIDE" ] && [ -n "$latest_fork_version" ]; then
			DOKPLOY_FORK_VERSION="$latest_fork_version"
		fi
	fi

	if metadata_matches "$service_env"; then
		if [ -n "$current_digest" ] &&
			{ [ "$current_digest" = "$latest_index_digest" ] || [ "$current_digest" = "$latest_platform_digest" ]; }; then
			echo "AgentHits Dokploy is already up to date: $DOKPLOY_IMAGE@$current_digest"
			exit 0
		fi

		if [ -z "$current_digest" ] &&
			[ "$remote_metadata_loaded" = "1" ] &&
			image_reference_matches_update_target "$current_image"; then
			echo "AgentHits Dokploy is already up to date: $DOKPLOY_IMAGE (metadata matches latest image)"
			exit 0
		fi
	fi

	echo "Updating AgentHits Dokploy to $DOKPLOY_IMAGE"
	if [ -n "$latest_index_digest" ]; then
		echo "Latest image digest: $latest_index_digest"
	fi

	pull_update_image

	local update_args=(
		--image "$DOKPLOY_IMAGE"
		--update-failure-action rollback
		--env-add RELEASE_TAG="$DOKPLOY_RELEASE_TAG"
		--env-add "DOKPLOY_OFFICIAL_VERSION=$DOKPLOY_OFFICIAL_VERSION"
	)
	if [ -n "${DOKPLOY_FORK_VERSION:-}" ]; then
		update_args+=(--env-add "DOKPLOY_FORK_VERSION=$DOKPLOY_FORK_VERSION")
	elif printf '%s\n' "$service_env" | grep -q '^DOKPLOY_FORK_VERSION='; then
		update_args+=(--env-rm DOKPLOY_FORK_VERSION)
	fi
	local previous_index=""
	previous_index="$(docker service inspect dokploy --format '{{.Version.Index}}' 2>/dev/null || true)"
	docker service update --detach "${update_args[@]}" dokploy
	wait_for_panel_update "${previous_index:-0}"

	echo "AgentHits Dokploy updated to $DOKPLOY_IMAGE"
}

update_agenthits_dokploy

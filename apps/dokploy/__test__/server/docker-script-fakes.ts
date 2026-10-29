import { spawnSync } from "node:child_process";
import { PINNED_VERSIONS } from "@dokploy/server/setup/component-versions";

// Stand-ins for the host tools the generated update scripts call. Each one
// records its arguments in $CALL_LOG and keeps Docker's state in $FAKE_STATE.
export const BASH = spawnSync("sh", ["-c", "command -v bash"], {
	encoding: "utf8",
}).stdout.trim();

export const FAKE_TOOLS: Record<string, string> = {
	docker: `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$CALL_LOG"
case "$1" in
	pull) [ "$FAKE_PULL_FAILS" = 1 ] && exit 1 ;;
	create)
		[ "$FAKE_CREATE_FAILS" = 1 ] && exit 1
		for traefik_arg in "$@"; do traefik_image_arg="$traefik_arg"; done
		printf '%s\\n' "$traefik_image_arg" > "$FAKE_STATE/traefik-image"
		;;
	version) cat "$FAKE_STATE/engine" ;;
	info) echo "\${FAKE_SWARM_STATE:-active}" ;;
	ps) echo cid ;;
	exec)
		case "$*" in
			*redis-cli*) echo PONG ;;
		esac
		;;
	network)
		case "$2" in
			inspect) case " $FAKE_MISSING_NETWORKS " in *" $3 "*) exit 1 ;; esac ;;
			connect) case " $FAKE_CONNECT_FAILS " in *" $3 "*) exit 1 ;; esac ;;
		esac
		;;
	inspect)
		case "$*" in
			*State.Health*) echo "\${FAKE_PANEL_HEALTH:-healthy}" ;;
			*Config.Image*) echo "$FAKE_OLD_IMAGE" ;;
			*NetworkSettings*) echo "$FAKE_TRAEFIK_NETWORKS" ;;
			*PortBindings*) echo "$FAKE_PORT_BINDINGS" ;;
			*RestartCount*)
				traefik_now="$(cat "$FAKE_STATE/traefik-image" 2>/dev/null || echo "$FAKE_OLD_IMAGE")"
				if [ "$FAKE_NOT_RUNNING" = 1 ] && [ "$traefik_now" != "$FAKE_OLD_IMAGE" ]; then echo "false 0"; else echo "true 0"; fi
				;;
			*State.Running*)
				traefik_now="$(cat "$FAKE_STATE/traefik-image" 2>/dev/null || echo "$FAKE_OLD_IMAGE")"
				if [ "$FAKE_NOT_RUNNING" = 1 ] && [ "$traefik_now" != "$FAKE_OLD_IMAGE" ]; then echo false; else echo true; fi
				;;
		esac
		;;
esac
exit 0
`,
	"apt-get": `#!/bin/sh
printf 'apt-get %s\\n' "$*" >> "$CALL_LOG"
case "$1" in
	update)
		[ "$FAKE_UPDATE_FAILS" = 1 ] && exit 1
		;;
	download)
		[ "$FAKE_DOWNLOAD_FAILS" = 1 ] && exit 1
		printf 'fake package\\n' > "\${2%%=*}.deb"
		;;
	install)
		case "$*" in
			*--download-only*)
				[ "$FAKE_PREDOWNLOAD_FAILS" = 1 ] && exit 1
				;;
			*--allow-downgrades*)
				[ "$FAKE_ROLLBACK_FAILS" = 1 ] && exit 1
				printf '%s\\n' "$FAKE_PREVIOUS_ENGINE" > "$FAKE_STATE/engine"
				;;
			*--no-download*)
				if [ "$FAKE_UPGRADE_KEEPS_OLD" != 1 ]; then
					printf '%s\\n' "$FAKE_TARGET_ENGINE" > "$FAKE_STATE/engine"
				fi
				;;
		esac
		;;
esac
exit 0
`,
	"apt-cache": `#!/bin/sh
printf 'apt-cache %s\\n' "$*" >> "$CALL_LOG"
case "$1" in
	madison)
		[ "$FAKE_NO_CANDIDATE" = 1 ] && exit 0
		if [ "$FAKE_CANDIDATE_AFTER_REPO" = 1 ] && [ ! -f "$DOKPLOY_APT_SOURCES_DIR/docker.list" ]; then
			exit 0
		fi
		echo " docker-ce | 5:${PINNED_VERSIONS.docker}-1~ubuntu.24.04~noble | https://download.docker.com/linux/ubuntu noble/stable amd64 Packages"
		;;
	policy)
		case "$2" in
			containerd.io)
				candidate=1.7.27-1
				if [ "$FAKE_CONTAINERD_CHANGES" = 1 ]; then candidate=2.0.0-1; fi
				printf 'containerd.io:\\n  Installed: 1.7.27-1\\n  Candidate: %s\\n' "$candidate"
				;;
			docker-buildx-plugin)
				printf 'docker-buildx-plugin:\\n  Installed: 0.25.0-1~ubuntu.24.04~noble\\n  Candidate: 0.25.0-1~ubuntu.24.04~noble\\n'
				;;
			docker-compose-plugin)
				printf 'docker-compose-plugin:\\n  Installed: 2.40.0-1~ubuntu.24.04~noble\\n  Candidate: 2.40.0-1~ubuntu.24.04~noble\\n'
				;;
		esac
		;;
esac
exit 0
`,
	"dpkg-query": `#!/bin/sh
printf 'dpkg-query %s\\n' "$*" >> "$CALL_LOG"
case "$2" in
	*Status-Status*)
		case "$3" in
			docker-ce) [ "$FAKE_NO_DOCKER_CE" = 1 ] || echo installed ;;
			docker-ce-cli | containerd.io | docker-buildx-plugin | docker-compose-plugin) echo installed ;;
		esac
		;;
	*Version*)
		case "$3" in
			docker-ce | docker-ce-cli | docker-ce-rootless-extras) echo "5:28.3.0-1~ubuntu.24.04~noble" ;;
			containerd.io) echo "1.7.27-1" ;;
			docker-buildx-plugin) echo "0.25.0-1~ubuntu.24.04~noble" ;;
			docker-compose-plugin) echo "2.40.0-1~ubuntu.24.04~noble" ;;
		esac
		;;
esac
exit 0
`,
	dpkg: `#!/bin/sh
echo amd64
`,
	systemctl: `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$CALL_LOG"
`,
	curl: `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$CALL_LOG"
if [ -n "$FAKE_CURL_FAILS_FOR" ]; then
	case "$*" in
		*"$FAKE_CURL_FAILS_FOR"*) exit 22 ;;
	esac
fi
out=""
while [ "$#" -gt 0 ]; do
	if [ "$1" = "-o" ]; then out="$2"; fi
	shift
done
printf '%s\\n' 'echo fake get-docker "$@"' > "$out"
`,
	sudo: `#!/bin/sh
exec "$@"
`,
	sleep: `#!/bin/sh
exit 0
`,
};

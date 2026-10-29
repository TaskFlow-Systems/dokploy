import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);
const installerScript = path.join(repoRoot, "install-agenthits.sh");
const powershellScript = path.join(repoRoot, "install-agenthits.ps1");

const SPAWN_TEST_TIMEOUT_MS = 60_000;

// The update tests run the installer, which waits for Traefik for several seconds.
// The default limit of 5 seconds fails on a loaded CI runner.
vi.setConfig({ testTimeout: SPAWN_TEST_TIMEOUT_MS });

const realPath = (command: string) =>
	spawnSync("sh", ["-c", `command -v ${command}`], {
		encoding: "utf8",
	}).stdout.trim();

const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_CALL_LOG"
case "$1" in
	info)
		case "$*" in
			*Swarm*) echo active ;;
			*) echo 29.8.2 ;;
		esac
		exit 0
		;;
	version)
		cat "$DOCKER_ENGINE_FILE"
		exit 0
		;;
	pull)
		if [ "$2" = "$FAKE_PULL_FAILS_FOR" ]; then exit 1; fi
		exit 0
		;;
	ps)
		case "$*" in
			*"name=dokploy-postgres"*"ancestor="*)
				case "$*" in
					*"ancestor=$FAKE_POSTGRES_IMAGE") echo fake-task-container ;;
				esac
				;;
			*) echo fake-task-container ;;
		esac
		exit 0
		;;
	exec)
		case "$*" in
			*pg_dumpall*)
				if [ "$FAKE_DUMP_FAILS" = 1 ]; then exit 1; fi
				echo "-- fake dump"
				;;
			*redis-cli*)
				echo PONG
				;;
		esac
		exit 0
		;;
	inspect)
		case "$*" in
			*Config.Image*) echo "$FAKE_TRAEFIK_IMAGE" ;;
			*NetworkSettings*) echo "$FAKE_TRAEFIK_NETWORKS" ;;
			*HostConfig.PortBindings*)
				if [ "$FAKE_TRAEFIK_PORT80" = "1" ]; then echo '{"80/tcp":[{"HostIp":"","HostPort":"80"}],"443/tcp":[{"HostIp":"","HostPort":"443"}]}'; fi
				;;
			*RestartCount*)
				traefik_now="$(cat "$DOCKER_TRAEFIK_IMAGE_FILE" 2>/dev/null || echo "$FAKE_TRAEFIK_IMAGE")"
				if [ "$FAKE_TRAEFIK_RUNNING" = "false" ] && [ "$traefik_now" != "$FAKE_TRAEFIK_IMAGE" ]; then echo "false 0"; else echo "true 0"; fi
				;;
			*State.Running*)
				traefik_now="$(cat "$DOCKER_TRAEFIK_IMAGE_FILE" 2>/dev/null || echo "$FAKE_TRAEFIK_IMAGE")"
				if [ "$FAKE_TRAEFIK_RUNNING" = "false" ] && [ "$traefik_now" != "$FAKE_TRAEFIK_IMAGE" ]; then echo false; else echo true; fi
				;;
			*State.Health.Status*) echo healthy ;;
		esac
		exit 0
		;;
	create)
		for traefik_arg in "$@"; do traefik_image_arg="$traefik_arg"; done
		printf '%s\\n' "$traefik_image_arg" > "$DOCKER_TRAEFIK_IMAGE_FILE"
		exit 0
		;;
	network)
		case "$2" in
			inspect)
				case " $FAKE_MISSING_NETWORKS " in *" $3 "*) exit 1 ;; esac
				;;
			connect)
				case " $FAKE_CONNECT_FAILS " in *" $3 "*) exit 1 ;; esac
				;;
		esac
		exit 0
		;;
	service)
		if [ "$2" = "inspect" ]; then
			case "$5" in
				*ContainerSpec.Image*)
					case "$3" in
						dokploy) echo "$FAKE_PANEL_IMAGE" ;;
						dokploy-redis) echo "$FAKE_REDIS_IMAGE" ;;
						dokploy-postgres) echo "$FAKE_POSTGRES_IMAGE" ;;
					esac
					;;
				*ContainerSpec.Env*)
					printf '%s\\n' "RELEASE_TAG=agenthits-dev" "DOKPLOY_OFFICIAL_VERSION=v0.29.8"
					;;
				*Version.Index*)
					cat "$DOCKER_INDEX_FILE"
					;;
				*UpdateStatus.State*)
					if [ "$(cat "$DOCKER_INDEX_FILE")" -gt 1 ]; then echo "$FAKE_UPDATE_STATE"; fi
					;;
			esac
			exit 0
		fi
		if [ "$2" = "update" ]; then
			echo $(( $(cat "$DOCKER_INDEX_FILE") + 1 )) > "$DOCKER_INDEX_FILE"
		fi
		exit 0
		;;
	buildx)
		cat <<'EOF'
Name:      ghcr.io/agenthits/dokploy:agenthits-dev
MediaType: application/vnd.oci.image.index.v1+json
Digest:    sha256:index

Manifests:
  Name:        ghcr.io/agenthits/dokploy:agenthits-dev@sha256:platform
  MediaType:   application/vnd.oci.image.manifest.v1+json
  Platform:    linux/amd64
EOF
		exit 0
		;;
esac
exit 0
`;

const FAKE_APT_GET = `#!/bin/sh
printf 'apt-get %s\\n' "$*" >> "$DOCKER_CALL_LOG"
case "$1" in
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
				printf '%s\\n' "$FAKE_PREVIOUS_ENGINE" > "$DOCKER_ENGINE_FILE"
				;;
			*--no-download*)
				[ "$FAKE_UPGRADE_FAILS" = 1 ] && exit 1
				if [ "$FAKE_UPGRADE_KEEPS_OLD" != 1 ]; then
					printf '%s\\n' "$FAKE_TARGET_ENGINE" > "$DOCKER_ENGINE_FILE"
				fi
				;;
		esac
		;;
esac
exit 0
`;

const FAKE_APT_CACHE = `#!/bin/sh
printf 'apt-cache %s\\n' "$*" >> "$DOCKER_CALL_LOG"
case "$1" in
	madison)
		echo " docker-ce | 5:29.8.2-1~ubuntu.24.04~noble | https://download.docker.com/linux/ubuntu noble/stable amd64 Packages"
		;;
	policy)
		case "$2" in
			containerd.io)
				printf 'containerd.io:\\n  Installed: 1.7.27-1\\n  Candidate: 1.7.27-1\\n'
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
`;

const FAKE_DPKG_QUERY = `#!/bin/sh
printf 'dpkg-query %s\\n' "$*" >> "$DOCKER_CALL_LOG"
case "$2" in
	*Status-Status*)
		case "$3" in
			docker-ce | docker-ce-cli | containerd.io | docker-buildx-plugin | docker-compose-plugin) echo installed ;;
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
`;

const FAKE_SYSTEMCTL = `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$DOCKER_CALL_LOG"
exit 0
`;

const FAKE_CURL = `#!/bin/sh
echo "unexpected curl: $*" >> "$DOCKER_CALL_LOG"
exit 1
`;

const FAKE_ID = `#!/bin/sh
if [ "$1" = "-u" ]; then
	echo 0
	exit 0
fi
exec ${realPath("id")} "$@"
`;

const FAKE_UNAME = `#!/bin/sh
if [ "$1" = "-s" ]; then
	echo Linux
	exit 0
fi
exec ${realPath("uname")} "$@"
`;

const textLines = (...rows: string[]) => `${rows.join("\n")}\n`;

const TLS_TRAEFIK_CONFIG = textLines(
	"certificatesResolvers:",
	"  letsencrypt:",
	"    acme:",
	"      email: ops@example.com",
	"      tlsChallenge: {}",
);

const HTTP_TRAEFIK_CONFIG = textLines(
	"certificatesResolvers:",
	"  letsencrypt:",
	"    acme:",
	"      email: ops@example.com",
	"      httpChallenge:",
	"        entryPoint: web",
);

type OperatorScenario = {
	redisImage?: string;
	postgresImage?: string;
	traefikImage?: string;
	panelImage?: string;
	traefikRunning?: "true" | "false";
	traefikNetworks?: string;
	traefikPublishesPort80?: boolean;
	traefikConfig?: string;
	missingNetworks?: string;
	connectFails?: string;
	updateState?: string;
	pullFailsFor?: string;
	dumpFails?: boolean;
	upgradeEngine?: boolean;
	engineVersion?: string;
	previousEngine?: string;
	upgradeKeepsOld?: boolean;
	upgradeFails?: boolean;
	rollbackFails?: boolean;
	downloadFails?: boolean;
	predownloadFails?: boolean;
	hostCodename?: string;
	repoCodename?: string;
	settleSeconds?: string;
};

const runInstaller = (
	scenario: OperatorScenario = {},
	args: string[] = ["update"],
) => {
	const dir = mkdtempSync(path.join(tmpdir(), "dokploy-operator-update-"));
	try {
		const callLog = path.join(dir, "docker-calls.log");
		const indexFile = path.join(dir, "service-index");
		const engineFile = path.join(dir, "engine");
		const backupDir = path.join(dir, "backups");
		const sourcesDir = path.join(dir, "sources");
		const osRelease = path.join(dir, "os-release");
		const traefikConfig = path.join(dir, "traefik.yml");
		writeFileSync(traefikConfig, scenario.traefikConfig ?? TLS_TRAEFIK_CONFIG);
		writeFileSync(callLog, "");
		writeFileSync(indexFile, "1");
		writeFileSync(engineFile, `${scenario.engineVersion ?? "29.8.2"}\n`);
		writeFileSync(
			osRelease,
			`ID=ubuntu\nVERSION_CODENAME=${scenario.hostCodename ?? "noble"}\n`,
		);
		const sourceFiles = scenario.repoCodename
			? {
					"docker.list": `deb [arch=amd64] https://download.docker.com/linux/ubuntu ${scenario.repoCodename} stable\n`,
				}
			: {};
		mkdirSync(sourcesDir);
		for (const [name, body] of Object.entries(sourceFiles)) {
			writeFileSync(path.join(sourcesDir, name), body);
		}

		const fakes: Record<string, string> = {
			docker: FAKE_DOCKER,
			"apt-get": FAKE_APT_GET,
			"apt-cache": FAKE_APT_CACHE,
			"dpkg-query": FAKE_DPKG_QUERY,
			systemctl: FAKE_SYSTEMCTL,
			curl: FAKE_CURL,
			id: FAKE_ID,
			uname: FAKE_UNAME,
		};
		for (const [name, body] of Object.entries(fakes)) {
			writeFileSync(path.join(dir, name), body);
			chmodSync(path.join(dir, name), 0o755);
		}

		const result = spawnSync("bash", [installerScript, ...args], {
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${dir}:${process.env.PATH}`,
				DOCKER_CALL_LOG: callLog,
				DOCKER_INDEX_FILE: indexFile,
				DOCKER_ENGINE_FILE: engineFile,
				DOCKER_TRAEFIK_IMAGE_FILE: path.join(dir, "traefik-image"),
				AGENTHITS_SKIP_HOST_CHECK: "1",
				DOKPLOY_BACKUP_DIR: backupDir,
				DOKPLOY_APT_SOURCES_DIR: sourcesDir,
				DOKPLOY_OS_RELEASE: osRelease,
				TRAEFIK_CONFIG_FILE: traefikConfig,
				DOCKER_ENGINE_UPGRADE: scenario.upgradeEngine ? "1" : "0",
				AGENTHITS_PULL_RETRY_DELAY: "0",
				DOKPLOY_HEALTH_INTERVAL: "0",
				DOKPLOY_HEALTH_TIMEOUT: "2",
				DOKPLOY_DOCKER_VERIFY_TIMEOUT: "2",
				DOKPLOY_TRAEFIK_SETTLE: scenario.settleSeconds ?? "0",
				REDIS_IMAGE: "redis:8.10.2",
				POSTGRES_IMAGE: "postgres:18.6",
				TRAEFIK_IMAGE: "traefik:v3.7.14",
				DOCKER_VERSION: "29.8.2",
				FAKE_REDIS_IMAGE: scenario.redisImage ?? "redis:8.10.2",
				FAKE_POSTGRES_IMAGE: scenario.postgresImage ?? "postgres:18.6",
				FAKE_TRAEFIK_IMAGE: scenario.traefikImage ?? "traefik:v3.7.14",
				FAKE_PANEL_IMAGE:
					scenario.panelImage ??
					"ghcr.io/agenthits/dokploy:agenthits-dev@sha256:index",
				FAKE_TRAEFIK_RUNNING: scenario.traefikRunning ?? "true",
				FAKE_TRAEFIK_NETWORKS:
					scenario.traefikNetworks ?? "bridge dokploy-network",
				FAKE_TRAEFIK_PORT80: scenario.traefikPublishesPort80 ? "1" : "0",
				FAKE_MISSING_NETWORKS: scenario.missingNetworks ?? "",
				FAKE_CONNECT_FAILS: scenario.connectFails ?? "",
				FAKE_UPDATE_STATE: scenario.updateState ?? "completed",
				FAKE_PULL_FAILS_FOR: scenario.pullFailsFor ?? "",
				FAKE_DUMP_FAILS: scenario.dumpFails ? "1" : "0",
				FAKE_PREVIOUS_ENGINE: scenario.previousEngine ?? "28.3.0",
				FAKE_TARGET_ENGINE: "29.8.2",
				FAKE_UPGRADE_KEEPS_OLD: scenario.upgradeKeepsOld ? "1" : "0",
				FAKE_UPGRADE_FAILS: scenario.upgradeFails ? "1" : "0",
				FAKE_ROLLBACK_FAILS: scenario.rollbackFails ? "1" : "0",
				FAKE_DOWNLOAD_FAILS: scenario.downloadFails ? "1" : "0",
				FAKE_PREDOWNLOAD_FAILS: scenario.predownloadFails ? "1" : "0",
			},
		});

		const calls = readFileSync(callLog, "utf8").split("\n").filter(Boolean);
		const backups = (() => {
			try {
				return readdirSync(backupDir);
			} catch {
				return [];
			}
		})();
		const backupEntries = backups.map((name) => {
			const entry = path.join(backupDir, name);
			const stat = statSync(entry);
			return {
				name,
				mode: stat.mode & 0o777,
				files: stat.isDirectory()
					? readdirSync(entry).map((file) => ({
							name: file,
							mode: statSync(path.join(entry, file)).mode & 0o777,
						}))
					: [],
			};
		});
		const backupModes = backups.map(
			(name) => statSync(path.join(backupDir, name)).mode & 0o777,
		);
		const configBackup = readdirSync(dir).find((name) =>
			name.includes(".bak-"),
		);
		return {
			result,
			calls,
			backups,
			backupModes,
			backupEntries,
			configText: readFileSync(traefikConfig, "utf8"),
			configBackupText: configBackup
				? readFileSync(path.join(dir, configBackup), "utf8")
				: undefined,
		};
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
};

const firstIndex = (calls: string[], prefix: string) =>
	calls.findIndex((call) => call.startsWith(prefix));

const shellFunctionText = (script: string, name: string) => {
	const lines = script.split("\n");
	const start = lines.indexOf(`${name}() {`);
	const end = lines.indexOf("}", start);
	return lines.slice(start, end + 1).join("\n");
};

const DOCKER_NEW = "5:29.8.2-1~ubuntu.24.04~noble";
const DOCKER_OLD = "5:28.3.0-1~ubuntu.24.04~noble";

describe("install-agenthits.sh update", () => {
	it(
		"changes nothing when every pinned image is already running",
		() => {
			const { result, calls, backups } = runInstaller();

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("Traefik already runs");
			expect(result.stdout).toContain("already up to date");
			expect(calls.some((call) => call.startsWith("service update"))).toBe(
				false,
			);
			expect(calls.some((call) => call.startsWith("create --name"))).toBe(
				false,
			);
			expect(backups).toEqual([]);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"pre-downloads every image before any service is touched",
		() => {
			const { result, calls } = runInstaller({
				pullFailsFor: "traefik:v3.7.14",
				redisImage: "redis:8.10.1",
				traefikImage: "traefik:v3.6.25",
			});

			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(
				"Pre-download failed: traefik:v3.7.14. Nothing was changed.",
			);
			expect(calls.some((call) => call.startsWith("service update"))).toBe(
				false,
			);
			expect(calls.some((call) => call.startsWith("stop "))).toBe(false);
			expect(calls.some((call) => call.startsWith("create --name"))).toBe(
				false,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"backs up Postgres and swaps Redis, Traefik, Postgres, then the panel, in that order",
		() => {
			const { result, calls, backups, backupModes } = runInstaller({
				redisImage: "redis:8.10.1",
				postgresImage: "postgres:18.5",
				traefikImage: "traefik:v3.6.25",
			});

			expect(result.status).toBe(0);
			expect(backups).toHaveLength(1);
			expect(backupModes).toEqual([0o600]);
			expect(backups[0]).toMatch(/^postgres-.*\.sql\.gz$/);

			const backup = firstIndex(calls, "ps -q");
			const redis = firstIndex(
				calls,
				"service update --detach --update-order stop-first --update-failure-action rollback --image redis:8.10.2 dokploy-redis",
			);
			const traefikStop = firstIndex(calls, "stop dokploy-traefik");
			const traefikRemove = firstIndex(calls, "rm dokploy-traefik");
			const traefikCreate = firstIndex(calls, "create --name dokploy-traefik");
			const traefikStart = firstIndex(calls, "start dokploy-traefik");
			const postgres = firstIndex(
				calls,
				"service update --detach --update-order stop-first --update-failure-action rollback --image postgres:18.6 dokploy-postgres",
			);
			const panel = firstIndex(calls, "buildx imagetools inspect");
			const lastPull = Math.max(
				...calls.map((call, index) => (call.startsWith("pull ") ? index : -1)),
			);

			for (const step of [
				backup,
				redis,
				traefikStop,
				traefikRemove,
				traefikCreate,
				traefikStart,
				postgres,
				panel,
			]) {
				expect(step).toBeGreaterThanOrEqual(0);
			}
			expect(lastPull).toBeLessThan(backup);
			expect(backup).toBeLessThan(redis);
			expect(redis).toBeLessThan(traefikStop);
			expect(traefikStop).toBeLessThan(traefikRemove);
			expect(traefikRemove).toBeLessThan(traefikCreate);
			expect(traefikCreate).toBeLessThan(traefikStart);
			expect(traefikStart).toBeLessThan(postgres);
			expect(postgres).toBeLessThan(panel);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
	it(
		"stops before any swap when the Postgres backup fails",
		() => {
			const { result, calls } = runInstaller({
				postgresImage: "postgres:18.5",
				redisImage: "redis:8.10.1",
				dumpFails: true,
			});

			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("Nothing was changed");
			expect(calls.some((call) => call.startsWith("service update"))).toBe(
				false,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"stops the update when swarm rolls Redis back",
		() => {
			const { result, calls } = runInstaller({
				redisImage: "redis:8.10.1",
				postgresImage: "postgres:18.5",
				updateState: "rollback_completed",
			});

			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("swarm state: rollback_completed");
			expect(
				calls.some((call) => call.startsWith("stop dokploy-traefik")),
			).toBe(false);
			expect(
				calls.some(
					(call) =>
						call.startsWith("service update") &&
						call.includes("dokploy-postgres"),
				),
			).toBe(false);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"restores the previous Traefik image when the new one is not running",
		() => {
			const { result, calls } = runInstaller({
				traefikImage: "traefik:v3.6.25",
				traefikRunning: "false",
			});

			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(
				"Error: Traefik update failed while checking the new Traefik container",
			);
			expect(result.stderr).toContain(
				"The previous Traefik container is running again.",
			);
			const recreated = calls.filter((call) =>
				call.startsWith("create --name dokploy-traefik"),
			);
			expect(recreated).toHaveLength(2);
			expect(recreated[1]?.endsWith("traefik:v3.6.25")).toBe(true);
			expect(calls.some((call) => call.startsWith("service update"))).toBe(
				false,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
	it(
		"reconnects every network of the old Traefik container before the new one starts",
		() => {
			const { result, calls } = runInstaller({
				traefikImage: "traefik:v3.6.25",
				traefikNetworks: "bridge dokploy-network app-a app-b",
			});

			expect(result.status).toBe(0);
			const connected = (network: string) =>
				calls.indexOf(`network connect ${network} dokploy-traefik`);
			const start = calls.indexOf("start dokploy-traefik");
			expect(connected("app-a")).toBeGreaterThanOrEqual(0);
			expect(connected("app-b")).toBeGreaterThanOrEqual(0);
			expect(connected("app-a")).toBeLessThan(start);
			expect(connected("app-b")).toBeLessThan(start);
			expect(
				calls.some((call) => call.startsWith("network connect bridge")),
			).toBe(false);
			expect(
				calls.filter(
					(call) => call === "network connect dokploy-network dokploy-traefik",
				),
			).toHaveLength(1);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"skips a Traefik network that no longer exists",
		() => {
			const { result, calls } = runInstaller({
				traefikImage: "traefik:v3.6.25",
				traefikNetworks: "app-a app-b",
				missingNetworks: "app-b",
			});

			expect(result.status).toBe(0);
			expect(calls).toContain("network connect app-a dokploy-traefik");
			expect(calls).not.toContain("network connect app-b dokploy-traefik");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"reports the failed step when a network cannot be connected and the old container cannot be restored",
		() => {
			const { result, calls } = runInstaller({
				traefikImage: "traefik:v3.6.25",
				traefikNetworks: "app-a",
				connectFails: "app-a",
			});

			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(
				"Error: Traefik update failed while creating the new Traefik container and connecting its networks.",
			);
			expect(result.stderr).toContain("failed as well");
			expect(
				calls.some(
					(call) =>
						call.startsWith("create --name dokploy-traefik") &&
						call.endsWith("traefik:v3.6.25"),
				),
			).toBe(true);
			expect(calls.some((call) => call.startsWith("service update"))).toBe(
				false,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
	it(
		"keeps an installed Postgres whose major differs from the pin and runs the other steps",
		() => {
			const { result, calls, backups } = runInstaller({
				postgresImage: "postgres:17.5",
				redisImage: "redis:8.10.1",
				traefikImage: "traefik:v3.6.25",
			});

			expect(result.status).toBe(0);
			expect(result.stdout).toContain(
				"Postgres 17 stays. A major upgrade is a separate migration; this update does not change it.",
			);
			expect(result.stderr).not.toContain("changes the major version");
			expect(backups).toEqual([]);
			expect(calls.some((call) => call.includes("pg_dumpall"))).toBe(false);
			expect(calls).not.toContain("pull postgres:18.6");
			expect(
				calls.some(
					(call) =>
						call.startsWith("service update") &&
						call.includes("dokploy-postgres"),
				),
			).toBe(false);

			const redis = firstIndex(
				calls,
				"service update --detach --update-order stop-first --update-failure-action rollback --image redis:8.10.2 dokploy-redis",
			);
			const traefikStop = firstIndex(calls, "stop dokploy-traefik");
			const traefikStart = firstIndex(calls, "start dokploy-traefik");
			const panel = firstIndex(calls, "buildx imagetools inspect");
			expect(redis).toBeGreaterThanOrEqual(0);
			expect(redis).toBeLessThan(traefikStop);
			expect(traefikStop).toBeLessThan(traefikStart);
			expect(traefikStart).toBeLessThan(panel);
			expect(result.stdout).toContain("Panel host update finished.");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
});

describe("install-agenthits.sh Docker Engine upgrade", () => {
	it(
		"leaves the Docker Engine alone unless DOCKER_ENGINE_UPGRADE=1",
		() => {
			const { result, calls } = runInstaller({ engineVersion: "28.3.0" });

			expect(result.status).toBe(0);
			expect(calls.some((call) => call.startsWith("apt-get"))).toBe(false);
			expect(calls.some((call) => call.startsWith("systemctl"))).toBe(false);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"does nothing when the Engine already runs the pinned version",
		() => {
			const { result, calls } = runInstaller({ upgradeEngine: true });

			expect(result.status).toBe(0);
			expect(calls.some((call) => call.startsWith("apt-get"))).toBe(false);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"saves the current Docker packages before the Engine is changed",
		() => {
			const { result, calls, backupEntries } = runInstaller({
				upgradeEngine: true,
				engineVersion: "28.3.0",
			});

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("Docker Engine is 29.8.2");
			const save = calls.indexOf(`apt-get download docker-ce=${DOCKER_OLD}`);
			const predownload = calls.indexOf(
				`apt-get install -y -qq --download-only docker-ce=${DOCKER_NEW} docker-ce-cli=${DOCKER_NEW} containerd.io docker-buildx-plugin docker-compose-plugin`,
			);
			const install = calls.indexOf(
				`apt-get install -y -qq --no-download docker-ce=${DOCKER_NEW} docker-ce-cli=${DOCKER_NEW} containerd.io docker-buildx-plugin docker-compose-plugin`,
			);
			expect(save).toBeGreaterThanOrEqual(0);
			expect(save).toBeLessThan(predownload);
			expect(predownload).toBeLessThan(install);
			expect(calls).toContain(`apt-get download docker-ce-cli=${DOCKER_OLD}`);
			expect(
				calls.some((call) => call.startsWith("apt-get download containerd.io")),
			).toBe(false);
			expect(backupEntries).toHaveLength(1);
			expect(backupEntries[0]?.name).toMatch(/^docker-rollback-\d{8}T\d{6}Z$/);
			expect(backupEntries[0]?.mode).toBe(0o700);
			expect(backupEntries[0]?.files.map((file) => file.name).sort()).toEqual([
				"docker-ce-cli.deb",
				"docker-ce.deb",
			]);
			expect(backupEntries[0]?.files.every((file) => file.mode === 0o600)).toBe(
				true,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"finishes the Docker Engine upgrade while Postgres keeps its major version",
		() => {
			const { result, calls } = runInstaller({
				postgresImage: "postgres:17.5",
				upgradeEngine: true,
				engineVersion: "28.3.0",
			});

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("Postgres 17 stays.");
			expect(result.stdout).toContain("Docker Engine is 29.8.2");
			expect(result.stdout).toContain("Panel host update finished.");
			expect(result.stderr).not.toContain("rolled back");
			expect(
				calls.includes(
					`apt-get install -y -qq --no-download docker-ce=${DOCKER_NEW} docker-ce-cli=${DOCKER_NEW} containerd.io docker-buildx-plugin docker-compose-plugin`,
				),
			).toBe(true);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"stops before any change when a current Docker package cannot be saved",
		() => {
			const { result, calls, backupEntries } = runInstaller({
				upgradeEngine: true,
				engineVersion: "28.3.0",
				downloadFails: true,
			});

			expect(result.status).not.toBe(0);
			expect(
				backupEntries.some((entry) =>
					entry.name.startsWith("docker-rollback-"),
				),
			).toBe(false);
			expect(result.stderr).toContain(
				"Pre-download failed: current Docker packages for rollback. Nothing was changed.",
			);
			expect(calls.some((call) => call.startsWith("apt-get install"))).toBe(
				false,
			);
			expect(calls.some((call) => call.startsWith("service update"))).toBe(
				false,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"refuses to upgrade when the Docker apt repository is for another release",
		() => {
			const { result, calls, backups } = runInstaller({
				upgradeEngine: true,
				engineVersion: "28.3.0",
				hostCodename: "noble",
				repoCodename: "jammy",
			});

			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("is for jammy, but this host runs noble");
			expect(result.stderr).toContain("Nothing was changed");
			expect(calls.some((call) => call.startsWith("apt-get"))).toBe(false);
			expect(backups).toEqual([]);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"rolls the Engine back when the upgraded host does not report the pinned version",
		() => {
			const { result, calls, backupEntries } = runInstaller({
				upgradeEngine: true,
				engineVersion: "28.3.0",
				upgradeKeepsOld: true,
			});

			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(
				"Docker Engine was rolled back to 28.3.0",
			);
			const rollbackDir = backupEntries[0]?.name ?? "";
			expect(result.stderr).toContain(rollbackDir);
			expect(
				calls.some(
					(call) =>
						call.startsWith(
							"apt-get install -y --allow-downgrades --no-download ",
						) && call.includes(rollbackDir),
				),
			).toBe(true);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"rolls the Engine back when the upgrade install itself fails",
		() => {
			const { result, calls } = runInstaller({
				upgradeEngine: true,
				engineVersion: "28.3.0",
				upgradeFails: true,
			});

			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(
				"installing the pre-downloaded Docker packages failed",
			);
			expect(result.stderr).toContain(
				"Docker Engine was rolled back to 28.3.0",
			);
			expect(
				calls.some((call) =>
					call.startsWith("apt-get install -y --allow-downgrades"),
				),
			).toBe(true);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"prints the commands for a manual rollback when the rollback itself fails",
		() => {
			const { result } = runInstaller({
				upgradeEngine: true,
				engineVersion: "28.3.0",
				upgradeKeepsOld: true,
				rollbackFails: true,
			});

			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(
				"the Docker Engine rollback did not finish",
			);
			expect(result.stderr).toContain(
				"apt-get install -y --allow-downgrades --no-download",
			);
			expect(result.stderr).toContain("docker-rollback-");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
	it(
		"removes the saved packages when the new packages cannot be downloaded, then aborts",
		() => {
			const { result, calls, backupEntries } = runInstaller({
				upgradeEngine: true,
				engineVersion: "28.3.0",
				predownloadFails: true,
			});

			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(
				"Pre-download failed: the Docker packages. Nothing was changed.",
			);
			expect(
				backupEntries.some((entry) =>
					entry.name.startsWith("docker-rollback-"),
				),
			).toBe(false);
			expect(calls.some((call) => call.startsWith("service update"))).toBe(
				false,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
});

describe("install-agenthits.sh Traefik and host settings", () => {
	it("keeps /etc/dokploy readable by others but not writable", () => {
		const installer = readFileSync(installerScript, "utf8");

		expect(installer).toContain("chmod 755 /etc/dokploy\n");
		expect(installer).not.toContain("chmod 777");
	});

	it("defaults DOCKER_ENGINE_UPGRADE to off", () => {
		const installer = readFileSync(installerScript, "utf8");

		expect(installer).toContain(
			'DOCKER_ENGINE_UPGRADE="${DOCKER_ENGINE_UPGRADE:-0}"',
		);
	});

	it("passes DOCKER_ENGINE_UPGRADE through the macOS and WSL launchers", () => {
		const installer = readFileSync(installerScript, "utf8");
		const powershell = readFileSync(powershellScript, "utf8");
		const passthrough = installer.slice(
			installer.indexOf("PASSTHROUGH_VARS=("),
			installer.indexOf(")", installer.indexOf("PASSTHROUGH_VARS=(")),
		);
		const wslPassthrough = powershell.slice(
			powershell.indexOf("$PassthroughVars = @("),
			powershell.indexOf(")", powershell.indexOf("$PassthroughVars = @(")),
		);

		expect(passthrough).toContain("DOCKER_ENGINE_UPGRADE");
		expect(wslPassthrough).toContain("'DOCKER_ENGINE_UPGRADE'");
	});

	it("keeps the Docker rollback path in the installer", () => {
		const installer = readFileSync(installerScript, "utf8");

		expect(installer).toContain(
			"apt-get install -y --allow-downgrades --no-download",
		);
		expect(installer).toContain("docker-rollback-");
	});

	it("reattaches the Traefik networks, starts the new container last, and never renames", () => {
		const installer = readFileSync(installerScript, "utf8");
		const swap = installer.slice(installer.indexOf("swap_dokploy_traefik() {"));
		const order = [
			swap.indexOf("docker stop dokploy-traefik"),
			swap.indexOf("docker rm dokploy-traefik"),
			swap.indexOf('create_dokploy_traefik "$TRAEFIK_IMAGE" no'),
			swap.indexOf("docker start dokploy-traefik >/dev/null"),
			swap.indexOf("docker update --restart always dokploy-traefik"),
		];

		expect(order.every((position) => position >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(installer).toContain(
			'docker network connect "$network" dokploy-traefik',
		);
		expect(installer).not.toContain("docker rename");
		expect(installer).not.toContain("docker run -d");
	});
});

describe("install-agenthits.sh Traefik restart policy", () => {
	it("creates the new Traefik with --restart no and raises the policy only after the check", () => {
		const { result, calls } = runInstaller({ traefikImage: "traefik:v3.6.25" });

		expect(result.status).toBe(0);
		const created =
			calls.find((call) => call.startsWith("create --name dokploy-traefik")) ??
			"";
		expect(created).toContain("--restart no");
		expect(calls.some((call) => call.startsWith("update --restart no"))).toBe(
			false,
		);
		expect(
			calls.indexOf("update --restart always dokploy-traefik"),
		).toBeGreaterThan(calls.indexOf("start dokploy-traefik"));
	});
	it("restores --restart always on the Traefik it puts back", () => {
		const { result, calls } = runInstaller({
			traefikImage: "traefik:v3.6.25",
			traefikRunning: "false",
		});

		expect(result.status).not.toBe(0);
		const restore = calls.indexOf("update --restart always dokploy-traefik");
		expect(restore).toBeGreaterThanOrEqual(0);
		expect(restore).toBeLessThan(calls.lastIndexOf("start dokploy-traefik"));
	});
});

describe("install-agenthits launchers", () => {
	it("passes the same settings through the macOS and WSL launchers", () => {
		const installer = readFileSync(installerScript, "utf8");
		const powershell = readFileSync(powershellScript, "utf8");
		const macos = installer.slice(
			installer.indexOf("PASSTHROUGH_VARS=("),
			installer.indexOf("\n)", installer.indexOf("PASSTHROUGH_VARS=(")),
		);
		const wsl = powershell.slice(
			powershell.indexOf("$PassthroughVars = @("),
			powershell.indexOf("\n)", powershell.indexOf("$PassthroughVars = @(")),
		);
		const macosSettings = [...macos.matchAll(/^\s*([A-Z][A-Z0-9_]*)$/gm)]
			.map((match) => match[1])
			.sort();
		const wslSettings = [...wsl.matchAll(/'([A-Z][A-Z0-9_]*)'/g)]
			.map((match) => match[1])
			.sort();

		expect(macosSettings).toContain("DOCKER_ENGINE_UPGRADE");
		expect(wslSettings).toEqual(macosSettings);
	});
});

describe("install-agenthits.sh toolchain downloads", () => {
	const installer = readFileSync(installerScript, "utf8");
	const helperText = () => {
		const start = installer.indexOf("run_install_script() {");
		return installer.slice(start, installer.indexOf("\n}\n", start) + 3);
	};
	const FAKE_INSTALL_CURL = `#!/bin/sh
if [ "$FAKE_CURL_MODE" = fail ]; then exit 22; fi
case "$FAKE_CURL_MODE" in
	fail-for:*)
		case "$*" in
			*"\${FAKE_CURL_MODE#fail-for:}"*) exit 22 ;;
		esac
		;;
esac
out=""
while [ "$#" -gt 0 ]; do
	if [ "$1" = "-o" ]; then out="$2"; fi
	shift
done
printf '%s\\n' 'echo fake nixpacks "$NIXPACKS_VERSION"' > "$out"
`;

	// "fail-for:<text>" fails only the downloads whose URL contains <text>.
	const runHelper = (
		args: string[],
		curlMode: "ok" | "fail" | `fail-for:${string}`,
	) => {
		const dir = mkdtempSync(path.join(tmpdir(), "dokploy-install-script-"));
		try {
			const binDir = path.join(dir, "bin");
			mkdirSync(binDir);
			for (const tool of ["bash", "env", "mktemp", "rm"]) {
				symlinkSync(realPath(tool), path.join(binDir, tool));
			}
			const curl = path.join(dir, "curl");
			writeFileSync(curl, FAKE_INSTALL_CURL);
			chmodSync(curl, 0o755);
			const traefikConfig = path.join(dir, "traefik.yml");
			writeFileSync(traefikConfig, TLS_TRAEFIK_CONFIG);
			const script = [
				"set -euo pipefail",
				helperText(),
				`run_install_script ${args.join(" ")}`,
			].join("\n");
			return spawnSync(realPath("bash"), [], {
				input: script,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${dir}:${binDir}`,
					FAKE_CURL_MODE: curlMode,
					TRAEFIK_CONFIG_FILE: traefikConfig,
				},
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	it("does not pipe the Nixpacks and Railpack install scripts into bash", () => {
		expect(installer).toContain(
			'run_install_script https://nixpacks.com/install.sh Nixpacks "NIXPACKS_VERSION=$NIXPACKS_VERSION"',
		);
		expect(installer).toContain(
			'run_install_script https://railpack.com/install.sh Railpack "RAILPACK_VERSION=$RAILPACK_VERSION" \\\n\t\t\thttps://raw.githubusercontent.com/railwayapp/railpack/refs/heads/main/install.sh',
		);
		expect(installer).not.toContain('bash -c "$(curl');
	});

	it("stops the install when the install script cannot be downloaded", () => {
		const result = runHelper(
			[
				"https://nixpacks.com/install.sh",
				"Nixpacks",
				"NIXPACKS_VERSION=29.4.0",
			],
			"fail",
		);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(
			"the Nixpacks install script could not be downloaded or checked",
		);
	});

	it("downloads the install script from the fallback URL when the first one fails", () => {
		const result = runHelper(
			[
				"https://railpack.com/install.sh",
				"Railpack",
				"NIXPACKS_VERSION=29.4.0",
				"https://raw.githubusercontent.com/railwayapp/railpack/refs/heads/main/install.sh",
			],
			"fail-for:railpack.com",
		);

		expect(result.status).toBe(0);
		expect(result.stderr).toContain(
			"The Railpack install script could not be downloaded or checked from https://railpack.com/install.sh.",
		);
		expect(result.stdout).toContain("fake nixpacks 29.4.0");
	});

	it("stops the install when the fallback URL fails too", () => {
		const result = runHelper(
			[
				"https://railpack.com/install.sh",
				"Railpack",
				"NIXPACKS_VERSION=29.4.0",
				"https://raw.githubusercontent.com/railwayapp/railpack/refs/heads/main/install.sh",
			],
			"fail-for:install.sh",
		);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(
			"the Railpack install script could not be downloaded or checked; Railpack was not installed.",
		);
	});

	it("runs the downloaded install script with the pinned version", () => {
		const result = runHelper(
			[
				"https://nixpacks.com/install.sh",
				"Nixpacks",
				"NIXPACKS_VERSION=29.4.0",
			],
			"ok",
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("fake nixpacks 29.4.0");
	});
});

describe("install-agenthits.sh Docker rollback restart policy", () => {
	it("resets Traefik's restart policy before the Docker rollback starts it", () => {
		const installer = readFileSync(installerScript, "utf8");
		const rollback = installer.slice(
			installer.indexOf("rollback_docker_engine() {"),
			installer.indexOf("fail_docker_engine_upgrade() {"),
		);

		const reset = rollback.indexOf(
			"docker update --restart always dokploy-traefik",
		);
		expect(reset).toBeGreaterThanOrEqual(0);
		expect(reset).toBeLessThan(
			rollback.indexOf("docker start dokploy-traefik"),
		);
	});

	it("resets Traefik's restart policy during the Docker rollback", () => {
		const { result, calls } = runInstaller({
			upgradeEngine: true,
			engineVersion: "28.3.0",
			upgradeKeepsOld: true,
		});

		expect(result.status).not.toBe(0);
		expect(calls).toContain("update --restart always dokploy-traefik");
	});
});

describe("install-agenthits.sh Docker verification window", () => {
	it("checks Docker within DOKPLOY_DOCKER_VERIFY_TIMEOUT, 120 seconds by default", () => {
		const installer = readFileSync(installerScript, "utf8");
		const rollback = installer.slice(
			installer.indexOf("rollback_docker_engine() {"),
			installer.indexOf("fail_docker_engine_upgrade() {"),
		);
		const upgrade = installer.slice(
			installer.indexOf("upgrade_docker_engine() {"),
			installer.indexOf("# Order: Redis, Traefik, Postgres"),
		);

		expect(installer).toContain(
			'DOKPLOY_DOCKER_VERIFY_TIMEOUT="${DOKPLOY_DOCKER_VERIFY_TIMEOUT:-120}"',
		);
		for (const section of [rollback, upgrade]) {
			expect(section).toContain('wait_within "$DOKPLOY_DOCKER_VERIFY_TIMEOUT"');
			expect(section).not.toContain("DOKPLOY_HEALTH_TIMEOUT");
		}
	});

	it("passes DOKPLOY_DOCKER_VERIFY_TIMEOUT through the macOS and WSL launchers", () => {
		const installer = readFileSync(installerScript, "utf8");
		const powershell = readFileSync(powershellScript, "utf8");
		const macos = installer.slice(
			installer.indexOf("PASSTHROUGH_VARS=("),
			installer.indexOf("\n)", installer.indexOf("PASSTHROUGH_VARS=(")),
		);
		const wsl = powershell.slice(
			powershell.indexOf("$PassthroughVars = @("),
			powershell.indexOf("\n)", powershell.indexOf("$PassthroughVars = @(")),
		);

		expect(macos).toContain("DOKPLOY_DOCKER_VERIFY_TIMEOUT");
		expect(wsl).toContain("'DOKPLOY_DOCKER_VERIFY_TIMEOUT'");
	});
});

const PORT_80_PUBLICATION =
	/(?:-p|--publish)[=\s]+\S*\b80\b|published=80\b|\b80\/tcp\b/;

describe("install-agenthits.sh publishes no port 80", () => {
	it(
		"creates the Traefik container with HTTPS and HTTP/3 and never port 80",
		() => {
			const { result, calls } = runInstaller({
				traefikImage: "traefik:v3.6.25",
			});

			expect(result.status).toBe(0);
			const created = calls.filter((call) =>
				call.startsWith("create --name dokploy-traefik"),
			);
			expect(created).not.toHaveLength(0);
			for (const call of created) {
				expect(call).not.toMatch(PORT_80_PUBLICATION);
				expect(call).toContain("-p 443:443/tcp");
				expect(call).toContain("-p 443:443/udp");
			}
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"replaces Traefik with the same image when the running one still publishes port 80",
		() => {
			const { result, calls } = runInstaller({
				traefikImage: "traefik:v3.7.14",
				traefikPublishesPort80: true,
			});

			expect(result.status).toBe(0);
			expect(result.stdout).not.toContain("Traefik already runs");
			expect(result.stdout).toContain("Traefik runs traefik:v3.7.14");
			const created = calls.filter((call) =>
				call.startsWith("create --name dokploy-traefik"),
			);
			expect(created).toHaveLength(1);
			expect(created[0]).not.toMatch(PORT_80_PUBLICATION);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it("keeps port 80 out of the static Traefik config, the firewall and the preflight checks", () => {
		const installer = readFileSync(installerScript, "utf8");
		const defaults = shellFunctionText(
			installer,
			"create_default_traefik_files",
		);

		expect(defaults).toContain("tlsChallenge: {}");
		expect(defaults).not.toContain("httpChallenge");
		expect(installer).not.toContain("TRAEFIK_HTTP_PUBLISH");
		expect(installer).not.toMatch(/ufw allow 80\//);
		expect(installer).not.toMatch(/require_free_port 80\b/);
	});
});

describe("install-agenthits.sh Traefik settle check", () => {
	it("polls the new Traefik once a second over the settle time, then checks it once more", () => {
		const installer = readFileSync(installerScript, "utf8");

		expect(installer).toContain("traefik_wait_settled() {");
		expect(installer).toContain("if ! traefik_wait_settled; then");
		expect(installer).not.toContain('sleep "$DOKPLOY_TRAEFIK_SETTLE"');
	});

	it(
		"checks the new Traefik once a second over the settle time, then once more",
		() => {
			const { result, calls } = runInstaller({
				traefikImage: "traefik:v3.6.25",
				settleSeconds: "2",
			});

			expect(result.status).toBe(0);
			const checks = calls.filter((call) =>
				call.startsWith(
					"inspect --format {{.State.Running}} {{.RestartCount}}",
				),
			);
			expect(checks).toHaveLength(3);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"stops at the first check that finds the new Traefik not running",
		() => {
			const { result, calls } = runInstaller({
				traefikImage: "traefik:v3.6.25",
				traefikRunning: "false",
				settleSeconds: "10",
			});

			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(
				"while checking the new Traefik container",
			);
			const checks = calls.filter((call) =>
				call.startsWith(
					"inspect --format {{.State.Running}} {{.RestartCount}}",
				),
			);
			expect(checks).toHaveLength(2);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
});

const runMigrateTraefikAcme = (
	config: string | null,
	{
		passPath = true,
		failWrite = false,
	}: { passPath?: boolean; failWrite?: boolean } = {},
) => {
	const installer = readFileSync(installerScript, "utf8");
	const dir = mkdtempSync(path.join(tmpdir(), "traefik-acme-"));
	try {
		const configPath = path.join(dir, "traefik.yml");
		if (config !== null) {
			writeFileSync(configPath, config);
		}
		const scriptPath = path.join(dir, "migrate.sh");
		const failingCat = failWrite
			? 'cat() {\n\tcase "$1" in\n\t\t*.tmp) return 1 ;;\n\t\t*) command cat "$@" ;;\n\tesac\n}\n'
			: "";
		writeFileSync(
			scriptPath,
			`set -eu\n${failingCat}${shellFunctionText(installer, "migrate_traefik_acme_to_tls")}\nmigrate_traefik_acme_to_tls${passPath ? ' "$1"' : ""}\n`,
		);
		const result = spawnSync("/bin/bash", [scriptPath, configPath], {
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `/bin:/usr/bin:${process.env.PATH}`,
				TRAEFIK_CONFIG_FILE: configPath,
			},
		});
		const entries = readdirSync(dir).sort();
		const backupName = entries.find((name) => name.includes(".bak-"));
		return {
			result,
			configText: existsSync(configPath)
				? readFileSync(configPath, "utf8")
				: null,
			entries,
			backupName,
			backupBytes: backupName ? readFileSync(path.join(dir, backupName)) : null,
		};
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
};

const runDirectoryGuard = (target: string) => {
	const installer = readFileSync(installerScript, "utf8");
	const lines = installer.split("\n");
	const start = lines.indexOf('\tif [ -d "$TRAEFIK_CONFIG_FILE" ]; then');
	const end = lines.indexOf("\tfi", start);
	const dir = mkdtempSync(path.join(tmpdir(), "traefik-guard-"));
	try {
		const scriptPath = path.join(dir, "guard.sh");
		writeFileSync(
			scriptPath,
			`set -eu\nTRAEFIK_CONFIG_FILE="$1"\n${lines.slice(start, end + 1).join("\n")}\n`,
		);
		return spawnSync("/bin/bash", [scriptPath, target], {
			encoding: "utf8",
			env: { ...process.env, PATH: `/bin:/usr/bin:${process.env.PATH}` },
		});
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
};

describe("install-agenthits.sh Traefik ACME migration", () => {
	it("runs the migration after the trap and before the old Traefik container is stopped", () => {
		const installer = readFileSync(installerScript, "utf8");
		const swap = shellFunctionText(installer, "swap_dokploy_traefik");
		const trap = swap.indexOf(
			"trap 'traefik_restore \"being interrupted\"' HUP INT TERM",
		);
		const migrate = swap.indexOf(
			'if ! migrate_traefik_acme_to_tls; then traefik_restore "converting the Traefik config to tlsChallenge"; fi',
		);
		const stop = swap.indexOf("docker stop dokploy-traefik");

		expect(trap).toBeGreaterThanOrEqual(0);
		expect(migrate).toBeGreaterThan(trap);
		expect(stop).toBeGreaterThan(migrate);
	});

	it("skips the early return when the config still has httpChallenge or the container publishes port 80", () => {
		const installer = readFileSync(installerScript, "utf8");
		const swap = shellFunctionText(installer, "swap_dokploy_traefik");

		expect(swap).toContain('TRAEFIK_ACME_BACKUP=""');
		expect(swap).toContain(
			"! grep -q '^[[:space:]]*httpChallenge:' \"$TRAEFIK_CONFIG_FILE\" 2>/dev/null",
		);
		expect(swap).toContain(
			`! docker inspect -f '{{json .HostConfig.PortBindings}}' dokploy-traefik 2>/dev/null | grep -q '"80/tcp"'`,
		);
	});

	it("names the backup with a UTC timestamp and writes the converted file in place", () => {
		const installer = readFileSync(installerScript, "utf8");
		const migrate = shellFunctionText(installer, "migrate_traefik_acme_to_tls");

		expect(installer).toContain("migrate_traefik_acme_to_tls() {");
		expect(migrate).toContain('backup="$config.bak-$(date -u +%Y%m%d%H%M%S)"');
		expect(migrate).toContain('cp -p "$config" "$backup"');
		expect(migrate).toContain('print substr($0, 1, indent) "tlsChallenge: {}"');
		expect(migrate).toContain('cat "$config.tmp" >"$config"');
	});

	it("keeps the converted config and reports the backup before any container is recreated", () => {
		const installer = readFileSync(installerScript, "utf8");
		const restore = shellFunctionText(installer, "traefik_restore");
		const failed = restore.indexOf(
			'echo "Error: Traefik update failed while $failed_step." >&2',
		);
		const kept = restore.indexOf(
			'echo "Kept the converted Traefik config (tlsChallenge). Previous config saved to $TRAEFIK_ACME_BACKUP." >&2',
		);
		const containerRestore = restore.indexOf(
			'if [ "$TRAEFIK_OLD_STOPPED" = "1" ]; then',
		);

		expect(failed).toBeGreaterThanOrEqual(0);
		expect(kept).toBeGreaterThan(failed);
		expect(containerRestore).toBeGreaterThan(kept);
		expect(restore).not.toContain('cat "$TRAEFIK_ACME_BACKUP"');
	});

	it("converts a block-form httpChallenge and keeps a byte-exact backup", () => {
		const original = textLines(
			"global:",
			"  sendAnonymousUsage: false",
			"entryPoints:",
			"  web:",
			"    address: :80",
			"certificatesResolvers:",
			"  letsencrypt:",
			"    acme:",
			"      email: ops@example.com",
			"      storage: /etc/traefik/acme.json",
			"      httpChallenge:",
			"        entryPoint: web",
		);
		const run = runMigrateTraefikAcme(original);

		expect(run.result.status).toBe(0);
		expect(run.result.stdout).toMatch(
			/^Certificate renewal now uses port 443 \(tlsChallenge\)\. Previous config saved to \S+traefik\.yml\.bak-\d{14}\n$/,
		);
		expect(run.configText).toBe(
			textLines(
				"global:",
				"  sendAnonymousUsage: false",
				"entryPoints:",
				"  web:",
				"    address: :80",
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      email: ops@example.com",
				"      storage: /etc/traefik/acme.json",
				"      tlsChallenge: {}",
			),
		);
		expect(run.backupName).toMatch(/^traefik\.yml\.bak-\d{14}$/);
		expect(run.backupBytes).toEqual(Buffer.from(original));
		expect(run.entries).not.toContain("traefik.yml.tmp");
	});

	it("keeps the keys that follow a block-form httpChallenge", () => {
		const original = textLines(
			"certificatesResolvers:",
			"  letsencrypt:",
			"    acme:",
			"      email: ops@example.com",
			"      httpChallenge:",
			"        entryPoint: web",
			"      storage: /etc/traefik/acme.json",
			"  staging:",
			"    acme:",
			"      email: ops@example.com",
			"dynamic:",
			"  directory: /etc/traefik/dynamic",
		);
		const run = runMigrateTraefikAcme(original);

		expect(run.result.status).toBe(0);
		expect(run.configText).toBe(
			textLines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      email: ops@example.com",
				"      tlsChallenge: {}",
				"      storage: /etc/traefik/acme.json",
				"  staging:",
				"    acme:",
				"      email: ops@example.com",
				"dynamic:",
				"  directory: /etc/traefik/dynamic",
			),
		);
		expect(run.backupBytes).toEqual(Buffer.from(original));
	});

	it("converts an inline httpChallenge in place", () => {
		const original = textLines(
			"certificatesResolvers:",
			"  letsencrypt:",
			"    acme:",
			"      email: ops@example.com",
			"      httpChallenge: {entryPoint: web}",
			"      storage: /etc/traefik/acme.json",
		);
		const run = runMigrateTraefikAcme(original);

		expect(run.result.status).toBe(0);
		expect(run.configText).toBe(
			textLines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      email: ops@example.com",
				"      tlsChallenge: {}",
				"      storage: /etc/traefik/acme.json",
			),
		);
		expect(run.backupBytes).toEqual(Buffer.from(original));
	});

	it("leaves a config already on tlsChallenge untouched and makes no backup", () => {
		const original = textLines(
			"certificatesResolvers:",
			"  letsencrypt:",
			"    acme:",
			"      email: ops@example.com",
			"      tlsChallenge: {}",
		);
		const run = runMigrateTraefikAcme(original);

		expect(run.result.status).toBe(0);
		expect(run.result.stdout).toBe("");
		expect(run.configText).toBe(original);
		expect(run.backupName).toBeUndefined();
	});

	it("does nothing and creates no file when the config is missing", () => {
		const run = runMigrateTraefikAcme(null);

		expect(run.result.status).toBe(0);
		expect(run.configText).toBeNull();
		expect(run.backupName).toBeUndefined();
	});

	it("keeps the original config when the converted file fails verification", () => {
		const original = textLines(
			"certificatesResolvers:",
			"  letsencrypt:",
			"    acme:",
			"      httpChallenge: {entryPoint: web} # old",
		);
		const run = runMigrateTraefikAcme(original);

		expect(run.result.status).toBe(1);
		expect(run.result.stderr).toMatch(
			/could not convert \S+traefik\.yml to tlsChallenge\. The previous config is saved at \S+traefik\.yml\.bak-\d{14}\./,
		);
		expect(run.configText).toBe(original);
		expect(run.backupBytes).toEqual(Buffer.from(original));
		expect(run.entries).not.toContain("traefik.yml.tmp");
	});

	it("keeps a blank line inside a block-form httpChallenge and drops only its children", () => {
		const original = textLines(
			"certificatesResolvers:",
			"  letsencrypt:",
			"    acme:",
			"      email: ops@example.com",
			"      httpChallenge:",
			"",
			"        entryPoint: web",
			"providers:",
			"  docker:",
			"    exposedByDefault: false",
		);
		const run = runMigrateTraefikAcme(original);

		expect(run.result.status).toBe(0);
		expect(run.configText).toBe(
			textLines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      email: ops@example.com",
				"      tlsChallenge: {}",
				"",
				"providers:",
				"  docker:",
				"    exposedByDefault: false",
			),
		);
		expect(parse(run.configText ?? "")).toEqual({
			certificatesResolvers: {
				letsencrypt: {
					acme: { email: "ops@example.com", tlsChallenge: {} },
				},
			},
			providers: { docker: { exposedByDefault: false } },
		});
		expect(run.backupBytes).toEqual(Buffer.from(original));
	});

	it("uses TRAEFIK_CONFIG_FILE when it is called without a path", () => {
		const original = textLines(
			"certificatesResolvers:",
			"  letsencrypt:",
			"    acme:",
			"      httpChallenge: {entryPoint: web}",
		);
		const run = runMigrateTraefikAcme(original, { passPath: false });

		expect(run.result.status).toBe(0);
		expect(run.configText).toBe(
			textLines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      tlsChallenge: {}",
			),
		);
		expect(run.backupBytes).toEqual(Buffer.from(original));
	});

	it("reads and writes the Traefik config only through TRAEFIK_CONFIG_FILE", () => {
		const installer = readFileSync(installerScript, "utf8");
		const migrate = shellFunctionText(installer, "migrate_traefik_acme_to_tls");
		const swap = shellFunctionText(installer, "swap_dokploy_traefik");
		const restore = shellFunctionText(installer, "traefik_restore");

		expect(installer).toContain(
			'TRAEFIK_CONFIG_FILE="${TRAEFIK_CONFIG_FILE:-/etc/dokploy/traefik/traefik.yml}"',
		);
		expect(migrate).toContain('local config="${1:-$TRAEFIK_CONFIG_FILE}"');
		expect(swap).toContain('"$TRAEFIK_CONFIG_FILE" 2>/dev/null');
		for (const text of [migrate, swap, restore]) {
			expect(text).not.toContain("/etc/dokploy/traefik/traefik.yml");
		}
	});

	it("converts the Traefik config right after the default file is written, before any secret or service is created", () => {
		const installer = readFileSync(installerScript, "utf8");
		const install = shellFunctionText(installer, "install_agenthits_dokploy");
		const defaults = install.indexOf("\tcreate_default_traefik_files\n");
		const migrate = install.indexOf(
			'\tif ! migrate_traefik_acme_to_tls "$TRAEFIK_CONFIG_FILE"; then echo "Error: could not convert the Traefik config to tlsChallenge. Check the file named above, then run the installer again." >&2; exit 1; fi\n',
		);
		const firstSecret = install.indexOf("create_secret_if_missing ");
		const firstService = install.indexOf("docker service create");

		expect(defaults).toBeGreaterThanOrEqual(0);
		expect(migrate).toBeGreaterThan(defaults);
		expect(firstSecret).toBeGreaterThan(migrate);
		expect(firstService).toBeGreaterThan(migrate);
	});

	it(
		"converts an httpChallenge config during an update and keeps the previous file",
		() => {
			const { result, configText, configBackupText } = runInstaller({
				traefikImage: "traefik:v3.6.25",
				traefikConfig: HTTP_TRAEFIK_CONFIG,
			});

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("Certificate renewal now uses port 443");
			expect(configText).toBe(TLS_TRAEFIK_CONFIG);
			expect(configBackupText).toBe(HTTP_TRAEFIK_CONFIG);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"keeps the converted Traefik config when the new Traefik does not start",
		() => {
			const { result, configText, configBackupText } = runInstaller({
				traefikImage: "traefik:v3.6.25",
				traefikRunning: "false",
				traefikConfig: HTTP_TRAEFIK_CONFIG,
			});

			expect(result.status).not.toBe(0);
			expect(result.stderr).toMatch(
				/Kept the converted Traefik config \(tlsChallenge\)\. Previous config saved to \S+traefik\.yml\.bak-\d{14}\./,
			);
			expect(configText).toBe(TLS_TRAEFIK_CONFIG);
			expect(configBackupText).toBe(HTTP_TRAEFIK_CONFIG);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it("writes and mounts the static Traefik config through TRAEFIK_CONFIG_FILE", () => {
		const installer = readFileSync(installerScript, "utf8");
		const defaults = shellFunctionText(
			installer,
			"create_default_traefik_files",
		);
		const container = shellFunctionText(installer, "create_dokploy_traefik");

		expect(defaults).toContain('if [ -d "$TRAEFIK_CONFIG_FILE" ]; then');
		expect(defaults).toContain('rm -rf "$TRAEFIK_CONFIG_FILE"');
		expect(defaults).toContain('if [ ! -f "$TRAEFIK_CONFIG_FILE" ]; then');
		expect(defaults).toContain("cat >\"$TRAEFIK_CONFIG_FILE\" <<'EOF'");
		expect(defaults).toContain("mkdir -p /etc/dokploy/traefik/dynamic");
		expect(container).toContain(
			'-v "$TRAEFIK_CONFIG_FILE:/etc/traefik/traefik.yml" \\',
		);
		expect(container).toContain(
			"-v /etc/dokploy/traefik/dynamic:/etc/dokploy/traefik/dynamic \\",
		);
		expect(defaults).toContain('case "$TRAEFIK_CONFIG_FILE" in');
		expect(defaults).toContain(
			"/etc/dokploy/traefik/traefik.yml | */traefik.yml)",
		);
		expect(defaults).not.toMatch(
			/(?:-[df]|rm -rf|cat >)\s*\/etc\/dokploy\/traefik\/traefik\.yml/,
		);
		expect(container).not.toContain("/etc/dokploy/traefik/traefik.yml");
	});

	it("keeps a comment line inside a block-form httpChallenge without ending the skip", () => {
		const original = textLines(
			"certificatesResolvers:",
			"  letsencrypt:",
			"    acme:",
			"      email: ops@example.com",
			"      httpChallenge:",
			"# note",
			"        entryPoint: web",
		);
		const run = runMigrateTraefikAcme(original);

		expect(run.result.status).toBe(0);
		expect(run.configText).toBe(
			textLines(
				"certificatesResolvers:",
				"  letsencrypt:",
				"    acme:",
				"      email: ops@example.com",
				"      tlsChallenge: {}",
			),
		);
		expect(parse(run.configText ?? "")).toEqual({
			certificatesResolvers: {
				letsencrypt: {
					acme: { email: "ops@example.com", tlsChallenge: {} },
				},
			},
		});
		expect(run.backupBytes).toEqual(Buffer.from(original));
	});

	it("refuses a conversion that would leave a line indented under tlsChallenge", () => {
		const original = textLines(
			"certificatesResolvers:",
			"  letsencrypt:",
			"    acme:",
			"      httpChallenge: {entryPoint: web}",
			"        extra: true",
		);
		const run = runMigrateTraefikAcme(original);

		expect(run.result.status).toBe(1);
		expect(run.result.stderr).toMatch(
			/would leave output line 5 indented under tlsChallenge\. The config is unchanged/,
		);
		expect(run.configText).toBe(original);
		expect(run.entries).not.toContain("traefik.yml.tmp");
	});

	it("restores the original config when the in-place write fails", () => {
		const original = textLines(
			"certificatesResolvers:",
			"  letsencrypt:",
			"    acme:",
			"      email: ops@example.com",
			"      httpChallenge:",
			"        entryPoint: web",
		);
		const run = runMigrateTraefikAcme(original, { failWrite: true });

		expect(run.result.status).toBe(1);
		expect(run.result.stderr).toMatch(
			/could not write \S+traefik\.yml\. The previous config was restored from \S+traefik\.yml\.bak-\d{14}\./,
		);
		expect(run.configText).toBe(original);
		expect(run.backupBytes).toEqual(Buffer.from(original));
		expect(run.entries).not.toContain("traefik.yml.tmp");
	});

	it("removes a directory only when its path ends in traefik.yml", () => {
		const root = mkdtempSync(path.join(tmpdir(), "traefik-guard-target-"));
		try {
			const target = path.join(root, "traefik.yml");
			mkdirSync(target);
			writeFileSync(path.join(target, "stale"), "x");

			const result = runDirectoryGuard(target);

			expect(result.status).toBe(0);
			expect(existsSync(target)).toBe(false);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	it("refuses to remove a directory at any other path", () => {
		const root = mkdtempSync(path.join(tmpdir(), "traefik-guard-target-"));
		try {
			const target = path.join(root, "other.yml");
			mkdirSync(target);

			const result = runDirectoryGuard(target);

			expect(result.status).toBe(1);
			expect(result.stderr).toContain(
				"is a directory, not the Traefik config file",
			);
			expect(existsSync(target)).toBe(true);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});
});

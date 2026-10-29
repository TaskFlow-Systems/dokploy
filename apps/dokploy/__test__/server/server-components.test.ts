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
import {
	BUILDPACKS_VERSION,
	NIXPACKS_VERSION,
	PINNED_VERSIONS,
	RAILPACK_VERSION,
} from "@dokploy/server/setup/component-versions";
import {
	buildComponentStatuses,
	buildComponentUpdateScript,
	COMPONENTS_UPDATE_DONE,
	DOCKER_UPGRADE_SKIPPED_MESSAGE,
	filterDockerUpgrade,
	parseComponentVersions,
	type UpdatableComponent,
} from "@dokploy/server/setup/server-components";
import { RAILPACK_INSTALL_SCRIPT_URLS } from "@dokploy/server/setup/server-setup";
import {
	buildTraefikCreateCommand,
	buildTraefikCreateWithImage,
	buildTraefikRunCommand,
	buildTraefikTlsMigrationStep,
	TRAEFIK_VERSION,
} from "@dokploy/server/setup/traefik-setup";
import { describe, expect, it } from "vitest";

const PORT_80_PUBLICATION =
	/(?:-p|--publish)[=\s]+\S*\b80\b|published=80\b|\b80\/tcp\b/;

const TRAEFIK_SKIP_CHECK_LINE =
	/^if \[ "\$traefik_existed" = 1 \] && \[ "\$\{traefik_old_image%%@\*\}" = .*$/m;

// The read-only skip check names httpChallenge and 80/tcp; the assertions cover everything else.
const withoutSkipCheck = (script: string) => {
	expect(script.match(TRAEFIK_SKIP_CHECK_LINE)).not.toBeNull();
	return script.replace(TRAEFIK_SKIP_CHECK_LINE, "");
};

describe("parseComponentVersions", () => {
	it("extracts the semantic version from each tool's output", () => {
		const output = [
			"docker=29.4.2",
			"traefik=traefik:v3.6.25",
			"nixpacks=nixpacks 1.41.0",
			"railpack=railpack version 0.15.4",
			"buildpacks=0.39.1+git-dc9220d.build-6702",
			"rclone=rclone v1.75.1",
		].join("\n");

		expect(parseComponentVersions(output)).toEqual({
			docker: "29.4.2",
			traefik: "3.6.25",
			nixpacks: "1.41.0",
			railpack: "0.15.4",
			buildpacks: "0.39.1",
			rclone: "1.75.1",
		});
	});

	it("reports a missing tool as null", () => {
		expect(parseComponentVersions("traefik=\nnixpacks=")).toEqual({
			traefik: null,
			nixpacks: null,
		});
	});

	it("ignores lines that are not component values", () => {
		expect(parseComponentVersions("something=1.2.3\nnoequals")).toEqual({});
	});
});

describe("buildComponentStatuses", () => {
	it("marks a pinned component outdated when the installed version differs", () => {
		const statuses = buildComponentStatuses({ traefik: "3.6.25" });
		const traefik = statuses.find((status) => status.name === "traefik");

		expect(traefik).toEqual({
			name: "traefik",
			installed: "3.6.25",
			target: TRAEFIK_VERSION,
			outdated: TRAEFIK_VERSION !== "3.6.25",
		});
	});

	it("is up to date when the installed version matches the pin", () => {
		const statuses = buildComponentStatuses({
			docker: PINNED_VERSIONS.docker,
			rclone: PINNED_VERSIONS.rclone,
			traefik: TRAEFIK_VERSION,
			nixpacks: NIXPACKS_VERSION,
			railpack: RAILPACK_VERSION,
			buildpacks: BUILDPACKS_VERSION,
		});

		expect(statuses.filter((status) => status.outdated)).toEqual([]);
	});

	it("treats a missing pinned component as outdated", () => {
		const statuses = buildComponentStatuses({ nixpacks: null });
		const nixpacks = statuses.find((status) => status.name === "nixpacks");

		expect(nixpacks?.installed).toBeNull();
		expect(nixpacks?.outdated).toBe(true);
	});

	it("marks Docker and RClone outdated when they differ from the pin", () => {
		const statuses = buildComponentStatuses({ docker: "1.0.0", rclone: null });
		const docker = statuses.find((status) => status.name === "docker");
		const rclone = statuses.find((status) => status.name === "rclone");

		expect(docker).toMatchObject({
			target: PINNED_VERSIONS.docker,
			outdated: true,
		});
		expect(rclone).toMatchObject({
			target: PINNED_VERSIONS.rclone,
			outdated: true,
		});
	});
});

describe("buildComponentUpdateScript", () => {
	it("replaces the Traefik container from the pinned image without renaming the old one", () => {
		const script = buildComponentUpdateScript(["traefik"]);

		expect(script).toContain(`docker pull traefik:v${TRAEFIK_VERSION}`);
		expect(script).toContain(`traefik_create "traefik:v${TRAEFIK_VERSION}"`);
		expect(script).toContain(buildTraefikCreateWithImage('"$1"').trim());
		expect(script).toContain(
			"docker network disconnect bridge dokploy-traefik",
		);
		expect(script).not.toContain("docker rename");
	});
	it("never publishes host port 80 when it replaces the Traefik container", () => {
		const script = withoutSkipCheck(buildComponentUpdateScript(["traefik"]));

		expect(script).not.toMatch(PORT_80_PUBLICATION);
		expect(script).toMatch(/-p 443:443\s/);
		expect(script).toContain("-p 443:443/udp");
	});
	it("stops and removes the old Traefik, creates the new one, attaches its networks, and starts it last", () => {
		const script = buildComponentUpdateScript(["traefik"]);
		const order = [
			script.indexOf("if ! $SUDO_CMD docker stop dokploy-traefik >/dev/null;"),
			script.indexOf("if ! $SUDO_CMD docker rm dokploy-traefik >/dev/null;"),
			script.indexOf('if ! traefik_create "traefik:v'),
			script.indexOf('if ! traefik_connect "$traefik_extra_networks";'),
			script.indexOf("if ! $SUDO_CMD docker start dokploy-traefik >/dev/null;"),
			script.indexOf(
				"if ! $SUDO_CMD docker update --restart always dokploy-traefik >/dev/null;",
			),
		];

		expect(order.every((position) => position >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(script).not.toContain("docker run");
		expect(script).not.toContain("docker rename");
	});
	it("reads the networks of the running Traefik on the host, before it is replaced", () => {
		const script = buildComponentUpdateScript(["traefik"]);
		const read = script.indexOf(
			"{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}",
		);

		expect(read).toBeGreaterThanOrEqual(0);
		expect(read).toBeLessThan(
			script.indexOf("if ! $SUDO_CMD docker stop dokploy-traefik >/dev/null;"),
		);
		expect(script).toContain("bridge | dokploy-network) continue ;;");
	});
	it("raises the restart policy of the new Traefik only after it passes the check", () => {
		const script = buildComponentUpdateScript(["traefik"]);
		const check = script.indexOf("if ! traefik_check_running; then");
		const raise = script.indexOf(
			"if ! $SUDO_CMD docker update --restart always dokploy-traefik >/dev/null; then",
		);

		expect(script).toMatch(
			/docker create --name dokploy-traefik\s+--restart no\s/,
		);
		expect(check).toBeGreaterThanOrEqual(0);
		expect(raise).toBeGreaterThan(check);
	});
	it("converts the Traefik config to tlsChallenge before the old container is stopped", () => {
		const script = buildComponentUpdateScript(["traefik"]);
		const step = buildTraefikTlsMigrationStep();
		const at = script.indexOf(step);

		expect(at).toBeGreaterThanOrEqual(0);
		expect(script.slice(0, at)).toMatch(/if ! \{\n$/);
		expect(script.slice(at + step.length)).toMatch(
			/^\n\s*\}; then\n\s*traefik_restore "converting the Traefik config to tlsChallenge"\n/,
		);
		expect(at).toBeLessThan(
			script.indexOf("if ! $SUDO_CMD docker stop dokploy-traefik >/dev/null;"),
		);
	});
	it("keeps the converted Traefik config on rollback, names the backup, and never restores httpChallenge", () => {
		const script = buildComponentUpdateScript(["traefik"]);
		const kept = script.indexOf(
			'if [ "$traefik_tls_converted" = 1 ]; then echo "Kept the converted Traefik config (tlsChallenge). Port 443 is published, so the restored container works with it. Previous config saved to $traefik_acme_backup." >&2; fi',
		);
		const trapSet = script.indexOf(
			"trap 'traefik_restore \"being interrupted\"' HUP INT TERM",
		);

		const definition = script.indexOf("traefik_restore() {");

		expect(kept).toBeGreaterThan(definition);
		expect(kept).toBeLessThan(trapSet);
		expect(kept).toBeLessThan(
			script.indexOf('echo "Restoring the previous Traefik container from'),
		);
		expect(script.slice(definition, trapSet)).not.toContain(
			'cat "$traefik_acme_backup"',
		);
		expect(script.indexOf('traefik_tls_converted=""')).toBeLessThan(trapSet);
	});
	it("keeps httpChallenge out of the Traefik step apart from the conversion", () => {
		const script = withoutSkipCheck(buildComponentUpdateScript(["traefik"]));

		expect(script.replace(buildTraefikTlsMigrationStep(), "")).not.toMatch(
			/httpchallenge/i,
		);
	});
	it("passes the pinned versions into the installers through env", () => {
		const script = buildComponentUpdateScript(["nixpacks", "railpack"]);

		expect(script).toContain(
			`env NIXPACKS_VERSION=${NIXPACKS_VERSION} bash "$nixpacks_installer"`,
		);
		expect(script).toContain(
			`env RAILPACK_VERSION=${RAILPACK_VERSION} bash "$railpack_installer"`,
		);
	});

	it("downloads the Nixpacks and Railpack install scripts to files and checks them before running them", () => {
		const script = buildComponentUpdateScript(["nixpacks", "railpack"]);

		expect(script).toContain(
			"for nixpacks_installer_url in https://nixpacks.com/install.sh; do",
		);
		expect(script).toContain(
			`for railpack_installer_url in ${RAILPACK_INSTALL_SCRIPT_URLS.join(" ")}; do`,
		);
		expect(script).toContain('bash -n "$nixpacks_installer"');
		expect(script).not.toContain('bash -c "$(curl');
	});
	it("installs the pinned Docker and RClone", () => {
		const script = buildComponentUpdateScript(["docker", "rclone"]);

		expect(script).toContain(`Updating Docker to ${PINNED_VERSIONS.docker}`);
		expect(script).toContain(
			`rclone-v${PINNED_VERSIONS.rclone}-linux-$RCLONE_RELEASE_ARCH.zip`,
		);
	});

	it("installs Docker from the pre-downloaded apt packages and never runs get.docker.com", () => {
		const script = buildComponentUpdateScript(["docker"]);

		expect(script).toContain("apt-get install -y --no-download");
		expect(script).not.toContain("get.docker.com");
	});

	it("keeps a rollback for a failed Docker update in the generated script", () => {
		const script = buildComponentUpdateScript(["docker"]);

		expect(script).toContain(
			"apt-get install -y --allow-downgrades --no-download",
		);
		expect(script).toContain("docker-rollback-");
	});

	it("skips only the Docker step for each Docker-specific pre-download failure", () => {
		const script = buildComponentUpdateScript(["docker", "traefik"]);

		expect(script).toContain("DOCKER_SKIPPED=1");
		expect(script).toContain(
			"Docker not updated: $DOCKER_SKIP_REASON. The other components continue.",
		);
		expect(script).toContain(
			"this host has no apt-get, so the Docker packages cannot be pre-downloaded or rolled back",
		);
		expect(script).toContain("is for $repo_codename, but this host runs");
		expect(script).toContain(
			"is not offered by the Docker apt repository configured on this host",
		);
		expect(script).toContain(
			"is only added automatically on ubuntu and debian",
		);
		expect(script).toContain(
			"the current Docker packages could not be saved for rollback",
		);
		expect(script).toContain(
			"docker-ce is not installed, so there is no Docker Engine to roll back to",
		);
	});

	it("aborts the whole update before any change for other pre-download failures", () => {
		const script = buildComponentUpdateScript(["docker", "traefik"]);

		expect(script).toContain(
			`abort_before_change "Pre-download failed: traefik:v${TRAEFIK_VERSION}."`,
		);
		expect(script).toContain(
			'abort_before_change "Pre-download failed: the apt package lists could not be refreshed."',
		);
		expect(script).toContain(
			'abort_before_change "Pre-download failed: the Docker packages."',
		);
	});

	it("removes the Docker key and source this run wrote when a later Docker step fails", () => {
		const script = buildComponentUpdateScript(["docker"]);

		expect(script).toContain('rm -f "$DOKPLOY_APT_SOURCES_DIR/docker.list"');
		expect(script).toContain('rm -f "$DOKPLOY_DOCKER_KEYRING"');
		expect(script).toMatch(
			/--download-only[^\n]*; then\s+docker_undo_repo\s+docker_remove_rollback_dir\s+abort_before_change/,
		);
		expect(script).toMatch(
			/docker_save_rollback_packages; then\s+docker_undo_repo\s+return 1/,
		);
	});

	it("removes the saved-packages directory this run created when Docker is skipped or the update aborts", () => {
		const script = buildComponentUpdateScript(["docker"]);

		expect(script).toContain('rm -rf "$DOCKER_ROLLBACK_DIR"');
		expect(script).toMatch(
			/"\$DOCKER_SKIPPED" = 1 \]; then\s+docker_remove_rollback_dir\s+fi/,
		);
		expect(script).toMatch(
			/docker_undo_repo\s+docker_remove_rollback_dir\s+abort_before_change "Pre-download failed: the Docker packages\./,
		);
	});

	it("resets the Traefik restart policy before the Docker rollback starts it", () => {
		const script = buildComponentUpdateScript(["docker"]);
		const rollback = script.slice(
			script.indexOf("docker_roll_back() {"),
			script.indexOf("docker_update_from_apt() {"),
		);

		const reset = rollback.indexOf(
			"docker update --restart always dokploy-traefik",
		);
		expect(reset).toBeGreaterThanOrEqual(0);
		expect(reset).toBeLessThan(
			rollback.indexOf("docker start dokploy-traefik"),
		);
	});

	it("waits 30 seconds for the new Docker before rolling back", () => {
		const script = buildComponentUpdateScript(["docker"]);
		const wait = script.slice(
			script.indexOf("docker_wait_ready() {"),
			script.indexOf("docker_roll_back() {"),
		);

		expect(wait).toContain('if [ "$attempt" -ge 30 ]; then');
		expect(wait).toContain("sleep 1");
		expect(wait).not.toContain("sleep 2");
	});

	it("polls the new Traefik once a second over the settle time, then checks it once more", () => {
		const script = buildComponentUpdateScript(["traefik"]);

		expect(script).toContain("traefik_wait_settled() {");
		expect(script).toContain("if ! traefik_wait_settled; then");
		expect(script).not.toContain('sleep "${TRAEFIK_SETTLE_SECONDS');
	});

	it("ends with the marker the UI waits for", () => {
		expect(buildComponentUpdateScript(["buildpacks"])).toContain(
			COMPONENTS_UPDATE_DONE,
		);
	});

	it("generates valid bash for every updatable component", () => {
		const script = buildComponentUpdateScript([
			"docker",
			"traefik",
			"rclone",
			"nixpacks",
			"railpack",
			"buildpacks",
		]);
		const result = spawnSync("bash", ["-n"], { input: script });

		expect(result.stderr.toString()).toBe("");
		expect(result.status).toBe(0);
	});
});

describe("filterDockerUpgrade", () => {
	it("keeps Docker when the upgrade is enabled", () => {
		expect(filterDockerUpgrade(["docker", "rclone"], true)).toEqual({
			components: ["docker", "rclone"],
			skippedDocker: false,
		});
	});

	it("removes Docker when the upgrade is not enabled", () => {
		expect(filterDockerUpgrade(["rclone", "docker", "traefik"], false)).toEqual(
			{ components: ["rclone", "traefik"], skippedDocker: true },
		);
	});

	it("reports nothing when Docker is not selected", () => {
		expect(filterDockerUpgrade(["traefik"], false)).toEqual({
			components: ["traefik"],
			skippedDocker: false,
		});
	});

	it("leaves no components when Docker was the only one selected", () => {
		expect(filterDockerUpgrade(["docker"], false)).toEqual({
			components: [],
			skippedDocker: true,
		});
	});

	it("names the reason in the line the dialog shows", () => {
		expect(DOCKER_UPGRADE_SKIPPED_MESSAGE).toBe(
			"Docker Engine not upgraded: it restarts every container on this server. Enable it explicitly to upgrade.",
		);
	});
});

const BASH = spawnSync("sh", ["-c", "command -v bash"], {
	encoding: "utf8",
}).stdout.trim();

const FAKE_TOOLS: Record<string, string> = {
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
	network)
		case "$2" in
			inspect) case " $FAKE_MISSING_NETWORKS " in *" $3 "*) exit 1 ;; esac ;;
			connect) case " $FAKE_CONNECT_FAILS " in *" $3 "*) exit 1 ;; esac ;;
		esac
		;;
	inspect)
		case "$*" in
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

const SYSTEM_TOOLS = [
	"id",
	"awk",
	"grep",
	"date",
	"mktemp",
	"tee",
	"dirname",
	"install",
	"rm",
	"chmod",
	"mkdir",
	"sh",
	"sed",
	"cat",
	"head",
	"tr",
	"cut",
	"wc",
	"sort",
	"test",
];

const linkSystemTools = (binDir: string) => {
	mkdirSync(binDir);
	for (const name of SYSTEM_TOOLS) {
		const found = spawnSync("sh", ["-c", `command -v ${name}`], {
			encoding: "utf8",
		}).stdout.trim();
		const executable = found.startsWith("/")
			? found
			: ["/usr/bin", "/bin"]
					.map((dir) => path.join(dir, name))
					.find((candidate) => existsSync(candidate));
		if (executable) {
			symlinkSync(executable, path.join(binDir, name));
		}
	}
	return binDir;
};

const DOCKER_LIST_JAMMY =
	"deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu jammy stable\n";
const DOCKER_LIST_NOBLE =
	"deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n";
const DOCKER_SOURCES_JAMMY =
	"Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: jammy\nComponents: stable\nSigned-By: /etc/apt/keyrings/docker.asc\n";

type ScriptOptions = {
	env?: Record<string, string>;
	osRelease?: string;
	sourceFiles?: Record<string, string>;
	withoutApt?: boolean;
	preexistingKeyring?: string;
	traefikConfig?: string;
};

const listBackups = (backups: string) => {
	try {
		return readdirSync(backups).map((name) => {
			const dirPath = path.join(backups, name);
			return {
				name,
				mode: statSync(dirPath).mode & 0o777,
				files: readdirSync(dirPath).map((file) => ({
					name: file,
					mode: statSync(path.join(dirPath, file)).mode & 0o777,
				})),
			};
		});
	} catch {
		return [];
	}
};

const readSources = (sources: string) =>
	Object.fromEntries(
		readdirSync(sources).map((name) => [
			name,
			readFileSync(path.join(sources, name), "utf8"),
		]),
	);

const runComponentScript = (
	components: UpdatableComponent[],
	options: ScriptOptions = {},
) => {
	const dir = mkdtempSync(path.join(tmpdir(), "component-update-"));
	try {
		const callLog = path.join(dir, "calls.log");
		const osRelease = path.join(dir, "os-release");
		const sources = path.join(dir, "sources");
		const keyring = path.join(dir, "keyrings", "docker.asc");
		const backups = path.join(dir, "backups");
		const traefikConfigPath = path.join(
			dir,
			"etc-root",
			"traefik",
			"traefik.yml",
		);
		mkdirSync(sources);
		if (options.traefikConfig !== undefined) {
			mkdirSync(path.dirname(traefikConfigPath), { recursive: true });
			writeFileSync(traefikConfigPath, options.traefikConfig);
		}
		if (options.preexistingKeyring !== undefined) {
			mkdirSync(path.dirname(keyring));
			writeFileSync(keyring, options.preexistingKeyring);
		}
		writeFileSync(callLog, "");
		writeFileSync(path.join(dir, "engine"), "28.3.0\n");
		writeFileSync(
			osRelease,
			options.osRelease ?? "ID=ubuntu\nVERSION_CODENAME=noble\n",
		);
		for (const [name, body] of Object.entries(options.sourceFiles ?? {})) {
			writeFileSync(path.join(sources, name), body);
		}
		for (const [name, body] of Object.entries(FAKE_TOOLS)) {
			if (options.withoutApt && name.startsWith("apt-")) {
				continue;
			}
			writeFileSync(path.join(dir, name), body);
			chmodSync(path.join(dir, name), 0o755);
		}
		const pathValue = options.withoutApt
			? `${dir}:${linkSystemTools(path.join(dir, "bin"))}`
			: `${dir}:${process.env.PATH}`;
		// Config paths point into the temp dir, so a run never touches the host's real config.
		const result = spawnSync(BASH, [], {
			input: buildComponentUpdateScript(components).replaceAll(
				"/etc/dokploy",
				path.join(dir, "etc-root"),
			),
			encoding: "utf8",
			env: {
				...process.env,
				PATH: pathValue,
				CALL_LOG: callLog,
				FAKE_STATE: dir,
				FAKE_PREVIOUS_ENGINE: "28.3.0",
				FAKE_TARGET_ENGINE: PINNED_VERSIONS.docker,
				FAKE_OLD_IMAGE: "traefik:v3.6.25",
				TMPDIR: dir,
				TRAEFIK_SETTLE_SECONDS: "0",
				DOKPLOY_BACKUP_DIR: backups,
				DOKPLOY_OS_RELEASE: osRelease,
				DOKPLOY_APT_SOURCES_DIR: sources,
				DOKPLOY_DOCKER_KEYRING: keyring,
				...options.env,
			},
		});
		return {
			status: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
			calls: readFileSync(callLog, "utf8").split("\n").filter(Boolean),
			backups: listBackups(backups),
			keyringExists: existsSync(keyring),
			keyring: existsSync(keyring) ? readFileSync(keyring, "utf8") : null,
			keyringDirExists: existsSync(path.dirname(keyring)),
			sources: readSources(sources),
			traefikConfigFile: existsSync(traefikConfigPath)
				? readFileSync(traefikConfigPath, "utf8")
				: null,
			traefikBackups: existsSync(path.dirname(traefikConfigPath))
				? readdirSync(path.dirname(traefikConfigPath)).filter((name) =>
						name.includes(".bak-"),
					)
				: [],
		};
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
};

const SPAWN_TEST_TIMEOUT_MS = 30_000;
const DOCKER_OLD = "5:28.3.0-1~ubuntu.24.04~noble";
const DOCKER_NEW = `5:${PINNED_VERSIONS.docker}-1~ubuntu.24.04~noble`;
const HTTP_CHALLENGE_CONFIG =
	"certificatesResolvers:\n  letsencrypt:\n    acme:\n      email: admin@example.com\n      httpChallenge:\n        entryPoint: web\n";
const TLS_CHALLENGE_CONFIG =
	"certificatesResolvers:\n  letsencrypt:\n    acme:\n      email: admin@example.com\n      tlsChallenge: {}\n";
const UNCONVERTIBLE_CONFIG =
	"certificatesResolvers:\n  letsencrypt:\n    acme:\n      httpChallenge:   # HTTP-01\n        entryPoint: web\n";

// Each test runs the generated script in a real shell, which takes seconds
// on a runner that is busy with other jobs.
describe("buildComponentUpdateScript run order", { timeout: 60_000 }, () => {
	it(
		"changes nothing when the Traefik image cannot be pulled",
		() => {
			const run = runComponentScript(["traefik"], {
				env: { FAKE_PULL_FAILS: "1" },
			});

			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain("Nothing was changed");
			expect(
				run.calls.some((call) =>
					/^docker (stop|rename|create|start) /.test(call),
				),
			).toBe(false);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"aborts the whole update before any change when the Traefik image cannot be pulled, with Docker selected",
		() => {
			const run = runComponentScript(["docker", "traefik"], {
				env: { FAKE_PULL_FAILS: "1" },
			});

			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain("Nothing was changed");
			expect(run.calls.some((call) => call.startsWith("apt-get"))).toBe(false);
			expect(run.calls.some((call) => call.startsWith("docker rename"))).toBe(
				false,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"aborts the whole update before any change when the apt package lists cannot be refreshed",
		() => {
			const run = runComponentScript(["docker", "traefik"], {
				env: { FAKE_UPDATE_FAILS: "1" },
			});

			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain(
				"Pre-download failed: the apt package lists could not be refreshed. Nothing was changed.",
			);
			expect(run.calls.some((call) => call.startsWith("docker rename"))).toBe(
				false,
			);
			expect(run.calls.some((call) => call.startsWith("docker create"))).toBe(
				false,
			);
			expect(run.calls.some((call) => call.startsWith("apt-get install"))).toBe(
				false,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"aborts the whole update before any change when the Docker packages cannot be downloaded",
		() => {
			const run = runComponentScript(["docker", "traefik"], {
				env: { FAKE_PREDOWNLOAD_FAILS: "1" },
			});

			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain(
				"Pre-download failed: the Docker packages. Nothing was changed.",
			);
			expect(run.calls.some((call) => call.startsWith("docker rename"))).toBe(
				false,
			);
			expect(run.calls.some((call) => call.includes("--no-download"))).toBe(
				false,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"downloads every artifact before the first step changes anything",
		() => {
			const run = runComponentScript(["traefik", "docker"]);

			expect(run.status).toBe(0);
			const download = run.calls.findIndex((call) =>
				call.includes("--download-only"),
			);
			const pull = run.calls.findIndex((call) =>
				call.startsWith("docker pull traefik:v"),
			);
			const firstChange = run.calls.findIndex((call) =>
				call.startsWith("docker stop dokploy-traefik"),
			);
			expect(download).toBeGreaterThanOrEqual(0);
			expect(pull).toBeGreaterThanOrEqual(0);
			expect(pull).toBeLessThan(firstChange);
			expect(download).toBeLessThan(firstChange);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it("replaces Traefik only after the new container has run", () => {
		const run = runComponentScript(["traefik"]);

		expect(run.status).toBe(0);
		expect(run.stdout).toContain(
			`Traefik version ${TRAEFIK_VERSION} installed`,
		);
		const at = (prefix: string) =>
			run.calls.findIndex((call) => call.startsWith(prefix));
		const order = [
			at("docker pull traefik:v"),
			at("docker stop dokploy-traefik"),
			at("docker rm dokploy-traefik"),
			at("docker create --name dokploy-traefik"),
			at("docker network connect dokploy-network dokploy-traefik"),
			at("docker start dokploy-traefik"),
			at(
				"docker inspect -f {{.State.Running}} {{.RestartCount}} dokploy-traefik",
			),
			at("docker update --restart always dokploy-traefik"),
		];
		expect(order.every((position) => position >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(run.calls.at(-1)).toBe(
			"docker update --restart always dokploy-traefik",
		);
	});
	it(
		"converts a Traefik config that still uses httpChallenge before the old container is stopped",
		() => {
			const run = runComponentScript(["traefik"], {
				traefikConfig: HTTP_CHALLENGE_CONFIG,
			});

			expect(run.status).toBe(0);
			expect(run.traefikConfigFile).toBe(TLS_CHALLENGE_CONFIG);
			expect(run.traefikBackups).toHaveLength(1);
			expect(run.calls).toContain("docker stop dokploy-traefik");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
	it(
		"leaves the old Traefik running when its config cannot be converted",
		() => {
			const run = runComponentScript(["traefik"], {
				traefikConfig: UNCONVERTIBLE_CONFIG,
			});

			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain("could not convert");
			expect(run.traefikConfigFile).toBe(UNCONVERTIBLE_CONFIG);
			expect(run.calls.some((call) => call.startsWith("docker stop"))).toBe(
				false,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
	it(
		"keeps the converted Traefik config when a later step fails, without restoring httpChallenge",
		() => {
			const run = runComponentScript(["traefik"], {
				traefikConfig: HTTP_CHALLENGE_CONFIG,
				env: { FAKE_CREATE_FAILS: "1" },
			});

			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain("Kept the converted Traefik config");
			expect(run.stderr).not.toContain("Restored the previous Traefik config");
			expect(run.traefikConfigFile).toBe(TLS_CHALLENGE_CONFIG);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
	it(
		"converts and replaces Traefik when its image is the target but the config still uses httpChallenge",
		() => {
			const run = runComponentScript(["traefik"], {
				traefikConfig: HTTP_CHALLENGE_CONFIG,
				env: {
					FAKE_OLD_IMAGE: `traefik:v${TRAEFIK_VERSION}`,
					FAKE_PORT_BINDINGS: "{}",
				},
			});

			expect(run.status).toBe(0);
			expect(run.stdout).not.toContain("Traefik already runs");
			expect(run.traefikConfigFile).toBe(TLS_CHALLENGE_CONFIG);
			expect(run.calls).toContain("docker stop dokploy-traefik");
			expect(run.stdout).toContain(
				`Traefik version ${TRAEFIK_VERSION} installed`,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
	it(
		"leaves Traefik running when its image is the target and neither the config nor port 80 needs a change",
		() => {
			const run = runComponentScript(["traefik"], {
				traefikConfig: TLS_CHALLENGE_CONFIG,
				env: {
					FAKE_OLD_IMAGE: `traefik:v${TRAEFIK_VERSION}`,
					FAKE_PORT_BINDINGS: "{}",
				},
			});

			expect(run.status).toBe(0);
			expect(run.stdout).toContain(
				`Traefik already runs traefik:v${TRAEFIK_VERSION}`,
			);
			expect(run.calls.some((call) => call.startsWith("docker stop"))).toBe(
				false,
			);
			expect(run.calls.some((call) => call.startsWith("docker create"))).toBe(
				false,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
	it(
		"replaces Traefik when its image is the target but port 80 is still published",
		() => {
			const run = runComponentScript(["traefik"], {
				traefikConfig: TLS_CHALLENGE_CONFIG,
				env: {
					FAKE_OLD_IMAGE: `traefik:v${TRAEFIK_VERSION}`,
					FAKE_PORT_BINDINGS:
						'{"80/tcp":[{"HostIp":"0.0.0.0","HostPort":"80"}]}',
				},
			});

			expect(run.status).toBe(0);
			expect(run.stdout).not.toContain("Traefik already runs");
			expect(run.calls).toContain("docker stop dokploy-traefik");
			expect(run.stdout).toContain(
				`Traefik version ${TRAEFIK_VERSION} installed`,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
	it("creates the new Traefik with --restart no and raises the policy only after the start", () => {
		const run = runComponentScript(["traefik"]);

		expect(run.status).toBe(0);
		const created =
			run.calls.find((call) =>
				call.startsWith("docker create --name dokploy-traefik"),
			) ?? "";
		expect(created).toContain("--restart no");
		expect(created).not.toContain("--restart always");
		expect(
			run.calls.indexOf("docker update --restart always dokploy-traefik"),
		).toBeGreaterThan(run.calls.indexOf("docker start dokploy-traefik"));
	});
	it(
		"restores --restart always on the Traefik it puts back",
		() => {
			const run = runComponentScript(["traefik"], {
				env: { FAKE_NOT_RUNNING: "1" },
			});

			expect(run.status).not.toBe(0);
			const restore = run.calls.indexOf(
				"docker update --restart always dokploy-traefik",
			);
			expect(restore).toBeGreaterThanOrEqual(0);
			expect(restore).toBeLessThan(
				run.calls.lastIndexOf("docker start dokploy-traefik"),
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it("restores the previous Traefik image when the new one is not running", () => {
		const run = runComponentScript(["traefik"], {
			env: { FAKE_NOT_RUNNING: "1" },
		});

		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain(
			"Error: Traefik update failed while checking the new Traefik container",
		);
		expect(run.stderr).toContain(
			"The previous Traefik container is running again.",
		);
		expect(run.stdout).not.toContain("installed");
		const recreated = run.calls.filter((call) =>
			call.startsWith("docker create --name dokploy-traefik"),
		);
		expect(recreated).toHaveLength(2);
		expect(recreated[1]?.endsWith("traefik:v3.6.25")).toBe(true);
	});
	it("reports the failed step when the new container cannot be created and the old one cannot be restored", () => {
		const run = runComponentScript(["traefik"], {
			env: { FAKE_CREATE_FAILS: "1" },
		});

		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain(
			"Error: Traefik update failed while creating the new Traefik container.",
		);
		expect(run.stderr).toContain("failed as well");
		expect(
			run.calls.some((call) => call.startsWith("docker network connect")),
		).toBe(false);
	});
	it(
		"connects every network of the old Traefik container before the new one starts",
		() => {
			const run = runComponentScript(["traefik"], {
				env: { FAKE_TRAEFIK_NETWORKS: "bridge dokploy-network app-a app-b" },
			});

			expect(run.status).toBe(0);
			const connected = (network: string) =>
				run.calls.indexOf(`docker network connect ${network} dokploy-traefik`);
			const start = run.calls.indexOf("docker start dokploy-traefik");
			expect(connected("app-a")).toBeGreaterThanOrEqual(0);
			expect(connected("app-b")).toBeGreaterThanOrEqual(0);
			expect(connected("app-a")).toBeLessThan(start);
			expect(connected("app-b")).toBeLessThan(start);
			expect(
				run.calls.some((call) =>
					call.startsWith("docker network connect bridge"),
				),
			).toBe(false);
			expect(
				run.calls.filter(
					(call) =>
						call === "docker network connect dokploy-network dokploy-traefik",
				),
			).toHaveLength(1);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"skips a network that no longer exists",
		() => {
			const run = runComponentScript(["traefik"], {
				env: {
					FAKE_TRAEFIK_NETWORKS: "app-a app-b",
					FAKE_MISSING_NETWORKS: "app-b",
				},
			});

			expect(run.status).toBe(0);
			expect(run.calls).toContain(
				"docker network connect app-a dokploy-traefik",
			);
			expect(run.calls).not.toContain(
				"docker network connect app-b dokploy-traefik",
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it("reports the failed step when a network cannot be connected and the old container cannot be restored", () => {
		const run = runComponentScript(["traefik"], {
			env: { FAKE_TRAEFIK_NETWORKS: "app-a", FAKE_CONNECT_FAILS: "app-a" },
		});

		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain(
			"Error: Traefik update failed while connecting the new Traefik container to its networks.",
		);
		expect(run.stderr).toContain("failed as well");
		expect(
			run.calls.some(
				(call) =>
					call.startsWith("docker create --name dokploy-traefik") &&
					call.endsWith("traefik:v3.6.25"),
			),
		).toBe(true);
	});
	it(
		"downloads the pinned Docker packages before the Docker step runs",
		() => {
			const run = runComponentScript(["docker"]);

			expect(run.status).toBe(0);
			expect(run.calls).toContain(
				`apt-get install -y -qq --download-only docker-ce=${DOCKER_NEW} docker-ce-cli=${DOCKER_NEW} containerd.io docker-buildx-plugin docker-compose-plugin`,
			);
			expect(run.stdout.indexOf("Downloading update artifacts")).toBeLessThan(
				run.stdout.indexOf(`Updating Docker to ${PINNED_VERSIONS.docker}`),
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"saves the current Docker packages before the Engine is changed",
		() => {
			const run = runComponentScript(["docker"]);

			expect(run.status).toBe(0);
			const save = run.calls.indexOf(
				`apt-get download docker-ce=${DOCKER_OLD}`,
			);
			const predownload = run.calls.indexOf(
				`apt-get install -y -qq --download-only docker-ce=${DOCKER_NEW} docker-ce-cli=${DOCKER_NEW} containerd.io docker-buildx-plugin docker-compose-plugin`,
			);
			const install = run.calls.indexOf(
				`apt-get install -y --no-download docker-ce=${DOCKER_NEW} docker-ce-cli=${DOCKER_NEW} containerd.io docker-buildx-plugin docker-compose-plugin`,
			);
			expect(save).toBeGreaterThanOrEqual(0);
			expect(save).toBeLessThan(predownload);
			expect(predownload).toBeLessThan(install);
			expect(run.calls).toContain(
				`apt-get download docker-ce-cli=${DOCKER_OLD}`,
			);
			expect(
				run.calls.some((call) =>
					call.startsWith("apt-get download containerd.io"),
				),
			).toBe(false);
			expect(run.backups).toHaveLength(1);
			expect(run.backups[0]?.name).toMatch(/^docker-rollback-\d{8}T\d{6}Z$/);
			expect(run.backups[0]?.mode).toBe(0o700);
			expect(run.backups[0]?.files.map((file) => file.name).sort()).toEqual([
				"docker-ce-cli.deb",
				"docker-ce.deb",
			]);
			expect(run.backups[0]?.files.every((file) => file.mode === 0o600)).toBe(
				true,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"installs the pinned Docker from apt without running get.docker.com",
		() => {
			const run = runComponentScript(["docker"]);

			expect(run.status).toBe(0);
			expect(run.calls.some((call) => call.includes("get.docker.com"))).toBe(
				false,
			);
			expect(run.stdout).toContain(
				`Docker version ${PINNED_VERSIONS.docker} installed`,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"rolls Docker back when the daemon does not come back on the pinned version",
		() => {
			const run = runComponentScript(["docker"], {
				env: { FAKE_UPGRADE_KEEPS_OLD: "1" },
			});

			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain("Docker was rolled back to 28.3.0");
			expect(run.stderr).toContain("docker-rollback-");
			expect(
				run.calls.some(
					(call) =>
						call.startsWith(
							"apt-get install -y --allow-downgrades --no-download ",
						) && call.includes("docker-rollback-"),
				),
			).toBe(true);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"prints the commands to finish the rollback by hand when the rollback fails",
		() => {
			const run = runComponentScript(["docker"], {
				env: { FAKE_UPGRADE_KEEPS_OLD: "1", FAKE_ROLLBACK_FAILS: "1" },
			});

			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain("did not finish");
			expect(run.stderr).toContain(
				"apt-get install -y --allow-downgrades --no-download",
			);
			expect(run.stderr).toContain("docker-rollback-");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"skips only Docker when the current Docker packages cannot be saved",
		() => {
			const run = runComponentScript(["docker", "traefik"], {
				env: { FAKE_DOWNLOAD_FAILS: "1" },
			});

			expect(run.status).toBe(0);
			expect(run.stdout).toContain(
				"Docker not updated: the current Docker packages could not be saved for rollback. The other components continue.",
			);
			expect(run.stdout).toContain(
				`Traefik version ${TRAEFIK_VERSION} installed`,
			);
			expect(run.calls.some((call) => call.startsWith("apt-get install"))).toBe(
				false,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"skips only Docker when docker-ce is not installed, as on hosts running docker.io",
		() => {
			const run = runComponentScript(["docker", "traefik"], {
				env: { FAKE_NO_DOCKER_CE: "1" },
			});

			expect(run.status).toBe(0);
			expect(run.stdout).toContain(
				"Docker not updated: docker-ce is not installed, so there is no Docker Engine to roll back to.",
			);
			expect(run.stdout).toContain(
				`Traefik version ${TRAEFIK_VERSION} installed`,
			);
			expect(run.calls.some((call) => call.startsWith("apt-get install"))).toBe(
				false,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"skips only Docker when apt-get is missing, and never runs get.docker.com",
		() => {
			const run = runComponentScript(["docker", "traefik"], {
				withoutApt: true,
			});

			expect(run.status).toBe(0);
			expect(run.stdout).toContain(
				"Docker not updated: this host has no apt-get, so the Docker packages cannot be pre-downloaded or rolled back. The other components continue.",
			);
			expect(run.stdout).toContain(
				`Traefik version ${TRAEFIK_VERSION} installed`,
			);
			expect(run.calls.some((call) => call.startsWith("curl"))).toBe(false);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"skips only the Docker step when the apt repository is for another release",
		() => {
			const run = runComponentScript(["docker", "traefik"], {
				sourceFiles: { "docker.list": DOCKER_LIST_JAMMY },
			});

			expect(run.status).toBe(0);
			expect(run.stdout).toContain("Docker not updated:");
			expect(run.stdout).toContain("is for jammy, but this host runs noble");
			expect(run.stdout).toContain(
				`Traefik version ${TRAEFIK_VERSION} installed`,
			);
			expect(run.stdout).toContain(COMPONENTS_UPDATE_DONE);
			expect(run.calls.some((call) => call.startsWith("apt-get "))).toBe(false);
			expect(run.calls.some((call) => call.includes("get.docker.com"))).toBe(
				false,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"reads the Docker repository codename from a deb822 sources file too",
		() => {
			const run = runComponentScript(["docker"], {
				sourceFiles: { "docker.sources": DOCKER_SOURCES_JAMMY },
			});

			expect(run.status).toBe(0);
			expect(run.stdout).toContain("is for jammy, but this host runs noble");
			expect(run.calls.some((call) => call.startsWith("apt-get "))).toBe(false);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"accepts a Docker repository for the same release",
		() => {
			const run = runComponentScript(["docker"], {
				sourceFiles: { "docker.list": DOCKER_LIST_NOBLE },
			});

			expect(run.status).toBe(0);
			expect(run.stdout).not.toContain("Docker not updated");
			expect(run.stdout).toContain(
				`Docker version ${PINNED_VERSIONS.docker} installed`,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"adds Docker's repository when none is configured and apt does not offer the pinned version",
		() => {
			const run = runComponentScript(["docker"], {
				env: { FAKE_CANDIDATE_AFTER_REPO: "1" },
			});

			expect(run.status).toBe(0);
			expect(
				run.calls.some((call) =>
					call.startsWith(
						"curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o ",
					),
				),
			).toBe(true);
			expect(run.keyringExists).toBe(true);
			expect(run.sources["docker.list"]).toMatch(
				/^deb \[arch=amd64 signed-by=.+docker\.asc\] https:\/\/download\.docker\.com\/linux\/ubuntu noble stable\n$/,
			);
			expect(
				run.calls.filter((call) => call === "apt-get update -qq"),
			).toHaveLength(2);
			expect(run.stdout).toContain(
				`Docker version ${PINNED_VERSIONS.docker} installed`,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"skips only Docker, without rewriting it, when the repository does not offer the pinned version",
		() => {
			const run = runComponentScript(["docker", "traefik"], {
				env: { FAKE_NO_CANDIDATE: "1" },
				sourceFiles: { "docker.list": DOCKER_LIST_NOBLE },
			});

			expect(run.status).toBe(0);
			expect(run.stdout).toContain(
				`Docker not updated: Docker ${PINNED_VERSIONS.docker} is not offered by the Docker apt repository configured on this host.`,
			);
			expect(run.stdout).toContain(
				`Traefik version ${TRAEFIK_VERSION} installed`,
			);
			expect(run.sources["docker.list"]).toBe(DOCKER_LIST_NOBLE);
			expect(run.keyringExists).toBe(false);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"skips only Docker on an unsupported distribution, without any change",
		() => {
			const run = runComponentScript(["docker", "traefik"], {
				env: { FAKE_CANDIDATE_AFTER_REPO: "1" },
				osRelease: "ID=fedora\nVERSION_CODENAME=40\n",
			});

			expect(run.status).toBe(0);
			expect(run.stdout).toContain(
				"is not in the apt sources, and Docker's repository is only added automatically on ubuntu and debian (this host is 'fedora').",
			);
			expect(run.stdout).toContain(
				`Traefik version ${TRAEFIK_VERSION} installed`,
			);
			expect(run.calls.some((call) => call.startsWith("curl"))).toBe(false);
			expect(run.calls.some((call) => call.startsWith("apt-get install"))).toBe(
				false,
			);
			expect(run.keyringExists).toBe(false);
			expect(run.sources).toEqual({});
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
	it(
		"removes the Docker key and source it wrote, then aborts, when the new packages cannot be downloaded",
		() => {
			const run = runComponentScript(["docker", "traefik"], {
				env: { FAKE_CANDIDATE_AFTER_REPO: "1", FAKE_PREDOWNLOAD_FAILS: "1" },
			});

			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain(
				"Pre-download failed: the Docker packages. Nothing was changed.",
			);
			expect(run.sources).toEqual({});
			expect(run.keyringExists).toBe(false);
			expect(run.keyringDirExists).toBe(false);
			expect(run.calls.some((call) => call.startsWith("docker rename"))).toBe(
				false,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"removes what it wrote, then skips only Docker, when the rollback packages cannot be saved",
		() => {
			const run = runComponentScript(["docker", "traefik"], {
				env: { FAKE_CANDIDATE_AFTER_REPO: "1", FAKE_DOWNLOAD_FAILS: "1" },
			});

			expect(run.status).toBe(0);
			expect(run.stdout).toContain(
				"Docker not updated: the current Docker packages could not be saved for rollback. The other components continue.",
			);
			expect(run.stdout).toContain(
				`Traefik version ${TRAEFIK_VERSION} installed`,
			);
			expect(run.sources).toEqual({});
			expect(run.keyringExists).toBe(false);
			expect(run.keyringDirExists).toBe(false);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"removes what it wrote, then skips only Docker, when the pinned version is still missing after the update",
		() => {
			const run = runComponentScript(["docker", "traefik"], {
				env: { FAKE_NO_CANDIDATE: "1" },
			});

			expect(run.status).toBe(0);
			expect(run.stdout).toContain(
				`Docker not updated: Docker ${PINNED_VERSIONS.docker} is not in the apt sources, even after adding Docker's repository. The other components continue.`,
			);
			expect(run.stdout).toContain(
				`Traefik version ${TRAEFIK_VERSION} installed`,
			);
			expect(run.sources).toEqual({});
			expect(run.keyringExists).toBe(false);
			expect(run.keyringDirExists).toBe(false);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"keeps a Docker key that existed before the run and removes only the source it wrote",
		() => {
			const run = runComponentScript(["docker", "traefik"], {
				env: { FAKE_CANDIDATE_AFTER_REPO: "1", FAKE_DOWNLOAD_FAILS: "1" },
				preexistingKeyring: "existing key\n",
			});

			expect(run.status).toBe(0);
			expect(run.keyring).toBe("existing key\n");
			expect(run.sources).toEqual({});
			expect(run.calls.some((call) => call.startsWith("curl"))).toBe(false);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
	it(
		"removes the saved packages when they cannot be saved, so Docker is skipped with nothing left behind",
		() => {
			const run = runComponentScript(["docker", "traefik"], {
				env: { FAKE_DOWNLOAD_FAILS: "1" },
			});

			expect(run.status).toBe(0);
			expect(run.stdout).toContain(
				"Docker not updated: the current Docker packages could not be saved for rollback.",
			);
			expect(run.backups).toEqual([]);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"removes the saved packages when the new packages cannot be downloaded, then aborts",
		() => {
			const run = runComponentScript(["docker", "traefik"], {
				env: { FAKE_PREDOWNLOAD_FAILS: "1" },
			});

			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain(
				"Pre-download failed: the Docker packages. Nothing was changed.",
			);
			expect(run.backups).toEqual([]);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
	it(
		"fails the update when the Nixpacks install script cannot be downloaded",
		() => {
			const run = runComponentScript(["nixpacks"], {
				env: { FAKE_CURL_FAILS_FOR: "nixpacks.com" },
			});

			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain(
				"the Nixpacks install script could not be downloaded or checked",
			);
			expect(run.stdout).not.toContain("Nixpacks version");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"installs Railpack from the downloaded script when the download succeeds",
		() => {
			const run = runComponentScript(["railpack"]);

			expect(run.status).toBe(0);
			expect(
				run.calls.some((call) =>
					call.startsWith("curl -fsSL https://railpack.com/install.sh -o "),
				),
			).toBe(true);
			expect(run.stdout).toContain(
				`Railpack version ${RAILPACK_VERSION} installed`,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
	it(
		"installs Railpack from the GitHub copy of the install script when railpack.com fails",
		() => {
			const run = runComponentScript(["railpack"], {
				env: { FAKE_CURL_FAILS_FOR: "railpack.com" },
			});

			expect(run.status).toBe(0);
			expect(
				run.calls.some((call) =>
					call.startsWith(
						"curl -fsSL https://raw.githubusercontent.com/railwayapp/railpack/refs/heads/main/install.sh -o ",
					),
				),
			).toBe(true);
			expect(run.stderr).toContain(
				"The Railpack install script could not be downloaded or checked from https://railpack.com/install.sh.",
			);
			expect(run.stdout).toContain(
				`Railpack version ${RAILPACK_VERSION} installed`,
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"fails the update when neither copy of the Railpack install script can be downloaded",
		() => {
			const run = runComponentScript(["railpack"], {
				env: { FAKE_CURL_FAILS_FOR: "install.sh" },
			});

			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain(
				"the Railpack install script could not be downloaded or checked; Railpack was not changed.",
			);
			expect(run.stdout).not.toContain("Railpack version");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
	it(
		"fails the update when the RClone download fails",
		() => {
			const run = runComponentScript(["rclone"], {
				env: { FAKE_CURL_FAILS_FOR: "downloads.rclone.org" },
			});

			expect(run.status).not.toBe(0);
			expect(run.stdout).not.toContain("RClone version");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"fails the update when the Buildpacks download fails",
		() => {
			const run = runComponentScript(["buildpacks"], {
				env: { FAKE_CURL_FAILS_FOR: "github.com" },
			});

			expect(run.status).not.toBe(0);
			expect(run.stdout).not.toContain("Buildpacks version");
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
	it(
		"resets the Traefik restart policy during the Docker rollback",
		() => {
			const run = runComponentScript(["docker"], {
				env: { FAKE_UPGRADE_KEEPS_OLD: "1" },
			});

			expect(run.status).not.toBe(0);
			expect(run.calls).toContain(
				"docker update --restart always dokploy-traefik",
			);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
	it(
		"checks the new Traefik once a second over the settle time, then once more",
		() => {
			const run = runComponentScript(["traefik"], {
				env: { TRAEFIK_SETTLE_SECONDS: "3" },
			});

			expect(run.status).toBe(0);
			const checks = run.calls.filter((call) =>
				call.startsWith(
					"docker inspect -f {{.State.Running}} {{.RestartCount}}",
				),
			);
			expect(checks).toHaveLength(4);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);

	it(
		"stops at the first check that finds the new Traefik not running",
		() => {
			const run = runComponentScript(["traefik"], {
				env: { FAKE_NOT_RUNNING: "1", TRAEFIK_SETTLE_SECONDS: "10" },
			});

			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain("while checking the new Traefik container");
			const checks = run.calls.filter((call) =>
				call.startsWith(
					"docker inspect -f {{.State.Running}} {{.RestartCount}}",
				),
			);
			expect(checks).toHaveLength(2);
		},
		SPAWN_TEST_TIMEOUT_MS,
	);
});

describe("buildTraefikCreateCommand", () => {
	it("creates the container with the same ports and image as run, without starting it", () => {
		const command = buildTraefikCreateCommand("3.7.5");

		expect(command).toContain("docker create");
		expect(command).not.toContain("docker run");
		expect(command).not.toContain("network connect");
		expect(command).toMatch(/-p 443:443\s/);
		expect(command).toContain("-p 443:443/udp");
		expect(command).toContain("traefik:v3.7.5");
	});

	it("never publishes host port 80", () => {
		expect(buildTraefikCreateCommand("3.7.5")).not.toMatch(PORT_80_PUBLICATION);
	});
});

describe("buildTraefikRunCommand", () => {
	it("publishes HTTPS and HTTP/3 with the requested image and never port 80", () => {
		const command = buildTraefikRunCommand("3.7.5");

		expect(command).toMatch(/-p 443:443\s/);
		expect(command).not.toMatch(PORT_80_PUBLICATION);
		expect(command).toContain("-p 443:443/udp");
		expect(command).toContain("traefik:v3.7.5");
	});
});

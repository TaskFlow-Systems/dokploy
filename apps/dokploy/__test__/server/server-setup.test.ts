import { execFileSync, execSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createTraefikInstance,
	defaultCommand,
	RAILPACK_INSTALL_SCRIPT_URLS,
	reportDockerVersion,
} from "@dokploy/server";
import {
	NIXPACKS_VERSION,
	RAILPACK_VERSION,
} from "@dokploy/server/setup/component-versions";
import {
	buildTraefikRunCommand,
	buildTraefikTlsMigrationStep,
	TRAEFIK_VERSION,
} from "@dokploy/server/setup/traefik-setup";
import { describe, expect, it } from "vitest";

const resolveBin = (name: string) =>
	execSync(`command -v ${name}`, { encoding: "utf8" }).trim();

/**
 * Build a sandbox PATH so `command -v docker` only sees our fake docker
 * binary (or nothing), regardless of what the host has installed.
 */
const makeSandbox = (dockerShim?: string) => {
	const dir = mkdtempSync(path.join(tmpdir(), "dokploy-server-setup-"));
	for (const tool of ["awk", "tr"]) {
		const shim = path.join(dir, tool);
		writeFileSync(shim, `#!/bin/sh\nexec ${resolveBin(tool)} "$@"\n`);
		chmodSync(shim, 0o755);
	}
	if (dockerShim) {
		const shim = path.join(dir, "docker");
		writeFileSync(shim, dockerShim);
		chmodSync(shim, 0o755);
	}
	return dir;
};

const runReport = (sandboxPath: string) => {
	const script = [
		"DOCKER_VERSION=28.5.0",
		reportDockerVersion(),
		'echo "$DOCKER_VERSION_REPORT"',
	].join("\n");
	return execFileSync(resolveBin("bash"), ["-c", script], {
		encoding: "utf8",
		env: { ...process.env, PATH: sandboxPath },
	})
		.trim()
		.split("\n")
		.pop();
};

describe("reportDockerVersion", () => {
	it("reports the engine version when docker and its daemon are available", () => {
		const sandbox = makeSandbox(
			[
				"#!/bin/sh",
				'if [ "$1" = "--version" ]; then',
				'	echo "Docker version 25.0.0, build aaaaaaa"',
				"	exit 0",
				"fi",
				'if [ "$1" = "version" ]; then',
				'	echo "29.4.3"',
				"	exit 0",
				"fi",
				"exit 1",
			].join("\n"),
		);
		expect(runReport(sandbox)).toBe("29.4.3 (already installed)");
	});

	it("falls back to the client version when the daemon is unreachable", () => {
		const sandbox = makeSandbox(
			[
				"#!/bin/sh",
				'if [ "$1" = "--version" ]; then',
				'	echo "Docker version 29.4.3, build 055a478"',
				"	exit 0",
				"fi",
				'echo "Cannot connect to the Docker daemon" >&2',
				"exit 1",
			].join("\n"),
		);
		expect(runReport(sandbox)).toBe("29.4.3 (already installed)");
	});

	it("reports the pinned version to be installed when docker is missing", () => {
		expect(runReport(makeSandbox())).toBe("28.5.0 (will be installed)");
	});
});

describe("defaultCommand", () => {
	it.each([false, true])(
		"prints the detected Docker version in the setup banner (isBuildServer=%s)",
		(isBuildServer) => {
			const script = defaultCommand(isBuildServer);
			expect(script).toContain(reportDockerVersion());
			expect(script).toContain(
				'echo "| Docker            | $DOCKER_VERSION_REPORT"',
			);
			expect(script).not.toContain(
				'echo "| Docker            | $DOCKER_VERSION"',
			);
		},
	);
});

const BASH = resolveBin("bash");
const SETUP_STEP_TOOLS = ["bash", "env", "mktemp", "rm", "tar", "uname"];

// The lines of one step of the setup script: from the echo that names it to the next step.
const setupStep = (script: string, marker: string) => {
	const start = script.lastIndexOf("\n", script.indexOf(marker)) + 1;
	const next = script.indexOf('\necho -e "', start);
	return script.slice(start, next === -1 ? script.length : next + 1);
};

// Runs one step as the setup script runs it: under set -e, with a PATH that holds only
// the fake curl and the tools the step needs, so nixpacks, railpack and pack are absent.
// failsFor fails only the downloads whose URL contains it.
const runSetupStep = (step: string, curlMode: "ok" | "fail", failsFor = "") => {
	const dir = mkdtempSync(path.join(tmpdir(), "dokploy-setup-step-"));
	try {
		const binDir = path.join(dir, "bin");
		mkdirSync(binDir);
		for (const tool of SETUP_STEP_TOOLS) {
			symlinkSync(resolveBin(tool), path.join(binDir, tool));
		}
		const curl = path.join(dir, "curl");
		writeFileSync(
			curl,
			`#!/bin/sh
if [ "$FAKE_CURL_MODE" = fail ]; then exit 22; fi
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
printf '%s\\n' 'echo fake installer "$NIXPACKS_VERSION$RAILPACK_VERSION"' > "$out"
`,
		);
		chmodSync(curl, 0o755);
		const script = [
			"set -e",
			'command_exists() { command -v "$@" >/dev/null 2>&1; }',
			'SUDO_CMD=""',
			"SYS_ARCH=x86_64",
			step,
		].join("\n");
		return spawnSync(BASH, [], {
			input: script,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${dir}:${binDir}`,
				FAKE_CURL_MODE: curlMode,
				FAKE_CURL_FAILS_FOR: failsFor,
			},
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

describe("createTraefikInstance", () => {
	it("converts the Traefik config before a missing container is created, and stops if that fails", () => {
		const command = createTraefikInstance();
		const migration = command.indexOf(buildTraefikTlsMigrationStep());

		expect(migration).toBeGreaterThanOrEqual(0);
		expect(migration).toBeLessThan(
			command.indexOf(buildTraefikRunCommand(TRAEFIK_VERSION)),
		);
		expect(command).toMatch(/\}; then\s+echo "[^"]*" >&2\s+exit 1\s+fi\s/);
	});
});

describe("install scripts in the server setup", () => {
	it.each([false, true])(
		"downloads the Nixpacks and Railpack install scripts to files and checks them before running them (isBuildServer=%s)",
		(isBuildServer) => {
			const script = defaultCommand(isBuildServer);

			expect(script).toContain(
				"for nixpacks_installer_url in https://nixpacks.com/install.sh; do",
			);
			expect(script).toContain(
				'curl -fsSL "$nixpacks_installer_url" -o "$nixpacks_installer"',
			);
			expect(script).toContain('bash -n "$nixpacks_installer"');
			expect(script).toContain(
				`env NIXPACKS_VERSION=${NIXPACKS_VERSION} bash "$nixpacks_installer"`,
			);
			expect(script).toContain(
				`for railpack_installer_url in ${RAILPACK_INSTALL_SCRIPT_URLS.join(" ")}; do`,
			);
			expect(script).toContain(
				'curl -fsSL "$railpack_installer_url" -o "$railpack_installer"',
			);
			expect(script).toContain('bash -n "$railpack_installer"');
			expect(script).toContain(
				`env RAILPACK_VERSION=${RAILPACK_VERSION} bash "$railpack_installer"`,
			);
			expect(script).not.toContain('bash -c "$(curl');
		},
	);

	it("stops the setup when the Nixpacks install script cannot be downloaded", () => {
		const result = runSetupStep(
			setupStep(defaultCommand(true), 'Installing Nixpacks"'),
			"fail",
		);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(
			"the Nixpacks install script could not be downloaded or checked",
		);
		expect(result.stdout).not.toContain("Nixpacks version");
	});

	it("stops the setup when the Railpack install script cannot be downloaded", () => {
		const result = runSetupStep(
			setupStep(defaultCommand(true), 'Installing Railpack"'),
			"fail",
		);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(
			"the Railpack install script could not be downloaded or checked",
		);
		expect(result.stdout).not.toContain("Railpack version");
	});

	it("runs the downloaded Railpack install script with the pinned version", () => {
		const result = runSetupStep(
			setupStep(defaultCommand(true), 'Installing Railpack"'),
			"ok",
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(`fake installer ${RAILPACK_VERSION}`);
		expect(result.stdout).toContain(
			`Railpack version ${RAILPACK_VERSION} installed`,
		);
	});

	it("installs Railpack from the GitHub copy of the install script when railpack.com fails", () => {
		const result = runSetupStep(
			setupStep(defaultCommand(true), 'Installing Railpack"'),
			"ok",
			"railpack.com",
		);

		expect(result.status).toBe(0);
		expect(result.stderr).toContain(
			"The Railpack install script could not be downloaded or checked from https://railpack.com/install.sh.",
		);
		expect(result.stdout).toContain(`fake installer ${RAILPACK_VERSION}`);
		expect(result.stdout).toContain(
			`Railpack version ${RAILPACK_VERSION} installed`,
		);
	});

	it("stops the setup when neither copy of the Railpack install script can be downloaded", () => {
		const result = runSetupStep(
			setupStep(defaultCommand(true), 'Installing Railpack"'),
			"ok",
			"install.sh",
		);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(
			"could not be downloaded or checked from https://raw.githubusercontent.com/railwayapp/railpack/refs/heads/main/install.sh.",
		);
		expect(result.stdout).not.toContain("Railpack version");
	});

	it("stops the setup when the RClone download fails", () => {
		const result = runSetupStep(
			setupStep(defaultCommand(true), 'Installing RClone. "'),
			"fail",
		);

		expect(result.status).not.toBe(0);
	});

	it("stops the setup when the Buildpacks download fails", () => {
		const result = runSetupStep(
			setupStep(defaultCommand(true), 'Installing Buildpacks"'),
			"fail",
		);

		expect(result.status).not.toBe(0);
	});
});

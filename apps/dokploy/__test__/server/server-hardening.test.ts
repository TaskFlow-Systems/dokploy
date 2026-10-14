import { execSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	buildServerHardeningScript,
	defaultCommand,
	hardenFail2banCommand,
	SERVER_HARDENING_ITEMS,
	type ServerHardeningItem,
} from "@dokploy/server";
import { afterEach, describe, expect, it } from "vitest";

const BASH = execSync("command -v bash", { encoding: "utf8" }).trim();

const subsets: { items: ServerHardeningItem[] }[] = [
	{ items: ["ufw"] },
	{ items: ["ssh"] },
	{ items: ["fail2ban"] },
	{ items: ["ufw", "ssh", "fail2ban"] },
];

describe("buildServerHardeningScript", () => {
	it.each(subsets)("is valid bash for $items", ({ items }) => {
		const result = spawnSync(BASH, ["-n"], {
			input: buildServerHardeningScript(items),
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("contains only the selected items", () => {
		const script = buildServerHardeningScript(["fail2ban"]);

		expect(script).toContain("install -y -qq fail2ban");
		expect(script).not.toContain("ufw --force enable");
		expect(script).not.toContain("PasswordAuthentication no");
	});

	it("skips the package list update when only SSH is hardened", () => {
		expect(buildServerHardeningScript(["ssh"])).not.toContain(
			"apt-get -o DPkg::Lock::Timeout=300 update",
		);
	});

	it("never opens port 80", () => {
		const script = buildServerHardeningScript([...SERVER_HARDENING_ITEMS]);

		expect(script).not.toMatch(/ufw allow 80\b/);
		expect(script).not.toMatch(/\b80\/(tcp|udp)/);
	});

	it("stops when the SSH user has neither root nor passwordless sudo", () => {
		const script = buildServerHardeningScript(["ufw"]);

		expect(script).toMatch(/elif sudo -n true 2>\/dev\/null; then/);
		expect(script).toMatch(/needs root or passwordless sudo[^\n]*\n\s*exit 1/);
	});
});

describe("defaultCommand hardening step", () => {
	const previous = process.env.DOKPLOY_SERVER_HARDENING;

	afterEach(() => {
		if (previous === undefined) {
			delete process.env.DOKPLOY_SERVER_HARDENING;
		} else {
			process.env.DOKPLOY_SERVER_HARDENING = previous;
		}
	});

	it("leaves hardening out when DOKPLOY_SERVER_HARDENING is not set", () => {
		delete process.env.DOKPLOY_SERVER_HARDENING;

		expect(defaultCommand()).not.toContain("Applying security hardening");
	});

	it("adds the requested items when DOKPLOY_SERVER_HARDENING is set", () => {
		process.env.DOKPLOY_SERVER_HARDENING = "ufw";
		const script = defaultCommand();

		expect(script).toContain('echo -e "15. Applying security hardening"');
		expect(script).toContain("ufw --force enable");
		expect(script).not.toContain("PasswordAuthentication no");
	});
});

// Runs the Fail2Ban step against a temporary jail.local with fake apt-get and systemctl.
const runFail2banStep = (existingJail?: string) => {
	const dir = mkdtempSync(path.join(tmpdir(), "dokploy-fail2ban-"));
	try {
		const jail = path.join(dir, "jail.local");
		if (existingJail !== undefined) {
			writeFileSync(jail, existingJail);
		}
		for (const tool of ["apt-get", "systemctl"]) {
			const fake = path.join(dir, tool);
			writeFileSync(fake, "#!/bin/sh\nexit 0\n");
			chmodSync(fake, 0o755);
		}
		const step = hardenFail2banCommand().replaceAll(
			"/etc/fail2ban/jail.local",
			jail,
		);
		const result = spawnSync(BASH, [], {
			input: ["set -e", 'SUDO_CMD=""', "OS_TYPE=ubuntu", step].join("\n"),
			encoding: "utf8",
			env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
		});
		return { ...result, jail: readFileSync(jail, "utf8") };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

describe("hardenFail2banCommand", () => {
	it("creates jail.local with an aggressive sshd jail", () => {
		const result = runFail2banStep();

		expect(result.status).toBe(0);
		expect(result.jail).toBe("[sshd]\nenabled = true\nmode = aggressive\n");
	});

	it("appends the sshd jail to a jail.local that has none", () => {
		const result = runFail2banStep("[DEFAULT]\nbantime = 1h\n");

		expect(result.status).toBe(0);
		expect(result.jail).toBe(
			"[DEFAULT]\nbantime = 1h\n\n[sshd]\nenabled = true\nmode = aggressive\n",
		);
	});

	it("keeps an existing sshd jail unchanged", () => {
		const existing = "[sshd]\nenabled = true\nmode = normal\n";
		const result = runFail2banStep(existing);

		expect(result.status).toBe(0);
		expect(result.jail).toBe(existing);
		expect(result.stdout).toContain("already has an [sshd] section");
	});
});

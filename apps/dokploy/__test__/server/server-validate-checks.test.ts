import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	validateDockerGroup,
	validateDokployNetwork,
	validateSwarm,
} from "@dokploy/server";
import { afterEach, describe, expect, it } from "vitest";

const BASH = spawnSync("sh", ["-c", "command -v bash"], {
	encoding: "utf8",
}).stdout.trim();

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

const run = (script: string, fakes: Record<string, string>) => {
	const dir = mkdtempSync(path.join(tmpdir(), "validate-"));
	dirs.push(dir);
	for (const [name, body] of Object.entries(fakes)) {
		const file = path.join(dir, name);
		writeFileSync(file, `#!/bin/sh\n${body}\n`);
		chmodSync(file, 0o755);
	}
	const result = spawnSync(BASH, ["-c", script], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
	});
	return result.stdout.trim();
};

const docker = (swarm: string, networks: string[] = []) =>
	`case "$1" in
	info) echo ${swarm} ;;
	network) ${networks.map((name) => `echo ${name}`).join("; ") || ":"} ;;
esac`;

describe("validateSwarm", () => {
	it.each([
		["active", "true"],
		["inactive", "false"],
		["pending", "false"],
		["error", "false"],
		["locked", "false"],
	])("reads %s as %s", (state, expected) => {
		expect(run(validateSwarm(), { docker: docker(state) })).toBe(expected);
	});

	it("reports no swarm when docker cannot be reached", () => {
		expect(run(validateSwarm(), { docker: "exit 1" })).toBe("false");
	});
});

describe("validateDokployNetwork", () => {
	it("finds the network", () => {
		expect(
			run(validateDokployNetwork(), {
				docker: docker("inactive", ["bridge", "dokploy-network"]),
			}),
		).toBe("true");
	});

	it("does not take another network that holds the name", () => {
		expect(
			run(validateDokployNetwork(), {
				docker: docker("inactive", ["bridge", "my-dokploy-network-old"]),
			}),
		).toBe("false");
	});
});

describe("validateDockerGroup", () => {
	it("finds the docker group", () => {
		expect(
			run(validateDockerGroup(), { groups: "echo 'dev docker sudo'" }),
		).toBe("true");
	});

	it("does not take a group that starts with docker-", () => {
		expect(
			run(validateDockerGroup(), { groups: "echo 'dev docker-admin sudo'" }),
		).toBe("false");
	});
});

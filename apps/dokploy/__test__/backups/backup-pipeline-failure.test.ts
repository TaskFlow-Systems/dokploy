import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getLibsqlBackupCommand } from "@dokploy/server/utils/backups/utils";
import { wrapBashPipefail } from "@dokploy/server/utils/restore/safe-input";
import { getRestoreCommand } from "@dokploy/server/utils/restore/utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// A `docker` stand-in that runs the inner `sh -c` script on this machine, with
// the sqld data directory moved into a temp dir. `sh` here is whatever the
// host has (dash on Debian), the shell without pipefail.
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "backup-pipe-"));
	mkdirSync(path.join(dir, "sqld", "iku.db"), { recursive: true });
	writeFileSync(path.join(dir, "sqld", "iku.db", "data"), "payload");
	mkdirSync(path.join(dir, "bin"));
	const shim = path.join(dir, "bin", "docker");
	writeFileSync(
		shim,
		`#!/bin/sh
shift; [ "$1" = "-i" ] && shift; shift
[ "$1" = "sh" ] && shift && shift
exec sh -c "$(printf '%s' "$1" | sed 's#/var/lib/sqld#${dir}/sqld#g')"
`,
	);
	chmodSync(shim, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (script: string) =>
	spawnSync("/bin/sh", ["-c", script], {
		env: {
			...process.env,
			PATH: `${dir}/bin:${process.env.PATH}`,
			CONTAINER_ID: "c",
		},
		encoding: "utf8",
	});

describe("libsql backup pipeline", () => {
	it("fails when the database name does not exist", () => {
		// the outer backup script runs with pipefail; mirror that here
		const outer = spawnSync(
			"/bin/bash",
			["-c", `set -o pipefail; ${getLibsqlBackupCommand("iku")} > /dev/null`],
			{
				env: {
					...process.env,
					PATH: `${dir}/bin:${process.env.PATH}`,
					CONTAINER_ID: "c",
				},
				encoding: "utf8",
			},
		);
		expect(outer.status).not.toBe(0);
		expect(outer.stderr).toContain("iku");
	});

	it("still succeeds for an existing database", () => {
		const outer = spawnSync(
			"/bin/bash",
			[
				"-c",
				`set -o pipefail; ${getLibsqlBackupCommand("iku.db")} | gzip -dc | tar -tf -`,
			],
			{
				env: {
					...process.env,
					PATH: `${dir}/bin:${process.env.PATH}`,
					CONTAINER_ID: "c",
				},
				encoding: "utf8",
			},
		);
		expect(outer.status).toBe(0);
		expect(outer.stdout).toContain("iku.db/data");
	});
});

describe("restore pipelines", () => {
	it("wrapBashPipefail fails when a non-final stage fails, under sh", () => {
		const plain = run("false | cat");
		const wrapped = run(wrapBashPipefail("false | cat"));
		expect(plain.status).toBe(0);
		expect(wrapped.status).not.toBe(0);
	});

	it("a failing rclone stage fails the postgres restore command", () => {
		const command = getRestoreCommand({
			appName: "app",
			type: "postgres",
			restoreType: "database",
			credentials: { database: "app", databaseUser: "u" },
			rcloneCommand: "(echo rclone failed >&2; exit 3)",
		});
		// the shim `docker ps` prints nothing, `docker exec` consumes stdin
		writeFileSync(
			path.join(dir, "bin", "docker"),
			'#!/bin/sh\n[ "$1" = ps ] && exit 0\ncat >/dev/null\n',
		);
		const result = run(command);
		expect(result.status).not.toBe(0);
	});
});

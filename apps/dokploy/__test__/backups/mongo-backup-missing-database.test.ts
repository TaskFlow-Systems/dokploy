import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getMongoBackupCommand } from "@dokploy/server/utils/backups/utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// `mongodump -d nosuchdb` exits 0 with an empty archive, so the command asks the
// server for its database names first. `docker` runs the inner script here, the
// `mongosh` stand-in answers like the real one for a list of databases, and
// `mongodump` leaves a marker file when it runs.
let dir: string;
const write = (name: string, body: string) => {
	const file = path.join(dir, "bin", name);
	writeFileSync(file, `#!/bin/bash\n${body}\n`);
	chmodSync(file, 0o755);
};
beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "mongo-missing-db-"));
	mkdirSync(path.join(dir, "bin"));
	write(
		"docker",
		`shift
envs=()
while [ "$1" = "-e" ]; do envs+=("$2"); shift 2; done
[ "$1" = "-i" ] && shift
shift
exec env "\${envs[@]}" "$@"`,
	);
	// The databases the server holds: "app" and "admin". The script is the one the
	// command passes, run with the same rule: exit 0 when the name is listed.
	write(
		"mongosh",
		`[ -n "$MONGOSH_BROKEN" ] && { echo "MongoServerError: Authentication failed" >&2; exit 1; }
case " app admin " in *" $DOKPLOY_DB_NAME "*) exit 0;; *) exit 3;; esac`,
	);
	write("mongodump", `touch "${dir}/dumped"; printf ARCHIVE`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (database: string, env: Record<string, string> = {}) =>
	spawnSync(
		"bash",
		[
			"-c",
			`set -o pipefail; ${getMongoBackupCommand(database, "u", "p")} | cat`,
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				...env,
				PATH: `${dir}/bin:${process.env.PATH}`,
				CONTAINER_ID: "c",
			},
		},
	);

describe("mongo backup of a database that is not there", () => {
	it("fails with a clear message and does not dump", () => {
		const result = run("nosuchdb");

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Database nosuchdb does not exist");
		expect(result.stdout).toBe("");
		expect(existsSync(path.join(dir, "dumped"))).toBe(false);
	});

	it("dumps a database the server lists", () => {
		const result = run("app");

		expect(result.status).toBe(0);
		expect(result.stdout).toBe("ARCHIVE");
	});

	it("stops on any other mongosh failure instead of dumping", () => {
		const result = run("app", { MONGOSH_BROKEN: "1" });

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Authentication failed");
		expect(existsSync(path.join(dir, "dumped"))).toBe(false);
	});

	it("still dumps when the image has no mongosh", () => {
		rmSync(path.join(dir, "bin", "mongosh"));
		const result = spawnSync(
			"bash",
			[
				"-c",
				`set -o pipefail; ${getMongoBackupCommand("app", "u", "p")} | cat`,
			],
			{
				encoding: "utf8",
				env: {
					PATH: `${dir}/bin:/usr/bin:/bin`,
					CONTAINER_ID: "c",
				},
			},
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toBe("ARCHIVE");
	});
});

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { getMongoBackupCommand } from "@dokploy/server/utils/backups/utils";
import { getMongoRestoreCommand } from "@dokploy/server/utils/restore/utils";
import {
	REDACTED_SECRET_VALUE,
	redactSensitiveText,
} from "@dokploy/server/utils/security/redaction";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMongoPasswordChangeCommand } from "@/server/api/utils/database-password";

// The ones that read as an option are what the tools' own parsers refuse in the
// `-p <value>` form.
const ALLOWED_PASSWORDS = [
	"-x",
	"--port",
	"-",
	"--eval",
	"--help",
	"--host=127.0.0.1",
	"#hash",
	"*",
	"a=b",
	"p@ss:w?rd#1%41&^*()_+-=[]{}|,.<>~",
];
// DATABASE_PASSWORD_REGEX refuses this one today, but an old row can hold it.
const PASSWORDS = [...ALLOWED_PASSWORDS, `we'ird"pass\\word $HOME \`x\` ;!`];

const CASES: Array<[string, (password: string) => string]> = [
	["mongodump", (password) => getMongoBackupCommand("app", "user", password)],
	[
		"mongorestore",
		(password) => getMongoRestoreCommand("app", "user", password),
	],
	[
		"mongosh",
		(databasePassword) =>
			buildMongoPasswordChangeCommand({
				databaseUser: "user",
				databasePassword,
				password: "new-password",
			}),
	],
];

let bin: string;

// `docker` applies -e and runs the rest in the container's place, so both shell
// layers run as in production. The tools print the arguments they receive.
beforeAll(() => {
	bin = mkdtempSync(join(tmpdir(), "mongo-password-argument-"));
	const writeTool = (name: string, body: string) => {
		const path = join(bin, name);
		writeFileSync(path, `#!/bin/bash\n${body}\n`);
		chmodSync(path, 0o755);
	};
	writeTool(
		"docker",
		`shift
envs=()
while [ "$1" = "-e" ]; do envs+=("$2"); shift 2; done
[ "$1" = "-i" ] && shift
shift
exec env "\${envs[@]}" "$@"`,
	);
	for (const tool of ["mongodump", "mongorestore", "mongosh"]) {
		writeTool(tool, `printf '%s\\0' "$@"`);
	}
});

afterAll(() => {
	rmSync(bin, { recursive: true, force: true });
});

const argumentsOf = (command: string) =>
	execFileSync("bash", ["-c", command], {
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${bin}${delimiter}${process.env.PATH}`,
			CONTAINER_ID: "container",
		},
	})
		.split("\0")
		.slice(0, -1);

describe.each(CASES)("password of the %s command", (_tool, build) => {
	it.each(PASSWORDS)("hands %s over in the = form", (password) => {
		const args = argumentsOf(build(password));

		expect(args).toContain(`--password=${password}`);
		expect(args).toContain("--username=user");
		expect(args).not.toContain("-p");
		expect(args).not.toContain("--password");
	});

	it.each([...ALLOWED_PASSWORDS, "abc&secretTail", "abc|secretTail"])(
		"keeps %s out of a failed command's text",
		(password) => {
			const text = redactSensitiveText(build(password));

			expect(text).toContain(
				`-e DOKPLOY_DB_PASSWORD=${REDACTED_SECRET_VALUE} `,
			);
			expect(text).not.toContain("secretTail");
		},
	);
});

describe("new password of the mongosh command", () => {
	it.each(PASSWORDS)("reaches the script intact: %s", (password) => {
		const args = argumentsOf(
			buildMongoPasswordChangeCommand({
				databaseUser: "user",
				databasePassword: "current",
				password,
			}),
		);

		expect(args.at(-1)).toBe(
			`db.getSiblingDB("admin").changeUserPassword("user", ${JSON.stringify(password)})`,
		);
	});
});

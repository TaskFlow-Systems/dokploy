import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPostgresPasswordChangeCommand } from "../../server/api/utils/database-password";

const execFileAsync = promisify(execFile);

const IMAGE = "postgres:17";
const CHECKOUT_ID = createHash("sha256")
	.update(process.cwd())
	.digest("hex")
	.slice(0, 8);
const CONTAINER = `real-postgres-pw-${CHECKOUT_ID}-${Date.now()}`;
const REAL_TEST_TIMEOUT = 180_000;

const docker = async (...args: string[]) => {
	const { stdout } = await execFileAsync("docker", args, {
		timeout: 60_000,
	});
	return stdout.trim();
};

const sh = (command: string) =>
	execFileAsync("sh", ["-c", command], {
		env: { ...process.env, CONTAINER_ID: CONTAINER },
		timeout: 60_000,
	});

describe("postgres password change, user not named like the database", () => {
	beforeAll(async () => {
		await docker(
			"run",
			"-d",
			"--name",
			CONTAINER,
			"-e",
			"POSTGRES_USER=appuser",
			"-e",
			"POSTGRES_DB=app",
			"-e",
			"POSTGRES_PASSWORD=oldpass",
			IMAGE,
		);
		const deadline = Date.now() + 90_000;
		for (;;) {
			try {
				// the entrypoint runs a temporary server first; the final one is TCP
				await docker("exec", CONTAINER, "pg_isready", "-h", "127.0.0.1");
				await docker(
					"exec",
					CONTAINER,
					"psql",
					"-U",
					"appuser",
					"-d",
					"app",
					"-c",
					"select 1",
				);
				break;
			} catch (error) {
				if (Date.now() > deadline) throw error;
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		}
	}, REAL_TEST_TIMEOUT);

	afterAll(async () => {
		await docker("rm", "-f", CONTAINER).catch(() => undefined);
	}, REAL_TEST_TIMEOUT);

	it(
		"changes the password",
		async () => {
			await sh(
				buildPostgresPasswordChangeCommand({
					databaseName: "app",
					databaseUser: "appuser",
					password: "n3w'pass",
				}),
			);
			const out = await docker(
				"exec",
				"-e",
				"PGPASSWORD=n3w'pass",
				CONTAINER,
				"psql",
				"-h",
				"127.0.0.1",
				"-U",
				"appuser",
				"-d",
				"app",
				"-tAc",
				"select 42",
			);
			expect(out).toBe("42");
		},
		REAL_TEST_TIMEOUT,
	);
});

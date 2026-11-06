import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { waitForComposeContainers } from "@dokploy/server/utils/docker/compose-containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const IMAGE = "alpine:3.22";
const REAL_TEST_TIMEOUT = 120_000;
const FAST_LIMITS = { stableMs: 3_000, crashLimitMs: 15_000, intervalMs: 500 };

// The PR workflow removes projects named real-compose-<id>* after a cancelled run.
const CHECKOUT_ID = createHash("sha256")
	.update(process.cwd())
	.digest("hex")
	.slice(0, 8);
const RUN_ID = `${CHECKOUT_ID}-${Date.now()}`;

const projects: string[] = [];
let directory = "";

const run = async (...args: string[]) => {
	const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
	return stdout.trim();
};

const newProject = (kind: string) => {
	const name = `real-compose-${RUN_ID}-${kind}`;
	projects.push(name);
	return name;
};

/** What the panel runs, and what it starts timing from. */
const up = async (project: string, services: string, only: string[] = []) => {
	const file = join(directory, `${project}.yml`);
	await writeFile(file, `services:\n${services}`);
	const startedSince = Date.now();
	await run(
		"compose",
		"-p",
		project,
		"-f",
		file,
		"up",
		"-d",
		"--remove-orphans",
		...only,
	);
	return startedSince;
};

const service = (name: string, command: string, extra = "") =>
	`  ${name}:\n    image: ${IMAGE}\n    command: ["sh", "-c", ${JSON.stringify(command)}]\n${extra}`;

const failureOf = (promise: Promise<unknown>) =>
	promise.then(
		() => "",
		(error: Error) => error.message,
	);

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "compose-containers-"));
	await run("pull", "-q", IMAGE);
}, REAL_TEST_TIMEOUT);

afterAll(async () => {
	for (const project of projects) {
		await run("compose", "-p", project, "down", "-t", "0", "-v").catch(
			() => undefined,
		);
	}
	await rm(directory, { recursive: true, force: true });
}, REAL_TEST_TIMEOUT);

describe("waitForComposeContainers on real Docker", () => {
	it(
		"passes a project that runs, with a migration that exited 0, and a redeploy is quick",
		async () => {
			const project = newProject("fine");
			const services =
				service("web", "sleep 3600") +
				service("migrate", "echo migrated") +
				service(
					"api",
					"sleep 3600",
					'    healthcheck:\n      test: ["CMD", "true"]\n      interval: 1s\n',
				);

			const firstSince = await up(project, services);
			const first = Date.now();
			await expect(
				waitForComposeContainers(project, null, {
					...FAST_LIMITS,
					startedSince: firstSince,
				}),
			).resolves.toBe(3);
			expect(Date.now() - first).toBeGreaterThanOrEqual(2_000);

			// `up` runs the migration again and leaves the rest alone.
			const secondSince = await up(project, services);
			const second = Date.now();
			await expect(
				waitForComposeContainers(project, null, {
					...FAST_LIMITS,
					startedSince: secondSince,
				}),
			).resolves.toBe(3);
			expect(Date.now() - second).toBeLessThan(2_500);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"fails at once on a one-shot service that exited with an error",
		async () => {
			const project = newProject("oneshot");
			const startedSince = await up(
				project,
				service("web", "sleep 3600") + service("migrate", "exit 4"),
			);

			const message = await failureOf(
				waitForComposeContainers(project, null, {
					...FAST_LIMITS,
					startedSince,
				}),
			);

			expect(message).toBe(
				`Container ${project}-migrate-1 exited with code 4, and its restart policy does not start it again.`,
			);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"fails a restart loop at the crash limit with its exit code",
		async () => {
			const project = newProject("loop");
			const startedSince = await up(
				project,
				service("web", "sleep 1; exit 3", "    restart: unless-stopped\n"),
			);
			const started = Date.now();

			const message = await failureOf(
				waitForComposeContainers(project, null, {
					...FAST_LIMITS,
					startedSince,
				}),
			);

			expect(message).toMatch(
				new RegExp(
					`^Container ${project}-web-1 keeps restarting: it last exited with code 3 \\(waited \\d+ s\\)\\.$`,
				),
			);
			expect(Date.now() - started).toBeLessThan(25_000);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"passes a service that crashes once and then stays up",
		async () => {
			const project = newProject("once");
			// The volume outlives the first run, so only that run fails.
			const startedSince = await up(
				project,
				`${service(
					"web",
					"if [ -e /state/ran ]; then sleep 3600; else touch /state/ran; sleep 1; exit 1; fi",
					"    restart: on-failure\n    volumes:\n      - state:/state\n",
				)}volumes:\n  state: {}\n`,
			);

			await expect(
				waitForComposeContainers(project, null, {
					...FAST_LIMITS,
					startedSince,
				}),
			).resolves.toBe(1);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"fails on an unhealthy container and waits for a slow health check",
		async () => {
			const sick = newProject("sick");
			const sickSince = await up(
				sick,
				service(
					"web",
					"sleep 3600",
					'    healthcheck:\n      test: ["CMD", "false"]\n      interval: 1s\n      retries: 2\n',
				),
			);
			expect(
				await failureOf(
					waitForComposeContainers(sick, null, {
						...FAST_LIMITS,
						startedSince: sickSince,
					}),
				),
			).toMatch(
				new RegExp(
					`^Container ${sick}-web-1 is unhealthy: its health check failed \\d+ times in a row\\.$`,
				),
			);

			const slow = newProject("slow");
			const slowSince = await up(
				slow,
				service(
					"web",
					"sleep 6; touch /tmp/ready; sleep 3600",
					'    healthcheck:\n      test: ["CMD", "test", "-e", "/tmp/ready"]\n      interval: 1s\n      start_period: 30s\n',
				),
			);
			const started = Date.now();
			await expect(
				waitForComposeContainers(slow, null, {
					...FAST_LIMITS,
					startedSince: slowSince,
				}),
			).resolves.toBe(1);
			expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"leaves alone a container that a deployment of other services did not run",
		async () => {
			const project = newProject("subset");
			const services =
				service("web", "sleep 3600") + service("broken", "exit 1");
			const firstSince = await up(project, services);
			expect(
				await failureOf(
					waitForComposeContainers(project, null, {
						...FAST_LIMITS,
						startedSince: firstSince,
					}),
				),
			).toContain(`${project}-broken-1 exited with code 1`);

			await new Promise((resolve) => setTimeout(resolve, 1_500));
			const secondSince = await up(project, services, ["web"]);
			await expect(
				waitForComposeContainers(project, null, {
					...FAST_LIMITS,
					startedSince: secondSince,
				}),
			).resolves.toBe(1);
		},
		REAL_TEST_TIMEOUT,
	);
});

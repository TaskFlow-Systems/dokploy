import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { waitForStackRollout } from "@dokploy/server/utils/docker/stack-rollout";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const IMAGE = "redis:8-alpine";
const REAL_TEST_TIMEOUT = 120_000;
const FAST_LIMITS = { timeoutMs: 25_000, quietStartAllowanceMs: 0 };

// The PR workflow removes services named real-<kind>-<id>* after a cancelled run.
const CHECKOUT_ID = createHash("sha256")
	.update(process.cwd())
	.digest("hex")
	.slice(0, 8);
const RUN_ID = `${CHECKOUT_ID}-${Date.now()}`;

const stacks: string[] = [];
let directory = "";

const docker = async (...args: string[]) => {
	const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
	return stdout.trim();
};

const newStack = (kind: string) => {
	const name = `real-stack-${RUN_ID}-${kind}`;
	stacks.push(name);
	return name;
};

const deploy = async (stack: string, services: string) => {
	const file = join(directory, `${stack}-${Date.now()}.yml`);
	await writeFile(file, `services:\n${services}`);
	// What the panel runs: no --detach=false, and it exits 0 whatever Swarm does next.
	await docker("stack", "deploy", "-c", file, stack, "--prune");
};

const longRunning = (name: string, deployOptions = "{}") =>
	`  ${name}:\n    image: ${IMAGE}\n    deploy: ${deployOptions}\n`;

const exiting = (name: string, code: number, deployOptions = "{}") =>
	`  ${name}:\n    image: ${IMAGE}\n    command: ["sh", "-c", "exit ${code}"]\n    deploy: ${deployOptions}\n`;

const failureOf = (promise: Promise<unknown>) =>
	promise.then(
		() => "",
		(error: Error) => error.message,
	);

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "stack-rollout-"));
	await docker("pull", "-q", IMAGE);
}, REAL_TEST_TIMEOUT);

afterAll(async () => {
	for (const stack of stacks) {
		await docker("stack", "rm", stack).catch(() => undefined);
	}
	// `stack rm` gives up on a network whose tasks are still stopping.
	for (let attempt = 0; attempt < 30; attempt++) {
		const left = (await docker("network", "ls", "--format", "{{.Name}}"))
			.split("\n")
			.filter((name) => stacks.some((stack) => name.startsWith(`${stack}_`)));
		if (left.length === 0) break;
		await Promise.all(
			left.map((name) => docker("network", "rm", name).catch(() => undefined)),
		);
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	await rm(directory, { recursive: true, force: true });
}, REAL_TEST_TIMEOUT);

describe("waitForStackRollout on real Docker", () => {
	it(
		"waits for a new stack, and a redeploy that changes nothing takes seconds",
		async () => {
			const stack = newStack("fresh");
			const services =
				longRunning("web") +
				longRunning("worker", "{ replicas: 2 }") +
				longRunning("stopped", "{ replicas: 0 }") +
				exiting("job", 0, "{ mode: replicated-job }");
			await deploy(stack, services);

			await expect(waitForStackRollout(stack)).resolves.toBe(3);
			const running = await docker(
				"service",
				"ls",
				"--filter",
				`label=com.docker.stack.namespace=${stack}`,
				"--format",
				"{{.Name}} {{.Replicas}}",
			);
			expect(running).toContain(`${stack}_web 1/1`);
			expect(running).toContain(`${stack}_worker 2/2`);

			await deploy(stack, services);
			const startedAt = Date.now();
			await expect(waitForStackRollout(stack)).resolves.toBe(3);
			expect(Date.now() - startedAt).toBeLessThan(15_000);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"reports a rollback by name, which `docker stack deploy` never does",
		async () => {
			const stack = newStack("rollback");
			const policy =
				"{ update_config: { failure_action: rollback, monitor: 2s } }";
			await deploy(stack, longRunning("web", policy) + longRunning("other"));
			await waitForStackRollout(stack);

			await deploy(stack, exiting("web", 1, policy) + longRunning("other"));
			const failure = await failureOf(waitForStackRollout(stack));

			expect(failure).toContain(`${stack}_web`);
			expect(failure).toMatch(/rolling back|rolled back/);
			expect(failure).toContain("non-zero exit (1)");
			expect(failure).not.toContain(`${stack}_other`);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"reports the default failure action, which leaves the update paused",
		async () => {
			const stack = newStack("paused");
			const policy = "{ update_config: { monitor: 2s } }";
			await deploy(stack, longRunning("web", policy));
			await waitForStackRollout(stack);

			await deploy(stack, exiting("web", 1, policy));
			const failure = await failureOf(waitForStackRollout(stack));

			expect(failure).toContain(`${stack}_web`);
			expect(failure).toContain("paused");
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"passes a service that ends by itself, also after an update",
		async () => {
			const stack = newStack("oneshot");
			const none = "{ restart_policy: { condition: none } }";
			const onFailure = "{ restart_policy: { condition: on-failure } }";
			await deploy(stack, exiting("a", 0, none) + exiting("b", 0, onFailure));
			await expect(waitForStackRollout(stack, null, FAST_LIMITS)).resolves.toBe(
				2,
			);

			await deploy(stack, exiting("a", 0, none) + exiting("b", 0, onFailure));
			await expect(waitForStackRollout(stack, null, FAST_LIMITS)).resolves.toBe(
				2,
			);

			const changed = `  a:\n    image: ${IMAGE}\n    command: ["sh", "-c", "sleep 1; exit 0"]\n    deploy: ${none}\n`;
			await deploy(stack, changed + exiting("b", 0, onFailure));
			await expect(waitForStackRollout(stack, null, FAST_LIMITS)).resolves.toBe(
				2,
			);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"does not pass a short task that failed, or a rollback of a short task",
		async () => {
			const stack = newStack("oneshotupdate");
			const none = "restart_policy: { condition: none }";
			await deploy(stack, exiting("paused", 0, `{ ${none} }`));
			await waitForStackRollout(stack, null, FAST_LIMITS);

			await deploy(stack, exiting("paused", 4, `{ ${none} }`));
			expect(
				await failureOf(waitForStackRollout(stack, null, FAST_LIMITS)),
			).toContain("non-zero exit (4)");

			const rollingBack = newStack("oneshotrollback");
			const policy = `{ ${none}, update_config: { failure_action: rollback } }`;
			await deploy(rollingBack, exiting("short", 0, policy));
			await waitForStackRollout(rollingBack, null, FAST_LIMITS);

			const changed = `  short:\n    image: ${IMAGE}\n    command: ["sh", "-c", "sleep 1; exit 0"]\n    deploy: ${policy}\n`;
			await deploy(rollingBack, changed);
			expect(
				await failureOf(waitForStackRollout(rollingBack, null, FAST_LIMITS)),
			).toMatch(/rolling back|rolled back/);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"fails a service that ended with an error and will not run again",
		async () => {
			const stack = newStack("oneshotbad");
			const services =
				exiting("bad", 3, "{ restart_policy: { condition: none } }") +
				longRunning("web");
			await deploy(stack, services);

			const failure = await failureOf(
				waitForStackRollout(stack, null, FAST_LIMITS),
			);
			expect(failure).toContain(`${stack}_bad`);
			expect(failure).toContain("does not run it again");
			expect(failure).toContain("non-zero exit (3)");

			// Swarm does not start it again for the same spec, so the next deploy says the same.
			await deploy(stack, services);
			expect(
				await failureOf(waitForStackRollout(stack, null, FAST_LIMITS)),
			).toContain("non-zero exit (3)");
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"fails a new service in a restart loop at the limit",
		async () => {
			const stack = newStack("loop");
			await deploy(stack, exiting("loop", 1) + longRunning("web"));

			const failure = await failureOf(
				waitForStackRollout(stack, null, FAST_LIMITS),
			);

			expect(failure).toContain(`${stack}_loop`);
			expect(failure).toContain("did not converge");
			expect(failure).not.toContain(`${stack}_web`);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"has nothing to wait for when the stack does not exist",
		async () => {
			await expect(
				waitForStackRollout(`real-stack-${RUN_ID}-absent`),
			).resolves.toBe(0);
		},
		REAL_TEST_TIMEOUT,
	);
});

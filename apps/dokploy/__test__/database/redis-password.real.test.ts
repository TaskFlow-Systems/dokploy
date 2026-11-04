import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { docker } from "@dokploy/server/constants";
import {
	buildRedis,
	type RedisNested,
} from "@dokploy/server/utils/databases/redis";
import { changeRedisPassword } from "@dokploy/server/utils/databases/redis-password";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const IMAGE = "redis:8";
const REAL_TEST_TIMEOUT = 180_000;
const WAIT_TIMEOUT_MS = 90_000;

// Same id as application.real.test.ts: the PR workflow removes services named
// real-<kind>-<id>* after a cancelled run, and Docker is shared by CI runners.
const CHECKOUT_ID = createHash("sha256")
	.update(process.cwd())
	.digest("hex")
	.slice(0, 8);
const RUN_ID = `${CHECKOUT_ID}-${Date.now()}`;
const NETWORK = `real-redis-net-${RUN_ID}`;
const CLIENT = `real-redis-client-${RUN_ID}`;
const SPECIAL_PASSWORD = "p@ss:w?rd#1%41&^*()_+-=[]{}|,.<>~";

// With a wrong password redis-cli prints WRONGPASS to stderr and goes on to send
// the command, which gets NOAUTH on stdout.
const REFUSED = /NOAUTH|WRONGPASS/;

const appNames: string[] = [];

// Asynchronous with a timeout: a blocking call that hangs also stops the event
// loop, so the test's own timeout never fires and the run hangs with no result.
const dockerCli = async (...args: string[]) => {
	const { stdout } = await execFileAsync("docker", args, {
		timeout: 60_000,
		maxBuffer: 16 * 1024 * 1024,
	});
	return stdout.trim();
};

const fixture = (
	kind: string,
	databasePassword: string,
	overrides: Partial<RedisNested> = {},
) => {
	const appName = `real-redis-${RUN_ID}-${kind}`;
	appNames.push(appName);
	return {
		redisId: `redis-${kind}`,
		name: appName,
		appName,
		dockerImage: IMAGE,
		databasePassword,
		serverId: null,
		env: null,
		command: null,
		args: null,
		externalPort: null,
		memoryLimit: null,
		memoryReservation: null,
		cpuLimit: null,
		cpuReservation: null,
		networkSwarm: [{ Target: NETWORK }],
		mounts: [
			{
				type: "volume",
				volumeName: `${appName}-data`,
				mountPath: "/data",
			},
		],
		environmentId: "env",
		environment: {
			environmentId: "env",
			projectId: "project",
			name: "production",
			env: "",
			project: {
				projectId: "project",
				organizationId: "org",
				name: "project",
				env: "",
			},
		},
		...overrides,
	} as unknown as RedisNested;
};

const internalUrl = (redis: RedisNested) =>
	`redis://default:${encodeURIComponent(redis.databasePassword)}@${redis.appName}:6379`;

// redis-cli exits with an error on some refusals and not on others, so only the
// reply text tells them apart.
const redisCli = async (...args: string[]) => {
	try {
		return await dockerCli(
			"exec",
			CLIENT,
			"redis-cli",
			"--no-auth-warning",
			...args,
		);
	} catch (error) {
		const { stdout, stderr } = error as { stdout: string; stderr: string };
		return `${stdout}${stderr}`.trim();
	}
};

const waitUntil = async (
	what: string,
	check: () => Promise<boolean>,
	explain?: () => Promise<string>,
) => {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	let lastError = "the condition never held";
	while (Date.now() < deadline) {
		try {
			if (await check()) return;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	const details = explain ? `\n${await explain()}` : "";
	throw new Error(
		`Timed out waiting for ${what}. Last error: ${lastError}${details}`,
	);
};

const containerIds = async (appName: string, ...flags: string[]) =>
	(
		await dockerCli(
			"ps",
			...flags,
			"-q",
			"--filter",
			`label=com.docker.swarm.service.name=${appName}`,
		)
	)
		.split("\n")
		.filter(Boolean);

const runningContainerId = async (appName: string) =>
	(await containerIds(appName))[0] ?? "";

// `docker service logs` does not return on every daemon; the tasks' own logs do.
const serviceLogs = async (appName: string) => {
	const logs: string[] = [];
	for (const id of await containerIds(appName, "-a")) {
		const { stdout, stderr } = await execFileAsync("docker", ["logs", id], {
			timeout: 60_000,
			maxBuffer: 16 * 1024 * 1024,
		});
		logs.push(stdout, stderr);
	}
	return logs.join("\n");
};

const waitForPassword = (url: string, appName: string) =>
	waitUntil(
		`${appName} to accept its password`,
		async () => (await redisCli("-u", url, "PING")) === "PONG",
		async () =>
			`logs: ${(await serviceLogs(appName).catch((error: Error) => error.message)).slice(-2000)}`,
	);

const expectOnlyPasswordAccepted = async (redis: RedisNested) => {
	expect(await redisCli("-u", internalUrl(redis), "PING")).toBe("PONG");
	expect(await redisCli("-h", redis.appName, "PING")).toMatch(REFUSED);
	expect(
		await redisCli(
			"-u",
			`redis://default:not-the-password@${redis.appName}:6379`,
			"PING",
		),
	).toMatch(REFUSED);
};

// Swarm bumps Version.Index while a service converges, and an update against an
// older index fails. buildRedis then falls through to createService and hits the
// name conflict, so a redeploy has to wait until the index stays put.
const waitForSettledService = (appName: string) => {
	let lastIndex = -1;
	return waitUntil(`${appName} to settle`, async () => {
		const index = (await docker.getService(appName).inspect()).Version.Index;
		const settled = index === lastIndex;
		lastIndex = index;
		return settled;
	});
};

const redeploy = async (redis: RedisNested) => {
	const before = await runningContainerId(redis.appName);
	await waitForSettledService(redis.appName);
	await buildRedis(redis);
	await waitUntil("the redeployed task", async () => {
		const current = await runningContainerId(redis.appName);
		return current !== "" && current !== before;
	});
	await waitForPassword(internalUrl(redis), redis.appName);
	return before;
};

const changePassword = async (redis: RedisNested, password: string) => {
	await changeRedisPassword(redis, password);
	const changed = { ...redis, databasePassword: password };
	await waitForPassword(internalUrl(changed), redis.appName);
	return changed;
};

const expectOnlyNewPassword = async (
	changed: RedisNested,
	before: RedisNested,
) => {
	await expectOnlyPasswordAccepted(changed);
	expect(await redisCli("-u", internalUrl(before), "PING")).toMatch(REFUSED);
};

const killTask = async (redis: RedisNested) => {
	const killed = await runningContainerId(redis.appName);
	await dockerCli("kill", killed);
	await waitUntil("Swarm to restart the task", async () => {
		const current = await runningContainerId(redis.appName);
		return current !== "" && current !== killed;
	});
	await waitForPassword(internalUrl(redis), redis.appName);
};

const createOldCommandService = (redis: RedisNested, password: string) =>
	docker.createService({
		Name: redis.appName,
		TaskTemplate: {
			ContainerSpec: {
				Image: IMAGE,
				Env: [`REDIS_PASSWORD=${password}`],
				Command: ["/bin/sh"],
				Args: ["-c", `redis-server --requirepass ${password}`],
				Mounts: [
					{
						Type: "volume",
						Source: `${redis.appName}-data`,
						Target: "/data",
					},
				],
			},
			Networks: [{ Target: NETWORK }],
		},
		EndpointSpec: { Mode: "dnsrr" },
	});

const freePort = () =>
	new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});

describe("redis start command", () => {
	beforeAll(async () => {
		await dockerCli("image", "inspect", IMAGE).catch(() =>
			execFileAsync("docker", ["pull", "--quiet", IMAGE], {
				timeout: 290_000,
			}),
		);
		await dockerCli(
			"network",
			"create",
			"--driver",
			"overlay",
			"--attachable",
			NETWORK,
		);
		await dockerCli(
			"run",
			"-d",
			"--name",
			CLIENT,
			"--network",
			NETWORK,
			"--add-host",
			"host.docker.internal:host-gateway",
			"--entrypoint",
			"sleep",
			IMAGE,
			"3600",
		);
	}, 300_000);

	afterAll(async () => {
		const ignoreErrors = (args: string[]) =>
			dockerCli(...args).catch(() => undefined);

		await ignoreErrors(["rm", "-f", "-v", CLIENT]);
		for (const appName of appNames) {
			await ignoreErrors(["service", "rm", appName]);
		}
		for (const appName of appNames) {
			await waitUntil(
				`${appName} to stop`,
				async () => (await runningContainerId(appName)) === "",
			).catch(() => undefined);
			for (const id of await containerIds(appName, "-a")) {
				await ignoreErrors(["rm", "-f", "-v", id]);
			}
			await ignoreErrors(["volume", "rm", `${appName}-data`]);
		}
		await ignoreErrors(["network", "rm", NETWORK]);
	}, 180_000);

	it.each([
		["every-special-character", SPECIAL_PASSWORD],
		["leading-hash", "#starts-with-hash"],
		// As the last argument a lone dash makes redis-server read its config from stdin.
		["lone-dash", "-"],
		["option-name", "--port"],
		["shell-glob", "*"],
	])(
		"starts and signs in with the password %s",
		async (kind, password) => {
			const redis = fixture(kind, password);
			await buildRedis(redis);
			await waitForPassword(internalUrl(redis), redis.appName);

			await expectOnlyPasswordAccepted(redis);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"signs in through the published port",
		async () => {
			const port = await freePort();
			const redis = fixture("published", SPECIAL_PASSWORD, {
				externalPort: port,
			});
			await buildRedis(redis);

			await waitForPassword(
				`redis://default:${encodeURIComponent(SPECIAL_PASSWORD)}@host.docker.internal:${port}`,
				redis.appName,
			);
			expect(
				await redisCli("-h", "host.docker.internal", "-p", `${port}`, "PING"),
			).toMatch(REFUSED);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"takes a password the validator rejects today, as an old row can hold",
		async () => {
			const redis = fixture("old-row", `we'ird"pass\\word $HOME \`x\` ;!`);
			await buildRedis(redis);
			await waitForPassword(internalUrl(redis), redis.appName);

			await expectOnlyPasswordAccepted(redis);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"keeps the stored password when the service env sets the same names",
		async () => {
			const redis = fixture("env-names", "stored-Passw0rd", {
				env: "REDIS_PASSWORD=from-env\nDOKPLOY_DB_PASSWORD=from-env",
			});
			await buildRedis(redis);
			await waitForPassword(internalUrl(redis), redis.appName);

			await expectOnlyPasswordAccepted(redis);
			expect(
				await redisCli(
					"-u",
					`redis://default:from-env@${redis.appName}:6379`,
					"PING",
				),
			).toMatch(REFUSED);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"uses the default start after the custom command form was saved empty",
		async () => {
			const redis = fixture("empty-override", "stored-Passw0rd", {
				command: "",
				args: [],
			});
			await buildRedis(redis);
			await waitForPassword(internalUrl(redis), redis.appName);

			await expectOnlyPasswordAccepted(redis);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"refuses to start with an empty password",
		async () => {
			const redis = fixture("empty-password", "");
			await buildRedis(redis);

			await waitUntil("the refusal in the task's log", async () =>
				(await serviceLogs(redis.appName)).includes("no password"),
			);
			const [task] = await containerIds(redis.appName, "-a");
			await waitUntil(
				"the refused task to exit",
				async () =>
					(await dockerCli("inspect", "-f", "{{.State.Status}}", `${task}`)) ===
					"exited",
			);
			expect(
				await dockerCli("inspect", "-f", "{{.State.ExitCode}}", `${task}`),
			).not.toBe("0");
			expect(await serviceLogs(redis.appName)).not.toContain(
				"Ready to accept connections",
			);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"keeps the password and the last snapshot of a database on the old command over its next deploy",
		async () => {
			const redis = fixture("old-command", "stored-Passw0rd");
			await createOldCommandService(redis, redis.databasePassword);
			await waitForPassword(internalUrl(redis), redis.appName);
			await redisCli("-u", internalUrl(redis), "SET", "snapshot", "kept");
			// The old shell stays PID 1 and keeps SIGTERM from Redis, so this one stop
			// ends in SIGKILL with no final save.
			expect(await redisCli("-u", internalUrl(redis), "SAVE")).toBe("OK");

			await redeploy(redis);

			await expectOnlyPasswordAccepted(redis);
			expect(await redisCli("-u", internalUrl(redis), "GET", "snapshot")).toBe(
				"kept",
			);

			await redisCli("-u", internalUrl(redis), "SET", "unsaved", "kept");
			const stopped = await redeploy(redis);

			expect(
				await dockerCli("inspect", "-f", "{{.State.ExitCode}}", stopped),
			).toBe("0");
			expect(await redisCli("-u", internalUrl(redis), "GET", "unsaved")).toBe(
				"kept",
			);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"keeps a password changed in the panel and the data over a task restart without a deploy",
		async () => {
			const redis = fixture("change-restart", SPECIAL_PASSWORD);
			await buildRedis(redis);
			await waitForPassword(internalUrl(redis), redis.appName);
			await redisCli("-u", internalUrl(redis), "SET", "marker", "kept");
			const stopped = await runningContainerId(redis.appName);

			const changed = await changePassword(redis, "#changed&(in)|<panel>");

			expect(
				await dockerCli("inspect", "-f", "{{.State.ExitCode}}", stopped),
			).toBe("0");
			await expectOnlyNewPassword(changed, redis);
			expect(await redisCli("-u", internalUrl(changed), "GET", "marker")).toBe(
				"kept",
			);

			await killTask(changed);

			await expectOnlyNewPassword(changed, redis);
			expect(await redisCli("-u", internalUrl(changed), "GET", "marker")).toBe(
				"kept",
			);
			const { Spec } = await docker.getService(redis.appName).inspect();
			expect(JSON.stringify(Spec)).not.toContain(
				JSON.stringify(SPECIAL_PASSWORD).slice(1, -1),
			);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"keeps the changed password over the next deploy",
		async () => {
			const redis = fixture("change-deploy", SPECIAL_PASSWORD);
			await buildRedis(redis);
			await waitForPassword(internalUrl(redis), redis.appName);
			await redisCli("-u", internalUrl(redis), "SET", "marker", "kept");

			const changed = await changePassword(redis, "#changed&(in)|<panel>");
			const stopped = await redeploy(changed);

			expect(
				await dockerCli("inspect", "-f", "{{.State.ExitCode}}", stopped),
			).toBe("0");
			await expectOnlyNewPassword(changed, redis);
			expect(await redisCli("-u", internalUrl(changed), "GET", "marker")).toBe(
				"kept",
			);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"moves a database off the old command when its password changes, and saves first",
		async () => {
			const redis = fixture("change-old-command", "stored-Passw0rd");
			await createOldCommandService(redis, redis.databasePassword);
			await waitForPassword(internalUrl(redis), redis.appName);
			await redisCli("-u", internalUrl(redis), "SET", "unsaved", "kept");

			const changed = await changePassword(redis, "new-Passw0rd");

			await expectOnlyNewPassword(changed, redis);
			expect(await redisCli("-u", internalUrl(changed), "GET", "unsaved")).toBe(
				"kept",
			);
			await killTask(changed);
			await expectOnlyNewPassword(changed, redis);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"repairs a database whose restart undid an earlier change",
		async () => {
			const running = fixture("change-undone", "running-Passw0rd");
			await createOldCommandService(running, running.databasePassword);
			await waitForPassword(internalUrl(running), running.appName);
			await redisCli("-u", internalUrl(running), "SET", "unsaved", "kept");

			const panelShows = { ...running, databasePassword: "panel-Passw0rd" };
			expect(await redisCli("-u", internalUrl(panelShows), "PING")).toMatch(
				REFUSED,
			);

			const changed = await changePassword(panelShows, "new-Passw0rd");

			await expectOnlyNewPassword(changed, running);
			expect(await redisCli("-u", internalUrl(changed), "GET", "unsaved")).toBe(
				"kept",
			);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"stores the password of a stopped database for its next start",
		async () => {
			const redis = fixture("change-stopped", "stored-Passw0rd");
			await buildRedis(redis);
			await waitForPassword(internalUrl(redis), redis.appName);
			await dockerCli("service", "scale", "-d", `${redis.appName}=0`);
			await waitUntil(
				"the task to stop",
				async () => (await runningContainerId(redis.appName)) === "",
			);

			await changeRedisPassword(redis, "new-Passw0rd");
			const changed = { ...redis, databasePassword: "new-Passw0rd" };

			expect(await runningContainerId(redis.appName)).toBe("");
			await waitForSettledService(redis.appName);
			await dockerCli("service", "scale", "-d", `${redis.appName}=1`);
			await waitForPassword(internalUrl(changed), redis.appName);
			await expectOnlyNewPassword(changed, redis);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"fails the change and keeps the old password when Swarm goes back to the old spec",
		async () => {
			const redis = fixture("change-rollback", "stored-Passw0rd");
			await buildRedis(redis);
			await waitForPassword(internalUrl(redis), redis.appName);
			await redisCli("-u", internalUrl(redis), "SET", "marker", "kept");
			await waitForSettledService(redis.appName);

			// The start refuses an empty password, as Redis 6 does a password that
			// starts with --, so the new task exits and Swarm rolls the update back.
			await expect(changeRedisPassword(redis, "")).rejects.toThrow(
				/went back to the old one/,
			);

			await waitForPassword(internalUrl(redis), redis.appName);
			await expectOnlyPasswordAccepted(redis);
			expect(await redisCli("-u", internalUrl(redis), "GET", "marker")).toBe(
				"kept",
			);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"changes only the running Redis under a custom command, and fails when Redis refuses",
		async () => {
			const redis = fixture("change-custom", "stored-Passw0rd", {
				command: "/bin/sh",
				args: ["-c", 'exec redis-server --requirepass "$REDIS_PASSWORD"'],
			});
			await buildRedis(redis);
			await waitForPassword(internalUrl(redis), redis.appName);
			const running = await runningContainerId(redis.appName);

			await expect(
				changeRedisPassword(
					{ ...redis, databasePassword: "not-the-password" },
					"other-Passw0rd",
				),
			).rejects.toThrow(/refused/);
			await expectOnlyPasswordAccepted(redis);

			const changed = await changePassword(redis, "new-Passw0rd");

			expect(await runningContainerId(redis.appName)).toBe(running);
			await expectOnlyNewPassword(changed, redis);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"reports a database that was never deployed as not running",
		async () => {
			const redis = fixture("change-missing", "stored-Passw0rd");

			await expect(changeRedisPassword(redis, "new-Passw0rd")).rejects.toThrow(
				/No running container found/,
			);
		},
		REAL_TEST_TIMEOUT,
	);
});

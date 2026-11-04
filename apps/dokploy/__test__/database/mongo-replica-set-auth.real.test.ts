import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { docker } from "@dokploy/server/constants";
import { getMongoBackupCommand } from "@dokploy/server/utils/backups/utils";
import {
	buildMongo,
	type MongoNested,
} from "@dokploy/server/utils/databases/mongo";
import { getMongoRestoreCommand } from "@dokploy/server/utils/restore/utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildExternalMongoUrl,
	buildInternalMongoUrl,
} from "@/lib/mongo-connection-url";
import { buildMongoPasswordChangeCommand } from "@/server/api/utils/database-password";

const execFileAsync = promisify(execFile);

// mongod 8 refuses to start on kernels from 6.19 up to 7.0.13 (SERVER-121912),
// and GitHub-hosted runners have 7.0.0.
const IMAGE = "mongo:7";
const REAL_TEST_TIMEOUT = 240_000;
const WAIT_TIMEOUT_MS = 120_000;

// Same id as application.real.test.ts: the PR workflow removes services named
// real-<kind>-<id>* after a cancelled run, and Docker is shared by CI runners.
const CHECKOUT_ID = createHash("sha256")
	.update(process.cwd())
	.digest("hex")
	.slice(0, 8);
const RUN_ID = `${CHECKOUT_ID}-${Date.now()}`;
const NETWORK = `real-mongo-net-${RUN_ID}`;
const CLIENT = `real-mongo-client-${RUN_ID}`;
const OUTSIDE_CLIENT = `real-mongo-outside-${RUN_ID}`;
const SPECIAL_PASSWORD = "p@ss:w?rd#1%41&^*()_+-=[]{}|,.<>~";

const appNames: string[] = [];

// Asynchronous with a timeout: a blocking call that hangs also stops the event
// loop, so the test's own timeout never fires and the run hangs with no result.
const dockerCli = async (...args: string[]) => {
	const { stdout } = await execFileAsync("docker", args, {
		timeout: 60_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout.trim();
};

const fixture = (
	kind: string,
	databasePassword = "stored-Passw0rd",
	overrides: Partial<MongoNested> = {},
) => {
	const appName = `real-mongo-${RUN_ID}-${kind}`;
	appNames.push(appName);
	return {
		mongoId: `mongo-${kind}`,
		name: appName,
		appName,
		dockerImage: IMAGE,
		databaseUser: "panel_user",
		databasePassword,
		replicaSets: true,
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
				mountPath: "/data/db",
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
	} as unknown as MongoNested;
};

// The script replica sets ran before access control: the starting point of a move.
const legacyScript = (mongo: MongoNested) => `
#!/bin/bash
mongod --port 27017 --replSet rs0 --bind_ip_all &
MONGOD_PID=$!
while ! mongosh --eval "db.adminCommand('ping')" > /dev/null 2>&1; do
	sleep 2
done
REPLICA_STATUS=$(mongosh --quiet --eval "rs.status().ok || 0")
if [ "$REPLICA_STATUS" != "1" ]; then
	mongosh --eval '
	rs.initiate({
		_id: "rs0",
		members: [{ _id: 0, host: "${mongo.appName}:27017", priority: 1 }]
	});
	while (!rs.isMaster().ismaster) {
		sleep(1000);
	}
	db.getSiblingDB("admin").createUser({
		user: "${mongo.databaseUser}",
		pwd: "${mongo.databasePassword}",
		roles: ["root"]
	});
	'
fi
wait $MONGOD_PID`;

const deployLegacy = (mongo: MongoNested) =>
	docker.createService({
		Name: mongo.appName,
		TaskTemplate: {
			ContainerSpec: {
				Image: IMAGE,
				Command: ["/bin/bash"],
				Args: ["-c", legacyScript(mongo)],
				Mounts: [
					{
						Type: "volume",
						Source: `${mongo.appName}-data`,
						Target: "/data/db",
					},
				],
			},
			Networks: [{ Target: NETWORK }],
		},
		EndpointSpec: { Mode: "dnsrr" },
	});

const anonymousUrl = (mongo: MongoNested) =>
	`mongodb://${mongo.appName}:27017/?directConnection=true`;

const storedUrl = (mongo: MongoNested) => buildInternalMongoUrl(mongo);

const mongosh = (url: string, js: string, client = CLIENT) =>
	dockerCli("exec", client, "mongosh", url, "--quiet", "--eval", js);

const mongoshError = async (url: string, js: string, client = CLIENT) => {
	try {
		return { refused: false, output: await mongosh(url, js, client) };
	} catch (error) {
		const { stdout, stderr } = error as { stdout: string; stderr: string };
		return { refused: true, output: `${stdout}${stderr}` };
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
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	const details = explain ? `\n${await explain()}` : "";
	throw new Error(
		`Timed out waiting for ${what}. Last error: ${lastError}${details}`,
	);
};

// The stored password already works during the one open start of a move, so a
// successful sign-in alone does not mean the move has finished.
const waitForAccessControl = (mongo: MongoNested) =>
	waitUntil(
		"access control and the stored connection string",
		async () => {
			const anonymous = await mongoshError(
				anonymousUrl(mongo),
				"db.adminCommand({ listDatabases: 1 })",
			);
			if (!anonymous.output.includes("requires authentication")) {
				throw new Error(`Anonymous client: ${anonymous.output}`);
			}
			return (
				(await mongosh(storedUrl(mongo), "db.hello().isWritablePrimary")) ===
				"true"
			);
		},
		() => describeService(mongo.appName),
	);

const waitForAnonymousAccess = (mongo: MongoNested) =>
	waitUntil(
		"the open replica set",
		async () =>
			(await mongosh(anonymousUrl(mongo), "db.hello().isWritablePrimary")) ===
			"true",
		() => describeService(mongo.appName),
	);

const expectAnonymousRefused = async (mongo: MongoNested) => {
	const insert = await mongoshError(
		anonymousUrl(mongo),
		'db.getSiblingDB("app").docs.insertOne({ from: "anonymous" })',
	);
	expect(insert.refused).toBe(true);
	expect(insert.output).toMatch(/requires authentication/);

	const list = await mongoshError(
		anonymousUrl(mongo),
		"db.adminCommand({ listDatabases: 1 })",
	);
	expect(list.refused).toBe(true);
	expect(list.output).toMatch(/requires authentication/);
};

const insertDoc = (url: string, marker: string) =>
	mongosh(
		url,
		`db.getSiblingDB("app").docs.insertOne({ marker: "${marker}" }, { writeConcern: { w: "majority", j: true } }); print("ok")`,
	);

const countDocs = async (url: string, marker: string) =>
	Number(
		await mongosh(
			url,
			`print(db.getSiblingDB("app").docs.countDocuments({ marker: "${marker}" }))`,
		),
	);

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

const execInTask = async (appName: string, ...command: string[]) =>
	dockerCli("exec", await runningContainerId(appName), ...command);

// `docker service logs` does not return on every daemon; the tasks' own logs do.
const serviceLogs = async (appName: string) => {
	const logs: string[] = [];
	for (const id of await containerIds(appName, "-a")) {
		const { stdout, stderr } = await execFileAsync("docker", ["logs", id], {
			timeout: 60_000,
			maxBuffer: 64 * 1024 * 1024,
		});
		logs.push(stdout, stderr);
	}
	return logs.join("\n");
};

// A timeout on a CI runner leaves nothing else to look at once the run is over.
const describeService = async (appName: string) => {
	const run = (...args: string[]) =>
		dockerCli(...args).catch((error: Error) => `failed: ${error.message}`);
	const task = await runningContainerId(appName).catch(() => "");
	const lines = [
		`engine: ${await run("info", "--format", "{{.ServerVersion}} {{.KernelVersion}}")}`,
		`tasks: ${await run("service", "ps", "--no-trunc", "--format", "{{.Name}} {{.CurrentState}} {{.Error}}", appName)}`,
		`network: ${await run("network", "inspect", "--format", "{{json .IPAM.Config}}", NETWORK)}`,
		`client resolves: ${await run("exec", CLIENT, "getent", "hosts", appName)}`,
		`task resolves: ${task ? await run("exec", task, "getent", "hosts", appName) : "no running task"}`,
		`task address: ${task ? await run("exec", task, "hostname", "-i") : "no running task"}`,
		`logs: ${(await serviceLogs(appName).catch((error: Error) => error.message)).slice(-3000)}`,
	];
	return lines.join("\n");
};

// Swarm bumps Version.Index while a service converges, and an update against an
// older index fails. buildMongo then falls through to createService and hits the
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

// Runs a command the panel builds the way the panel does, on the host with
// $CONTAINER_ID set.
const runPanelCommand = async (appName: string, command: string) => {
	const containerId = await runningContainerId(appName);
	await execFileAsync(
		"bash",
		["-c", `CONTAINER_ID=${containerId}\n${command}`],
		{
			timeout: 60_000,
		},
	);
};

const freePort = () =>
	new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});

const redeploy = async (mongo: MongoNested) => {
	const before = await runningContainerId(mongo.appName);
	await waitForSettledService(mongo.appName);
	await buildMongo(mongo);
	await waitUntil("the redeployed task", async () => {
		const current = await runningContainerId(mongo.appName);
		return current !== "" && current !== before;
	});
	await waitForAccessControl(mongo);
	return before;
};

describe("mongo replica set access control", () => {
	beforeAll(async () => {
		await dockerCli("image", "inspect", IMAGE).catch(() =>
			execFileAsync("docker", ["pull", "--quiet", IMAGE], {
				timeout: 590_000,
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
		// A client in its own container: inside the database's container the
		// localhost exception would hide a missing check.
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
		// On no overlay network, so a service's name does not resolve here, as on
		// a client machine.
		await dockerCli(
			"run",
			"-d",
			"--name",
			OUTSIDE_CLIENT,
			"--add-host",
			"host.docker.internal:host-gateway",
			"--entrypoint",
			"sleep",
			IMAGE,
			"3600",
		);
	}, 600_000);

	afterAll(async () => {
		const ignoreErrors = (args: string[]) =>
			dockerCli(...args).catch(() => undefined);

		await ignoreErrors(["rm", "-f", "-v", CLIENT]);
		await ignoreErrors(["rm", "-f", "-v", OUTSIDE_CLIENT]);
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

	it(
		"refuses anonymous clients, accepts the stored credentials and keeps data over a redeploy",
		async () => {
			const mongo = fixture("new");
			await buildMongo(mongo);
			await waitForAccessControl(mongo);

			await expectAnonymousRefused(mongo);
			expect(await insertDoc(storedUrl(mongo), "before-redeploy")).toBe("ok");

			const wrongPassword = await mongoshError(
				storedUrl({ ...mongo, databasePassword: "not-the-password" }),
				"db.adminCommand({ listDatabases: 1 })",
			);
			expect(wrongPassword.refused).toBe(true);
			expect(wrongPassword.output).toMatch(/Authentication failed/);

			expect(
				await execInTask(
					mongo.appName,
					"stat",
					"-c",
					"%a",
					"/data/db/.dokploy-keyfile",
				),
			).toBe("400");
			const key = await execInTask(
				mongo.appName,
				"cat",
				"/data/db/.dokploy-keyfile",
			);

			const stopped = await redeploy(mongo);

			expect(await countDocs(storedUrl(mongo), "before-redeploy")).toBe(1);
			await expectAnonymousRefused(mongo);
			expect(
				await execInTask(mongo.appName, "cat", "/data/db/.dokploy-keyfile"),
			).toBe(key);
			// 137 would mean SIGKILL after the grace period instead of a clean shutdown.
			expect(
				await dockerCli("inspect", "-f", "{{.State.ExitCode}}", stopped),
			).toBe("0");
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"refuses anonymous clients on the published port",
		async () => {
			const port = await freePort();
			const mongo = fixture("published", undefined, { externalPort: port });
			await buildMongo(mongo);
			await waitForAccessControl(mongo);

			const outside = `mongodb://host.docker.internal:${port}/?directConnection=true`;
			await waitUntil(
				"the published port",
				async () => (await mongosh(outside, "db.hello().ok")) === "1",
			);
			const anonymous = await mongoshError(
				outside,
				"db.adminCommand({ listDatabases: 1 })",
			);
			expect(anonymous.refused).toBe(true);
			expect(anonymous.output).toMatch(/requires authentication/);
			expect(
				await mongosh(
					buildExternalMongoUrl({
						...mongo,
						host: "host.docker.internal",
						port,
					}),
					"db.adminCommand({ listDatabases: 1 }).ok",
				),
			).toBe("1");
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"connects with the panel's strings, from outside the Docker network and from inside it",
		async () => {
			const port = await freePort();
			const mongo = fixture("strings", SPECIAL_PASSWORD, {
				externalPort: port,
			});
			await buildMongo(mongo);
			await waitForAccessControl(mongo);

			const external = buildExternalMongoUrl({
				...mongo,
				host: "host.docker.internal",
				port,
			});
			await waitUntil(
				"the published port",
				async () =>
					(await mongosh(
						external,
						"db.adminCommand({ listDatabases: 1 }).ok",
						OUTSIDE_CLIENT,
					)) === "1",
			);

			// Transactions are what a replica set is usually picked for, and a direct
			// connection must not lose them.
			expect(
				await mongosh(
					external,
					`const session = db.getMongo().startSession();
					session.startTransaction();
					session.getDatabase("app").docs.insertOne({ marker: "outside" });
					session.commitTransaction();
					print(db.getSiblingDB("app").docs.countDocuments({ marker: "outside" }))`,
					OUTSIDE_CLIENT,
				),
			).toBe("1");

			expect(await mongosh(external, "db.hello().me", OUTSIDE_CLIENT)).toBe(
				`${mongo.appName}:27017`,
			);

			// mongosh adds directConnection=true to a one-host URL that does not set it,
			// so only an explicit false behaves as a driver does by default.
			const discovering = external.replace(
				"directConnection=true",
				"directConnection=false",
			);
			const discovered = await mongoshError(
				discovering,
				"db.hello().ok",
				OUTSIDE_CLIENT,
			);
			expect(discovered.refused).toBe(true);
			expect(discovered.output).toContain(mongo.appName);

			expect(
				await mongosh(
					`${buildInternalMongoUrl(mongo)}&directConnection=false`,
					`print(db.getSiblingDB("app").docs.countDocuments({ marker: "outside" }))`,
				),
			).toBe("1");
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"runs the panel's backup and restore commands with the stored credentials",
		async () => {
			const mongo = fixture("backup");
			await buildMongo(mongo);
			await waitForAccessControl(mongo);
			await insertDoc(storedUrl(mongo), "backed-up");

			const dir = await mkdtemp(join(tmpdir(), "mongo-replica-set-auth-"));
			const archive = join(dir, "app.archive.gz");
			try {
				await runPanelCommand(
					mongo.appName,
					`${getMongoBackupCommand("app", mongo.databaseUser, mongo.databasePassword)} > ${archive}`,
				);
				await mongosh(
					storedUrl(mongo),
					'db.getSiblingDB("app").docs.deleteMany({}); print("ok")',
				);
				expect(await countDocs(storedUrl(mongo), "backed-up")).toBe(0);

				await runPanelCommand(
					mongo.appName,
					`gunzip -c ${archive} | ${getMongoRestoreCommand("app", mongo.databaseUser, mongo.databasePassword)}`,
				);
				expect(await countDocs(storedUrl(mongo), "backed-up")).toBe(1);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"moves an open replica set to auth on its next deploy without losing data or access",
		async () => {
			const mongo = fixture("legacy");
			await deployLegacy(mongo);
			await waitForAnonymousAccess(mongo);
			await waitUntil(
				"the user the old script creates",
				async () =>
					(await mongosh(
						anonymousUrl(mongo),
						`print(db.getSiblingDB("admin").getUser("${mongo.databaseUser}") !== null)`,
					)) === "true",
			);

			expect(await insertDoc(anonymousUrl(mongo), "open-era")).toBe("ok");
			await mongosh(
				anonymousUrl(mongo),
				'db.getSiblingDB("admin").createUser({ user: "unknown_user", pwd: "x", roles: ["root"] }); print("ok")',
			);
			// A password changed behind the panel's back: never enforced, so never noticed.
			await mongosh(
				anonymousUrl(mongo),
				`db.getSiblingDB("admin").changeUserPassword("${mongo.databaseUser}", "drifted"); print("ok")`,
			);

			await buildMongo(mongo);
			await waitForAccessControl(mongo);

			await expectAnonymousRefused(mongo);
			expect(await countDocs(storedUrl(mongo), "open-era")).toBe(1);
			expect(await insertDoc(storedUrl(mongo), "after-move")).toBe("ok");

			const logs = await serviceLogs(mongo.appName);
			expect(logs).toContain("Turning on access control");
			expect(logs).toMatch(/keep access.*admin\.unknown_user/);

			await redeploy(mongo);
			expect(await countDocs(storedUrl(mongo), "after-move")).toBe(1);
			await expectAnonymousRefused(mongo);
			expect(await serviceLogs(mongo.appName)).not.toContain(
				"Setup did not finish",
			);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"creates the stored user when an open replica set has none",
		async () => {
			const mongo = fixture("no-user");
			await deployLegacy(mongo);
			await waitUntil(
				"the user the old script creates",
				async () =>
					(await mongosh(
						anonymousUrl(mongo),
						`print(db.getSiblingDB("admin").getUser("${mongo.databaseUser}") !== null)`,
					)) === "true",
			);
			await insertDoc(anonymousUrl(mongo), "open-era");
			await mongosh(
				anonymousUrl(mongo),
				`db.getSiblingDB("admin").dropUser("${mongo.databaseUser}"); print("ok")`,
			);

			await buildMongo(mongo);
			await waitForAccessControl(mongo);

			await expectAnonymousRefused(mongo);
			expect(await countDocs(storedUrl(mongo), "open-era")).toBe(1);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"turns a standalone database into a replica set with auth",
		async () => {
			const standalone = fixture("standalone", SPECIAL_PASSWORD, {
				replicaSets: false,
			});
			await buildMongo(standalone);
			await waitForAccessControl(standalone);
			await insertDoc(storedUrl(standalone), "standalone-era");

			const mongo = { ...standalone, replicaSets: true } as MongoNested;
			await redeploy(mongo);

			await expectAnonymousRefused(mongo);
			expect(await countDocs(storedUrl(mongo), "standalone-era")).toBe(1);
			expect(await mongosh(storedUrl(mongo), "db.hello().setName")).toBe("rs0");
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"takes a password the validator rejects today, as an old row can hold",
		async () => {
			const mongo = fixture("quoting", `we'ird"pass\\word $HOME \`x\` ;!`);
			await buildMongo(mongo);
			await waitForAccessControl(mongo);

			await expectAnonymousRefused(mongo);
			expect(await insertDoc(storedUrl(mongo), "quoted")).toBe("ok");

			const service = await docker.getService(mongo.appName).inspect();
			expect(
				service.Spec.TaskTemplate.ContainerSpec.Args.join(" "),
			).not.toContain(mongo.databasePassword);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"keeps the database up when the stored credentials are stale after a password change",
		async () => {
			const mongo = fixture("stale");
			await buildMongo(mongo);
			await waitForAccessControl(mongo);
			await insertDoc(storedUrl(mongo), "before-change");

			await runPanelCommand(
				mongo.appName,
				buildMongoPasswordChangeCommand({
					databaseUser: mongo.databaseUser,
					databasePassword: mongo.databasePassword,
					password: "changed-in-panel",
				}),
			);
			const changed = { ...mongo, databasePassword: "changed-in-panel" };

			// Swarm restarts the task with the spec it has, so Env still holds the old password.
			await dockerCli("kill", await runningContainerId(mongo.appName));
			await waitForAccessControl(changed);

			expect(await countDocs(storedUrl(changed), "before-change")).toBe(1);
			await expectAnonymousRefused(mongo);
			await waitUntil("the stale credentials message", async () =>
				(await serviceLogs(mongo.appName)).includes("Setup did not finish"),
			);
		},
		REAL_TEST_TIMEOUT,
	);
});

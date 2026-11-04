import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { docker } from "@dokploy/server/constants";
import {
	buildLibsql,
	type LibsqlNested,
} from "@dokploy/server/utils/databases/libsql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLibsqlUrl } from "@/lib/database-connection-url";

const execFileAsync = promisify(execFile);

const IMAGE = "ghcr.io/tursodatabase/libsql-server:v0.24.32";
const CLIENT_IMAGE = "curlimages/curl:8.12.1";
const REAL_TEST_TIMEOUT = 240_000;
const WAIT_TIMEOUT_MS = 90_000;

// Same id as application.real.test.ts: the PR workflow removes services named
// real-<kind>-<id>* after a cancelled run, and Docker is shared by CI runners.
const CHECKOUT_ID = createHash("sha256")
	.update(process.cwd())
	.digest("hex")
	.slice(0, 8);
const RUN_ID = `${CHECKOUT_ID}-${Date.now()}`;
const NETWORK = `real-libsql-net-${RUN_ID}`;
const CLIENT = `real-libsql-client-${RUN_ID}`;
const RECOVERY = `real-libsql-recovery-${RUN_ID}`;
const SPECIAL_PASSWORD = "p@ss:w?rd#1%41";

const appNames: string[] = [];

const dockerCli = async (...args: string[]) => {
	const { stdout } = await execFileAsync("docker", args, {
		timeout: 60_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout.trim();
};

const fixture = (
	kind: string,
	overrides: Partial<LibsqlNested> = {},
): LibsqlNested => {
	const appName = `real-libsql-${RUN_ID}-${kind}`;
	if (!appNames.includes(appName)) appNames.push(appName);
	return {
		libsqlId: `libsql-${kind}`,
		name: appName,
		appName,
		dockerImage: IMAGE,
		databaseUser: "panel",
		databasePassword: SPECIAL_PASSWORD,
		sqldNode: "primary",
		sqldPrimaryUrl: null,
		enableNamespaces: false,
		serverId: null,
		env: null,
		command: null,
		externalPort: null,
		externalGRPCPort: null,
		externalAdminPort: null,
		memoryLimit: null,
		memoryReservation: null,
		cpuLimit: null,
		cpuReservation: null,
		networkSwarm: [{ Target: NETWORK }],
		mounts: [
			{
				type: "volume",
				volumeName: `${appName}-data`,
				mountPath: "/var/lib/sqld",
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
	} as unknown as LibsqlNested;
};

// The string the panel shows as a primary's Internal Replication Connection URL.
const replicationUrl = (libsql: LibsqlNested) =>
	buildLibsqlUrl(libsql, { host: libsql.appName, port: 5001 });

const replicaOf = (
	primary: LibsqlNested,
	kind: string,
	overrides: Partial<LibsqlNested> = {},
) =>
	fixture(kind, {
		sqldNode: "replica",
		sqldPrimaryUrl: replicationUrl(primary),
		...overrides,
	});

const curl = (...args: string[]) =>
	dockerCli("exec", CLIENT, "curl", "-s", "--max-time", "20", ...args);

const namespaceHeader = (namespace?: string) =>
	namespace ? ["-H", `Host: ${namespace}.db.local`] : [];

const runSql = async (
	host: string,
	statement: string,
	options: { auth?: string; namespace?: string } = {},
) => {
	const output = await curl(
		...(options.auth ? ["-H", `Authorization: Basic ${options.auth}`] : []),
		...namespaceHeader(options.namespace),
		"-H",
		"Content-Type: application/json",
		"-d",
		JSON.stringify({ statements: [statement] }),
		`http://${host}:8080/`,
	);
	const [result] = JSON.parse(output) as [
		{ results?: { rows: unknown[][] }; error?: string },
	];
	if (result.error) throw new Error(result.error);
	return result.results?.rows.flat() ?? [];
};

const basicAuth = ({ databaseUser, databasePassword }: LibsqlNested) =>
	Buffer.from(`${databaseUser}:${databasePassword}`).toString("base64");

const sql = (libsql: LibsqlNested, statement: string, namespace?: string) =>
	runSql(libsql.appName, statement, { auth: basicAuth(libsql), namespace });

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
	return [
		`tasks: ${await run("service", "ps", "--no-trunc", "--format", "{{.Name}} {{.CurrentState}} {{.Error}}", appName)}`,
		`logs: ${(await serviceLogs(appName).catch((error: Error) => error.message)).slice(-3000)}`,
	].join("\n");
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

const waitForRows = (
	libsql: LibsqlNested,
	statement: string,
	expected: unknown[],
	namespace?: string,
) =>
	waitUntil(
		`${libsql.appName} to return ${JSON.stringify(expected)} for ${statement}`,
		async () =>
			JSON.stringify(await sql(libsql, statement, namespace)) ===
			JSON.stringify(expected),
		() => describeService(libsql.appName),
	);

const deployPrimary = async (kind: string, overrides = {}) => {
	const primary = fixture(kind, overrides);
	await buildLibsql(primary);
	await waitUntil(
		`${primary.appName} to answer`,
		async () =>
			(await curl(
				"-o",
				"/dev/null",
				"-w",
				"%{http_code}",
				`http://${primary.appName}:8080/health`,
			)) === "200",
		() => describeService(primary.appName),
	);
	return primary;
};

// Swarm bumps Version.Index while a service converges, and an update against an
// older index fails. buildLibsql then falls through to createService and hits the
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

const redeploy = async (libsql: LibsqlNested) => {
	const before = await runningContainerId(libsql.appName);
	await waitForSettledService(libsql.appName);
	await buildLibsql(libsql);
	await waitUntil(
		"the redeployed task",
		async () => {
			const current = await runningContainerId(libsql.appName);
			return current !== "" && current !== before;
		},
		() => describeService(libsql.appName),
	);
};

const listSetAside = async (libsql: LibsqlNested) => {
	const output = await dockerCli(
		"exec",
		await runningContainerId(libsql.appName),
		"sh",
		"-c",
		"ls -d iku.db.before-replica-* 2>/dev/null || true",
	);
	return output.split("\n").filter(Boolean);
};

describe("libsql replica", () => {
	beforeAll(async () => {
		for (const image of [IMAGE, CLIENT_IMAGE]) {
			await dockerCli("image", "inspect", image).catch(() =>
				execFileAsync("docker", ["pull", "--quiet", image], {
					timeout: 590_000,
				}),
			);
		}
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
			"--entrypoint",
			"sleep",
			CLIENT_IMAGE,
			"3600",
		);
	}, 600_000);

	afterAll(async () => {
		const ignoreErrors = (args: string[]) =>
			dockerCli(...args).catch(() => undefined);

		await ignoreErrors(["rm", "-f", "-v", CLIENT]);
		await ignoreErrors(["rm", "-f", "-v", RECOVERY]);
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
			// Swarm can still hold the volume for a moment after its task is gone.
			await waitUntil(`${appName}'s volume to go`, async () => {
				await dockerCli("volume", "rm", "-f", `${appName}-data`);
				return true;
			}).catch(() => undefined);
		}
		await ignoreErrors(["network", "rm", NETWORK]);
	}, 180_000);

	it(
		"receives what the primary holds and writes, and passes its own writes on",
		async () => {
			const primary = await deployPrimary("primary");
			await sql(primary, "create table t(v text)");
			await sql(primary, "insert into t values ('before-replica')");

			const replica = replicaOf(primary, "replica");
			await buildLibsql(replica);
			await waitForRows(replica, "select v from t", ["before-replica"]);

			await sql(primary, "insert into t values ('after-replica')");
			await waitForRows(replica, "select v from t", [
				"before-replica",
				"after-replica",
			]);

			await sql(replica, "insert into t values ('through-replica')");
			await waitForRows(primary, "select v from t", [
				"before-replica",
				"after-replica",
				"through-replica",
			]);

			// A restart keeps the replicated data, and nothing gets set aside.
			await redeploy({ ...replica, env: "RESTARTED=1" });
			await waitForRows(replica, "select count(*) from t", [3]);
			expect(await listSetAside(replica)).toEqual([]);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"sets aside the data of a replica that ran as its own primary, once and readable",
		async () => {
			const primary = await deployPrimary("source");
			await sql(primary, "create table shared(v text)");
			await sql(primary, "insert into shared values ('from-primary')");

			// What the previous build deployed for a replica: the primary's command,
			// so sqld never saw a primary URL and took writes of its own.
			const former = await deployPrimary("former");
			await sql(former, "create table own(v text)");
			await sql(former, "insert into own values ('own-row')");
			await sql(former, "create table shared(v text, extra int)");
			await sql(former, "insert into shared values ('own-shared-row', 1)");

			const replica = replicaOf(primary, "former");
			await redeploy(replica);

			await waitForRows(replica, "select v from shared", ["from-primary"]);
			await expect(sql(replica, "select v from own")).rejects.toThrow(
				"no such table",
			);
			await waitForRows(replica, "pragma integrity_check", ["ok"]);

			const setAside = await listSetAside(replica);
			expect(setAside).toHaveLength(1);
			expect(await serviceLogs(replica.appName)).toContain(
				`This node's own data is kept in ${setAside[0]}`,
			);

			// The second deploy finds a replica, so the first copy stays the only one.
			await redeploy({ ...replica, env: "RESTARTED=1" });
			await waitForRows(replica, "select v from shared", ["from-primary"]);
			expect(await listSetAside(replica)).toEqual(setAside);

			await dockerCli(
				"run",
				"-d",
				"--name",
				RECOVERY,
				"--network",
				NETWORK,
				"--network-alias",
				RECOVERY,
				"-v",
				`${replica.appName}-data:/var/lib/sqld`,
				"--entrypoint",
				"sqld",
				IMAGE,
				"--db-path",
				`${setAside[0]}`,
				"--http-listen-addr",
				"0.0.0.0:8080",
			);
			await waitUntil("the set-aside data", async () => {
				const rows = await runSql(RECOVERY, "select v from own");
				return JSON.stringify(rows) === JSON.stringify(["own-row"]);
			});
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"replicates named namespaces when both nodes enable them",
		async () => {
			const primary = await deployPrimary("ns-primary", {
				enableNamespaces: true,
			});
			const created = await curl(
				"-o",
				"/dev/null",
				"-w",
				"%{http_code}",
				"-X",
				"POST",
				"-H",
				"Content-Type: application/json",
				"-d",
				"{}",
				`http://${primary.appName}:5000/v1/namespaces/tenant/create`,
			);
			expect(created).toBe("200");
			await sql(primary, "create table n(v text)", "tenant");
			await sql(primary, "insert into n values ('in-tenant')", "tenant");

			const replica = replicaOf(primary, "ns-replica", {
				enableNamespaces: true,
			});
			await buildLibsql(replica);
			await waitForRows(replica, "select v from n", ["in-tenant"], "tenant");
			await expect(sql(replica, "select v from n")).rejects.toThrow(
				"no such table",
			);

			await sql(replica, "insert into n values ('through-replica')", "tenant");
			await waitForRows(
				primary,
				"select v from n",
				["in-tenant", "through-replica"],
				"tenant",
			);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"makes a replica of a custom command that has no replication flags",
		async () => {
			const primary = await deployPrimary("custom-primary");
			await sql(primary, "create table t(v text)");
			await sql(primary, "insert into t values ('from-primary')");

			const replica = replicaOf(primary, "custom-replica", {
				command: "sqld --db-path iku.db --http-listen-addr 0.0.0.0:8080",
			});
			await buildLibsql(replica);
			await waitForRows(replica, "select v from t", ["from-primary"]);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"finds sqld refusing to listen for gRPC with a primary URL, the reason buildLibsql rejects it",
		async () => {
			const refusal = await execFileAsync(
				"docker",
				[
					"run",
					"--rm",
					"-e",
					"SQLD_PRIMARY_GRPC_URL=http://primary:5001",
					"--entrypoint",
					"sqld",
					IMAGE,
					"--grpc-listen-addr",
					"0.0.0.0:5001",
				],
				{ timeout: 60_000 },
			).then(
				() => "started",
				(error: { stderr: string }) => error.stderr,
			);

			expect(refusal).toContain("cannot be used with '--primary-grpc-url");
		},
		REAL_TEST_TIMEOUT,
	);
});

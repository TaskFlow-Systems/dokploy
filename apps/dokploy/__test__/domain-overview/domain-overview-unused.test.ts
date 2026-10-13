import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DomainOverviewAccess } from "@dokploy/server/services/domain-overview";
import { ExecError } from "@dokploy/server/utils/process/ExecError";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	findServers: vi.fn(),
	findServer: vi.fn(),
	findSettings: vi.fn(),
	getAllDomainsForOrganization: vi.fn(),
	getPublicIpWithFallback: vi.fn(),
	resolveDomainRecords: vi.fn(),
	select: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			server: { findMany: mocks.findServers, findFirst: mocks.findServer },
			webServerSettings: { findFirst: mocks.findSettings },
		},
		select: mocks.select,
	},
}));

vi.mock("@dokploy/server/services/overview", () => ({
	getAllDomainsForOrganization: mocks.getAllDomainsForOrganization,
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock("@dokploy/server/services/web-server-update", () => ({
	isServerUpdateRunning: () => false,
}));

vi.mock("@dokploy/server/wss/utils", () => ({
	getPublicIpWithFallback: mocks.getPublicIpWithFallback,
}));

vi.mock(
	"@dokploy/server/utils/domain-overview/dns-status",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@dokploy/server/utils/domain-overview/dns-status")
		>()),
		resolveDomainRecords: mocks.resolveDomainRecords,
	}),
);

const {
	assertNoTraefikDeletion,
	clearStaleDeletionLock,
	deleteUnusedCertificates,
	recoverInterruptedTraefik,
	warnAboutInterruptedTraefikDeletion,
	deletionTiming,
	getDomainOverview,
	getTraefikLogs,
} = await import("@dokploy/server/services/domain-overview");
const { acquireTraefikOperation, runningTraefikOperation } = await import(
	"@dokploy/server/setup/traefik-operation-lock"
);
const { acquireHostStackUpdateLock } = await import(
	"@dokploy/server/setup/host-stack-lock"
);
const { applications, compose } = await import("@dokploy/server/db/schema");

const workDir = mkdtempSync(path.join(tmpdir(), "domain-overview-certs-"));

const makeCertificate = (name: string, days: number) => {
	const base = path.join(workDir, `${name}-${days}`);
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			`${base}.key`,
			"-out",
			`${base}.crt`,
			"-days",
			String(days),
			"-subj",
			`/CN=${name}`,
		],
		{ stdio: "ignore" },
	);
	return Buffer.from(readFileSync(`${base}.crt`, "utf8")).toString("base64");
};

const KEY_MATERIAL = "DUMMY-PRIVATE-KEY-FOR-TESTS-ONLY";
const DAY = 24 * 60 * 60 * 1000;

type AcmeFixture = { main: string; sans?: string[]; days: number };

const acmeDocument = (entries: AcmeFixture[]) =>
	JSON.stringify({
		letsencrypt: {
			Account: { Email: "ops@example.com", PrivateKey: KEY_MATERIAL },
			Certificates: entries.map((item) => ({
				domain: { main: item.main, sans: item.sans ?? [] },
				certificate: makeCertificate(item.main, item.days),
				key: KEY_MATERIAL,
			})),
		},
	});

const ROUTES = "ids=$(docker ps -q)";
const DYNAMIC = "scan()";
const STATUS = "DOKPLOY_LOCK";
const LAUNCH = "prune_logs";
const ACME_READ = "jq -c";
const LOGS = "__DOKPLOY_LOG_RC";

type Machine = {
	routes?: string;
	dynamic?: string;
	acme?: string;
	logs?: string;
	status?: string;
	launch?: string;
	clear?: string;
	recover?: string;
	fail?: Partial<Record<"routes" | "dynamic" | "acme" | "logs", unknown>>;
};

const commandHandler = (machine: Machine) => async (command: string) => {
	const answer = (
		key: "routes" | "dynamic" | "acme" | "logs",
		stdout: string | undefined,
	) => {
		if (machine.fail?.[key]) {
			throw machine.fail[key];
		}
		return { stdout: stdout ?? "", stderr: "" };
	};
	if (command.includes("DOKPLOY_LOCKCLEAR")) {
		return {
			stdout:
				machine.clear ?? "DOKPLOY_LOCKCLEAR cleared\nDOKPLOY_TRAEFIK running\n",
			stderr: "",
		};
	}
	if (command.includes("invalid_marker")) {
		return {
			stdout: machine.recover ?? "DOKPLOY_RESULT recovered\n",
			stderr: "",
		};
	}
	if (command.includes(STATUS)) {
		return { stdout: machine.status ?? "DOKPLOY_LOCK 0\n", stderr: "" };
	}
	if (command.includes(LAUNCH)) {
		return {
			stdout:
				machine.launch ??
				"DOKPLOY_LAUNCHED acme-delete-20261012T101500Z-abc123.log\n",
			stderr: "",
		};
	}
	if (command.includes(ROUTES)) {
		return answer("routes", machine.routes);
	}
	if (command.includes(DYNAMIC)) {
		return answer("dynamic", machine.dynamic);
	}
	if (command.includes(ACME_READ)) {
		return answer(
			"acme",
			machine.acme ?? '{"letsencrypt":{"Certificates":[]}}',
		);
	}
	if (command.includes(LOGS)) {
		return answer("logs", machine.logs ?? "__DOKPLOY_LOG_RC=0\n");
	}
	throw new Error(`unexpected command: ${command.slice(0, 80)}`);
};

const useLocal = (machine: Machine) =>
	mocks.execAsync.mockImplementation(commandHandler(machine));
const useRemote = (machine: Machine) =>
	mocks.execAsyncRemote.mockImplementation(
		async (_serverId: string, command: string) =>
			commandHandler(machine)(command),
	);

const routeLine = (name: string, host: string) =>
	`/${name}|${JSON.stringify({
		"traefik.enable": "true",
		[`traefik.http.routers.${name}.rule`]: `Host(\`${host}\`)`,
	})}`;

const workloadRows = new Map<unknown, unknown[]>();
const selectWorkloads = () => {
	let rows: unknown[] = [];
	const builder = {
		from: (table: unknown) => {
			rows = workloadRows.get(table) ?? [];
			return builder;
		},
		innerJoin: () => builder,
		where: () => Promise.resolve(rows),
	};
	return builder;
};

const access: DomainOverviewAccess = {
	canReadHost: async () => true,
	canReadCertificates: true,
};

const records = (a: string[], aaaa: string[] = []) => ({
	a: { ok: true as const, addresses: a },
	aaaa: aaaa.length
		? { ok: true as const, addresses: aaaa }
		: { ok: false as const, code: "ENODATA" },
});

const overviewFor = () => getDomainOverview("org-1", access);

let fakeNow = Date.now();

beforeAll(() => {
	fakeNow = Date.now();
});

beforeEach(() => {
	vi.clearAllMocks();
	deletionTiming.statusShareMs = 0;
	workloadRows.clear();
	mocks.select.mockImplementation(selectWorkloads);
	mocks.findServers.mockResolvedValue([]);
	mocks.findServer.mockResolvedValue({
		serverId: "server-1",
		name: "Build host",
	});
	mocks.findSettings.mockResolvedValue({
		serverIp: "192.0.2.10",
		host: "panel.example.com",
	});
	mocks.getAllDomainsForOrganization.mockResolvedValue([]);
	mocks.resolveDomainRecords.mockResolvedValue(records(["192.0.2.10"]));
});

afterEach(() => {
	vi.useRealTimers();
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("two tables", () => {
	it("lists a certificate nothing uses in the unused table, with where it is stored", async () => {
		useLocal({
			routes: routeLine("web", "live.example.com"),
			acme: acmeDocument([
				{ main: "live.example.com", days: 80 },
				{ main: "old.example.com", days: 80 },
			]),
		});

		const overview = await overviewFor();

		expect(overview.rows.map((row) => row.domain)).toEqual([
			"live.example.com",
			"panel.example.com",
		]);
		expect(overview.unusedCertificates).toHaveLength(1);
		expect(overview.unusedCertificates[0]).toMatchObject({
			main: "old.example.com",
			resolver: "letsencrypt",
			isLocal: true,
			deletable: true,
		});
		expect(overview.unusedCertificates[0]?.storagePath).toMatch(
			/\/traefik\/dynamic\/acme\.json$/,
		);
		expect(JSON.stringify(overview)).not.toContain(KEY_MATERIAL);
	});

	it("keeps a certificate whose alternative name or wildcard is used out of the unused table", async () => {
		useLocal({
			routes: [
				routeLine("a", "shop.example.com"),
				routeLine("b", "api.wild.example.com"),
			].join("\n"),
			acme: acmeDocument([
				{ main: "example.com", sans: ["shop.example.com"], days: 80 },
				{ main: "*.wild.example.com", days: 80 },
				{ main: "gone.example.com", days: 80 },
			]),
		});

		const overview = await overviewFor();

		expect(overview.unusedCertificates.map((item) => item.main)).toEqual([
			"gone.example.com",
		]);
	});

	it("never offers a domain that any dynamic config file mentions", async () => {
		useLocal({
			dynamic: "R\textra.yml\tHost(`file.example.com`)\n",
			acme: acmeDocument([{ main: "file.example.com", days: 80 }]),
		});

		const overview = await overviewFor();

		expect(overview.unusedCertificates).toEqual([]);
		expect(
			overview.rows.find((row) => row.domain === "file.example.com"),
		).toMatchObject({
			configFiles: ["extra.yml"],
		});
	});

	it("sorts problems first: expired, then expiring soonest, then by name", async () => {
		useLocal({
			acme: acmeDocument([
				{ main: "b-late.example.com", days: 300 },
				{ main: "a-late.example.com", days: 300 },
				{ main: "soon.example.com", days: 90 },
				{ main: "expired.example.com", days: 30 },
			]),
		});
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(fakeNow + 60.5 * DAY);

		const overview = await overviewFor();

		expect(overview.unusedCertificates.map((item) => item.main)).toEqual([
			"expired.example.com",
			"soon.example.com",
			"a-late.example.com",
			"b-late.example.com",
		]);
		expect(overview.unusedCertificates[0]?.certificate.daysLeft).toBeLessThan(
			0,
		);
	});

	it("hides the unused table when certificates cannot be read", async () => {
		useLocal({ acme: acmeDocument([{ main: "old.example.com", days: 80 }]) });

		const overview = await getDomainOverview("org-1", {
			...access,
			canReadCertificates: false,
		});

		expect(overview.unusedCertificates).toEqual([]);
		expect(
			mocks.execAsync.mock.calls.some(([c]) => String(c).includes("acme.json")),
		).toBe(false);
	});
});

describe("defect 1: the Traefik log", () => {
	it("says the log is not available when docker logs timed out", async () => {
		useLocal({
			routes: routeLine("web", "live.example.com"),
			logs: "__DOKPLOY_LOG_RC=124\n",
		});

		const overview = await overviewFor();

		expect(overview.rows.every((row) => row.logAvailable === false)).toBe(true);
		expect(overview.serverErrors.map((item) => item.message).join()).toMatch(
			/Traefik logs: .*did not finish/,
		);
	});

	it("says the log is not available when the command itself fails", async () => {
		useLocal({
			routes: routeLine("web", "live.example.com"),
			fail: { logs: new Error("boom") },
		});

		const overview = await overviewFor();

		expect(overview.rows.every((row) => row.logAvailable === false)).toBe(true);
	});

	it("marks the log available only when it was read", async () => {
		useLocal({ routes: routeLine("web", "live.example.com") });

		const overview = await overviewFor();

		expect(overview.rows.every((row) => row.logAvailable)).toBe(true);
		expect(overview.serverErrors).toEqual([]);
	});

	it("takes the last error from the log", async () => {
		useLocal({
			routes: routeLine("web", "live.example.com"),
			logs: 'time="2026-10-08T10:00:00Z" level=error msg="Unable to obtain ACME certificate for domains" domains=[live.example.com] error="no such host"\n__DOKPLOY_LOG_RC=0\n',
		});

		const overview = await overviewFor();

		expect(
			overview.rows.find((row) => row.domain === "live.example.com")?.lastError
				?.cause,
		).toBe("no_dns_record");
	});
});

describe("defect 2: remote commands that fail over SSH", () => {
	beforeEach(() => {
		mocks.findServers.mockResolvedValue([
			{ serverId: "server-1", name: "Build host", ipAddress: "198.51.100.20" },
		]);
		mocks.findSettings.mockResolvedValue({ serverIp: null, host: null });
		useLocal({});
	});

	it("keeps a sanitised reason and does not leak the address", async () => {
		useRemote({
			fail: {
				routes: new ExecError(
					"SSH connection error: connect ECONNREFUSED 198.51.100.20:22",
					{ command: "docker ps", serverId: "server-1" },
				),
			},
		});

		const overview = await overviewFor();
		const messages = overview.serverErrors
			.filter((item) => item.serverId === "server-1")
			.map((item) => item.message);

		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("could not run the command over SSH");
		expect(messages[0]).toContain("ECONNREFUSED");
		expect(messages[0]).not.toContain("198.51.100.20");
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(2);
	});

	it("shows the exit code and the first stderr line of a failing command", async () => {
		useRemote({
			fail: {
				routes: new ExecError("Remote command failed with exit code 127", {
					command: "docker ps",
					stderr: "sh: docker: command not found\nmore",
					exitCode: 127,
					serverId: "server-1",
				}),
			},
		});

		const overview = await overviewFor();

		expect(
			overview.serverErrors.find((item) => item.serverId === "server-1")
				?.message,
		).toBe(
			"Routes: command failed (exit code 127: sh: docker: command not found)",
		);
	});

	it("does not list unused certificates for a server whose routes could not be read", async () => {
		useRemote({
			acme: acmeDocument([{ main: "old.example.com", days: 80 }]),
			fail: { routes: new Error("x") },
		});

		const overview = await overviewFor();

		expect(overview.unusedCertificates).toEqual([]);
		expect(
			overview.servers.find((item) => item.serverId === "server-1")
				?.usageVerified,
		).toBe(false);
	});

	it("runs the commands of one server one after the other", async () => {
		let running = 0;
		let peak = 0;
		mocks.execAsyncRemote.mockImplementation(
			async (_id: string, command: string) => {
				running += 1;
				peak = Math.max(peak, running);
				await new Promise((resolve) => setTimeout(resolve, 5));
				running -= 1;
				return commandHandler({})(command);
			},
		);

		await overviewFor();

		expect(mocks.execAsyncRemote.mock.calls.length).toBeGreaterThanOrEqual(3);
		expect(peak).toBe(1);
	});

	it("reads remote Traefik files from the same directory as the certificates", async () => {
		useRemote({});

		await overviewFor();

		const commands = mocks.execAsyncRemote.mock.calls.map(([, c]) => String(c));
		expect(
			commands.some((c) => c.includes("/etc/dokploy/traefik/dynamic")),
		).toBe(true);
	});
});

describe("defect 3: the server address", () => {
	const row = (
		overview: Awaited<ReturnType<typeof overviewFor>>,
		domain: string,
	) => overview.rows.find((item) => item.domain === domain);

	it("gives a panel domain and a route-only domain the same answer", async () => {
		workloadRows.set(applications, [
			{
				id: "app-1",
				name: "one",
				appName: "one-app",
				serverId: null,
				environmentId: "env-1",
				projectId: "proj-1",
			},
		]);
		workloadRows.set(compose, []);
		mocks.getAllDomainsForOrganization.mockResolvedValue([
			{
				host: "panelside.example.com",
				serviceOwnerType: "application",
				serviceOwnerId: "app-1",
				serviceName: "one",
				projectId: "proj-1",
				environmentId: "env-1",
				domainType: "application",
				enabled: true,
			},
		]);
		useLocal({ routes: routeLine("web", "routeonly.example.com") });

		const overview = await overviewFor();

		expect(row(overview, "panelside.example.com")?.dns.status).toBe(
			"points_to_this_server",
		);
		expect(row(overview, "routeonly.example.com")?.dns.status).toBe(
			"points_to_this_server",
		);
		expect(row(overview, "panel.example.com")?.dns.status).toBe(
			"points_to_this_server",
		);
	});

	it("says the address is unknown on every row and does not ask outside services", async () => {
		mocks.findSettings.mockResolvedValue({
			serverIp: null,
			host: "panel.example.com",
		});
		mocks.resolveDomainRecords.mockResolvedValue(records(["198.51.100.7"]));
		useLocal({ routes: routeLine("web", "routeonly.example.com") });

		const overview = await overviewFor();

		expect(overview.rows.map((item) => item.dns.status)).toEqual([
			"server_address_unknown",
			"server_address_unknown",
		]);
		expect(mocks.getPublicIpWithFallback).not.toHaveBeenCalled();
	});

	it("says another address only when the address is known and differs", async () => {
		mocks.resolveDomainRecords.mockResolvedValue(records(["198.51.100.7"]));
		useLocal({ routes: routeLine("web", "routeonly.example.com") });

		const overview = await overviewFor();

		expect(row(overview, "routeonly.example.com")?.dns.status).toBe(
			"points_to_other_address",
		);
	});

	it("does not call an IPv6 answer another address when only an IPv4 address is known", async () => {
		mocks.resolveDomainRecords.mockResolvedValue(records([], ["2001:db8::7"]));
		useLocal({ routes: routeLine("web", "routeonly.example.com") });

		const overview = await overviewFor();

		expect(row(overview, "routeonly.example.com")?.dns.status).toBe(
			"server_address_unknown",
		);
	});

	it("uses the address a remote server's host name resolves to", async () => {
		mocks.findServers.mockResolvedValue([
			{
				serverId: "server-1",
				name: "Build host",
				ipAddress: "build.example.net",
			},
		]);
		mocks.resolveDomainRecords.mockImplementation(async (name: string) =>
			name === "build.example.net"
				? records(["203.0.113.5"])
				: records(["203.0.113.5"]),
		);
		useLocal({});
		useRemote({ routes: routeLine("web", "remote.example.com") });

		const overview = await overviewFor();

		expect(row(overview, "remote.example.com")?.dns.status).toBe(
			"points_to_this_server",
		);
	});
});

describe("defect 4: the panel's own domain", () => {
	it("lists the panel host as used by the panel, not as a certificate nothing uses", async () => {
		useLocal({
			acme: acmeDocument([{ main: "panel.example.com", days: 80 }]),
		});

		const overview = await overviewFor();

		expect(overview.unusedCertificates).toEqual([]);
		expect(
			overview.rows.find((item) => item.domain === "panel.example.com"),
		).toMatchObject({
			panelHost: true,
		});
	});

	it("finds the panel route in a file-provider config", async () => {
		useLocal({
			dynamic: "R\tdokploy.yml\tHost(`panel.example.com`)\n",
			acme: acmeDocument([{ main: "panel.example.com", days: 80 }]),
		});

		const overview = await overviewFor();

		expect(
			overview.rows.find((item) => item.domain === "panel.example.com"),
		).toMatchObject({
			panelHost: true,
			configFiles: ["dokploy.yml"],
		});
		expect(overview.unusedCertificates).toEqual([]);
	});
});

describe("deleting unused certificates", () => {
	const RESULT_OK =
		"DOKPLOY_LOCK 0\nDOKPLOY_LOGFILE acme-delete-20261012T101500Z-abc123.log\nDOKPLOY_BACKUP acme.json.bak-20261012T101500Z\nDOKPLOY_RESULT ok\n";
	const IN_PROGRESS =
		"DOKPLOY_LOCK 1\nDOKPLOY_LOGFILE acme-delete-20261012T101500Z-abc123.log\nDOKPLOY_PRECHECK ok\n";

	const storage = acmeDocument([
		{ main: "live.example.com", days: 80 },
		{ main: "old.example.com", days: 80 },
		{ main: "older.example.com", days: 80 },
		{ main: "panel.example.com", days: 80 },
		{ main: "shared.example.com", sans: ["live.example.com"], days: 80 },
	]);

	const launches = () =>
		[
			...mocks.execAsync.mock.calls.map(([command]) => String(command)),
			...mocks.execAsyncRemote.mock.calls.map(([, command]) => String(command)),
		].filter((command) => command.includes(LAUNCH));

	const statusAnswers = (machine: Machine, answers: string[]) => {
		let index = 0;
		mocks.execAsync.mockImplementation(async (command: string) => {
			if (command.includes(STATUS)) {
				const answer = answers[Math.min(index, answers.length - 1)] ?? "";
				index += 1;
				return { stdout: answer, stderr: "" };
			}
			return commandHandler(machine)(command);
		});
	};

	beforeEach(async () => {
		deletionTiming.pollIntervalMs = 5;
		deletionTiming.localWaitMs = 300;
		deletionTiming.remoteWaitMs = 300;
		deletionTiming.watchMaxMs = 60;
		while (runningTraefikOperation(null) !== null) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		useLocal({ routes: routeLine("web", "live.example.com"), acme: storage });
	});

	it("refuses a domain a route uses and changes nothing", async () => {
		const result = await deleteUnusedCertificates("org-1", null, [
			"old.example.com",
			"live.example.com",
		]);

		expect(result).toMatchObject({
			status: "refused",
			refused: [{ domain: "live.example.com", reason: "in_use" }],
		});
		expect(launches()).toEqual([]);
	});

	it("refuses an entry whose alternative name is still used", async () => {
		const result = await deleteUnusedCertificates("org-1", null, [
			"shared.example.com",
		]);

		expect(result).toMatchObject({
			status: "refused",
			refused: [{ reason: "in_use" }],
		});
		expect(launches()).toEqual([]);
	});

	it("refuses a certificate that a TCP router label uses", async () => {
		useLocal({
			routes: `/db|${JSON.stringify({
				"traefik.tcp.routers.db.rule": "HostSNI(`old.example.com`)",
			})}`,
			acme: storage,
		});

		const overview = await overviewFor();
		const result = await deleteUnusedCertificates("org-1", null, [
			"old.example.com",
		]);

		expect(overview.unusedCertificates.map((item) => item.main)).not.toContain(
			"old.example.com",
		);
		expect(result).toMatchObject({ status: "refused" });
		expect(launches()).toEqual([]);
	});

	it("refuses a certificate that a swarm service label uses", async () => {
		useLocal({
			routes: `svc:shop|${JSON.stringify({
				"traefik.http.routers.shop.rule": "Host(`old.example.com`)",
			})}`,
			acme: storage,
		});

		const result = await deleteUnusedCertificates("org-1", null, [
			"old.example.com",
		]);

		expect(result).toMatchObject({ status: "refused" });
	});

	it("refuses every certificate a regexp matcher can reach", async () => {
		useLocal({
			routes: `/web|${JSON.stringify({
				"traefik.http.routers.web.rule": "HostRegexp(`^old\\..+$`)",
			})}`,
			acme: storage,
		});

		const overview = await overviewFor();

		expect(overview.unusedCertificates.map((item) => item.main)).toContain(
			"older.example.com",
		);
		expect(overview.unusedCertificates.map((item) => item.main)).not.toContain(
			"old.example.com",
		);
	});

	it("refuses a certificate named in tls.domains of a label or a config file", async () => {
		useLocal({
			routes: `/web|${JSON.stringify({
				"traefik.http.routers.web.tls.domains[0].main": "old.example.com",
			})}`,
			dynamic: "M\textra.yml\tolder.example.com\n",
			acme: storage,
		});

		const result = await deleteUnusedCertificates("org-1", null, [
			"old.example.com",
			"older.example.com",
		]);

		expect(result).toMatchObject({
			status: "refused",
			refused: [{ reason: "in_use" }, { reason: "in_use" }],
		});
	});

	it("refuses everything when a config file could not be read", async () => {
		useLocal({
			dynamic: "E\tlocked.yml\t\n",
			acme: storage,
		});

		const result = await deleteUnusedCertificates("org-1", null, [
			"old.example.com",
		]);

		expect(result).toMatchObject({
			status: "refused",
			refused: [{ reason: "usage_unverified" }],
		});
	});

	it("refuses everything when docker could not list the routes", async () => {
		useLocal({
			fail: {
				routes: new ExecError("failed", { command: "docker", exitCode: 1 }),
			},
			acme: storage,
		});

		const overview = await overviewFor();
		const result = await deleteUnusedCertificates("org-1", null, [
			"old.example.com",
		]);

		expect(overview.unusedCertificates).toEqual([]);
		expect(result).toMatchObject({
			status: "refused",
			refused: [{ reason: "usage_unverified" }],
		});
	});

	it("refuses the panel's own domain even when no route is detected for it", async () => {
		const result = await deleteUnusedCertificates("org-1", null, [
			"panel.example.com",
		]);

		expect(result).toMatchObject({
			status: "refused",
			refused: [{ domain: "panel.example.com", reason: "panel_host" }],
		});
		expect(launches()).toEqual([]);
	});

	it("refuses a domain that is not in the storage", async () => {
		const result = await deleteUnusedCertificates("org-1", null, [
			"nothing.example.com",
		]);

		expect(result).toMatchObject({
			status: "refused",
			refused: [{ reason: "not_in_storage" }],
		});
	});

	it("refuses names that are not hostnames before any command runs", async () => {
		const result = await deleteUnusedCertificates("org-1", null, [
			"x.example.com'; rm -rf /; '",
			{ domain: "ok.example.com", resolver: "x'; id; '" },
		]);

		expect(result).toMatchObject({
			status: "refused",
			refused: [{ reason: "invalid_name" }, { reason: "invalid_name" }],
		});
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("rereads routes, config files and the storage at delete time", async () => {
		await deleteUnusedCertificates("org-1", null, ["old.example.com"]);

		const reads = mocks.execAsync.mock.calls.map(([c]) => String(c));
		expect(reads.some((c) => c.includes(ROUTES))).toBe(true);
		expect(reads.some((c) => c.includes(DYNAMIC))).toBe(true);
		expect(reads.some((c) => c.includes("acme.json"))).toBe(true);
	});

	it("reports the result when the script finishes while the request waits", async () => {
		statusAnswers(
			{ routes: routeLine("web", "live.example.com"), acme: storage },
			["DOKPLOY_LOCK 0\n", RESULT_OK],
		);

		const result = await deleteUnusedCertificates("org-1", null, [
			{ domain: "old.example.com", resolver: "letsencrypt" },
		]);

		expect(result).toMatchObject({
			status: "deleted",
			backupFile: "acme.json.bak-20261012T101500Z",
		});
		const [launch] = launches();
		expect(launch).toContain('"r":"letsencrypt","m":"old.example.com"');
		expect(launch).toContain("nohup");
	});

	it("says started, not done, while the script still runs, and keeps the locks until it ends", async () => {
		let finished = false;
		const machine = {
			routes: routeLine("web", "live.example.com"),
			acme: storage,
		};
		mocks.execAsync.mockImplementation(async (command: string) => {
			if (command.includes(STATUS)) {
				return {
					stdout: finished ? RESULT_OK : "DOKPLOY_LOCK 0\n",
					stderr: "",
				};
			}
			return commandHandler(machine)(command);
		});
		deletionTiming.localWaitMs = 40;
		deletionTiming.watchMaxMs = 5_000;

		const result = await deleteUnusedCertificates("org-1", null, [
			"old.example.com",
		]);

		expect(result).toMatchObject({ status: "started" });
		await expect(
			deleteUnusedCertificates("org-1", null, ["older.example.com"]),
		).rejects.toMatchObject({ code: "CONFLICT" });

		finished = true;
		while (runningTraefikOperation(null) !== null) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		const again = await deleteUnusedCertificates("org-1", null, [
			"nothing.example.com",
		]);
		expect(again.status).toBe("refused");
	});

	it("shows a failure the script reports", async () => {
		statusAnswers(
			{ routes: routeLine("web", "live.example.com"), acme: storage },
			[
				"DOKPLOY_LOCK 0\n",
				"DOKPLOY_LOCK 0\nDOKPLOY_LOGFILE acme-delete-20261012T101500Z-abc123.log\nDOKPLOY_RESULT jq_missing\n",
			],
		);

		const result = await deleteUnusedCertificates("org-1", null, [
			"old.example.com",
		]);

		expect(result).toMatchObject({ status: "failed", code: "jq_missing" });
		expect((result as { message: string }).message).toContain(
			"jq is not installed",
		);
	});

	it("reports a log directory that cannot be used and frees the locks", async () => {
		mocks.execAsync.mockImplementation(async (command: string) => {
			if (command.includes(LAUNCH)) {
				throw new ExecError("failed", {
					command,
					stdout: "DOKPLOY_RESULT log_dir_failed\n",
					exitCode: 1,
				});
			}
			return commandHandler({
				routes: routeLine("web", "live.example.com"),
				acme: storage,
			})(command);
		});

		const result = await deleteUnusedCertificates("org-1", null, [
			"old.example.com",
		]);

		expect(result).toMatchObject({ status: "failed", code: "log_dir_failed" });
		const next = await deleteUnusedCertificates("org-1", null, [
			"nothing.example.com",
		]);
		expect(next.status).toBe("refused");
	});

	it("refuses while a Traefik reload runs and while a host stack update runs", async () => {
		const releaseReload = acquireTraefikOperation(null, "reload");
		await expect(
			deleteUnusedCertificates("org-1", null, ["old.example.com"]),
		).rejects.toMatchObject({ code: "CONFLICT" });
		releaseReload?.();

		const releaseStack = acquireHostStackUpdateLock();
		await expect(
			deleteUnusedCertificates("org-1", null, ["old.example.com"]),
		).rejects.toMatchObject({ code: "CONFLICT" });
		releaseStack?.();

		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("runs the whole script over SSH on a remote server", async () => {
		mocks.findServers.mockResolvedValue([
			{ serverId: "server-1", name: "Build host", ipAddress: "198.51.100.20" },
		]);
		let statusCalls = 0;
		mocks.execAsyncRemote.mockImplementation(
			async (_id: string, command: string) => {
				if (command.includes(STATUS)) {
					statusCalls += 1;
					return {
						stdout: statusCalls > 1 ? RESULT_OK : "DOKPLOY_LOCK 0\n",
						stderr: "",
					};
				}
				return commandHandler({
					acme: acmeDocument([{ main: "old.example.com", days: 80 }]),
				})(command);
			},
		);

		const result = await deleteUnusedCertificates("org-1", "server-1", [
			"old.example.com",
		]);

		expect(result).toMatchObject({ status: "deleted" });
		expect(launches()).toHaveLength(1);
		expect(launches()[0]).toMatch(/^sh -c '/);
		expect(launches()[0]).toContain("/etc/dokploy/acme-delete.lock");
	});
});

describe("certificates under several resolvers", () => {
	const two = JSON.stringify({
		letsencrypt: {
			Account: {},
			Certificates: [
				{
					domain: { main: "dup.example.com", sans: [] },
					certificate: makeCertificate("dup.example.com", 80),
				},
			],
		},
		staging: {
			Account: {},
			Certificates: [
				{
					domain: { main: "dup.example.com", sans: [] },
					certificate: makeCertificate("dup.example.com", 80),
				},
				{
					domain: { main: "only-staging.example.com", sans: [] },
					certificate: makeCertificate("only-staging.example.com", 80),
				},
			],
		},
	});

	beforeEach(async () => {
		deletionTiming.pollIntervalMs = 5;
		deletionTiming.localWaitMs = 100;
		deletionTiming.watchMaxMs = 60;
		while (runningTraefikOperation(null) !== null) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		useLocal({ acme: two });
	});

	it("lists a certificate with the resolver it is stored under", async () => {
		const overview = await overviewFor();

		expect(
			overview.unusedCertificates
				.map((item) => [item.resolver, item.main])
				.sort(),
		).toEqual([
			["letsencrypt", "dup.example.com"],
			["staging", "dup.example.com"],
			["staging", "only-staging.example.com"],
		]);
	});

	it("refuses a main domain stored under two resolvers unless the resolver is named", async () => {
		const result = await deleteUnusedCertificates("org-1", null, [
			"dup.example.com",
		]);

		expect(result).toMatchObject({
			status: "refused",
			refused: [{ reason: "ambiguous" }],
		});
	});

	it("addresses resolver and main domain in the script", async () => {
		await deleteUnusedCertificates("org-1", null, [
			{ domain: "dup.example.com", resolver: "staging" },
		]);

		const launch = mocks.execAsync.mock.calls
			.map(([c]) => String(c))
			.find((c) => c.includes(LAUNCH));
		expect(launch).toContain('"r":"staging","m":"dup.example.com"');
	});
});

describe("reads during a deletion", () => {
	beforeEach(async () => {
		while (runningTraefikOperation(null) !== null) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		useLocal({ routes: routeLine("web", "live.example.com") });
	});

	it("returns quickly without reading routes while this process deletes", async () => {
		const release = acquireTraefikOperation(null, "certificate deletion");

		const overview = await overviewFor();
		release?.();

		const commands = mocks.execAsync.mock.calls.map(([c]) => String(c));
		expect(commands.some((c) => c.includes(ROUTES))).toBe(false);
		expect(overview.serverErrors.map((e) => e.message).join()).toMatch(
			/deletion is running/,
		);
		expect(overview.servers[0]).toMatchObject({
			usageVerified: false,
			lastDeletion: { state: "in_progress" },
		});
		expect(overview.unusedCertificates).toEqual([]);
	});

	it("does the same when the host reports a running deletion", async () => {
		useLocal({
			routes: routeLine("web", "live.example.com"),
			status:
				"DOKPLOY_LOCK 1\nDOKPLOY_LOGFILE acme-delete-20261012T101500Z-abc123.log\nDOKPLOY_PRECHECK ok\n",
		});

		const overview = await overviewFor();

		const commands = mocks.execAsync.mock.calls.map(([c]) => String(c));
		expect(commands.some((c) => c.includes(ROUTES))).toBe(false);
		expect(overview.servers[0]?.lastDeletion?.state).toBe("in_progress");
	});

	it.each([
		[
			"DOKPLOY_LOCK 0\nDOKPLOY_LOGFILE acme-delete-20261012T101500Z-abc123.log\nDOKPLOY_BACKUP acme.json.bak-20261012T101500Z\nDOKPLOY_RESULT ok\n",
			"succeeded",
			"ok",
		],
		[
			"DOKPLOY_LOCK 0\nDOKPLOY_LOGFILE acme-delete-20261012T101500Z-abc123.log\nDOKPLOY_RESULT start_failed_restored\n",
			"failed",
			"start_failed_restored",
		],
		[
			"DOKPLOY_LOCK 0\nDOKPLOY_LOGFILE acme-delete-20261012T101500Z-abc123.log\nDOKPLOY_PRECHECK ok\n",
			"interrupted",
			null,
		],
	])(
		"shows the last deletion result from the log (%#)",
		async (status, state, code) => {
			useLocal({ routes: routeLine("web", "live.example.com"), status });

			const overview = await overviewFor();

			expect(overview.servers[0]?.lastDeletion).toMatchObject({
				state,
				code,
				time: "2026-10-12T10:15:00Z",
			});
		},
	);

	it("shows no deletion when there never was one", async () => {
		const overview = await overviewFor();

		expect(overview.servers[0]?.lastDeletion).toBeNull();
	});

	it("shares one run between refetches that arrive together", async () => {
		await Promise.all([overviewFor(), overviewFor(), overviewFor()]);

		const routeReads = mocks.execAsync.mock.calls.filter(([c]) =>
			String(c).includes(ROUTES),
		);
		expect(routeReads).toHaveLength(1);
	});
});

describe("the per-server queue", () => {
	beforeEach(() => {
		mocks.findServers.mockResolvedValue([
			{ serverId: "server-1", name: "Build host", ipAddress: "198.51.100.20" },
		]);
		useLocal({});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not leave a command behind for a caller that stopped waiting", async () => {
		vi.useFakeTimers();
		mocks.execAsyncRemote.mockImplementation(() => new Promise(() => {}));

		const reads = [1, 2, 3].map(() =>
			getTraefikLogs("org-1", "server-1").catch((error) => error),
		);
		await vi.advanceTimersByTimeAsync(200_000);
		const results = await Promise.all(reads);

		expect(results).toHaveLength(3);
		expect(mocks.execAsyncRemote.mock.calls.length).toBeLessThan(3);
		expect(
			results.every(
				(result) => (result as { error: string | null }).error !== null,
			),
		).toBe(true);
	});
});

describe("a launch whose answer is lost", () => {
	const storage = acmeDocument([{ main: "old.example.com", days: 80 }]);

	beforeEach(async () => {
		deletionTiming.pollIntervalMs = 5;
		deletionTiming.localWaitMs = 100;
		deletionTiming.remoteWaitMs = 100;
		deletionTiming.watchMaxMs = 2_000;
		while (runningTraefikOperation(null) !== null) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	});

	const lostAnswer = (status: (call: number) => string) => {
		let calls = 0;
		const machine = {
			routes: routeLine("web", "live.example.com"),
			acme: storage,
		};
		mocks.execAsync.mockImplementation(async (command: string) => {
			if (command.includes(LAUNCH)) {
				throw new Error("The command timed out");
			}
			if (command.includes(STATUS)) {
				calls += 1;
				return { stdout: status(calls), stderr: "" };
			}
			return commandHandler(machine)(command);
		});
	};

	it("keeps the locks and says started, because the script may be running", async () => {
		lostAnswer((call) =>
			call === 1 ? "DOKPLOY_LOCK 0\n" : "DOKPLOY_LOCK 1\n",
		);

		const result = await deleteUnusedCertificates("org-1", null, [
			"old.example.com",
		]);

		expect(result).toMatchObject({ status: "started" });
		expect((result as { message: string }).message).toContain(
			"did not confirm",
		);
		await expect(
			deleteUnusedCertificates("org-1", null, ["old.example.com"]),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("names a log with a random suffix and watches that log", async () => {
		const logs: string[] = [];
		lostAnswer((call) =>
			call === 1 ? "DOKPLOY_LOCK 0\n" : "DOKPLOY_LOCK 1\n",
		);
		const original = mocks.execAsync.getMockImplementation();
		mocks.execAsync.mockImplementation(async (command: string) => {
			if (command.includes(STATUS) && command.includes("latest='")) {
				logs.push(command);
			}
			return original ? original(command) : { stdout: "", stderr: "" };
		});

		const result = await deleteUnusedCertificates("org-1", null, [
			"old.example.com",
		]);

		expect((result as { logFile: string }).logFile).toMatch(
			/^acme-delete-\d{8}T\d{6}Z-[0-9a-f]{6}\.log$/,
		);
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(
			logs.some((c) => c.includes((result as { logFile: string }).logFile)),
		).toBe(true);
	});

	it("lets go once the host shows the script is gone without a result", async () => {
		lostAnswer(() => "DOKPLOY_LOCK 0\n");

		await deleteUnusedCertificates("org-1", null, ["old.example.com"]);
		while (runningTraefikOperation(null) !== null) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		expect(runningTraefikOperation(null)).toBeNull();
	});

	it("lets go once the log shows a result", async () => {
		lostAnswer((call) =>
			call === 1
				? "DOKPLOY_LOCK 0\n"
				: "DOKPLOY_LOCK 0\nDOKPLOY_LOGFILE acme-delete-20261012T101500Z-abc123.log\nDOKPLOY_RESULT ok\n",
		);

		const result = await deleteUnusedCertificates("org-1", null, [
			"old.example.com",
		]);

		expect(result).toMatchObject({ status: "started" });
		while (runningTraefikOperation(null) !== null) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(runningTraefikOperation(null)).toBeNull();
	});

	it("reports a result the launcher printed before it failed", async () => {
		mocks.execAsync.mockImplementation(async (command: string) => {
			if (command.includes(LAUNCH)) {
				throw new ExecError("failed", {
					command,
					stdout: "DOKPLOY_RESULT launch_failed\n",
					exitCode: 1,
				});
			}
			return commandHandler({
				routes: routeLine("web", "live.example.com"),
				acme: storage,
			})(command);
		});

		const result = await deleteUnusedCertificates("org-1", null, [
			"old.example.com",
		]);

		expect(result).toMatchObject({ status: "failed", code: "launch_failed" });
		expect(runningTraefikOperation(null)).toBeNull();
	});
});

describe("labels that cannot be read", () => {
	it("refuses the deletion when a container's labels are not valid JSON", async () => {
		useLocal({
			routes: "/web|{broken json",
			acme: acmeDocument([{ main: "old.example.com", days: 80 }]),
		});

		const overview = await overviewFor();
		const result = await deleteUnusedCertificates("org-1", null, [
			"old.example.com",
		]);

		expect(overview.servers[0]?.usageVerified).toBe(false);
		expect(overview.unusedCertificates).toEqual([]);
		expect(result).toMatchObject({
			status: "refused",
			refused: [{ reason: "usage_unverified" }],
		});
	});
});

describe("backups outside the editor tree", () => {
	it("puts backups and the lock under the base path and never under the Traefik directory", async () => {
		useLocal({
			routes: routeLine("web", "live.example.com"),
			acme: acmeDocument([{ main: "old.example.com", days: 80 }]),
		});
		await deleteUnusedCertificates("org-1", null, ["old.example.com"]);

		const launch =
			mocks.execAsync.mock.calls
				.map(([c]) => String(c))
				.find((c) => c.includes(LAUNCH)) ?? "";
		const { paths } = await import("@dokploy/server/constants");

		expect(launch).toContain(`${paths().BASE_PATH}/acme-backups`);
		expect(launch).not.toContain(`${paths().MAIN_TRAEFIK_PATH}/acme-backups`);
		expect(launch).not.toContain(
			`${paths().DYNAMIC_TRAEFIK_PATH}/acme.json.bak`,
		);
	});
});

describe("an interrupted deletion and stale locks", () => {
	beforeEach(async () => {
		while (runningTraefikOperation(null) !== null) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		useLocal({ routes: routeLine("web", "live.example.com") });
	});

	it("shows Traefik as left stopped when a marker exists and no script is alive", async () => {
		useLocal({
			routes: routeLine("web", "live.example.com"),
			status:
				"DOKPLOY_LOCK 0\nDOKPLOY_STALE 1\nDOKPLOY_MARKER container stopped\n",
		});

		const overview = await overviewFor();

		expect(overview.servers[0]).toMatchObject({
			staleLock: true,
			traefikLeftStopped: { kind: "container", phase: "stopped" },
		});
	});

	it("does not call it left stopped while a script holds the lock", async () => {
		useLocal({
			routes: routeLine("web", "live.example.com"),
			status: "DOKPLOY_LOCK 1\nDOKPLOY_MARKER container stopped\n",
		});

		const overview = await overviewFor();

		expect(overview.servers[0]?.traefikLeftStopped).toBeNull();
	});

	it("shows nothing special on a healthy server", async () => {
		const overview = await overviewFor();

		expect(overview.servers[0]).toMatchObject({
			staleLock: false,
			traefikLeftStopped: null,
		});
	});

	it("clears a stale lock and reports Traefik's state", async () => {
		useLocal({
			clear: "DOKPLOY_LOCKCLEAR cleared\nDOKPLOY_TRAEFIK stopped\n",
		});

		const result = await clearStaleDeletionLock("org-1", null);

		expect(result).toMatchObject({ status: "cleared", traefik: "stopped" });
	});

	it("keeps a lock whose process is alive", async () => {
		useLocal({
			clear: "DOKPLOY_LOCKCLEAR alive\nDOKPLOY_TRAEFIK running\n",
		});

		const result = await clearStaleDeletionLock("org-1", null);

		expect(result.status).toBe("alive");
	});

	it("does not clear a lock while this process runs an operation", async () => {
		const release = acquireTraefikOperation(null, "reload");
		await expect(clearStaleDeletionLock("org-1", null)).rejects.toMatchObject({
			code: "CONFLICT",
		});
		release?.();
	});

	it("starts Traefik again on request and reports the result", async () => {
		useLocal({ recover: "DOKPLOY_RESULT recovered\n" });

		const result = await recoverInterruptedTraefik("org-1", null);

		expect(result).toMatchObject({ status: "recovered" });
		const sent =
			mocks.execAsync.mock.calls
				.map(([c]) => String(c))
				.find((c) => c.includes("invalid_marker")) ?? "";
		expect(sent).toContain("acme-delete.marker");
	});

	it("reads a failure result the script printed before exiting non-zero", async () => {
		mocks.execAsync.mockImplementation(async (command: string) => {
			throw new ExecError("failed", {
				command,
				stdout: "DOKPLOY_RESULT recovery_failed\n",
				exitCode: 1,
			});
		});

		const result = await recoverInterruptedTraefik("org-1", null);

		expect(result).toMatchObject({ status: "recovery_failed" });
	});

	it("does not start anything on its own when the page is read", async () => {
		useLocal({
			routes: routeLine("web", "live.example.com"),
			status: "DOKPLOY_LOCK 0\nDOKPLOY_MARKER container stopped\n",
		});

		await overviewFor();

		const sent = mocks.execAsync.mock.calls.map(([c]) => String(c));
		expect(sent.some((c) => c.includes("invalid_marker"))).toBe(false);
		expect(sent.some((c) => c.includes("docker start"))).toBe(false);
	});
});

describe("other Traefik operations during a deletion", () => {
	beforeEach(() => {
		useLocal({});
	});

	it("refuses while the host lock is held", async () => {
		useLocal({ status: "DOKPLOY_LOCK 1\n" });

		await expect(assertNoTraefikDeletion(null)).rejects.toMatchObject({
			code: "CONFLICT",
		});
	});

	it("refuses while a marker shows an interrupted deletion", async () => {
		useLocal({ status: "DOKPLOY_LOCK 0\nDOKPLOY_MARKER container stopped\n" });

		await expect(assertNoTraefikDeletion(null)).rejects.toThrow(
			/Start Traefik again/,
		);
	});

	it("allows the operation on a clean server and when the host cannot be asked", async () => {
		await expect(assertNoTraefikDeletion(null)).resolves.toBeUndefined();
		mocks.execAsync.mockRejectedValue(new Error("unreachable"));
		await expect(assertNoTraefikDeletion(null)).resolves.toBeUndefined();
	});
});

describe("one status poll for the watcher and the page", () => {
	const storage = acmeDocument([{ main: "old.example.com", days: 80 }]);

	it("answers page reads from the watcher's last poll", async () => {
		deletionTiming.pollIntervalMs = 20;
		deletionTiming.statusShareMs = 5_000;
		deletionTiming.localWaitMs = 30;
		deletionTiming.watchMaxMs = 400;
		while (runningTraefikOperation(null) !== null) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const machine = {
			routes: routeLine("web", "live.example.com"),
			acme: storage,
		};
		mocks.execAsync.mockImplementation(async (command: string) => {
			if (command.includes(STATUS)) {
				return {
					stdout:
						"DOKPLOY_LOCK 1\nDOKPLOY_LOGFILE acme-delete-20261012T101500Z-abc123.log\nDOKPLOY_PRECHECK ok\n",
					stderr: "",
				};
			}
			return commandHandler(machine)(command);
		});
		await deleteUnusedCertificates("org-1", null, ["old.example.com"]);
		const before = mocks.execAsync.mock.calls.filter(([c]) =>
			String(c).includes(STATUS),
		).length;

		await overviewFor();
		await overviewFor();

		const after = mocks.execAsync.mock.calls.filter(([c]) =>
			String(c).includes(STATUS),
		).length;
		expect(after - before).toBeLessThanOrEqual(2);
		expect(
			mocks.execAsync.mock.calls
				.slice(before)
				.filter(
					([c]) =>
						String(c).includes("latest=''") || String(c).includes('latest=""'),
				).length,
		).toBeLessThanOrEqual(2);
	});
});

describe("the warning at panel start", () => {
	it("logs when a marker exists and no script is alive, and stays quiet otherwise", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		useLocal({ status: "DOKPLOY_LOCK 0\nDOKPLOY_MARKER container stopped\n" });
		await warnAboutInterruptedTraefikDeletion();
		expect(warn).toHaveBeenCalledTimes(1);

		useLocal({ status: "DOKPLOY_LOCK 1\nDOKPLOY_MARKER container stopped\n" });
		await warnAboutInterruptedTraefikDeletion();
		useLocal({});
		await warnAboutInterruptedTraefikDeletion();
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});
});

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

const { deleteUnusedCertificates, getDomainOverview } = await import(
	"@dokploy/server/services/domain-overview"
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

const ROUTES = "docker ps -q | xargs";
const DYNAMIC = "grep -rHoE";
const ACME_READ = "jq -c";
const LOGS = "__DOKPLOY_LOG_RC";

type Machine = {
	routes?: string;
	dynamic?: string;
	acme?: string;
	logs?: string;
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
			dynamic:
				"/etc/dokploy/traefik/dynamic/extra.yml:Host(`file.example.com`)\n",
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
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
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
			dynamic:
				"/etc/dokploy/traefik/dynamic/dokploy.yml:Host(`panel.example.com`)\n",
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
	const deleteScripts = () =>
		[
			...mocks.execAsync.mock.calls,
			...mocks.execAsyncRemote.mock.calls.map(([, command]) => [command]),
		]
			.map(([command]) => String(command))
			.filter((command) => command.includes("EXPECTED="));

	beforeEach(() => {
		useLocal({
			routes: routeLine("web", "live.example.com"),
			acme: acmeDocument([
				{ main: "live.example.com", days: 80 },
				{ main: "old.example.com", days: 80 },
				{ main: "older.example.com", days: 80 },
				{ main: "panel.example.com", days: 80 },
				{ main: "shared.example.com", sans: ["live.example.com"], days: 80 },
			]),
		});
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
		expect(deleteScripts()).toEqual([]);
	});

	it("refuses an entry whose alternative name is still used", async () => {
		const result = await deleteUnusedCertificates("org-1", null, [
			"shared.example.com",
		]);

		expect(result).toMatchObject({
			status: "refused",
			refused: [{ reason: "in_use" }],
		});
		expect(deleteScripts()).toEqual([]);
	});

	it("refuses the panel's own domain even when no route is detected for it", async () => {
		const result = await deleteUnusedCertificates("org-1", null, [
			"panel.example.com",
		]);

		expect(result).toMatchObject({
			status: "refused",
			refused: [{ domain: "panel.example.com", reason: "panel_host" }],
		});
		expect(deleteScripts()).toEqual([]);
	});

	it("refuses a domain that is not in the storage", async () => {
		const result = await deleteUnusedCertificates("org-1", null, [
			"nothing.example.com",
		]);

		expect(result).toMatchObject({
			status: "refused",
			refused: [{ reason: "not_in_storage" }],
		});
		expect(deleteScripts()).toEqual([]);
	});

	it("refuses names that are not hostnames before any command runs", async () => {
		const result = await deleteUnusedCertificates("org-1", null, [
			"x.example.com'; rm -rf /; '",
		]);

		expect(result).toMatchObject({
			status: "refused",
			refused: [{ reason: "invalid_name" }],
		});
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("refuses everything when the routes of the server could not be read", async () => {
		useLocal({
			fail: { routes: new Error("x") },
			acme: acmeDocument([{ main: "old.example.com", days: 80 }]),
		});

		const result = await deleteUnusedCertificates("org-1", null, [
			"old.example.com",
		]);

		expect(result).toMatchObject({
			status: "refused",
			refused: [{ reason: "usage_unverified" }],
		});
		expect(deleteScripts()).toEqual([]);
	});

	it("rereads the state at delete time", async () => {
		await deleteUnusedCertificates("org-1", null, ["old.example.com"]).catch(
			() => undefined,
		);

		const reads = mocks.execAsync.mock.calls.map(([c]) => String(c));
		expect(reads.some((c) => c.includes(ROUTES))).toBe(true);
		expect(reads.some((c) => c.includes(DYNAMIC))).toBe(true);
		expect(reads.some((c) => c.includes("acme.json"))).toBe(true);
	});

	it("prepares in the request and applies detached on the panel host", async () => {
		mocks.execAsync.mockImplementation(async (command: string) => {
			if (command.includes("EXPECTED=") && command.includes("prepare")) {
				return {
					stdout:
						"DOKPLOY_BACKUP acme.json.bak-20261012T101500Z\nDOKPLOY_RESULT prepared\n",
					stderr: "",
				};
			}
			if (command.includes("nohup")) {
				return { stdout: "", stderr: "" };
			}
			return commandHandler({
				routes: routeLine("web", "live.example.com"),
				acme: acmeDocument([{ main: "old.example.com", days: 80 }]),
			})(command);
		});

		const result = await deleteUnusedCertificates("org-1", null, [
			"old.example.com",
		]);

		expect(result).toMatchObject({
			status: "restarting",
			backupFile: "acme.json.bak-20261012T101500Z",
		});
		const apply = mocks.execAsync.mock.calls
			.map(([c]) => String(c))
			.find((c) => c.includes("nohup"));
		expect(apply).toContain("apply");
		expect(apply).toContain('["old.example.com"]');
	});

	it("runs the whole script over SSH on a remote server and reports the backup", async () => {
		mocks.findServers.mockResolvedValue([
			{ serverId: "server-1", name: "Build host", ipAddress: "198.51.100.20" },
		]);
		mocks.execAsyncRemote.mockImplementation(
			async (_id: string, command: string) => {
				if (command.includes("EXPECTED=")) {
					return {
						stdout:
							"DOKPLOY_BACKUP acme.json.bak-20261012T101500Z\nDOKPLOY_RESULT ok\n",
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

		expect(result).toMatchObject({
			status: "deleted",
			backupFile: "acme.json.bak-20261012T101500Z",
		});
		expect(deleteScripts()).toHaveLength(1);
		expect(deleteScripts()[0]).toMatch(/^sh -c '/);
	});

	it("reports a missing jq from the script", async () => {
		mocks.findServers.mockResolvedValue([
			{ serverId: "server-1", name: "Build host", ipAddress: "198.51.100.20" },
		]);
		mocks.execAsyncRemote.mockImplementation(
			async (_id: string, command: string) => {
				if (command.includes("EXPECTED=")) {
					throw new ExecError("Remote command failed with exit code 1", {
						command,
						stdout: "DOKPLOY_RESULT jq_missing\n",
						exitCode: 1,
					});
				}
				return commandHandler({
					acme: acmeDocument([{ main: "old.example.com", days: 80 }]),
				})(command);
			},
		);

		const result = await deleteUnusedCertificates("org-1", "server-1", [
			"old.example.com",
		]);

		expect(result).toMatchObject({ status: "failed", code: "jq_missing" });
		expect((result as { message: string }).message).toContain(
			"jq is not installed",
		);
	});
});

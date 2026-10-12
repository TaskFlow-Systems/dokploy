import type { DomainOverviewAccess } from "@dokploy/server/services/domain-overview";
import { beforeEach, describe, expect, it, vi } from "vitest";

const FIXTURE_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIByzCCAXGgAwIBAgIUWlFvc+nf6dEY5hzHVUVViA92C6kwCgYIKoZIzj0EAwIw
NjEVMBMGA1UEAwwMZXhhbXBsZS50ZXN0MR0wGwYDVQQKDBRFeGFtcGxlIFRlc3Qg
Rml4dHVyZTAeFw0yNjAxMDEwMDAwMDBaFw0yNzA2MDExMjAwMDBaMDYxFTATBgNV
BAMMDGV4YW1wbGUudGVzdDEdMBsGA1UECgwURXhhbXBsZSBUZXN0IEZpeHR1cmUw
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAR8poBd9hdPZbBkGhYMU068RMvU5tEW
AGaG3Ak6Ia9ZJNXhgn2Rc8Kc1Xim/05OxNc7ubzinXH7XEBWyfLmI7Ylo10wWzAd
BgNVHQ4EFgQUkdsHQsjcvCmQo7qeXtOtA3bmJZAwDwYDVR0TAQH/BAUwAwEB/zAp
BgNVHREEIjAgggxleGFtcGxlLnRlc3SCEHd3dy5leGFtcGxlLnRlc3QwCgYIKoZI
zj0EAwIDSAAwRQIgWV3UtpalgH4fHv8AmFwlUfSdJjTLK5Li2K2OJKYZXrICIQCK
c9Rm3ru6I2cIJEIQwsANL6haSt6HrEbU14R9Zw3LWQ==
-----END CERTIFICATE-----
`;

const KEY_MATERIAL = "KEY-MATERIAL-FOR-TESTS-ONLY";

const acmeDocument = JSON.stringify({
	letsencrypt: {
		Account: { Email: "ops@example.test", PrivateKey: KEY_MATERIAL },
		Certificates: [
			{
				domain: { main: "one.example.test", sans: [] },
				certificate: Buffer.from(FIXTURE_CERTIFICATE, "utf8").toString(
					"base64",
				),
				key: KEY_MATERIAL,
			},
		],
	},
});

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	findServers: vi.fn(),
	findSettings: vi.fn(),
	getAllDomainsForOrganization: vi.fn(),
	getPublicIpWithFallback: vi.fn(),
	resolveDomainRecords: vi.fn(),
	select: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			server: { findMany: mocks.findServers },
			webServerSettings: { findFirst: mocks.findSettings },
		},
		select: mocks.select,
	},
}));

vi.mock("@dokploy/server/services/overview", () => ({
	getAllDomainsForOrganization: mocks.getAllDomainsForOrganization,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
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

const { getDomainOverview } = await import(
	"@dokploy/server/services/domain-overview"
);
const { applications, compose } = await import("@dokploy/server/db/schema");

const workloadRows = new Map<unknown, unknown[]>();

type SelectBuilder = {
	from: (table: unknown) => SelectBuilder;
	innerJoin: () => SelectBuilder;
	where: () => Promise<unknown[]>;
};

const selectWorkloads = (): SelectBuilder => {
	let rows: unknown[] = [];
	const builder: SelectBuilder = {
		from: (table) => {
			rows = workloadRows.get(table) ?? [];
			return builder;
		},
		innerJoin: () => builder,
		where: () => Promise.resolve(rows),
	};
	return builder;
};

const accessTo = (options: {
	servers: string[];
	certificates: boolean;
}): DomainOverviewAccess => ({
	canReadHost: async (serverId) =>
		serverId !== null && options.servers.includes(serverId),
	canReadCertificates: options.certificates,
});

describe("domain overview reads only what the caller may read", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		workloadRows.clear();
		workloadRows.set(applications, [
			{
				id: "app-1",
				name: "one",
				appName: "one-app",
				serverId: "server-1",
				environmentId: "env-1",
				projectId: "proj-1",
			},
			{
				id: "app-2",
				name: "other",
				appName: "other-app",
				serverId: "server-2",
				environmentId: "env-1",
				projectId: "proj-1",
			},
		]);
		workloadRows.set(compose, []);
		mocks.select.mockImplementation(() => selectWorkloads());
		mocks.findServers.mockResolvedValue([
			{ serverId: "server-1", name: "Build host", ipAddress: "" },
			{ serverId: "server-2", name: "Other host", ipAddress: "" },
		]);
		mocks.findSettings.mockResolvedValue(null);
		mocks.getAllDomainsForOrganization.mockResolvedValue([
			{
				host: "one.example.test",
				serviceOwnerType: "application",
				serviceOwnerId: "app-1",
				serviceName: "one",
				projectId: "proj-1",
				environmentId: "env-1",
				domainType: "application",
				enabled: true,
			},
			{
				host: "other.example.test",
				serviceOwnerType: "application",
				serviceOwnerId: "app-2",
				serviceName: "other",
				projectId: "proj-1",
				environmentId: "env-1",
				domainType: "application",
				enabled: true,
			},
		]);
		mocks.resolveDomainRecords.mockResolvedValue({
			a: { ok: true, addresses: [] },
			aaaa: { ok: false, code: "ENODATA" },
		});
		mocks.execAsync.mockResolvedValue({ stdout: "" });
		mocks.execAsyncRemote.mockImplementation(async () => ({ stdout: "" }));
	});

	it("contacts and lists only the servers the caller can read", async () => {
		const overview = await getDomainOverview(
			"org-1",
			accessTo({ servers: ["server-1"], certificates: false }),
		);

		expect(overview.servers.map((server) => server.serverId)).toEqual([
			"server-1",
		]);
		expect(overview.rows.map((row) => row.domain)).toEqual([
			"one.example.test",
		]);
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote.mock.calls.length).toBeGreaterThan(0);
		expect(
			mocks.execAsyncRemote.mock.calls.every(
				([serverId]) => serverId === "server-1",
			),
		).toBe(true);
		expect(mocks.resolveDomainRecords).not.toHaveBeenCalledWith(
			"other.example.test",
		);
	});

	it("does not read acme.json while certificate access is closed", async () => {
		const overview = await getDomainOverview(
			"org-1",
			accessTo({ servers: ["server-1"], certificates: false }),
		);
		const commands = mocks.execAsyncRemote.mock.calls.map(
			([, command]) => command as string,
		);

		expect(commands.some((command) => command.includes("acme.json"))).toBe(
			false,
		);
		expect(overview.certificatesVisible).toBe(false);
		expect(overview.rows.every((row) => row.certificate === null)).toBe(true);
	});

	it("returns certificate dates from acme.json and never the key material", async () => {
		mocks.execAsyncRemote.mockImplementation(async (_serverId, command) => ({
			stdout: (command as string).includes("acme.json") ? acmeDocument : "",
		}));

		const overview = await getDomainOverview(
			"org-1",
			accessTo({ servers: ["server-1"], certificates: true }),
		);

		expect(overview.certificatesVisible).toBe(true);
		expect(
			overview.rows.find((row) => row.domain === "one.example.test")
				?.certificate,
		).toMatchObject({ issuer: expect.any(String) });
		expect(JSON.stringify(overview)).not.toContain(KEY_MATERIAL);
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const dns = vi.hoisted(() => ({
	resolve4: vi.fn(),
	resolve6: vi.fn(),
}));

vi.mock("node:dns", () => ({
	promises: {
		resolve4: dns.resolve4,
		resolve6: dns.resolve6,
	},
}));

const {
	clearDnsLookupCache,
	DNS_CACHE_TTL_MS,
	DNS_LOOKUP_TIMEOUT_MS,
	mapDnsStatus,
	resolveDomainRecords,
} = await import("@dokploy/server/utils/domain-overview/dns-status");

const dnsError = (code: string) => Object.assign(new Error(code), { code });

const answer = (addresses: string[]) => ({ ok: true as const, addresses });
const failure = (code: string) => ({ ok: false as const, code });

describe("DNS status mapper", () => {
	it("says the name points to this server when an address matches", () => {
		expect(
			mapDnsStatus({
				records: { a: answer(["192.0.2.10"]), aaaa: failure("ENODATA") },
				serverAddresses: ["192.0.2.10"],
			}),
		).toBe("points_to_this_server");
	});

	it("says the name points to another address when none matches", () => {
		expect(
			mapDnsStatus({
				records: { a: answer(["198.51.100.7"]), aaaa: failure("ENODATA") },
				serverAddresses: ["192.0.2.10"],
			}),
		).toBe("points_to_other_address");
	});

	it("reports NXDOMAIN when both families say the name does not exist", () => {
		expect(
			mapDnsStatus({
				records: { a: failure("ENOTFOUND"), aaaa: failure("ENOTFOUND") },
				serverAddresses: ["192.0.2.10"],
			}),
		).toBe("nxdomain");
	});

	it("reports a record without an address when both families have no data", () => {
		expect(
			mapDnsStatus({
				records: { a: failure("ENODATA"), aaaa: failure("ENODATA") },
				serverAddresses: ["192.0.2.10"],
			}),
		).toBe("no_address");
	});

	it("reports a failed lookup when the lookup timed out", () => {
		expect(
			mapDnsStatus({
				records: { a: failure("ETIMEDOUT"), aaaa: failure("ENODATA") },
				serverAddresses: ["192.0.2.10"],
			}),
		).toBe("lookup_failed");
	});

	it("does not call the name another address while the server's family is unknown", () => {
		expect(
			mapDnsStatus({
				records: { a: failure("ESERVFAIL"), aaaa: answer(["2001:db8::7"]) },
				serverAddresses: ["192.0.2.10"],
			}),
		).toBe("lookup_failed");
	});

	it("matches any of several known server addresses", () => {
		expect(
			mapDnsStatus({
				records: { a: answer(["198.51.100.7"]), aaaa: failure("ENODATA") },
				serverAddresses: ["192.0.2.10", "198.51.100.7"],
			}),
		).toBe("points_to_this_server");
	});

	it("compares IPv6 addresses in their normalised form", () => {
		expect(
			mapDnsStatus({
				records: {
					a: failure("ENODATA"),
					aaaa: answer(["2001:0DB8:0:0:0:0:0:7"]),
				},
				serverAddresses: ["2001:db8::7"],
			}),
		).toBe("points_to_this_server");
	});

	it("does not call an IPv6 answer another address when only IPv4 is known", () => {
		expect(
			mapDnsStatus({
				records: { a: failure("ENODATA"), aaaa: answer(["2001:db8::7"]) },
				serverAddresses: ["192.0.2.10"],
			}),
		).toBe("server_address_unknown");
	});

	it("reports an unknown server address when the name resolves", () => {
		expect(
			mapDnsStatus({
				records: { a: answer(["192.0.2.10"]), aaaa: failure("ENODATA") },
				serverAddresses: [],
			}),
		).toBe("server_address_unknown");
	});
});

describe("DNS lookups", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		clearDnsLookupCache();
	});

	it("maps a name that resolves to this server", async () => {
		dns.resolve4.mockResolvedValue(["192.0.2.10"]);
		dns.resolve6.mockRejectedValue(dnsError("ENODATA"));

		const records = await resolveDomainRecords("points-here.example.test");

		expect(mapDnsStatus({ records, serverAddresses: ["192.0.2.10"] })).toBe(
			"points_to_this_server",
		);
	});

	it("maps a name that resolves to another address", async () => {
		dns.resolve4.mockResolvedValue(["198.51.100.7"]);
		dns.resolve6.mockRejectedValue(dnsError("ENODATA"));

		const records = await resolveDomainRecords("elsewhere.example.test");

		expect(mapDnsStatus({ records, serverAddresses: ["192.0.2.10"] })).toBe(
			"points_to_other_address",
		);
	});

	it("maps a name with no DNS record", async () => {
		dns.resolve4.mockRejectedValue(dnsError("ENOTFOUND"));
		dns.resolve6.mockRejectedValue(dnsError("ENOTFOUND"));

		const records = await resolveDomainRecords("missing.example.test");

		expect(mapDnsStatus({ records, serverAddresses: ["192.0.2.10"] })).toBe(
			"nxdomain",
		);
	});

	it("maps a name whose record has no address", async () => {
		dns.resolve4.mockRejectedValue(dnsError("ENODATA"));
		dns.resolve6.mockRejectedValue(dnsError("ENODATA"));

		const records = await resolveDomainRecords("empty.example.test");

		expect(mapDnsStatus({ records, serverAddresses: ["192.0.2.10"] })).toBe(
			"no_address",
		);
	});

	it("maps a lookup that does not answer within the timeout", async () => {
		vi.useFakeTimers();
		dns.resolve4.mockReturnValue(new Promise<string[]>(() => {}));
		dns.resolve6.mockRejectedValue(dnsError("ENODATA"));

		const pending = resolveDomainRecords("slow.example.test");
		await vi.advanceTimersByTimeAsync(DNS_LOOKUP_TIMEOUT_MS);
		const records = await pending;

		expect(records.a.ok).toBe(false);
		expect(mapDnsStatus({ records, serverAddresses: ["192.0.2.10"] })).toBe(
			"lookup_failed",
		);
	});

	it("maps a resolver error that is not NXDOMAIN or NODATA as a failed lookup", async () => {
		dns.resolve4.mockRejectedValue(dnsError("ECONNREFUSED"));
		dns.resolve6.mockRejectedValue(dnsError("ECONNREFUSED"));

		const records = await resolveDomainRecords("refused.example.test");

		expect(mapDnsStatus({ records, serverAddresses: ["192.0.2.10"] })).toBe(
			"lookup_failed",
		);
	});

	it("answers repeat lookups from the cache for ten minutes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-08T10:00:00.000Z"));
		dns.resolve4.mockResolvedValue(["192.0.2.10"]);
		dns.resolve6.mockRejectedValue(dnsError("ENODATA"));

		await resolveDomainRecords("cached.example.test");
		vi.setSystemTime(
			new Date(Date.parse("2026-10-08T10:00:00.000Z") + DNS_CACHE_TTL_MS - 1),
		);
		await resolveDomainRecords("cached.example.test");
		expect(dns.resolve4).toHaveBeenCalledTimes(1);

		vi.setSystemTime(
			new Date(Date.parse("2026-10-08T10:00:00.000Z") + DNS_CACHE_TTL_MS),
		);
		await resolveDomainRecords("cached.example.test");
		expect(dns.resolve4).toHaveBeenCalledTimes(2);
	});
});

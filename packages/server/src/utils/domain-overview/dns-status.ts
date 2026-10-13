import { promises as dnsPromises } from "node:dns";
import { isIP } from "node:net";
import { withTimeout } from "./with-timeout";

export const DNS_LOOKUP_TIMEOUT_MS = 5_000;
export const DNS_CACHE_TTL_MS = 10 * 60 * 1000;

export type DnsLookup =
	| { ok: true; addresses: string[] }
	| { ok: false; code: string };

export type DnsRecords = {
	a: DnsLookup;
	aaaa: DnsLookup;
};

export type DnsStatus =
	| "points_to_this_server"
	| "points_to_other_address"
	| "server_address_unknown"
	| "nxdomain"
	| "no_address"
	| "lookup_failed"
	| "not_checked";

const addressesOf = (lookup: DnsLookup) => (lookup.ok ? lookup.addresses : []);

export const resolvedAddresses = (records: DnsRecords) => [
	...addressesOf(records.a),
	...addressesOf(records.aaaa),
];

// ENOTFOUND is NXDOMAIN and ENODATA is a name with no address record. Any other
// code (timeout, SERVFAIL, refused) means the answer is unknown, not absent.
const isTransientFailure = (lookup: DnsLookup) =>
	!lookup.ok && lookup.code !== "ENOTFOUND" && lookup.code !== "ENODATA";

const normalizeAddress = (address: string) => {
	const family = isIP(address);
	if (family === 6) {
		try {
			return new URL(`http://[${address}]`).hostname.slice(1, -1);
		} catch {
			return address.toLowerCase();
		}
	}
	return address.toLowerCase();
};

const sameAddress = (left: string, right: string) =>
	normalizeAddress(left) === normalizeAddress(right);

// "Points to another address" is only claimed when the domain resolves to an
// address of a family the server's own addresses are known for. Otherwise the
// comparison would be a guess, so the answer is "server address unknown".
export const mapDnsStatus = ({
	records,
	serverAddresses,
}: {
	records: DnsRecords;
	serverAddresses: readonly string[];
}): DnsStatus => {
	const { a, aaaa } = records;
	const addresses = resolvedAddresses(records);
	const known = serverAddresses.filter((address) => isIP(address) !== 0);

	if (
		addresses.some((address) =>
			known.some((serverAddress) => sameAddress(address, serverAddress)),
		)
	) {
		return "points_to_this_server";
	}

	const knownV4 = known.some((address) => isIP(address) === 4);
	const knownV6 = known.some((address) => isIP(address) === 6);
	if (
		(knownV4 && isTransientFailure(a)) ||
		(knownV6 && isTransientFailure(aaaa))
	) {
		return "lookup_failed";
	}

	if (addresses.length > 0) {
		const comparable = addresses.some((address) =>
			isIP(address) === 6 ? knownV6 : knownV4,
		);
		return comparable ? "points_to_other_address" : "server_address_unknown";
	}

	if (isTransientFailure(a) || isTransientFailure(aaaa)) {
		return "lookup_failed";
	}
	if (
		(!a.ok && a.code === "ENOTFOUND") ||
		(!aaaa.ok && aaaa.code === "ENOTFOUND")
	) {
		return "nxdomain";
	}
	return "no_address";
};

type ResolveAddresses = (name: string) => Promise<string[]>;

const errorCode = (error: unknown) =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	typeof error.code === "string"
		? error.code
		: "UNKNOWN";

const lookupFamily = async (
	resolve: ResolveAddresses,
	name: string,
): Promise<DnsLookup> => {
	try {
		const addresses = await withTimeout(resolve(name), DNS_LOOKUP_TIMEOUT_MS);
		return { ok: true, addresses };
	} catch (error) {
		return { ok: false, code: errorCode(error) };
	}
};

type CacheEntry = {
	expiresAt: number;
	records: Promise<DnsRecords>;
};

const cache = new Map<string, CacheEntry>();

export const clearDnsLookupCache = () => {
	cache.clear();
};

// Failed lookups are cached too, so a slow resolver is not asked again on every
// page load for ten minutes.
export const resolveDomainRecords = (domain: string): Promise<DnsRecords> => {
	const now = Date.now();
	const cached = cache.get(domain);
	if (cached && cached.expiresAt > now) {
		return cached.records;
	}
	for (const [name, entry] of cache) {
		if (entry.expiresAt <= now) {
			cache.delete(name);
		}
	}
	const records = Promise.all([
		lookupFamily((name) => dnsPromises.resolve4(name), domain),
		lookupFamily((name) => dnsPromises.resolve6(name), domain),
	]).then(([a, aaaa]) => ({ a, aaaa }));
	cache.set(domain, { expiresAt: now + DNS_CACHE_TTL_MS, records });
	return records;
};

import { execFile } from "node:child_process";
import dns from "node:dns";
import path from "node:path";
import { promisify } from "node:util";
import {
	mapDnsStatus,
	resolveDomainRecords,
} from "@dokploy/server/utils/domain-overview/dns-status";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeDns } from "./fixtures/fake-dns";

// Bun answers ENOTFOUND where Node answers ENODATA for a name that exists but
// has no address record, so the status must not rest on that code alone. The
// same fake resolver is asked from Vitest (Node) and from a Bun process.
describe("DNS status against a real resolver", () => {
	let fake: Awaited<ReturnType<typeof startFakeDns>>;
	const original = dns.getServers();

	beforeAll(async () => {
		fake = await startFakeDns();
		dns.setServers([fake.server]);
	});
	afterAll(() => {
		dns.setServers(original);
		fake.close();
	});

	const status = async (name: string) =>
		mapDnsStatus({
			records: await resolveDomainRecords(name),
			serverAddresses: ["192.0.2.10"],
		});

	it("on Node: a name with only a TXT record has no address, a missing name is nxdomain", async () => {
		expect(await status("empty.test")).toBe("no_address");
		expect(await status("gone.test")).toBe("nxdomain");
	});

	it("on Bun: the same answers", async () => {
		const { stdout } = await promisify(execFile)(
			"bun",
			[path.join(__dirname, "fixtures", "dns-status-bun-check.ts")],
			{ timeout: 30_000 },
		);
		const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
		expect(result).toEqual({
			runtime: "bun",
			empty: "no_address",
			gone: "nxdomain",
		});
	}, 40_000);
});

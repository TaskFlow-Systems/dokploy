import dns from "node:dns";
import {
	mapDnsStatus,
	resolveDomainRecords,
} from "../../../../../packages/server/src/utils/domain-overview/dns-status";
import { startFakeDns } from "./fake-dns";

const fake = await startFakeDns();
dns.setServers([fake.server]);
const status = async (name: string) =>
	mapDnsStatus({
		records: await resolveDomainRecords(name),
		serverAddresses: ["192.0.2.10"],
	});
console.log(
	JSON.stringify({
		runtime: process.versions.bun ? "bun" : "node",
		empty: await status("empty.test"),
		gone: await status("gone.test"),
	}),
);
fake.close();
process.exit(0);

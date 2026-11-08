import http from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, fetch } from "../../../../../packages/server/src/utils/undici";

const server = http.createServer((req, res) =>
	res.end(`host=${req.headers.host}`),
);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

const lookups: string[] = [];
const agent = new Agent({
	connect: {
		lookup(hostname, options, callback) {
			lookups.push(String(hostname));
			if ((options as { all?: boolean }).all) {
				callback(null, [{ address: "127.0.0.1", family: 4 }]);
				return;
			}
			callback(null, "127.0.0.1", 4);
		},
	},
});

const response = await fetch(`http://pinned.invalid:${port}/`, {
	dispatcher: agent,
});
const body = await response.text();
let closed = false;
await agent.close().then(() => {
	closed = true;
});
server.close();

console.log(
	JSON.stringify({
		runtime: typeof (globalThis as { Bun?: unknown }).Bun,
		status: response.status,
		body,
		lookups,
		closed,
	}),
);

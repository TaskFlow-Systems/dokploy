import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { sendTelegramNotification } from "../../../../../packages/server/src/utils/notifications/utils";

const dir = mkdtempSync(path.join(tmpdir(), "telegram-bun-"));
execFileSync("openssl", [
	"req",
	"-x509",
	"-newkey",
	"rsa:2048",
	"-nodes",
	"-keyout",
	path.join(dir, "key.pem"),
	"-out",
	path.join(dir, "cert.pem"),
	"-subj",
	"/CN=api.telegram.org",
	"-days",
	"1",
	"-addext",
	"subjectAltName=DNS:api.telegram.org",
]);
const key = readFileSync(path.join(dir, "key.pem"));
const cert = readFileSync(path.join(dir, "cert.pem"));

const requests: Record<string, number> = {};
const delivered = new Set<string>();
const server = https.createServer({ key, cert }, (req, res) => {
	let raw = "";
	req.on("data", (chunk) => {
		raw += chunk;
	});
	req.on("end", () => {
		const token = req.url?.match(/^\/bot([^/]+)\//)?.[1] ?? "";
		requests[token] = (requests[token] ?? 0) + 1;
		const answer = (status: number, body: unknown) => {
			res.statusCode = status;
			res.end(JSON.stringify(body));
		};
		if (token === "bad") {
			answer(401, { ok: false, description: "Unauthorized" });
		} else if (token === "limited" && requests[token] === 1) {
			answer(429, { ok: false, parameters: { retry_after: 1 } });
		} else if (token === "far") {
			answer(429, { ok: false, parameters: { retry_after: 600 } });
		} else if (token === "broken" && requests[token] === 1) {
			answer(502, { ok: false });
		} else {
			delivered.add(`${token}:${JSON.parse(raw).text}`);
			answer(200, { ok: true });
		}
	});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

// A second address that accepts the TCP connection and never answers the TLS
// handshake: what a dropped connection looks like to the sender.
const silent = net.createServer(() => {});
await new Promise<void>((resolve) => silent.listen(port, "127.0.0.2", resolve));

let dropShare = 0.5;
const transport = (budgetMs?: number) => ({
	baseUrl: `https://api.telegram.org:${port}`,
	budgetMs,
	connect: {
		ca: cert,
		timeout: 300,
		lookup(_host: string, options: { all?: boolean }, callback: Function) {
			const address = Math.random() < dropShare ? "127.0.0.2" : "127.0.0.1";
			if (options.all) {
				callback(null, [{ address, family: 4 }]);
				return;
			}
			callback(null, address, 4);
		},
	},
});

const send = async (token: string, text: string, budgetMs?: number) => {
	const startedAt = Date.now();
	try {
		await sendTelegramNotification(
			{ botToken: token, chatId: "1", messageThreadId: null } as never,
			text,
			undefined,
			transport(budgetMs),
		);
		return { ok: true, ms: Date.now() - startedAt, error: "" };
	} catch (error) {
		return {
			ok: false,
			ms: Date.now() - startedAt,
			error: (error as Error).message,
		};
	}
};
console.log = () => {};

const total = 60;
const random = await Promise.all(
	Array.from({ length: total }, (_, i) => send("good", `m${i}`)),
);
const deliveredRandom = [...delivered].filter((d) =>
	d.startsWith("good:"),
).length;

dropShare = 1;
const outage = await send("good", "outage");
dropShare = 0;
const refused = await send("bad", "refused");
const limited = await send("limited", "limited");
const broken = await send("broken", "broken");
const far = await send("far", "far", 10_000);

process.stdout.write(
	`${JSON.stringify({
		runtime: typeof (globalThis as { Bun?: unknown }).Bun,
		random: {
			total,
			delivered: deliveredRandom,
			resolved: random.filter((r) => r.ok).length,
			maxMs: Math.max(...random.map((r) => r.ms)),
		},
		outage: { ...outage, requests: requests.good },
		refused: { ...refused, requests: requests.bad },
		limited: { ...limited, requests: requests.limited },
		broken: { ...broken, requests: requests.broken },
		far: { ...far, requests: requests.far },
	})}\n`,
);
server.close();
silent.close();
process.exit(0);

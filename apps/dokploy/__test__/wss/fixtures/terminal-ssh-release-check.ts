import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { clientKey, startShellServer } from "./ssh-shell-server";

type BunBuild = {
	module: (
		name: string,
		factory: () => { exports: object; loader: "object" },
	) => void;
	onLoad: (
		options: { filter: RegExp },
		callback: (args: { path: string }) => { contents: string; loader: "ts" },
	) => void;
};

declare const Bun:
	| {
			plugin: (plugin: {
				name: string;
				setup: (build: BunBuild) => void;
			}) => void;
	  }
	| undefined;

// Bun has no vi.mock: the modules that reach the database are replaced here
// before the terminal server is imported.
const wssDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../server/wss",
);
const realHost = process.env.SSH_HOST;
const realPort = Number(process.env.SSH_PORT);
const realKey = process.env.SSH_KEY_FILE
	? readFileSync(process.env.SSH_KEY_FILE, "utf8")
	: undefined;
const local = realHost ? undefined : await startShellServer();

const server = {
	organizationId: "org-1",
	port: local ? local.port : realPort,
	sshKey: { privateKey: realKey ?? clientKey },
	sshKeyId: "key-1",
	username: "root",
	ipAddress: realHost ?? "127.0.0.1",
};

Bun?.plugin({
	name: "terminal-stubs",
	setup(build) {
		build.module("@dokploy/server", () => ({
			exports: {
				IS_CLOUD: false,
				paths: () => ({}),
				execAsync: async () => ({ stdout: "", stderr: "" }),
				findServerById: async () => server,
				resolveTrustedOriginsForAuthRequest: async () => [],
				validateRequest: async () => ({
					user: { id: "user-1" },
					session: {
						id: "session-1",
						activeOrganizationId: "org-1",
						authMethod: "session",
					},
				}),
			},
			loader: "object",
		}));
		build.module("@dokploy/server/utils/servers/destination", () => ({
			exports: { resolveServerDestinationHost: async () => server.ipAddress },
			loader: "object",
		}));
		const stubs: Record<string, string> = {
			"authorize.ts":
				"export const canAccessTerminalOverWss = async () => true;",
			"server-permission.ts":
				"export const canAccessServerTerminalWebSocket = async () => true;",
			"../utils/docker.ts": "export const getDockerHost = async () => '';",
		};
		build.onLoad(
			{
				filter:
					/(server[\\/]wss[\\/](authorize|server-permission)|server[\\/]utils[\\/]docker)\.ts$/,
			},
			(args) => {
				const key = Object.keys(stubs).find((name) =>
					args.path.endsWith(name.replace("../utils/", "utils/")),
				);
				return { contents: stubs[key as string] as string, loader: "ts" };
			},
		);
	},
});

const { setupTerminalWebSocketServer } = await import(
	path.join(wssDir, "terminal.ts")
);

const web = http.createServer();
setupTerminalWebSocketServer(web);
await new Promise<void>((resolve) =>
	web.listen(0, "127.0.0.1", () => resolve()),
);
const webPort = (web.address() as AddressInfo).port;

const cycles = Number(process.env.CYCLES ?? 20);
for (let cycle = 0; cycle < cycles; cycle++) {
	const ws = new WebSocket(
		`ws://127.0.0.1:${webPort}/terminal?serverId=server-1`,
	);
	await new Promise<void>((resolve, reject) => {
		ws.on("error", reject);
		ws.once("close", () => reject(new Error("closed before the prompt")));
		ws.on("message", (data) => {
			if (/[#$] $/.test(data.toString())) {
				resolve();
			}
		});
	});
	ws.send("sleep 3000\n");
	await new Promise((resolve) => setTimeout(resolve, 50));
	ws.close();
	await new Promise((resolve) => ws.once("close", resolve));
}

// A real sshd drops everything when this process exits, so a probe reads it first.
await new Promise((resolve) =>
	setTimeout(resolve, Number(process.env.HOLD_MS ?? 0)),
);

let live = -1;
if (local) {
	for (let i = 0; i < 50 && local.live > 0; i++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	live = local.live;
}
console.log(
	JSON.stringify({
		runtime: typeof Bun === "undefined" ? "node" : "bun",
		cycles,
		live,
	}),
);
process.exit(0);

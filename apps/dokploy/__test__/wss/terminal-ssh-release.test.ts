import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { clientKey, startShellServer } from "./fixtures/ssh-shell-server";

const mocks = vi.hoisted(() => ({
	findServerById: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	execAsync: vi.fn(),
	findServerById: mocks.findServerById,
	resolveTrustedOriginsForAuthRequest: vi.fn(async () => []),
	validateRequest: vi.fn(async () => ({
		user: { id: "user-1" },
		session: {
			id: "session-1",
			activeOrganizationId: "org-1",
			authMethod: "session",
		},
	})),
}));

vi.mock("@dokploy/server/utils/servers/destination", () => ({
	resolveServerDestinationHost: vi.fn(async () => "127.0.0.1"),
}));

vi.mock("../../server/utils/docker", () => ({
	getDockerHost: vi.fn(),
}));

vi.mock("../../server/wss/authorize", () => ({
	canAccessTerminalOverWss: vi.fn(async () => true),
}));

vi.mock("../../server/wss/server-permission", () => ({
	canAccessServerTerminalWebSocket: vi.fn(async () => true),
}));

const { setupTerminalWebSocketServer } = await import(
	"../../server/wss/terminal"
);

type ShellServer = Awaited<ReturnType<typeof startShellServer>>;

describe("server terminal ssh connection", () => {
	let web: http.Server;
	let webPort: number;
	let ssh: ShellServer;

	const startSsh = async (options?: Parameters<typeof startShellServer>[0]) => {
		ssh = await startShellServer(options);
		mocks.findServerById.mockResolvedValue({
			organizationId: "org-1",
			port: ssh.port,
			sshKey: { privateKey: clientKey },
			sshKeyId: "key-1",
			username: "root",
		});
	};

	const open = async (options?: ConstructorParameters<typeof WebSocket>[2]) => {
		const ws = new WebSocket(
			`ws://127.0.0.1:${webPort}/terminal?serverId=server-1`,
			options,
		);
		await new Promise((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		return ws;
	};

	const gotPrompt = (ws: WebSocket) =>
		new Promise<void>((resolve) => {
			ws.on("message", (data) => {
				if (data.toString().includes("ready$")) {
					resolve();
				}
			});
		});

	beforeEach(async () => {
		web = http.createServer();
		setupTerminalWebSocketServer(web);
		await new Promise<void>((resolve) =>
			web.listen(0, "127.0.0.1", () => resolve()),
		);
		webPort = (web.address() as AddressInfo).port;
	});

	afterEach(async () => {
		vi.useRealTimers();
		await new Promise<void>((resolve) => web.close(() => resolve()));
		await ssh.close();
	});

	it("leaves no ssh connection after 20 open and close cycles", async () => {
		await startSsh();

		for (let cycle = 0; cycle < 20; cycle++) {
			const ws = await open();
			const prompt = gotPrompt(ws);
			await prompt;
			ws.send("sleep 3000\n");
			ws.close();
		}

		expect(ssh.total).toBe(20);
		await vi.waitFor(() => expect(ssh.live).toBe(0), { timeout: 5000 });
	});

	it("ends the connection of a client that leaves while ssh is still connecting", async () => {
		await startSsh({ authDelayMs: 300 });

		const ws = await open();
		await vi.waitFor(() => expect(ssh.total).toBe(1));
		ws.close();

		await vi.waitFor(() => expect(ssh.live).toBe(0), { timeout: 5000 });
		expect(ssh.shells).toBe(0);
	});

	it("ends the connection of a client that vanished without closing", async () => {
		await startSsh();
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		// This client never answers a ping, as a dropped network does not.
		const ws = await open({ autoPong: false });
		await gotPrompt(ws);
		expect(ssh.live).toBe(1);

		for (let tick = 0; tick < 4; tick++) {
			vi.advanceTimersByTime(30_000);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		await vi.waitFor(() => expect(ssh.live).toBe(0), { timeout: 5000 });
		ws.terminate();
	});
});

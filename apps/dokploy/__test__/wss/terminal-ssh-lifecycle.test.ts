import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

interface FakeClient extends EventEmitter {
	connect: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
	shell: ReturnType<typeof vi.fn>;
	exec: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
	clients: [] as FakeClient[],
	findServerById: vi.fn(),
	resolveServerDestinationHost: vi.fn(),
	validateRequest: vi.fn(),
}));

// The test opens the channels itself, through the callbacks the handlers pass.
vi.mock("ssh2", async () => {
	const { EventEmitter } = await import("node:events");
	class Client extends EventEmitter {
		connect = vi.fn(() => this);
		destroy = vi.fn(() => this);
		end = vi.fn(() => this);
		shell = vi.fn();
		// As ssh2 does once the connection has ended.
		exec = vi.fn(() => {
			if (this.end.mock.calls.length > 0) {
				throw new Error("Not connected");
			}
			return this;
		});
		constructor() {
			super();
			mocks.clients.push(this as unknown as FakeClient);
		}
	}
	return { Client };
});
vi.mock("node-pty", () => ({ spawn: vi.fn() }));
vi.mock("public-ip", () => ({ publicIpv4: vi.fn(), publicIpv6: vi.fn() }));
vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	execAsync: vi.fn(),
	findServerById: mocks.findServerById,
	resolveTrustedOriginsForAuthRequest: vi.fn(async () => []),
	validateRequest: mocks.validateRequest,
}));
vi.mock("@dokploy/server/utils/servers/destination", () => ({
	resolveServerDestinationHost: mocks.resolveServerDestinationHost,
}));
vi.mock("../../server/utils/docker", () => ({
	getDockerHost: vi.fn(),
}));
vi.mock("../../server/wss/authorize", () => ({
	canAccessTerminalOverWss: vi.fn(async () => true),
	canAccessDockerOverWss: vi.fn(async () => true),
}));
vi.mock("../../server/wss/server-permission", () => ({
	canAccessServerTerminalWebSocket: vi.fn(async () => true),
}));
vi.mock("../../server/wss/docker-permission", () => ({
	canAccessDockerTerminalWebSocket: vi.fn(async () => true),
}));
vi.mock("../../server/wss/container-ownership", () => ({
	containerBelongsToService: vi.fn(async () => true),
}));

const { setupDockerContainerTerminalWebSocketServer } = await import(
	"../../server/wss/docker-container-terminal"
);
const { HANGUP_SCAN_DELAYS_MS } = await import("../../server/wss/hangup-scans");
const { setupTerminalWebSocketServer } = await import(
	"../../server/wss/terminal"
);

const terminals = {
	server: {
		path: "/terminal?serverId=server-1",
		openChannel: (c: FakeClient) => c.shell,
	},
	container: {
		path: "/docker-container-terminal?containerId=abc123def456&serverId=server-1",
		openChannel: (c: FakeClient) => c.exec,
	},
} as const;

let server: http.Server;
let base: string;

beforeEach(async () => {
	vi.clearAllMocks();
	mocks.clients.length = 0;
	mocks.validateRequest.mockResolvedValue({
		user: { id: "user-1" },
		session: {
			id: "session-1",
			activeOrganizationId: "org-1",
			authMethod: "session",
		},
	});
	mocks.findServerById.mockResolvedValue({
		organizationId: "org-1",
		port: 22,
		username: "root",
		sshKeyId: "key-1",
		sshKey: { privateKey: "key" },
	});
	mocks.resolveServerDestinationHost.mockResolvedValue("203.0.113.10");
	server = http.createServer();
	setupTerminalWebSocketServer(server);
	setupDockerContainerTerminalWebSocketServer(server);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	vi.useRealTimers();
	await new Promise((r) => server.close(r));
});

const connect = async (path: string) => {
	const ws = new WebSocket(`${base}${path}`);
	ws.on("error", () => {});
	await new Promise((r) => ws.once("open", r));
	return ws;
};

const connecting = async () => {
	await vi.waitFor(() => expect(mocks.clients[0]?.connect).toHaveBeenCalled());
	return mocks.clients[0] as FakeClient;
};

const closeClient = async (ws: WebSocket) => {
	const closed = new Promise((r) => ws.once("close", r));
	ws.close();
	await closed;
};

// vi.waitFor would move the fake clock on every retry.
const until = async (condition: () => boolean) => {
	const deadline = Date.now() + 2_000;
	while (!condition() && Date.now() < deadline) {
		await new Promise((r) => setImmediate(r));
	}
	expect(condition()).toBe(true);
};

const fakeStream = () =>
	Object.assign(new EventEmitter(), {
		stderr: Object.assign(new EventEmitter(), { resume: vi.fn() }),
		end: vi.fn(),
		resume: vi.fn(),
		setWindow: vi.fn(),
		write: vi.fn(),
	});

const openShell = async (
	t: (typeof terminals)[keyof typeof terminals],
	error?: Error,
) => {
	const ws = await connect(t.path);
	const client = await connecting();
	client.emit("ready");
	await vi.waitFor(() => expect(t.openChannel(client)).toHaveBeenCalled());
	const stream = fakeStream();
	t.openChannel(client).mock.calls[0]?.at(-1)(
		error,
		error ? undefined : stream,
	);
	return { ws, client, stream };
};

describe.each(Object.entries(terminals))("%s terminal over SSH", (_, t) => {
	it("closes the socket and the connection when the remote shell exits", async () => {
		const { ws, client, stream } = await openShell(t);

		stream.emit("close", 0);

		await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
		expect(client.end).toHaveBeenCalled();
	});

	it("closes the socket and the connection when the shell cannot be opened", async () => {
		const { ws, client } = await openShell(
			t,
			new Error("channel open failure"),
		);

		await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED));
		expect(client.end).toHaveBeenCalled();
	});
});

describe("server terminal when the browser leaves", () => {
	it("ends a connection still being made at once and destroys it 3 s later", async () => {
		const ws = await connect(terminals.server.path);
		const client = await connecting();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		await closeClient(ws);
		await until(() => client.end.mock.calls.length > 0);
		vi.advanceTimersByTime(2_999);
		expect(client.destroy).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);

		expect(client.destroy).toHaveBeenCalledTimes(1);
		expect(client.shell).not.toHaveBeenCalled();
	});

	it("ends the shell and the connection of an open shell, and destroys a connection still open 3 s later", async () => {
		const { ws, client, stream } = await openShell(terminals.server);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		await closeClient(ws);
		await until(() => client.end.mock.calls.length > 0);
		expect(stream.end).toHaveBeenCalled();
		expect(client.destroy).not.toHaveBeenCalled();
		vi.advanceTimersByTime(3_000);

		expect(client.destroy).toHaveBeenCalledTimes(1);
	});

	it("does not destroy a connection that closed within 3 s", async () => {
		const { ws, client } = await openShell(terminals.server);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		await closeClient(ws);
		await until(() => client.end.mock.calls.length > 0);
		client.emit("close");
		vi.advanceTimersByTime(3_000);

		expect(client.destroy).not.toHaveBeenCalled();
	});
});

describe("container terminal when the browser leaves", () => {
	it("keeps the connection for every hangup scan and ends it after the last one", async () => {
		const { ws, client, stream } = await openShell(terminals.container);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		await closeClient(ws);
		for (const [scan, delay] of [0, ...HANGUP_SCAN_DELAYS_MS].entries()) {
			await vi.advanceTimersByTimeAsync(delay);
			await until(() => client.exec.mock.calls.length === scan + 2);
			expect(client.end).not.toHaveBeenCalled();
			const hangup = fakeStream();
			client.exec.mock.calls[scan + 1]?.at(-1)(undefined, hangup);
			hangup.emit("close", 0);
		}

		await until(() => client.end.mock.calls.length > 0);
		expect(stream.end).toHaveBeenCalled();
		expect(client.exec).toHaveBeenCalledTimes(HANGUP_SCAN_DELAYS_MS.length + 2);
		expect(client.destroy).not.toHaveBeenCalled();
	});
});

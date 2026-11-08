import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

type FakeConnection = EventEmitter & {
	destroy: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
	shell: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
	canAccessServerTerminalWebSocket: vi.fn(),
	canAccessTerminalOverWss: vi.fn(),
	connections: [] as FakeConnection[],
	findServerById: vi.fn(),
	getDockerHost: vi.fn(),
	resolveServerDestinationHost: vi.fn(),
	setupLocalServerSSHKey: vi.fn(),
	validateRequest: vi.fn(),
}));

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
	getDockerHost: mocks.getDockerHost,
}));

vi.mock("../../server/wss/authorize", () => ({
	canAccessTerminalOverWss: mocks.canAccessTerminalOverWss,
}));

vi.mock("../../server/wss/server-permission", () => ({
	canAccessServerTerminalWebSocket: mocks.canAccessServerTerminalWebSocket,
}));

vi.mock("../../server/wss/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../server/wss/utils")>()),
	setupLocalServerSSHKey: mocks.setupLocalServerSSHKey,
}));

// The test decides when the connection becomes ready and when the shell opens.
vi.mock("ssh2", async () => {
	const { EventEmitter } = await import("node:events");
	class Client extends EventEmitter {
		destroy = vi.fn();
		end = vi.fn();
		shell = vi.fn();
		constructor() {
			super();
			mocks.connections.push(this as unknown as FakeConnection);
		}
		connect() {
			return this;
		}
	}
	return { Client };
});

const { setupTerminalWebSocketServer } = await import(
	"../../server/wss/terminal"
);

const AUTH = {
	user: { id: "user-1" },
	session: {
		id: "session-1",
		activeOrganizationId: "org-1",
		authMethod: "session",
	},
};

const SERVER = {
	organizationId: "org-1",
	port: 22,
	sshKey: { privateKey: "test-key" },
	sshKeyId: "key-1",
	username: "root",
};

const LOCAL = "serverId=local&port=22&username=root";
const REMOTE = "serverId=server-1";

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

const closeClient = async (ws: WebSocket) => {
	const closed = new Promise((resolve) => ws.once("close", resolve));
	ws.close();
	await closed;
};

const makeStream = () =>
	Object.assign(new EventEmitter(), {
		end: vi.fn(),
		setWindow: vi.fn(),
		stderr: new EventEmitter(),
		write: vi.fn(),
	});

describe("server terminal socket", () => {
	let server: http.Server;
	let port: number;

	const open = async (query: string) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal?${query}`);
		await new Promise((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		return ws;
	};

	const connectionOf = async () => {
		await vi.waitFor(() => expect(mocks.connections).toHaveLength(1));
		return mocks.connections[0] as FakeConnection;
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		mocks.connections.length = 0;
		mocks.validateRequest.mockResolvedValue(AUTH);
		mocks.canAccessServerTerminalWebSocket.mockResolvedValue(true);
		mocks.canAccessTerminalOverWss.mockResolvedValue(true);
		mocks.findServerById.mockResolvedValue(SERVER);
		mocks.getDockerHost.mockResolvedValue("172.17.0.1");
		mocks.resolveServerDestinationHost.mockResolvedValue("203.0.113.10");
		mocks.setupLocalServerSSHKey.mockResolvedValue("test-key");

		server = http.createServer();
		setupTerminalWebSocketServer(server);
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => resolve());
		});
		port = (server.address() as AddressInfo).port;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it.each([
		["session check", LOCAL, mocks.validateRequest, AUTH],
		["access check", LOCAL, mocks.canAccessTerminalOverWss, true],
		["SSH key setup", LOCAL, mocks.setupLocalServerSSHKey, "test-key"],
		["Docker host lookup", LOCAL, mocks.getDockerHost, "172.17.0.1"],
		["server lookup", REMOTE, mocks.findServerById, SERVER],
		[
			"address lookup",
			REMOTE,
			mocks.resolveServerDestinationHost,
			"203.0.113.10",
		],
	] as const)(
		"opens no SSH connection when the socket closes during the %s",
		async (_name, query, check, value) => {
			const pending = deferred<unknown>();
			check.mockReturnValue(pending.promise);
			const ws = await open(query);
			await vi.waitFor(() => expect(check).toHaveBeenCalled());

			await closeClient(ws);
			pending.resolve(value);
			await flush();

			expect(mocks.connections).toHaveLength(0);
		},
	);

	it("opens no shell when the socket closes before SSH is ready", async () => {
		const ws = await open(REMOTE);
		const connection = await connectionOf();

		await closeClient(ws);
		connection.emit("ready");

		expect(connection.shell).not.toHaveBeenCalled();
		expect(connection.end).toHaveBeenCalled();
	});

	it("ends the connection at once when the socket closes before the shell opens", async () => {
		const ws = await open(REMOTE);
		const connection = await connectionOf();
		connection.emit("ready");
		expect(connection.shell).toHaveBeenCalledTimes(1);

		await closeClient(ws);
		await vi.waitFor(() => expect(connection.end).toHaveBeenCalled());
		const stream = makeStream();
		connection.shell.mock.calls[0]?.[1](undefined, stream);

		expect(stream.end).toHaveBeenCalled();
	});

	it("ends the shell and the connection when the socket closes later", async () => {
		const ws = await open(REMOTE);
		const connection = await connectionOf();
		connection.emit("ready");
		const stream = makeStream();
		connection.shell.mock.calls[0]?.[1](undefined, stream);
		expect(stream.end).not.toHaveBeenCalled();
		expect(connection.end).not.toHaveBeenCalled();

		await closeClient(ws);

		await vi.waitFor(() => expect(connection.end).toHaveBeenCalled());
		expect(stream.end).toHaveBeenCalled();
	});
});

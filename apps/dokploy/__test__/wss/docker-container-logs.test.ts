import type { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import { WebSocket } from "ws";

const PING_INTERVAL_MS = 45_000;

type FakeConnection = EventEmitter & {
	commands: string[];
	end: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
	canAccessDockerLogsWebSocket: vi.fn(),
	canAccessDockerOverWss: vi.fn(),
	containerBelongsToService: vi.fn(),
	connections: [] as FakeConnection[],
	findServerById: vi.fn(),
	resolveServerDestinationHost: vi.fn(),
	spawn: vi.fn(),
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

vi.mock("../../server/wss/authorize", () => ({
	canAccessDockerOverWss: mocks.canAccessDockerOverWss,
}));

vi.mock("../../server/wss/container-ownership", () => ({
	containerBelongsToService: mocks.containerBelongsToService,
}));

vi.mock("../../server/wss/docker-permission", () => ({
	canAccessDockerLogsWebSocket: mocks.canAccessDockerLogsWebSocket,
}));

vi.mock("node-pty", () => ({ spawn: mocks.spawn }));

// The test decides when the connection becomes ready. `exec` throws after
// `end`, as the real client does once its socket stops being writable.
vi.mock("ssh2", async () => {
	const { EventEmitter } = await import("node:events");
	class Client extends EventEmitter {
		commands: string[] = [];
		end = vi.fn();
		constructor() {
			super();
			mocks.connections.push(this as unknown as FakeConnection);
		}
		connect() {
			return this;
		}
		exec(
			command: string,
			_options: unknown,
			callback: (error: undefined, stream: EventEmitter) => void,
		) {
			if (this.end.mock.calls.length > 0) {
				throw new Error("Not connected");
			}
			this.commands.push(command);
			const stream = Object.assign(new EventEmitter(), {
				stderr: new EventEmitter(),
			});
			setImmediate(() => callback(undefined, stream));
			return this;
		}
	}
	return { Client };
});

const { setupDockerContainerLogsWebSocketServer } = await import(
	"../../server/wss/docker-container-logs"
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
	serverId: "server-1",
	sshKey: { privateKey: "test-key" },
	sshKeyId: "key-1",
	username: "root",
};

const LOCAL = "containerId=abc123def456";
const REMOTE = `${LOCAL}&serverId=server-1`;

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

describe("container logs socket", () => {
	let server: http.Server;
	let port: number;
	let pty: {
		kill: ReturnType<typeof vi.fn>;
		onData: ReturnType<typeof vi.fn>;
		write: ReturnType<typeof vi.fn>;
	};
	let setIntervalSpy: MockInstance<typeof setInterval>;
	let clearIntervalSpy: MockInstance<typeof clearInterval>;

	const open = async (query: string) => {
		const ws = new WebSocket(
			`ws://127.0.0.1:${port}/docker-container-logs?${query}`,
		);
		await new Promise((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		return ws;
	};

	const pingTimers = () =>
		setIntervalSpy.mock.calls.flatMap(([, delay], index) =>
			delay === PING_INTERVAL_MS
				? [setIntervalSpy.mock.results[index]?.value as NodeJS.Timeout]
				: [],
		);

	const expectNoPingTimerLeft = () => {
		for (const timer of pingTimers()) {
			expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
		}
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		mocks.connections.length = 0;
		mocks.validateRequest.mockResolvedValue(AUTH);
		mocks.canAccessDockerLogsWebSocket.mockResolvedValue(true);
		mocks.canAccessDockerOverWss.mockResolvedValue(true);
		mocks.containerBelongsToService.mockResolvedValue(true);
		mocks.findServerById.mockResolvedValue(SERVER);
		mocks.resolveServerDestinationHost.mockResolvedValue("203.0.113.10");
		pty = { kill: vi.fn(), onData: vi.fn(), write: vi.fn() };
		mocks.spawn.mockReturnValue(pty);
		setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

		server = http.createServer();
		setupDockerContainerLogsWebSocketServer(server);
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => resolve());
		});
		port = (server.address() as AddressInfo).port;
	});

	afterEach(async () => {
		setIntervalSpy.mockRestore();
		clearIntervalSpy.mockRestore();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	describe("closed while a check is still running", () => {
		const localChecks = [
			["session check", mocks.validateRequest, AUTH],
			["log access check", mocks.canAccessDockerLogsWebSocket, true],
			["docker access check", mocks.canAccessDockerOverWss, true],
		] as const;

		const remoteChecks = [
			...localChecks,
			["server lookup", mocks.findServerById, SERVER],
			["address lookup", mocks.resolveServerDestinationHost, "203.0.113.10"],
		] as const;

		it.each(localChecks)(
			"starts no process during the %s",
			async (_name, check, value) => {
				const pending = deferred<unknown>();
				check.mockReturnValue(pending.promise);
				const ws = await open(LOCAL);
				await vi.waitFor(() => expect(check).toHaveBeenCalled());

				await closeClient(ws);
				pending.resolve(value);
				await flush();

				expect(mocks.spawn).not.toHaveBeenCalled();
				await vi.waitFor(expectNoPingTimerLeft);
			},
		);

		it.each(remoteChecks)(
			"opens no SSH connection during the %s",
			async (_name, check, value) => {
				const pending = deferred<unknown>();
				check.mockReturnValue(pending.promise);
				const ws = await open(REMOTE);
				await vi.waitFor(() => expect(check).toHaveBeenCalled());

				await closeClient(ws);
				pending.resolve(value);
				await flush();

				expect(mocks.connections).toHaveLength(0);
				await vi.waitFor(expectNoPingTimerLeft);
			},
		);
	});

	it("starts the process when the socket stays open through the checks", async () => {
		const pending = deferred<unknown>();
		mocks.canAccessDockerOverWss.mockReturnValue(pending.promise);
		const ws = await open(LOCAL);
		await vi.waitFor(() =>
			expect(mocks.canAccessDockerOverWss).toHaveBeenCalled(),
		);

		pending.resolve(true);
		await flush();

		expect(mocks.spawn).toHaveBeenCalledTimes(1);
		expect(mocks.spawn.mock.calls[0]?.[1]).toEqual([
			"-c",
			expect.stringContaining("--follow abc123def456"),
		]);
		await closeClient(ws);
	});

	it("stops the running process and the ping when the socket closes", async () => {
		const ws = await open(LOCAL);
		await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
		expect(pingTimers()).toHaveLength(1);
		expect(pty.kill).not.toHaveBeenCalled();

		ws.close();

		await vi.waitFor(() => expect(pty.kill).toHaveBeenCalled());
		await vi.waitFor(expectNoPingTimerLeft);
	});

	it("ends the SSH connection and the ping when the socket closes", async () => {
		const ws = await open(REMOTE);
		await vi.waitFor(() => expect(mocks.connections).toHaveLength(1));
		const connection = mocks.connections[0] as FakeConnection;
		connection.emit("ready");
		expect(connection.commands).toEqual([
			expect.stringContaining("--follow abc123def456"),
		]);
		expect(connection.end).not.toHaveBeenCalled();

		ws.close();

		await vi.waitFor(() => expect(connection.end).toHaveBeenCalled());
		await vi.waitFor(expectNoPingTimerLeft);
	});

	it("runs nothing when the socket closes before SSH is ready", async () => {
		const ws = await open(REMOTE);
		await vi.waitFor(() => expect(mocks.connections).toHaveLength(1));
		const connection = mocks.connections[0] as FakeConnection;

		await closeClient(ws);
		await vi.waitFor(() => expect(connection.end).toHaveBeenCalled());
		connection.emit("ready");

		expect(connection.commands).toEqual([]);
	});

	describe("leaves no ping timer on the early exits", () => {
		// The server can answer in the same packet as the upgrade, so a listener
		// added after "open" would miss the message.
		const openUntilClosed = (query: string) =>
			new Promise<string[]>((resolve, reject) => {
				const ws = new WebSocket(
					`ws://127.0.0.1:${port}/docker-container-logs?${query}`,
				);
				const received: string[] = [];
				ws.on("message", (data) => received.push(data.toString()));
				ws.once("close", () => resolve(received));
				ws.once("error", reject);
			});

		it("server of another organization", async () => {
			mocks.findServerById.mockResolvedValue({
				...SERVER,
				organizationId: "org-2",
			});

			await openUntilClosed(REMOTE);

			expect(mocks.connections).toHaveLength(0);
			await vi.waitFor(expectNoPingTimerLeft);
		});

		it("server without an SSH key", async () => {
			mocks.findServerById.mockResolvedValue({ ...SERVER, sshKeyId: null });

			await openUntilClosed(REMOTE);

			expect(mocks.connections).toHaveLength(0);
			await vi.waitFor(expectNoPingTimerLeft);
		});

		it("failed server lookup", async () => {
			mocks.findServerById.mockRejectedValue(new Error("Server not found"));

			await expect(openUntilClosed(REMOTE)).resolves.toEqual([
				"Server not found",
			]);
			await vi.waitFor(expectNoPingTimerLeft);
		});

		it("process that cannot start", async () => {
			mocks.spawn.mockImplementation(() => {
				throw new Error("spawn failed");
			});

			await expect(openUntilClosed(LOCAL)).resolves.toEqual(["spawn failed"]);
			await vi.waitFor(expectNoPingTimerLeft);
		});

		it("SSH connection error", async () => {
			const closed = openUntilClosed(REMOTE);
			await vi.waitFor(() => expect(mocks.connections).toHaveLength(1));
			const connection = mocks.connections[0] as FakeConnection;

			connection.emit("error", new Error("refused"));

			await expect(closed).resolves.toEqual(["SSH error: refused"]);
			await vi.waitFor(expectNoPingTimerLeft);
		});
	});

	describe("container of a service", () => {
		it("denies a container outside the service", async () => {
			mocks.containerBelongsToService.mockResolvedValue(false);
			const ws = new WebSocket(
				`ws://127.0.0.1:${port}/docker-container-logs?containerId=dokploy-postgres&runType=native&serviceId=svc-1`,
			);
			const code = await new Promise<number>((resolve, reject) => {
				ws.once("close", resolve);
				ws.once("error", reject);
			});

			expect(code).toBe(4003);
			expect(mocks.containerBelongsToService).toHaveBeenCalledWith(
				"svc-1",
				"dokploy-postgres",
				null,
				"native",
			);
			expect(mocks.spawn).not.toHaveBeenCalled();
		});

		it("streams logs of a container of the service", async () => {
			mocks.containerBelongsToService.mockResolvedValue(true);
			const ws = await open("containerId=task1&runType=swarm&serviceId=svc-1");
			await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
			await closeClient(ws);
		});
	});
});

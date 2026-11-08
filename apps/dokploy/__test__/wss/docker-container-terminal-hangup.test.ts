import http from "node:http";
import type { AddressInfo } from "node:net";
import { quoteShellArgs } from "@dokploy/server/utils/shell";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

type FakeStream = import("node:events").EventEmitter & {
	stderr: import("node:events").EventEmitter & { resume: () => void };
	end: ReturnType<typeof vi.fn>;
	resume: ReturnType<typeof vi.fn>;
	setWindow: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
};
type FakeConnection = import("node:events").EventEmitter & {
	commands: string[];
	streams: FakeStream[];
	end: ReturnType<typeof vi.fn>;
	failNextExec: boolean;
	releaseExecCallbacks: () => void;
};

const mocks = vi.hoisted(() => ({
	canAccessDockerOverWss: vi.fn(),
	canAccessDockerTerminalWebSocket: vi.fn(),
	connections: [] as FakeConnection[],
	containerBelongsToService: vi.fn(),
	execFile: vi.fn(),
	findServerById: vi.fn(),
	holdExecCallback: { value: false },
	holdReady: { value: false },
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
	canAccessDockerTerminalWebSocket: mocks.canAccessDockerTerminalWebSocket,
}));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	execFile: mocks.execFile,
}));

// Real schedule is 0.5, 2 and 5 s; the same shape, faster.
vi.mock("../../server/wss/hangup-scans", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../server/wss/hangup-scans")>();
	return {
		...original,
		runHangupScans: (scan: Parameters<typeof original.runHangupScans>[0]) =>
			original.runHangupScans(scan, [20, 40, 60]),
	};
});

vi.mock("node-pty", () => ({ spawn: mocks.spawn }));

vi.mock("ssh2", async () => {
	const { EventEmitter } = await import("node:events");
	const makeStream = () =>
		Object.assign(new EventEmitter(), {
			stderr: Object.assign(new EventEmitter(), { resume: vi.fn() }),
			end: vi.fn(),
			resume: vi.fn(),
			setWindow: vi.fn(),
			write: vi.fn(),
		});
	class Client extends EventEmitter {
		commands: string[] = [];
		streams: FakeStream[] = [];
		end = vi.fn();
		failNextExec = false;
		heldExecCallbacks: (() => void)[] = [];
		constructor() {
			super();
			mocks.connections.push(this as unknown as FakeConnection);
		}
		connect() {
			if (!mocks.holdReady.value) {
				setImmediate(() => this.emit("ready"));
			}
			return this;
		}
		releaseExecCallbacks() {
			for (const release of this.heldExecCallbacks.splice(0)) {
				release();
			}
		}
		exec(
			command: string,
			optionsOrCallback: unknown,
			maybeCallback?: (error: Error | undefined, stream?: FakeStream) => void,
		) {
			const callback = (
				typeof optionsOrCallback === "function"
					? optionsOrCallback
					: maybeCallback
			) as (error: Error | undefined, stream?: FakeStream) => void;
			this.commands.push(command);
			if (this.failNextExec) {
				setImmediate(() => callback(new Error("channel refused")));
				return this;
			}
			const stream = makeStream();
			this.streams.push(stream);
			if (mocks.holdExecCallback.value) {
				this.heldExecCallbacks.push(() => callback(undefined, stream));
				return this;
			}
			setImmediate(() => callback(undefined, stream));
			return this;
		}
	}
	return { Client };
});

const { setupDockerContainerTerminalWebSocketServer } = await import(
	"../../server/wss/docker-container-terminal"
);
const { getTerminalHangupArgs } = await import("../../server/wss/utils");

const listen = async (server: http.Server) =>
	new Promise<number>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve((server.address() as AddressInfo).port);
		});
	});

const openTerminal = async (port: number, query: string) => {
	const ws = new WebSocket(
		`ws://127.0.0.1:${port}/docker-container-terminal?${query}`,
	);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	return ws;
};

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
};

// Closes the hangup channels (index `from` on) as the scans open them.
const answerScans = async (connection: FakeConnection, from: number) => {
	for (let next = from; next < from + 4; next++) {
		await vi.waitFor(() =>
			expect(connection.streams.length).toBeGreaterThan(next),
		);
		const stream = connection.streams[next] as FakeStream;
		await vi.waitFor(() => expect(stream.resume).toHaveBeenCalled());
		stream.emit("close", 0);
	}
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

const closeClient = async (ws: WebSocket) => {
	const closed = new Promise((resolve) => ws.once("close", resolve));
	ws.close();
	await closed;
};

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

const markerIn = (args: readonly string[]) => {
	const marker = args[args.indexOf("-e") + 1];
	expect(marker).toMatch(/^DOKPLOY_TERMINAL_SESSION=[a-f0-9]{32}$/);
	return marker as string;
};

describe("container terminal hangs up its shell when it closes", () => {
	let server: http.Server;
	let port: number;
	let pty: { kill: ReturnType<typeof vi.fn> };

	beforeEach(async () => {
		vi.clearAllMocks();
		mocks.connections.length = 0;
		mocks.holdExecCallback.value = false;
		mocks.holdReady.value = false;
		mocks.canAccessDockerOverWss.mockResolvedValue(true);
		mocks.canAccessDockerTerminalWebSocket.mockResolvedValue(true);
		mocks.containerBelongsToService.mockResolvedValue(true);
		mocks.validateRequest.mockResolvedValue(AUTH);
		mocks.findServerById.mockResolvedValue(SERVER);
		mocks.resolveServerDestinationHost.mockResolvedValue("203.0.113.10");
		pty = { kill: vi.fn() };
		mocks.spawn.mockReturnValue({
			...pty,
			onData: vi.fn(),
			onExit: vi.fn(),
			resize: vi.fn(),
			write: vi.fn(),
		});

		server = http.createServer();
		setupDockerContainerTerminalWebSocketServer(server);
		port = await listen(server);
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("hangs up the local session it started, and only that one", async () => {
		const ws = await openTerminal(port, "containerId=abc123def456");
		await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
		const args = mocks.spawn.mock.calls[0]?.[1] as string[];
		expect(args).toEqual([
			"exec",
			"-it",
			"-e",
			markerIn(args),
			"-w",
			"/",
			"abc123def456",
			"sh",
		]);
		expect(mocks.execFile).not.toHaveBeenCalled();

		ws.close();

		await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalled());
		expect(pty.kill).toHaveBeenCalled();
		expect(mocks.execFile).toHaveBeenCalledWith(
			"docker",
			getTerminalHangupArgs("abc123def456", "sh", markerIn(args)),
			expect.any(Function),
		);
	});

	it("gives two local sessions different markers", async () => {
		for (let i = 0; i < 2; i++) {
			const ws = await openTerminal(port, "containerId=abc123def456");
			await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(i + 1));
			ws.close();
		}
		const [first, second] = mocks.spawn.mock.calls.map((call) =>
			markerIn(call[1] as string[]),
		);
		expect(first).not.toBe(second);
	});

	it("hangs up a remote session before it ends the SSH connection", async () => {
		const ws = await openTerminal(
			port,
			"containerId=abc123def456&serverId=server-1&activeWay=bash",
		);
		await vi.waitFor(() =>
			expect(mocks.connections[0]?.commands).toHaveLength(1),
		);
		const connection = mocks.connections[0] as FakeConnection;
		const command = connection.commands[0] as string;
		const marker = markerIn(command.split(" "));
		expect(command).toBe(`docker exec -it -e ${marker} -w / abc123def456 bash`);

		ws.close();

		await vi.waitFor(() => expect(connection.commands).toHaveLength(2));
		expect(connection.commands[1]).toBe(
			quoteShellArgs([
				"docker",
				...getTerminalHangupArgs("abc123def456", "bash", marker),
			]),
		);
		const [shell, hangup] = connection.streams as [FakeStream, FakeStream];
		await vi.waitFor(() => expect(hangup.resume).toHaveBeenCalled());

		shell.emit("close", 129, "SIGHUP");
		expect(connection.end).not.toHaveBeenCalled();
		expect(shell.end).not.toHaveBeenCalled();

		hangup.emit("close", 0);
		await answerScans(connection, 1);
		await vi.waitFor(() => expect(shell.end).toHaveBeenCalled());
		expect(connection.end).toHaveBeenCalled();
		expect(connection.commands).toHaveLength(5);
	});

	it("hangs up a local shell that the daemon starts after the first scan", async () => {
		// The container: the shell appears 30 ms after the client left, i.e.
		// after the first scan (at 0) and the second (20 ms later).
		let shellStartsAt = Number.POSITIVE_INFINITY;
		let hungUp = 0;
		mocks.execFile.mockImplementation(
			(_file: string, _args: string[], callback: () => void) => {
				if (Date.now() >= shellStartsAt) {
					// The shell exists; this scan hangs it up and it is gone.
					shellStartsAt = Number.POSITIVE_INFINITY;
					hungUp++;
				}
				callback();
			},
		);
		const ws = await openTerminal(port, "containerId=abc123def456");
		await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
		const args = mocks.spawn.mock.calls[0]?.[1] as string[];

		shellStartsAt = Date.now() + 30;
		ws.close();

		await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalledTimes(4));
		expect(hungUp).toBe(1);
		for (const call of mocks.execFile.mock.calls) {
			expect(call[1]).toEqual(
				getTerminalHangupArgs("abc123def456", "sh", markerIn(args)),
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(mocks.execFile).toHaveBeenCalledTimes(4);
	});

	it("hangs up a remote shell that the daemon starts after the first scan, on one connection", async () => {
		const ws = await openTerminal(
			port,
			"containerId=abc123def456&serverId=server-1&activeWay=bash",
		);
		await vi.waitFor(() =>
			expect(mocks.connections[0]?.commands).toHaveLength(1),
		);
		const connection = mocks.connections[0] as FakeConnection;
		const marker = markerIn((connection.commands[0] as string).split(" "));

		ws.close();
		await answerScans(connection, 1);

		const expected = quoteShellArgs([
			"docker",
			...getTerminalHangupArgs("abc123def456", "bash", marker),
		]);
		expect(connection.commands.slice(1)).toEqual([
			expected,
			expected,
			expected,
			expected,
		]);
		await vi.waitFor(() => expect(connection.end).toHaveBeenCalled());
		expect(connection.end).toHaveBeenCalledTimes(1);
	});

	it("stops scanning and ends the connection when the SSH connection drops", async () => {
		const ws = await openTerminal(
			port,
			"containerId=abc123def456&serverId=server-1&activeWay=bash",
		);
		await vi.waitFor(() =>
			expect(mocks.connections[0]?.commands).toHaveLength(1),
		);
		const connection = mocks.connections[0] as FakeConnection;

		ws.close();
		await vi.waitFor(() => expect(connection.commands).toHaveLength(2));
		connection.emit("close");

		await vi.waitFor(() => expect(connection.end).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(connection.commands).toHaveLength(2);
	});

	describe("closed before the shell has started", () => {
		const SERVICE = "containerId=abc123def456&serviceId=service-1";
		const REMOTE = "containerId=abc123def456&serverId=server-1";

		it.each([
			["session check", mocks.validateRequest, AUTH],
			["terminal access check", mocks.canAccessDockerTerminalWebSocket, true],
			["docker access check", mocks.canAccessDockerOverWss, true],
			["container ownership check", mocks.containerBelongsToService, true],
		] as const)(
			"starts no local shell during the %s",
			async (_name, check, value) => {
				const pending = deferred<unknown>();
				check.mockReturnValue(pending.promise);
				const ws = await openTerminal(port, SERVICE);
				await vi.waitFor(() => expect(check).toHaveBeenCalled());

				await closeClient(ws);
				pending.resolve(value);
				await flush();

				expect(mocks.spawn).not.toHaveBeenCalled();
				expect(mocks.execFile).not.toHaveBeenCalled();
			},
		);

		it.each([
			["docker access check", mocks.canAccessDockerOverWss, true],
			["server lookup", mocks.findServerById, SERVER],
			["address lookup", mocks.resolveServerDestinationHost, "203.0.113.10"],
		] as const)(
			"opens no SSH connection during the %s",
			async (_name, check, value) => {
				const pending = deferred<unknown>();
				check.mockReturnValue(pending.promise);
				const ws = await openTerminal(port, REMOTE);
				await vi.waitFor(() => expect(check).toHaveBeenCalled());

				await closeClient(ws);
				pending.resolve(value);
				await flush();

				expect(mocks.connections).toHaveLength(0);
			},
		);

		it("runs nothing on a connection that became ready after the close", async () => {
			mocks.holdReady.value = true;
			const ws = await openTerminal(port, REMOTE);
			await vi.waitFor(() => expect(mocks.connections).toHaveLength(1));
			const connection = mocks.connections[0] as FakeConnection;

			await closeClient(ws);
			connection.emit("ready");

			expect(connection.commands).toEqual([]);
			expect(connection.end).toHaveBeenCalled();
		});

		it("hangs up a shell that opened after the close", async () => {
			mocks.holdExecCallback.value = true;
			const ws = await openTerminal(port, REMOTE);
			await vi.waitFor(() =>
				expect(mocks.connections[0]?.commands).toHaveLength(1),
			);
			const connection = mocks.connections[0] as FakeConnection;

			await closeClient(ws);
			expect(connection.commands).toHaveLength(1);
			mocks.holdExecCallback.value = false;
			connection.releaseExecCallbacks();

			await vi.waitFor(() => expect(connection.commands).toHaveLength(2));
			const marker = markerIn((connection.commands[0] as string).split(" "));
			expect(connection.commands[1]).toBe(
				quoteShellArgs([
					"docker",
					...getTerminalHangupArgs("abc123def456", "sh", marker),
				]),
			);
			await answerScans(connection, 1);
			await vi.waitFor(() => expect(connection.end).toHaveBeenCalled());
			expect(connection.commands).toHaveLength(5);
		});
	});

	it("still ends the SSH connection when the hangup cannot start", async () => {
		const ws = await openTerminal(
			port,
			"containerId=abc123def456&serverId=server-1&activeWay=bash",
		);
		await vi.waitFor(() =>
			expect(mocks.connections[0]?.commands).toHaveLength(1),
		);
		const connection = mocks.connections[0] as FakeConnection;
		connection.failNextExec = true;

		ws.close();

		await vi.waitFor(() => expect(connection.end).toHaveBeenCalled());
		expect(connection.commands).toHaveLength(2);
		expect(connection.streams[0]?.end).toHaveBeenCalled();
	});
});

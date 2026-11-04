import type { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

type FakeConnection = EventEmitter & {
	end: ReturnType<typeof vi.fn>;
	exec: ReturnType<typeof vi.fn>;
	shell: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
	connect: vi.fn(),
	connections: [] as FakeConnection[],
	execAsync: vi.fn(),
	findServerById: vi.fn(),
	getHostSystemStats: vi.fn(),
	validateRequest: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	docker: { listContainers: vi.fn(async () => []) },
	execAsync: mocks.execAsync,
	findDeploymentById: vi.fn(),
	findServerById: mocks.findServerById,
	getAccessibleServerIds: vi.fn(async () => new Set()),
	getHostSystemStats: mocks.getHostSystemStats,
	getLastAdvancedStatsFile: vi.fn(async () => ({})),
	recordAdvancedStats: vi.fn(async () => {}),
	resolveTrustedOriginsForAuthRequest: vi.fn(async () => []),
	validateRequest: mocks.validateRequest,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: mocks.validateRequest,
}));

vi.mock("@dokploy/server/services/deployment-log-access", () => ({
	checkDeploymentLogOwnerAccess: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(),
}));

vi.mock("@dokploy/server/utils/deployments/log-server", () => ({
	getDeploymentLogServerId: vi.fn(),
}));

vi.mock("@dokploy/server/utils/docker/utils", () => ({
	encodeBase64: vi.fn(),
}));

vi.mock("@dokploy/server/utils/servers/destination", () => ({
	resolveServerDestinationHost: vi.fn(async () => "203.0.113.10"),
}));

vi.mock("@dokploy/server/wss/utils", () => ({
	readValidDeploymentLogPath: vi.fn(() => true),
}));

vi.mock("@trpc/server/adapters/ws", () => ({
	applyWSSHandler: vi.fn(),
}));

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

vi.mock("../../server/api/root", () => ({ appRouter: {} }));
vi.mock("../../server/api/trpc", () => ({ createTRPCContext: vi.fn() }));

vi.mock("../../server/api/utils/monitoring-access", () => ({
	assertContainerMetricsServiceAccess: vi.fn(async () => {}),
}));

vi.mock("../../server/utils/docker", () => ({
	getDockerHost: vi.fn(async () => "172.17.0.1"),
}));

vi.mock("../../server/wss/authorize", () => ({
	canAccessDockerOverWss: vi.fn(async () => true),
	canAccessTerminalOverWss: vi.fn(async () => true),
	isServiceContainerName: vi.fn(() => true),
}));

vi.mock("../../server/wss/container-ownership", () => ({
	containerBelongsToService: vi.fn(async () => true),
	findServiceAppName: vi.fn(async () => null),
}));

vi.mock("../../server/wss/docker-permission", () => ({
	canAccessDockerLogsWebSocket: vi.fn(async () => true),
	canAccessDockerTerminalWebSocket: vi.fn(async () => true),
}));

vi.mock("../../server/wss/server-permission", () => ({
	canAccessMonitoringWebSocket: vi.fn(async () => true),
	canAccessServerTerminalWebSocket: vi.fn(async () => true),
}));

vi.mock("ssh2", async () => {
	const { EventEmitter } = await import("node:events");
	class Client extends EventEmitter {
		end = vi.fn();
		exec = vi.fn();
		shell = vi.fn();
		constructor() {
			super();
			mocks.connections.push(this as unknown as FakeConnection);
		}
		connect(config: unknown) {
			mocks.connect(config);
			return this;
		}
	}
	return { Client };
});

const { setupDockerContainerLogsWebSocketServer } = await import(
	"../../server/wss/docker-container-logs"
);
const { setupDockerContainerTerminalWebSocketServer } = await import(
	"../../server/wss/docker-container-terminal"
);
const { setupDockerStatsMonitoringSocketServer } = await import(
	"../../server/wss/docker-stats"
);
const { setupDrawerLogsWebSocketServer } = await import(
	"../../server/wss/drawer-logs"
);
const { setupDeploymentLogsWebSocketServer } = await import(
	"../../server/wss/listen-deployment"
);
const { setupTerminalWebSocketServer } = await import(
	"../../server/wss/terminal"
);

const AUTH = {
	user: { id: "user-1", role: "owner" },
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

const CONNECTION_FAILED =
	"The panel could not open this connection. Check the panel logs.";

const TERMINAL = "/terminal?serverId=server-1";
const CONTAINER_TERMINAL =
	"/docker-container-terminal?containerId=abcdef123456&serverId=server-1";
const CONTAINER_LOGS =
	"/docker-container-logs?containerId=abcdef123456&serverId=server-1";

// Each path with what its client can read: the stats and tRPC clients parse
// every message as JSON, so plain text would only throw there.
const SOCKETS = [
	[TERMINAL, "text"],
	[CONTAINER_TERMINAL, "text"],
	[CONTAINER_LOGS, "text"],
	["/listen-deployment?deploymentId=deployment-1", "text"],
	["/listen-docker-stats-monitoring?appName=web", "json"],
	["/drawer-logs", "json"],
] as const;

const never = () => new Promise<never>(() => {});

type Seen = {
	messages: string[];
	closed: Promise<{ code: number; reason: string }>;
};

describe("websocket handler failures", () => {
	let server: http.Server;
	let port: number;
	const processErrors: unknown[] = [];
	const recordProcessError = (error: unknown) => {
		processErrors.push(error);
	};
	// server.close() waits for upgraded sockets, including ones a failing test left open.
	const clients: { destroy: () => void }[] = [];

	const open = (path: string): Seen => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
		clients.push({ destroy: () => ws.terminate() });
		const messages: string[] = [];
		ws.on("message", (data) => messages.push(data.toString()));
		const closed = new Promise<{ code: number; reason: string }>((resolve) => {
			ws.once("close", (code, reason) =>
				resolve({ code, reason: reason.toString() }),
			);
		});
		return { messages, closed };
	};

	// Sends the handshake over plain TCP, so nothing cleans the input up first.
	const rawUpgrade = (path: string, host: string) => {
		const socket = net.connect(port, "127.0.0.1");
		clients.push(socket);
		socket.on("error", () => {});
		const closed = new Promise<void>((resolve) => {
			socket.once("close", () => resolve());
		});
		const upgraded = new Promise<void>((resolve) => {
			socket.on("data", (data) => {
				if (data.toString("latin1").startsWith("HTTP/1.1 101")) resolve();
			});
		});
		socket.write(
			[
				`GET ${path} HTTP/1.1`,
				`Host: ${host}`,
				"Connection: Upgrade",
				"Upgrade: websocket",
				"Sec-WebSocket-Version: 13",
				"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
				"",
				"",
			].join("\r\n"),
		);
		return { socket, closed, upgraded };
	};

	const connection = async () => {
		await vi.waitFor(() => expect(mocks.connections).toHaveLength(1));
		return mocks.connections[0] as FakeConnection;
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.connections.length = 0;
		mocks.connect.mockImplementation(() => {});
		mocks.findServerById.mockResolvedValue(SERVER);
		mocks.validateRequest.mockResolvedValue(AUTH);
		processErrors.length = 0;
		process.on("unhandledRejection", recordProcessError);
		process.on("uncaughtException", recordProcessError);

		server = http.createServer();
		setupDrawerLogsWebSocketServer(server);
		setupDeploymentLogsWebSocketServer(server);
		setupDockerContainerLogsWebSocketServer(server);
		setupDockerContainerTerminalWebSocketServer(server);
		setupTerminalWebSocketServer(server);
		setupDockerStatsMonitoringSocketServer(server);
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => resolve());
		});
		port = (server.address() as AddressInfo).port;
	});

	afterEach(async () => {
		for (const client of clients.splice(0)) {
			client.destroy();
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
		// A rejection is reported on the next turn of the event loop.
		await new Promise((resolve) => setImmediate(resolve));
		process.off("unhandledRejection", recordProcessError);
		process.off("uncaughtException", recordProcessError);
		vi.restoreAllMocks();
		expect(processErrors).toEqual([]);
	});

	describe.each(SOCKETS)("%s", (path, client) => {
		it("tells the client and closes when the session check fails", async () => {
			mocks.validateRequest.mockRejectedValue(
				new Error("connect ECONNREFUSED 172.18.0.2:5432"),
			);

			const { messages, closed } = open(path);

			await expect(closed).resolves.toEqual({
				code: 1011,
				reason: CONNECTION_FAILED,
			});
			expect(messages).toEqual(
				client === "text" ? [`${CONNECTION_FAILED}\n`] : [],
			);
		});

		it("drops an upgrade whose Host cannot be parsed", async () => {
			const { closed } = rawUpgrade(path, "a b");

			await closed;
		});

		it("drops an upgrade whose target cannot be parsed", async () => {
			const { closed } = rawUpgrade("//", `127.0.0.1:${port}`);

			await closed;
		});

		it("survives a malformed frame while the checks are still running", async () => {
			mocks.validateRequest.mockReturnValue(never());
			const { socket, closed, upgraded } = rawUpgrade(
				path,
				`127.0.0.1:${port}`,
			);
			await upgraded;

			// Masked frame with a reserved opcode.
			socket.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]));

			await closed;
		});
	});

	describe("server terminal", () => {
		it("explains a server without an SSH key and closes", async () => {
			mocks.findServerById.mockResolvedValue({ ...SERVER, sshKeyId: null });

			const { messages, closed } = open(TERMINAL);

			await closed;
			expect(messages).toEqual(["No SSH key available for this server\n"]);
		});

		it("closes when the server lookup fails", async () => {
			mocks.findServerById.mockRejectedValue(new Error("Server not found"));

			const { messages, closed } = open(TERMINAL);

			await expect(closed).resolves.toMatchObject({ code: 1011 });
			expect(messages).toEqual([`${CONNECTION_FAILED}\n`]);
		});

		it("closes when SSH rejects the key before connecting", async () => {
			mocks.connect.mockImplementation(() => {
				throw new Error("Cannot parse privateKey: Unsupported key format");
			});

			const { messages, closed } = open(TERMINAL);

			await expect(closed).resolves.toMatchObject({ code: 1011 });
			expect(messages).toContain(`${CONNECTION_FAILED}\n`);
		});

		it("shows the SSH error and closes", async () => {
			const { messages, closed } = open(TERMINAL);
			const conn = await connection();
			await vi.waitFor(() => expect(messages).toContain("Connecting...\n"));

			conn.emit("error", new Error("connect ETIMEDOUT"));

			await closed;
			expect(messages.at(-1)).toContain("connect ETIMEDOUT");
			expect(conn.end).toHaveBeenCalled();
		});

		it("shows a refused shell, closes and ends the connection", async () => {
			const { messages, closed } = open(TERMINAL);
			const conn = await connection();
			await vi.waitFor(() => expect(messages).toContain("Connecting...\n"));
			conn.emit("ready");
			expect(conn.shell).toHaveBeenCalledTimes(1);

			// ssh2 calls this from inside its own socket callback.
			conn.shell.mock.calls[0]?.[1](new Error("Channel open failure"));

			await closed;
			expect(messages.at(-1)).toContain("Channel open failure");
			expect(conn.end).toHaveBeenCalled();
		});
	});

	describe("container terminal", () => {
		it("shows a failed server lookup and closes", async () => {
			mocks.findServerById.mockRejectedValue(new Error("Server not found"));

			const { messages, closed } = open(CONTAINER_TERMINAL);

			await closed;
			expect(messages).toEqual(["Server not found"]);
		});

		it("explains a server without an SSH key and closes", async () => {
			mocks.findServerById.mockResolvedValue({ ...SERVER, sshKeyId: null });

			const { messages, closed } = open(CONTAINER_TERMINAL);

			await closed;
			expect(messages).toEqual(["No SSH key available for this server"]);
		});
	});

	describe("container logs", () => {
		it("shows a failed server lookup and closes", async () => {
			mocks.findServerById.mockRejectedValue(new Error("Server not found"));

			const { messages, closed } = open(CONTAINER_LOGS);

			await closed;
			expect(messages).toEqual(["Server not found"]);
		});

		it("explains a server without an SSH key and closes", async () => {
			mocks.findServerById.mockResolvedValue({ ...SERVER, sshKeyId: null });

			const { messages, closed } = open(CONTAINER_LOGS);

			await closed;
			expect(messages).toEqual(["No SSH key available for this server"]);
		});
	});

	describe("container stats", () => {
		it("closes with a shortened reason when the error is too long for one", async () => {
			mocks.getHostSystemStats.mockRejectedValue(new Error("x".repeat(500)));

			const { closed } = open(
				"/listen-docker-stats-monitoring?appName=dokploy",
			);

			const { code, reason } = await closed;
			expect(code).toBe(4000);
			expect(reason).toBe(`Error: ${"x".repeat(116)}`);
		}, 5000);
	});
});

describe("websocket server sources", () => {
	const dir = path.resolve(__dirname, "../../server/wss");
	const sources = readdirSync(dir)
		.filter((file) => file.endsWith(".ts") && file !== "connection.ts")
		.map((file) => [file, readFileSync(path.join(dir, file), "utf8")] as const);

	it.each(sources)("%s goes through the guarded helpers", (_file, source) => {
		expect(source).not.toMatch(/\.on\(\s*"connection"/);
		for (const [, firstLine] of source.matchAll(
			/\.on\("upgrade",[^\n]*\n([^\n]*)/g,
		)) {
			expect(firstLine).toContain("readUpgradePathname");
		}
	});
});

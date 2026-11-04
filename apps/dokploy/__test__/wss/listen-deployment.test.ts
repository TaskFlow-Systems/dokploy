import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

class FakeChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killed = false;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	signals: string[] = [];
	// Mirrors ChildProcess: `killed` flips as soon as a signal is delivered,
	// even if the process ignores it and keeps running.
	ignoreSigterm = false;

	kill(signal: NodeJS.Signals = "SIGTERM") {
		this.signals.push(signal);
		this.killed = true;
		if (signal === "SIGTERM" && this.ignoreSigterm) return true;
		this.signalCode = signal;
		this.emit("close", null, signal);
		return true;
	}
}

const children = vi.hoisted(() => [] as FakeChild[]);
const nextChild = vi.hoisted(() => ({ ignoreSigterm: false }));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: vi.fn(() => {
		const child = new FakeChild();
		child.ignoreSigterm = nextChild.ignoreSigterm;
		children.push(child);
		return child;
	}),
}));

const sshClients = vi.hoisted(
	() => [] as { connect: ReturnType<typeof vi.fn> }[],
);
vi.mock("ssh2", () => ({
	Client: vi.fn(function (this: Record<string, unknown>) {
		this.on = vi.fn(() => this);
		this.connect = vi.fn(() => this);
		this.end = vi.fn();
		sshClients.push(this as never);
	}),
}));

const mockValidateRequest = vi.hoisted(() => vi.fn());
const mockFindServerById = vi.hoisted(() => vi.fn());
const mockFindDeploymentById = vi.hoisted(() => vi.fn());
const mockCheckServicePermissionAndAccess = vi.hoisted(() => vi.fn());
const mockResolveServerDestinationHost = vi.hoisted(() => vi.fn());
// NOTE: full mocks (no importOriginal) — importing the real server barrel
// OOMs the websocket test worker.
vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	validateRequest: mockValidateRequest,
	findServerById: mockFindServerById,
	findDeploymentById: mockFindDeploymentById,
}));
vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
	checkServicePermissionAndAccess: mockCheckServicePermissionAndAccess,
}));
vi.mock("@dokploy/server/utils/servers/destination", () => ({
	resolveServerDestinationHost: mockResolveServerDestinationHost,
}));
vi.mock("@dokploy/server/wss/utils", () => ({
	readValidDirectory: () => true,
	readValidDeploymentLogPath: () => true,
}));

import { setupDeploymentLogsWebSocketServer } from "@/server/wss/listen-deployment";

const AUTH = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

const flush = () => new Promise((r) => setTimeout(r, 50));

let server: http.Server;
let url: string;

beforeEach(async () => {
	children.length = 0;
	sshClients.length = 0;
	nextChild.ignoreSigterm = false;
	vi.clearAllMocks();
	mockFindDeploymentById.mockResolvedValue({
		deploymentId: "dep-1",
		logPath: "/etc/dokploy/logs/app/deploy.log",
		applicationId: "app-1",
		composeId: null,
		scheduleId: null,
		volumeBackupId: null,
		serverId: null,
		buildServerId: null,
		backup: null,
		volumeBackup: null,
		schedule: null,
	});
	mockCheckServicePermissionAndAccess.mockResolvedValue(undefined);
	mockResolveServerDestinationHost.mockResolvedValue("10.0.0.1");
	server = http.createServer();
	setupDeploymentLogsWebSocketServer(server);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	url = `ws://127.0.0.1:${port}/listen-deployment?deploymentId=dep-1&logPath=/etc/dokploy/logs/app/deploy.log`;
});

afterEach(async () => {
	vi.useRealTimers();
	await new Promise((r) => server.close(r));
});

const connect = async (query = "") => {
	const ws = new WebSocket(`${url}${query}`);
	await new Promise((r) => ws.once("open", r));
	return ws;
};

const closeClient = async (ws: WebSocket) => {
	ws.close();
	await new Promise((r) => ws.once("close", r));
	await flush();
};

describe("deployment logs websocket (#5518)", () => {
	it("kills tail when the client disconnects", async () => {
		mockValidateRequest.mockResolvedValue(AUTH);
		const ws = await connect();
		await flush();
		expect(children).toHaveLength(1);

		await closeClient(ws);
		expect(children[0]!.signals).toContain("SIGTERM");
	});

	it("does not spawn tail when the client disconnects during auth", async () => {
		const auth = deferred<typeof AUTH>();
		mockValidateRequest.mockReturnValue(auth.promise);
		const ws = await connect();

		await closeClient(ws);
		auth.resolve(AUTH);
		await flush();

		const leaked = children.filter(
			(c) => c.exitCode === null && c.signalCode === null,
		);
		expect(leaked).toHaveLength(0);
	});

	it("does not open an SSH session when the client disconnects while loading the server", async () => {
		mockValidateRequest.mockResolvedValue(AUTH);
		const serverLookup = deferred<unknown>();
		mockFindServerById.mockReturnValue(serverLookup.promise);
		const ws = await connect("&serverId=srv-1");

		await closeClient(ws);
		serverLookup.resolve({
			organizationId: "org-1",
			sshKeyId: "key-1",
			sshKey: { privateKey: "key" },
			ipAddress: "10.0.0.1",
			port: 22,
			username: "root",
		});
		await flush();

		const connected = sshClients.filter((c) => c.connect.mock.calls.length > 0);
		expect(connected).toHaveLength(0);
	});

	it("does not spawn tail when the client disconnects while loading the deployment", async () => {
		mockValidateRequest.mockResolvedValue(AUTH);
		const deployment = await mockFindDeploymentById();
		const lookup = deferred<unknown>();
		mockFindDeploymentById.mockReturnValue(lookup.promise);
		const ws = await connect();
		await vi.waitFor(() => expect(mockFindDeploymentById).toHaveBeenCalled());

		await closeClient(ws);
		lookup.resolve(deployment);
		await flush();

		expect(children).toHaveLength(0);
	});

	it("does not spawn tail when the client disconnects during the access check", async () => {
		mockValidateRequest.mockResolvedValue(AUTH);
		const access = deferred<undefined>();
		mockCheckServicePermissionAndAccess.mockReturnValue(access.promise);
		const ws = await connect();
		await vi.waitFor(() =>
			expect(mockCheckServicePermissionAndAccess).toHaveBeenCalled(),
		);

		await closeClient(ws);
		access.resolve(undefined);
		await flush();

		expect(children).toHaveLength(0);
	});

	it("does not open an SSH session when the client disconnects while resolving the address", async () => {
		mockValidateRequest.mockResolvedValue(AUTH);
		mockFindDeploymentById.mockResolvedValue({
			...(await mockFindDeploymentById()),
			buildServerId: "srv-1",
		});
		mockFindServerById.mockResolvedValue({
			organizationId: "org-1",
			sshKeyId: "key-1",
			sshKey: { privateKey: "key" },
			ipAddress: "10.0.0.1",
			port: 22,
			username: "root",
		});
		const address = deferred<string>();
		mockResolveServerDestinationHost.mockReturnValue(address.promise);
		const ws = await connect();
		await vi.waitFor(() =>
			expect(mockResolveServerDestinationHost).toHaveBeenCalled(),
		);

		await closeClient(ws);
		address.resolve("10.0.0.1");
		await flush();

		expect(sshClients).toHaveLength(0);
	});

	it("force-kills tail with SIGKILL when SIGTERM does not stop it", async () => {
		nextChild.ignoreSigterm = true;
		mockValidateRequest.mockResolvedValue(AUTH);
		const ws = await connect();
		await flush();

		await closeClient(ws);
		await new Promise((r) => setTimeout(r, 1100));
		expect(children[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
	});
});

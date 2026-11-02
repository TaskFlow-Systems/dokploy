import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const BASE = "/base";
const SERVER_LOG_LINE = "line from the log on the server";

const mocks = vi.hoisted(() => ({
	checkPermission: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	findDeploymentById: vi.fn(),
	findServerById: vi.fn(),
	spawn: vi.fn(),
	hasValidLicense: vi.fn(),
	memberFindFirst: vi.fn(),
	serverFindMany: vi.fn(),
	sshConnect: vi.fn(),
	sshExec: vi.fn(),
	validateRequest: vi.fn(),
}));

// The real getAccessibleServerIds over a fake database, so that roles and the
// license decide here exactly as they decide for deployment.readLogs.
vi.mock("@dokploy/server", async () => {
	const { getAccessibleServerIds } = await vi.importActual<
		typeof import("@dokploy/server/services/server")
	>("@dokploy/server/services/server");
	return {
		IS_CLOUD: false,
		findDeploymentById: mocks.findDeploymentById,
		findServerById: mocks.findServerById,
		getAccessibleServerIds,
		validateRequest: mocks.validateRequest,
	};
});

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			member: { findFirst: mocks.memberFindFirst },
			server: { findMany: mocks.serverFindMany },
		},
	},
}));

vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: mocks.hasValidLicense,
}));

vi.mock("@dokploy/server/constants", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/constants")>();
	return {
		...actual,
		paths: () => ({
			...actual.paths(),
			BASE_PATH: BASE,
			LOGS_PATH: `${BASE}/logs`,
			APPLICATIONS_PATH: `${BASE}/applications`,
			SCHEDULES_PATH: `${BASE}/schedules`,
			VOLUME_BACKUPS_PATH: `${BASE}/volume-backups`,
		}),
	};
});

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: mocks.checkPermission,
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: mocks.spawn,
	};
});

vi.mock("ssh2", () => ({
	Client: class {
		private handlers: Record<string, () => void> = {};

		on(event: string, handler: () => void) {
			this.handlers[event] = handler;
			return this;
		}

		connect(options: unknown) {
			mocks.sshConnect(options);
			this.handlers.ready?.();
			return this;
		}

		exec(
			command: string,
			callback: (error: undefined, stream: EventEmitter) => void,
		) {
			mocks.sshExec(command);
			const stream = Object.assign(new EventEmitter(), {
				stderr: new EventEmitter(),
			});
			callback(undefined, stream);
			setTimeout(() => {
				stream.emit("data", SERVER_LOG_LINE);
				stream.emit("close");
			}, 0);
		}

		end() {}
	},
}));

const { setupDeploymentLogsWebSocketServer } = await import(
	"../../server/wss/listen-deployment"
);

const listen = async (server: http.Server) =>
	new Promise<number>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve((server.address() as AddressInfo).port);
		});
	});

const closeServer = async (server: http.Server) =>
	new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});

const openAndWaitForClose = async (port: number, path: string) =>
	new Promise<{ code: number; reason: string }>((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error("WebSocket close timeout"));
		}, 2000);
		const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);

		ws.on("close", (code, reason) => {
			clearTimeout(timeout);
			resolve({ code, reason: reason.toString() });
		});
		ws.on("error", reject);
	});

const createTailProcess = () => {
	const tailProcess = {
		killed: false,
		kill: vi.fn(),
		on: vi.fn((event: string, callback: () => void) => {
			if (event === "close") {
				setTimeout(callback, 0);
			}
			return tailProcess;
		}),
		stderr: new EventEmitter(),
		stdout: new EventEmitter(),
	};
	return tailProcess;
};

describe("deployment log WebSocket boundary", () => {
	let server: http.Server | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.validateRequest.mockResolvedValue({
			user: { id: "user-1" },
			session: { activeOrganizationId: "org-1" },
		});
		mocks.checkPermission.mockResolvedValue(undefined);
		mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
		mocks.findDeploymentById.mockResolvedValue({
			applicationId: "app-1",
			composeId: null,
			deploymentId: "deployment-1",
			logPath: `${BASE}/logs/app/app-2026-06-22.log`,
			scheduleId: null,
			schedule: null,
			serverId: null,
			volumeBackupId: null,
		});
		mocks.spawn.mockReturnValue(createTailProcess());
		mocks.hasValidLicense.mockResolvedValue(true);
		mocks.memberFindFirst.mockResolvedValue({
			accessedServers: [],
			role: "owner",
		});
		mocks.serverFindMany.mockResolvedValue([
			{ serverId: "server-1" },
			{ serverId: "server-2" },
		]);
	});

	afterEach(async () => {
		if (server?.listening) {
			await closeServer(server);
		}
		server = undefined;
	});

	it("rejects caller-supplied log paths without a deployment id", async () => {
		server = http.createServer();
		setupDeploymentLogsWebSocketServer(server);
		const port = await listen(server);

		await expect(
			openAndWaitForClose(
				port,
				`/listen-deployment?logPath=${encodeURIComponent(`${BASE}/logs/app/app-2026-06-22.log`)}`,
			),
		).resolves.toEqual({ code: 4000, reason: "deploymentId required" });

		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("requires deployment read access before tailing a deployment log", async () => {
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new Error("Permission denied"),
		);

		server = http.createServer();
		setupDeploymentLogsWebSocketServer(server);
		const port = await listen(server);

		await expect(
			openAndWaitForClose(
				port,
				`/listen-deployment?deploymentId=deployment-1&logPath=${encodeURIComponent(`${BASE}/logs/app/app-2026-06-22.log`)}`,
			),
		).resolves.toEqual({ code: 1005, reason: "" });

		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			{
				user: { id: "user-1" },
				session: { activeOrganizationId: "org-1" },
			},
			"app-1",
			{ deployment: ["read"] },
		);
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("tails the authorized deployment record log path instead of caller logPath", async () => {
		server = http.createServer();
		setupDeploymentLogsWebSocketServer(server);
		const port = await listen(server);

		await expect(
			openAndWaitForClose(
				port,
				`/listen-deployment?deploymentId=deployment-1&logPath=${encodeURIComponent(`${BASE}/applications/app/code/.env`)}`,
			),
		).resolves.toEqual({ code: 1005, reason: "" });

		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			{
				user: { id: "user-1" },
				session: { activeOrganizationId: "org-1" },
			},
			"app-1",
			{ deployment: ["read"] },
		);
		expect(mocks.spawn).toHaveBeenCalledWith("tail", [
			"-n",
			"+1",
			"-f",
			`${BASE}/logs/app/app-2026-06-22.log`,
		]);
	});

	it("ignores caller-supplied server ids for deployment rows without server binding", async () => {
		server = http.createServer();
		setupDeploymentLogsWebSocketServer(server);
		const port = await listen(server);

		await expect(
			openAndWaitForClose(
				port,
				`/listen-deployment?deploymentId=deployment-1&serverId=foreign-server&logPath=${encodeURIComponent(`${BASE}/applications/app/code/.env`)}`,
			),
		).resolves.toEqual({ code: 1005, reason: "" });

		expect(mocks.findServerById).not.toHaveBeenCalled();
		expect(mocks.spawn).toHaveBeenCalledWith("tail", [
			"-n",
			"+1",
			"-f",
			`${BASE}/logs/app/app-2026-06-22.log`,
		]);
	});

	describe("log bound to a server", () => {
		const serverSetupDeployment = {
			deploymentId: "deployment-1",
			logPath: `${BASE}/logs/server-1/server-1-2026-06-22.log`,
			schedule: null,
			scheduleId: null,
			serverId: "server-1",
		};
		const serverScheduleDeployment = {
			deploymentId: "deployment-1",
			logPath: `${BASE}/schedules/host/host-2026-06-22.log`,
			schedule: { scheduleType: "server", serverId: "server-1" },
			scheduleId: "schedule-1",
			serverId: null,
		};

		const readDeploymentLog = async (
			query = "deploymentId=deployment-1",
		): Promise<string[]> => {
			server = http.createServer();
			setupDeploymentLogsWebSocketServer(server);
			const port = await listen(server);

			return new Promise((resolve, reject) => {
				const received: string[] = [];
				const timeout = setTimeout(() => {
					reject(new Error("WebSocket close timeout"));
				}, 2000);
				const ws = new WebSocket(
					`ws://127.0.0.1:${port}/listen-deployment?${query}`,
				);

				ws.on("message", (data) => {
					received.push(data.toString());
				});
				ws.on("close", () => {
					clearTimeout(timeout);
					resolve(received);
				});
				ws.on("error", reject);
			});
		};

		const expectLogNotOpened = () => {
			expect(mocks.sshConnect).not.toHaveBeenCalled();
			expect(mocks.spawn).not.toHaveBeenCalled();
		};

		// Who may open the log does not depend on where it is read from.
		const expectLogOpened = () => {
			expect(
				mocks.sshConnect.mock.calls.length + mocks.spawn.mock.calls.length,
			).toBe(1);
		};

		beforeEach(() => {
			mocks.findServerById.mockResolvedValue({
				ipAddress: "203.0.113.10",
				organizationId: "org-1",
				port: 2222,
				sshKey: { privateKey: "private-key" },
				sshKeyId: "key-1",
				username: "deployer",
			});
		});

		describe.each([
			{ binding: "deployment.serverId", deployment: serverSetupDeployment },
			{ binding: "schedule.serverId", deployment: serverScheduleDeployment },
		])("through $binding", ({ deployment }) => {
			beforeEach(() => {
				mocks.findDeploymentById.mockResolvedValue(deployment);
			});

			it("refuses a member who is not assigned to the server", async () => {
				mocks.memberFindFirst.mockResolvedValue({
					accessedServers: ["server-2"],
					role: "member",
				});

				await expect(readDeploymentLog()).resolves.toEqual([]);

				expectLogNotOpened();
			});

			it("opens the log for a member assigned to the server", async () => {
				mocks.memberFindFirst.mockResolvedValue({
					accessedServers: ["server-1"],
					role: "member",
				});

				await readDeploymentLog();

				expectLogOpened();
			});

			it.each(["owner", "admin"])(
				"opens the log for an %s with no assigned servers",
				async (role) => {
					mocks.memberFindFirst.mockResolvedValue({
						accessedServers: [],
						role,
					});

					await readDeploymentLog();

					expectLogOpened();
				},
			);

			it("does not require an assignment without a valid license", async () => {
				mocks.hasValidLicense.mockResolvedValue(false);
				mocks.memberFindFirst.mockResolvedValue({
					accessedServers: [],
					role: "member",
				});

				await readDeploymentLog();

				expectLogOpened();
			});

			it("refuses an owner when the server is in another organization", async () => {
				mocks.serverFindMany.mockResolvedValue([{ serverId: "server-2" }]);
				mocks.findServerById.mockResolvedValue({
					organizationId: "org-2",
					sshKeyId: "key-1",
				});

				await expect(readDeploymentLog()).resolves.toEqual([]);

				expectLogNotOpened();
			});

			it("refuses an assigned member without deployment read permission", async () => {
				mocks.checkPermission.mockRejectedValue(new Error("Permission denied"));
				mocks.memberFindFirst.mockResolvedValue({
					accessedServers: ["server-1"],
					role: "member",
				});

				await expect(readDeploymentLog()).resolves.toEqual([]);

				expect(mocks.checkPermission).toHaveBeenCalledWith(
					{
						user: { id: "user-1" },
						session: { activeOrganizationId: "org-1" },
					},
					{ deployment: ["read"] },
				);
				expectLogNotOpened();
			});
		});

		it("reads the log over SSH from the server of the deployment", async () => {
			mocks.findDeploymentById.mockResolvedValue(serverScheduleDeployment);
			mocks.memberFindFirst.mockResolvedValue({
				accessedServers: ["server-1"],
				role: "member",
			});

			await expect(
				readDeploymentLog("deploymentId=deployment-1&serverId=server-2"),
			).resolves.toEqual([SERVER_LOG_LINE]);

			expect(mocks.findServerById.mock.calls).toEqual([["server-1"]]);
			expect(mocks.sshConnect).toHaveBeenCalledWith(
				expect.objectContaining({
					host: "203.0.113.10",
					port: 2222,
					privateKey: "private-key",
					username: "deployer",
				}),
			);
			const encodedLogPath = Buffer.from(
				serverScheduleDeployment.logPath,
			).toString("base64");
			expect(mocks.sshExec).toHaveBeenCalledWith(
				`tail -n +1 -f "$(echo '${encodedLogPath}' | base64 -d)"`,
			);
			expect(mocks.spawn).not.toHaveBeenCalled();
		});

		it("does not let the server named in the request stand in for the server of the deployment", async () => {
			mocks.findDeploymentById.mockResolvedValue(serverScheduleDeployment);
			mocks.memberFindFirst.mockResolvedValue({
				accessedServers: ["server-2"],
				role: "member",
			});

			await expect(
				readDeploymentLog("deploymentId=deployment-1&serverId=server-2"),
			).resolves.toEqual([]);

			expectLogNotOpened();
		});
	});

	it("tails authorized schedule deployment logs from the schedules root", async () => {
		mocks.findDeploymentById.mockResolvedValue({
			applicationId: null,
			composeId: null,
			deploymentId: "schedule-deployment-1",
			logPath: `${BASE}/schedules/schedule-app/schedule-app-2026-06-22.log`,
			scheduleId: "schedule-1",
			schedule: {
				applicationId: "app-1",
				serverId: null,
			},
			serverId: null,
			volumeBackupId: null,
		});

		server = http.createServer();
		setupDeploymentLogsWebSocketServer(server);
		const port = await listen(server);

		await expect(
			openAndWaitForClose(
				port,
				`/listen-deployment?deploymentId=schedule-deployment-1&logPath=${encodeURIComponent(`${BASE}/applications/app/code/.env`)}`,
			),
		).resolves.toEqual({ code: 1005, reason: "" });

		expect(mocks.spawn).toHaveBeenCalledWith("tail", [
			"-n",
			"+1",
			"-f",
			`${BASE}/schedules/schedule-app/schedule-app-2026-06-22.log`,
		]);
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			{
				user: { id: "user-1" },
				session: { activeOrganizationId: "org-1" },
			},
			"app-1",
			{ deployment: ["read"] },
		);
	});

	it("tails authorized volume backup deployment logs from the volume backups root", async () => {
		mocks.findDeploymentById.mockResolvedValue({
			applicationId: null,
			composeId: null,
			deploymentId: "volume-backup-deployment-1",
			logPath: `${BASE}/volume-backups/volume-app/volume-app-2026-06-22.log`,
			scheduleId: null,
			schedule: null,
			serverId: null,
			volumeBackupId: "volume-backup-1",
			volumeBackup: {
				applicationId: "app-1",
			},
		});

		server = http.createServer();
		setupDeploymentLogsWebSocketServer(server);
		const port = await listen(server);

		await expect(
			openAndWaitForClose(
				port,
				`/listen-deployment?deploymentId=volume-backup-deployment-1&logPath=${encodeURIComponent(`${BASE}/applications/app/code/.env`)}`,
			),
		).resolves.toEqual({ code: 1005, reason: "" });

		expect(mocks.spawn).toHaveBeenCalledWith("tail", [
			"-n",
			"+1",
			"-f",
			`${BASE}/volume-backups/volume-app/volume-app-2026-06-22.log`,
		]);
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			{
				user: { id: "user-1" },
				session: { activeOrganizationId: "org-1" },
			},
			"app-1",
			{ deployment: ["read"] },
		);
	});

	it("uses volume backup service server binding instead of caller-supplied server ids", async () => {
		mocks.findDeploymentById.mockResolvedValue({
			applicationId: null,
			composeId: null,
			deploymentId: "volume-backup-deployment-1",
			logPath: `${BASE}/volume-backups/volume-app/volume-app-2026-06-22.log`,
			scheduleId: null,
			schedule: null,
			serverId: null,
			volumeBackupId: "volume-backup-1",
			volumeBackup: {
				applicationId: "app-1",
				application: {
					serverId: "allowed-server",
				},
			},
		});
		mocks.findServerById.mockResolvedValue({
			organizationId: "org-1",
			sshKeyId: null,
		});

		server = http.createServer();
		setupDeploymentLogsWebSocketServer(server);
		const port = await listen(server);

		await expect(
			openAndWaitForClose(
				port,
				`/listen-deployment?deploymentId=volume-backup-deployment-1&serverId=foreign-server&logPath=${encodeURIComponent(`${BASE}/applications/app/code/.env`)}`,
			),
		).resolves.toEqual({ code: 1005, reason: "" });

		expect(mocks.findServerById).toHaveBeenCalledWith("allowed-server");
		expect(mocks.findServerById).not.toHaveBeenCalledWith("foreign-server");
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
});

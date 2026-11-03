import { quoteShellArg } from "@dokploy/server/utils/filesystem/safe-path";
import { Param, type SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	deleteReturning: vi.fn(),
	deleteWhere: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	findApplication: vi.fn(),
	findDeployment: vi.fn(),
	findDeployments: vi.fn(),
	insertReturning: vi.fn(),
	removeDirectoryIfExistsContent: vi.fn(),
	removeRollbackById: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => {
	const deleteChain = {
		returning: mocks.deleteReturning,
		where: mocks.deleteWhere.mockImplementation(() => deleteChain),
	};
	const insertChain = {
		returning: mocks.insertReturning,
		values: vi.fn(() => insertChain),
	};
	return {
		db: {
			delete: vi.fn(() => deleteChain),
			insert: vi.fn(() => insertChain),
			query: {
				applications: { findFirst: mocks.findApplication },
				deployments: {
					findFirst: mocks.findDeployment,
					findMany: mocks.findDeployments,
				},
			},
		},
	};
});

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
	ExecError: class ExecError extends Error {},
}));

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: vi.fn(async (serverId: string) => ({ serverId })),
}));

vi.mock("@dokploy/server/services/rollbacks", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/rollbacks")
	>()),
	removeRollbackById: mocks.removeRollbackById,
}));

vi.mock(
	"@dokploy/server/utils/filesystem/directory",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@dokploy/server/utils/filesystem/directory")
		>()),
		removeDirectoryIfExistsContent: mocks.removeDirectoryIfExistsContent,
	}),
);

const {
	createDeployment,
	removeDeployment,
	removeDeployments,
	removeLastFiveDeployments,
} = await import("@dokploy/server/services/deployment");

const logPath = "/etc/dokploy/logs/app/app-1.log";
const cleanupOptions = { timeoutMs: expect.any(Number) };

const deletedDeploymentIds = () =>
	mocks.deleteWhere.mock.calls.map(
		([condition]) =>
			(condition as SQL).queryChunks.find(
				(chunk): chunk is Param => chunk instanceof Param,
			)?.value,
	);

const remoteRemovals = () =>
	mocks.execAsyncRemote.mock.calls
		.filter(([, command]) => command.startsWith("rm "))
		.map(([serverId, command]) => ({ serverId, command }));

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "error").mockImplementation(() => {});
	mocks.deleteReturning.mockResolvedValue([{ deploymentId: "deployment-1" }]);
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.findDeployments.mockResolvedValue([]);
	mocks.insertReturning.mockResolvedValue([{ deploymentId: "new" }]);
});

describe("removeDeployment", () => {
	it.each([
		{
			holder: "build server",
			row: { buildServerId: "log-server", application: { serverId: "other" } },
		},
		{ holder: "application", row: { application: { serverId: "log-server" } } },
		{ holder: "compose", row: { compose: { serverId: "log-server" } } },
		{
			holder: "preview application",
			row: { previewDeployment: { application: { serverId: "log-server" } } },
		},
		{
			holder: "backup database",
			row: { backup: { postgres: { serverId: "log-server" } } },
		},
		{
			holder: "volume backup application",
			row: { volumeBackup: { application: { serverId: "log-server" } } },
		},
		{ holder: "schedule", row: { schedule: { serverId: "log-server" } } },
	])("removes the log on the server of the $holder", async ({ row }) => {
		mocks.findDeployment.mockResolvedValue({
			deploymentId: "deployment-1",
			logPath,
			...row,
		});

		await removeDeployment("deployment-1");

		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"log-server",
			`rm -f ${logPath}`,
			undefined,
			cleanupOptions,
		);
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(deletedDeploymentIds()).toEqual(["deployment-1"]);
	});

	it("removes the log on the panel when the service runs there", async () => {
		mocks.findDeployment.mockResolvedValue({
			deploymentId: "deployment-1",
			logPath,
			application: { serverId: null },
		});

		await removeDeployment("deployment-1");

		expect(mocks.execAsync).toHaveBeenCalledWith(`rm -f ${logPath}`);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("removes a server setup log on the panel without connecting to that server", async () => {
		mocks.findDeployment.mockResolvedValue({
			deploymentId: "deployment-1",
			logPath,
			serverId: "set-up-server",
		});

		await removeDeployment("deployment-1");

		expect(mocks.execAsync).toHaveBeenCalledWith(`rm -f ${logPath}`);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("quotes the log path for the shell", async () => {
		const spacedPath = "/etc/dokploy/logs/app/app 1;touch x.log";
		mocks.findDeployment.mockResolvedValue({
			deploymentId: "deployment-1",
			logPath: spacedPath,
		});

		await removeDeployment("deployment-1");

		expect(mocks.execAsync).toHaveBeenCalledWith(
			`rm -f ${quoteShellArg(spacedPath)}`,
		);
	});

	it("runs no command for a failed deployment without a log", async () => {
		mocks.findDeployment.mockResolvedValue({
			deploymentId: "deployment-1",
			logPath: "",
			application: { serverId: "log-server" },
		});

		await removeDeployment("deployment-1");

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(deletedDeploymentIds()).toEqual(["deployment-1"]);
	});

	it("keeps the row when the server holding the log is out of reach", async () => {
		mocks.findDeployment.mockResolvedValue({
			deploymentId: "deployment-1",
			logPath,
			buildServerId: "log-server",
		});
		mocks.execAsyncRemote.mockRejectedValue(new Error("SSH connection error"));

		await expect(removeDeployment("deployment-1")).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "SSH connection error",
		});

		expect(mocks.deleteWhere).not.toHaveBeenCalled();
	});

	it("returns only the deleted row, not the relations it looked up", async () => {
		const row = { deploymentId: "deployment-1", logPath };
		mocks.findDeployment.mockResolvedValue({
			...row,
			compose: { serverId: null, env: "SECRET=value" },
		});
		mocks.deleteReturning.mockResolvedValue([row]);

		await expect(removeDeployment("deployment-1")).resolves.toBe(row);
	});
});

describe("removeDeployments", () => {
	const application = {
		applicationId: "app-1",
		appName: "app",
		serverId: "deploy-server",
		buildServerId: "build-server",
		deployments: [
			{ buildServerId: "build-server" },
			{ buildServerId: "old-build-server" },
			{ buildServerId: "old-build-server" },
			{ buildServerId: null },
		],
	};

	it("removes the folder once on every server that holds its logs", async () => {
		await removeDeployments(application as never);

		const removals = remoteRemovals();
		expect(removals.map(({ serverId }) => serverId).sort()).toEqual([
			"build-server",
			"deploy-server",
			"old-build-server",
		]);
		for (const { command } of removals) {
			expect(command).toMatch(/^rm -rf .*logs\/app$/);
		}
		expect(mocks.removeDirectoryIfExistsContent).not.toHaveBeenCalled();
	});

	it("also clears the panel folder when the application runs on the panel", async () => {
		await removeDeployments({
			...application,
			serverId: null,
			buildServerId: null,
			deployments: [{ buildServerId: "old-build-server" }],
		} as never);

		expect(remoteRemovals().map(({ serverId }) => serverId)).toEqual([
			"old-build-server",
		]);
		expect(mocks.removeDirectoryIfExistsContent).toHaveBeenCalledTimes(1);
		expect(mocks.removeDirectoryIfExistsContent).toHaveBeenCalledWith(
			expect.stringMatching(/logs\/app$/),
		);
	});

	it("touches only the application's server when it never had a build server", async () => {
		await removeDeployments({
			...application,
			buildServerId: null,
			deployments: [{ buildServerId: null }],
		} as never);

		expect(remoteRemovals().map(({ serverId }) => serverId)).toEqual([
			"deploy-server",
		]);
	});

	it("still cleans the other servers and the rows when one server is out of reach", async () => {
		mocks.execAsyncRemote.mockImplementation(async (serverId: string) => {
			if (serverId === "old-build-server") {
				throw new Error("SSH connection error");
			}
			return { stdout: "", stderr: "" };
		});

		await expect(
			removeDeployments(application as never),
		).resolves.toBeUndefined();

		expect(remoteRemovals()).toHaveLength(3);
		expect(deletedDeploymentIds()).toEqual(["app-1"]);
	});
});

describe("rotation of old deployments on a new deployment", () => {
	const row = (id: number, overrides: Record<string, unknown> = {}) => ({
		deploymentId: `d-${id}`,
		logPath: `/etc/dokploy/logs/app/${id}.log`,
		buildServerId: null,
		rollbackId: null,
		...overrides,
	});
	const newest = Array.from({ length: 10 }, (_, index) => row(index));

	const deployApplication = (overrides: Record<string, unknown> = {}) => {
		mocks.findApplication.mockResolvedValue({
			applicationId: "app-1",
			appName: "app",
			serverId: "deploy-server",
			buildServerId: null,
			...overrides,
		});
		return createDeployment({
			applicationId: "app-1",
			title: "Deployment",
			description: "",
		});
	};

	it("removes nothing while the application has ten deployments", async () => {
		mocks.findDeployments.mockResolvedValue(newest);

		await deployApplication();

		expect(remoteRemovals()).toEqual([]);
		expect(mocks.deleteWhere).not.toHaveBeenCalled();
	});

	it("opens one connection per server, on the server that holds each log", async () => {
		mocks.findDeployments.mockResolvedValue([
			...newest,
			row(10),
			row(11, { buildServerId: "old-build-server" }),
			row(12, { buildServerId: "old-build-server" }),
			row(13),
		]);

		await deployApplication();

		const removals = remoteRemovals().sort((a, b) =>
			a.serverId.localeCompare(b.serverId),
		);
		expect(removals).toEqual([
			{
				serverId: "deploy-server",
				command:
					"rm -f /etc/dokploy/logs/app/10.log /etc/dokploy/logs/app/13.log",
			},
			{
				serverId: "old-build-server",
				command:
					"rm -f /etc/dokploy/logs/app/11.log /etc/dokploy/logs/app/12.log",
			},
		]);
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.findDeployment).not.toHaveBeenCalled();
		expect(deletedDeploymentIds()).toEqual(["d-10", "d-11", "d-12", "d-13"]);
	});

	it("removes the logs of a panel application on the panel, in one command", async () => {
		mocks.findDeployments.mockResolvedValue([...newest, row(10), row(11)]);

		await deployApplication({ serverId: null });

		expect(mocks.execAsync).toHaveBeenCalledTimes(1);
		expect(mocks.execAsync).toHaveBeenCalledWith(
			"rm -f /etc/dokploy/logs/app/10.log /etc/dokploy/logs/app/11.log",
		);
		expect(remoteRemovals()).toEqual([]);
	});

	it("does not let an unreachable server stop the new deployment", async () => {
		mocks.execAsyncRemote.mockImplementation(
			async (serverId: string, command: string) => {
				if (serverId === "old-build-server" && command.startsWith("rm ")) {
					throw new Error("SSH connection error");
				}
				return { stdout: "", stderr: "" };
			},
		);
		mocks.findDeployments.mockResolvedValue([
			...newest,
			row(10),
			row(11, { buildServerId: "old-build-server" }),
		]);

		await expect(deployApplication()).resolves.toEqual({
			deploymentId: "new",
		});

		expect(
			remoteRemovals()
				.map(({ serverId }) => serverId)
				.sort(),
		).toEqual(["deploy-server", "old-build-server"]);
		expect(deletedDeploymentIds()).toEqual(["d-10", "d-11"]);
	});

	it("removes the rollback before its row and goes on after a failure", async () => {
		mocks.removeRollbackById.mockImplementation(async (rollbackId: string) => {
			if (rollbackId === "rollback-10") {
				throw new Error("Rollback not found");
			}
			expect(mocks.deleteWhere).not.toHaveBeenCalled();
		});
		mocks.findDeployments.mockResolvedValue([
			...newest,
			row(10, { rollbackId: "rollback-10" }),
			row(11, { rollbackId: "rollback-11" }),
		]);

		await deployApplication();

		expect(deletedDeploymentIds()).toEqual(["d-11"]);
		expect(remoteRemovals()).toEqual([
			{
				serverId: "deploy-server",
				command: "rm -f /etc/dokploy/logs/app/11.log",
			},
		]);
	});
});

describe("removeLastFiveDeployments", () => {
	it("cleans server setup logs on the panel without connecting to the server", async () => {
		const rows = Array.from({ length: 6 }, (_, index) => ({
			deploymentId: `d-${index}`,
			logPath: `/etc/dokploy/logs/server/${index}.log`,
			serverId: "set-up-server",
		}));
		mocks.findDeployments.mockResolvedValue(rows);
		mocks.findDeployment
			.mockResolvedValueOnce(rows[4])
			.mockResolvedValueOnce(rows[5]);

		await removeLastFiveDeployments("set-up-server");

		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.execAsync.mock.calls.map(([command]) => command)).toEqual([
			"rm -f /etc/dokploy/logs/server/4.log",
			"rm -f /etc/dokploy/logs/server/5.log",
		]);
	});
});

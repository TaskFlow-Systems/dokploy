import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	returning: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => {
	const chain = {
		where: vi.fn(() => chain),
		returning: mocks.returning,
	};
	return { db: { delete: vi.fn(() => chain) } };
});

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
	ExecError: class ExecError extends Error {},
}));

const { removeDeployment } = await import(
	"@dokploy/server/services/deployment"
);

const logPath = "/etc/dokploy/logs/app/app-1.log";

describe("removeDeployment log cleanup", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("removes the log on the build server that holds it", async () => {
		mocks.returning.mockResolvedValue([
			{ deploymentId: "deployment-1", logPath, buildServerId: "build-server" },
		]);

		await removeDeployment("deployment-1");

		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"build-server",
			`rm -f ${logPath};`,
		);
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("removes the log locally when the deployment names no server", async () => {
		mocks.returning.mockResolvedValue([
			{
				deploymentId: "deployment-1",
				logPath,
				serverId: null,
				buildServerId: null,
			},
		]);

		await removeDeployment("deployment-1");

		expect(mocks.execAsync).toHaveBeenCalledWith(`rm -f ${logPath};`);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});
});

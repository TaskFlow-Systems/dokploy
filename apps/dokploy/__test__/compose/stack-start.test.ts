import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	composeFindFirst: vi.fn(),
	dbUpdate: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	waitForStackRollout: vi.fn(),
	setValues: vi.fn(),
}));

vi.mock("@dokploy/server/constants", () => ({
	paths: () => ({ COMPOSE_PATH: "/srv/dokploy/compose" }),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			compose: { findFirst: mocks.composeFindFirst },
			patch: { findMany: vi.fn(async () => []) },
			network: { findMany: vi.fn(async () => []) },
		},
		update: mocks.dbUpdate,
	},
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	ExecError: class ExecError extends Error {},
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock("@dokploy/server/utils/docker/stack-rollout", () => ({
	waitForStackRollout: mocks.waitForStackRollout,
}));

const { startCompose } = await import("@dokploy/server/services/compose");

const stackFixture = {
	appName: "stack-one",
	composeId: "compose-1",
	composePath: "./docker-compose.yml",
	composeType: "stack",
	sourceType: "raw",
	isolatedDeployment: false,
	serverId: null as string | null,
	env: "TOKEN=abc",
	mounts: [],
	domains: [],
	environment: { env: "", project: { env: "" } },
};

describe("startCompose for stacks", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.composeFindFirst.mockResolvedValue(stackFixture);
		mocks.dbUpdate.mockReturnValue({
			set: mocks.setValues.mockReturnValue({
				where: () => ({ returning: async () => [stackFixture] }),
			}),
		});
		mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.waitForStackRollout.mockResolvedValue(2);
	});

	it("deploys the stack again and waits for its services", async () => {
		await expect(startCompose("compose-1")).resolves.toBe(true);

		const command = mocks.execAsync.mock.calls[0]?.[0] as string;
		expect(command).toContain("cd /srv/dokploy/compose/stack-one/code");
		expect(command).toContain("docker stack deploy -c docker-compose.yml");
		expect(command).toContain("stack-one --prune --with-registry-auth");
		expect(command).toContain("TOKEN=abc");
		expect(mocks.waitForStackRollout).toHaveBeenCalledWith("stack-one", null);
		expect(mocks.setValues).toHaveBeenLastCalledWith({ composeStatus: "done" });
	});

	it("runs on the remote server when the stack lives there", async () => {
		mocks.composeFindFirst.mockResolvedValue({
			...stackFixture,
			serverId: "server-1",
		});

		await expect(startCompose("compose-1")).resolves.toBe(true);

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote.mock.calls[0]?.[0]).toBe("server-1");
		expect(mocks.execAsyncRemote.mock.calls[0]?.[1]).toContain(
			"docker stack deploy",
		);
	});

	it("marks the compose as error when the deploy or the rollout fails", async () => {
		mocks.waitForStackRollout.mockRejectedValue(new Error("service failed"));

		await expect(startCompose("compose-1")).rejects.toThrow("service failed");

		expect(mocks.setValues).toHaveBeenLastCalledWith({
			composeStatus: "error",
		});
	});
});

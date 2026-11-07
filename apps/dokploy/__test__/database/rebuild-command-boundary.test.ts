import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	deployPostgres: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	findPostgres: vi.fn(),
	removeService: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			postgres: {
				findFirst: mocks.findPostgres,
			},
		},
	},
}));

vi.mock("@dokploy/server/services/postgres", () => ({
	deployPostgres: mocks.deployPostgres,
}));

vi.mock("@dokploy/server/utils/docker/utils", () => ({
	removeService: mocks.removeService,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

const { rebuildDatabase } = await import(
	"@dokploy/server/utils/databases/rebuild"
);

describe("database rebuild command boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.deployPostgres.mockResolvedValue(undefined);
		mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.removeService.mockResolvedValue(undefined);
	});

	it("rejects unsafe stored volume names before docker volume rm", async () => {
		mocks.findPostgres.mockResolvedValue({
			appName: "postgres-one",
			serverId: null,
			mounts: [
				{
					type: "volume",
					volumeName: "postgres-data; touch /tmp/pwn",
				},
			],
		});

		await expect(rebuildDatabase("postgres-1", "postgres", 0)).rejects.toThrow(
			"Invalid Docker volume name",
		);

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("builds docker volume rm as quoted shell args", async () => {
		mocks.findPostgres.mockResolvedValue({
			appName: "postgres-one",
			serverId: "server-1",
			mounts: [
				{
					type: "volume",
					volumeName: "postgres-data.1",
				},
			],
		});

		await expect(rebuildDatabase("postgres-1", "postgres", 0)).resolves.toBe(
			undefined,
		);

		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"server-1",
			"docker volume rm postgres-data.1 --force",
		);
	});

	it("waits on the database's server until the service has no container, before the volumes", async () => {
		mocks.findPostgres.mockResolvedValue({
			appName: "postgres-one",
			serverId: "server-1",
			mounts: [{ type: "volume", volumeName: "postgres-data.1" }],
		});

		await rebuildDatabase("postgres-1", "postgres", 30_000);

		const commands = mocks.execAsyncRemote.mock.calls.map(([, command]) =>
			String(command),
		);
		expect(commands[0]).toContain(
			"docker ps -aq --filter label\\=com.docker.swarm.service.name\\=postgres-one",
		);
		expect(commands[0]).toContain('[ "$i" -gt 30 ]');
		expect(commands[1]).toBe("docker volume rm postgres-data.1 --force");
		expect(mocks.deployPostgres).toHaveBeenCalled();
	});

	it("leaves the volumes alone when the containers do not stop", async () => {
		mocks.findPostgres.mockResolvedValue({
			appName: "postgres-one",
			serverId: null,
			mounts: [{ type: "volume", volumeName: "postgres-data.1" }],
		});
		mocks.execAsync.mockRejectedValueOnce(
			new Error("The containers of postgres-one did not stop within 30 s"),
		);

		await expect(
			rebuildDatabase("postgres-1", "postgres", 30_000),
		).rejects.toThrow("did not stop within 30 s");

		expect(mocks.execAsync).toHaveBeenCalledTimes(1);
		expect(mocks.deployPostgres).not.toHaveBeenCalled();
	});
});

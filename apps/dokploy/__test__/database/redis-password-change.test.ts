import { changeRedisPassword } from "@dokploy/server/utils/databases/redis-password";
import { quoteShellArg } from "@dokploy/server/utils/filesystem/safe-path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	getRemoteDocker: vi.fn(),
	inspect: vi.fn(),
	update: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: mocks.getRemoteDocker,
}));

vi.mock("@dokploy/server/utils/backups/utils", () => ({
	getMissingServiceContainerCommand: (appName: string) =>
		`echo missing-${appName} >&2`,
	getServiceContainerCommand: (appName: string) => `find-${appName}`,
}));

vi.mock("node:timers/promises", () => ({
	setTimeout: vi.fn(async () => undefined),
}));

const START_SCRIPT =
	'exec redis-server --requirepass "${DOKPLOY_DB_PASSWORD:?no password to start Redis with}" --port 6379';

const row = (overrides = {}) =>
	({
		appName: "redis-app",
		databasePassword: "old",
		serverId: "server-1",
		env: "OTHER=1",
		command: null,
		args: null,
		...overrides,
	}) as never;

const service = (
	containerSpec: object,
	overrides = {},
	state = "completed",
) => {
	mocks.inspect.mockResolvedValue({
		Version: { Index: "12" },
		UpdateStatus: { State: state },
		Spec: {
			Name: "redis-app",
			Mode: { Replicated: { Replicas: 1 } },
			TaskTemplate: { ForceUpdate: 3, ContainerSpec: containerSpec },
			...overrides,
		},
	});
};

const currentStart = (env: string[]) => ({
	Image: "redis:8@sha256:abc",
	Command: ["/bin/sh"],
	Args: ["-c", START_SCRIPT],
	Env: env,
});

const oldStart = (password: string) => ({
	Image: "redis:8",
	Command: ["/bin/sh"],
	Args: ["-c", `redis-server --requirepass ${password}`],
	Env: [`REDIS_PASSWORD=${password}`],
});

const savedContainerSpec = () =>
	mocks.update.mock.calls[0]?.[0].TaskTemplate.ContainerSpec;

describe("changeRedisPassword", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getRemoteDocker.mockResolvedValue({
			getService: () => ({ inspect: mocks.inspect, update: mocks.update }),
		});
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "OK\n", stderr: "" });
		mocks.execAsync.mockResolvedValue({ stdout: "OK\n", stderr: "" });
		mocks.update.mockResolvedValue(undefined);
	});

	it("changes only the password lines of the spec, on the database's own server, and sends nothing to Redis", async () => {
		service(
			currentStart([
				"REDIS_PASSWORD=old",
				"OTHER=deployed",
				"DOKPLOY_DB_PASSWORD=old",
			]),
		);

		await changeRedisPassword(row(), "new");

		expect(mocks.getRemoteDocker).toHaveBeenCalledWith("server-1");
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.execAsync).not.toHaveBeenCalled();
		const [update] = mocks.update.mock.calls[0] ?? [];
		expect(update.version).toBe(12);
		expect(update.TaskTemplate.ForceUpdate).toBe(3);
		expect(savedContainerSpec()).toEqual({
			...currentStart([
				"REDIS_PASSWORD=new",
				"OTHER=deployed",
				"DOKPLOY_DB_PASSWORD=new",
			]),
		});
	});

	it("leaves REDIS_PASSWORD alone when the service env sets it, as a deploy does", async () => {
		service(
			currentStart(["REDIS_PASSWORD=from-env", "DOKPLOY_DB_PASSWORD=old"]),
		);

		await changeRedisPassword(row({ env: "REDIS_PASSWORD=from-env" }), "new");

		expect(savedContainerSpec().Env).toEqual([
			"REDIS_PASSWORD=from-env",
			"DOKPLOY_DB_PASSWORD=new",
		]);
	});

	it("has nothing to update or wait for when the password stays the same", async () => {
		service(
			currentStart(["REDIS_PASSWORD=old", "DOKPLOY_DB_PASSWORD=old"]),
			{},
			"none",
		);

		await changeRedisPassword(row(), "old");

		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.inspect).toHaveBeenCalledTimes(2);
	});

	it("saves through the database's server before replacing the old command", async () => {
		service(oldStart("old"));

		await changeRedisPassword(row(), "new");

		const command = mocks.execAsyncRemote.mock.calls[0]?.[1] as string;
		expect(mocks.execAsyncRemote.mock.calls[0]?.[0]).toBe("server-1");
		expect(command).toContain("redis-cli --no-auth-warning -a old SAVE");
		expect(mocks.execAsyncRemote.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.update.mock.invocationCallOrder[0] as number,
		);
		expect(savedContainerSpec().Args).toEqual(["-c", START_SCRIPT]);
		expect(savedContainerSpec().Env).toEqual([
			"REDIS_PASSWORD=new",
			"DOKPLOY_DB_PASSWORD=new",
		]);
	});

	it("runs a local database's save on the panel", async () => {
		service(oldStart("old"));

		await changeRedisPassword(row({ serverId: null }), "new");

		expect(mocks.getRemoteDocker).toHaveBeenCalledWith(null);
		expect(mocks.execAsync).toHaveBeenCalledTimes(1);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("signs in with the password in the old command when the row is ahead of it", async () => {
		service(oldStart("running"));
		mocks.execAsyncRemote
			.mockResolvedValueOnce({ stdout: "NOAUTH Authentication required.\n" })
			.mockResolvedValueOnce({ stdout: "OK\n" });

		await changeRedisPassword(row({ databasePassword: "panel" }), "new");

		expect(mocks.execAsyncRemote.mock.calls[1]?.[1]).toContain(
			"-a running SAVE",
		);
		expect(mocks.update).toHaveBeenCalled();
	});

	it("changes nothing when Redis cannot save before the restart", async () => {
		service(oldStart("old"));
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: "MISCONF no space left\n",
		});

		await expect(changeRedisPassword(row(), "new")).rejects.toThrow(
			/nothing changed: MISCONF no space left/,
		);

		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("fails when the spec update fails, with nothing sent to Redis", async () => {
		service(currentStart(["DOKPLOY_DB_PASSWORD=old"]));
		mocks.update.mockRejectedValue(new Error("connection lost"));

		await expect(changeRedisPassword(row(), "new")).rejects.toThrow(
			"connection lost",
		);

		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("repeats an update that Swarm refused for an older index", async () => {
		service(currentStart(["DOKPLOY_DB_PASSWORD=old"]));
		mocks.update.mockRejectedValueOnce(new Error("update out of sequence"));

		await changeRedisPassword(row(), "new");

		expect(mocks.update).toHaveBeenCalledTimes(2);
	});

	it("does not wait for a rollout or save on a stopped database", async () => {
		service(oldStart("old"), { Mode: { Replicated: { Replicas: 0 } } }, "none");

		await changeRedisPassword(row(), "new");

		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.update).toHaveBeenCalledTimes(1);
		expect(mocks.inspect).toHaveBeenCalledTimes(2);
	});

	it.each(["rollback_started", "rollback_completed"])(
		"fails when Swarm reports %s",
		async (state) => {
			service(currentStart(["DOKPLOY_DB_PASSWORD=old"]), {}, state);

			await expect(changeRedisPassword(row(), "new")).rejects.toThrow(
				/went back to the old one/,
			);
		},
	);

	it("keeps the change when the server stops answering after the update", async () => {
		service(currentStart(["DOKPLOY_DB_PASSWORD=old"]), {}, "updating");
		let elapsed = 0;
		const now = vi.spyOn(Date, "now").mockImplementation(() => {
			elapsed += 60_000;
			return elapsed;
		});
		mocks.update.mockImplementation(async () => {
			mocks.inspect.mockRejectedValue(new Error("connection lost"));
		});

		await expect(changeRedisPassword(row(), "new")).resolves.toBeUndefined();

		now.mockRestore();
	});

	it("reports a service that does not exist the way the dialog expects", async () => {
		mocks.inspect.mockRejectedValue(
			Object.assign(new Error("(HTTP code 404) no such service"), {
				statusCode: 404,
			}),
		);

		await expect(changeRedisPassword(row(), "new")).rejects.toThrow(
			"No running container found for redis-app",
		);
	});

	describe("under a custom command", () => {
		const custom = row({
			command: "redis-server",
			args: ["--appendonly", "yes"],
		});

		it("quotes both passwords and leaves the spec alone", async () => {
			const databasePassword = "old'; touch /tmp/pwn; '";
			const password = "safe|stillAllowed";

			await changeRedisPassword(
				row({ command: "redis-server", databasePassword }),
				password,
			);

			const command = mocks.execAsyncRemote.mock.calls[0]?.[1] as string;
			expect(command).toContain("find-redis-app");
			expect(command).toContain(
				`redis-cli --no-auth-warning -a ${quoteShellArg(databasePassword)} CONFIG SET requirepass ${quoteShellArg(password)}`,
			);
			expect(command).not.toContain(`-a '${databasePassword}'`);
			expect(command).not.toContain(`requirepass ${password}`);
			expect(mocks.update).not.toHaveBeenCalled();
			expect(mocks.getRemoteDocker).not.toHaveBeenCalled();
		});

		it("fails when Redis refuses, though redis-cli exits with 0", async () => {
			mocks.execAsyncRemote.mockResolvedValue({
				stdout: "NOAUTH Authentication required.\n",
			});

			await expect(changeRedisPassword(custom, "new")).rejects.toThrow(
				"Redis refused the new password: NOAUTH Authentication required.",
			);
		});
	});
});

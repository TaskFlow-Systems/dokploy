import {
	buildRedis,
	type RedisNested,
} from "@dokploy/server/utils/databases/redis";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createService: vi.fn(),
	inspect: vi.fn(),
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: vi.fn(async () => ({
		createService: mocks.createService,
		getService: () => ({ inspect: mocks.inspect }),
	})),
}));

vi.mock("@dokploy/server/utils/vault", () => ({
	withResolvedVaultRefs: vi.fn(async (entity: unknown) => entity),
}));

vi.mock("@dokploy/server/services/network", () => ({
	resolveServiceNetworks: vi.fn(async () => []),
}));

const PASSWORD = "#p@ss:w?rd%41&^*()_+-=[]{}|,.<>~";

const fixture = (overrides: Partial<RedisNested> = {}) =>
	({
		redisId: "redis-1",
		name: "db",
		appName: "redis-app",
		dockerImage: "redis:8",
		databasePassword: PASSWORD,
		serverId: null,
		env: null,
		command: null,
		args: null,
		externalPort: null,
		memoryLimit: null,
		memoryReservation: null,
		cpuLimit: null,
		cpuReservation: null,
		mounts: [],
		environmentId: "env",
		environment: {
			projectId: "project",
			name: "production",
			env: "",
			project: { organizationId: "org", name: "project", env: "" },
		},
		...overrides,
	}) as unknown as RedisNested;

const containerSpec = async (redis: RedisNested) => {
	await buildRedis(redis);
	return mocks.createService.mock.calls[0]?.[0].TaskTemplate.ContainerSpec;
};

describe("buildRedis start command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.inspect.mockRejectedValue(
			Object.assign(new Error("no such service"), { statusCode: 404 }),
		);
	});

	it("keeps the password out of the command and hands it over in Env", async () => {
		const { Command, Args, Env } = await containerSpec(fixture());

		expect(Command).toEqual(["/bin/sh"]);
		expect(Args.join(" ")).not.toContain(PASSWORD);
		expect(Env).toContain(`DOKPLOY_DB_PASSWORD=${PASSWORD}`);
		expect(Env).toContain(`REDIS_PASSWORD=${PASSWORD}`);
	});

	it("hands over a password dotenv would change, as an old row can hold", async () => {
		const databasePassword = `we'ird"pass\\nword $HOME #x`;
		const { Args, Env } = await containerSpec(fixture({ databasePassword }));

		expect(Args.join(" ")).not.toContain(databasePassword);
		expect(Env).toContain(`DOKPLOY_DB_PASSWORD=${databasePassword}`);
	});

	it("lets the stored password win over the same name in the service env", async () => {
		const { Env } = await containerSpec(
			fixture({ env: "DOKPLOY_DB_PASSWORD=from-env" }),
		);

		// Docker keeps the last value of a repeated name.
		const handedOver = Env.filter((entry: string) =>
			entry.startsWith("DOKPLOY_DB_PASSWORD="),
		);
		expect(handedOver.at(-1)).toBe(`DOKPLOY_DB_PASSWORD=${PASSWORD}`);
	});

	it("leaves REDIS_PASSWORD from the service env to the container only", async () => {
		const { Args, Env } = await containerSpec(
			fixture({ env: "REDIS_PASSWORD=from-env" }),
		);

		expect(Env).toContain("REDIS_PASSWORD=from-env");
		expect(Env).toContain(`DOKPLOY_DB_PASSWORD=${PASSWORD}`);
		expect(Args.join(" ")).not.toContain("REDIS_PASSWORD");
	});

	it.each([
		["a command", { command: "redis-server --port 6380", args: null }],
		[
			"a command and no args",
			{ command: "redis-server --port 6380", args: [] },
		],
		["args", { command: null, args: ["redis-server", "--port", "6380"] }],
		["args and an empty command", { command: "", args: ["redis-server"] }],
	])("leaves %s to the user", async (_, overrides) => {
		const { Command, Args, Env } = await containerSpec(fixture(overrides));

		expect(Command).toEqual(
			overrides.command ? overrides.command.split(" ") : undefined,
		);
		expect(Args).toEqual(overrides.args?.length ? overrides.args : undefined);
		expect(Env).not.toContain(`DOKPLOY_DB_PASSWORD=${PASSWORD}`);
	});

	it("takes both a command and args", async () => {
		const { Command, Args } = await containerSpec(
			fixture({ command: "redis-server", args: ["--port", "6380"] }),
		);

		expect(Command).toEqual(["redis-server"]);
		expect(Args).toEqual(["--port", "6380"]);
	});

	it.each([
		["no override at all", { command: null, args: null }],
		["what the form saves when left empty", { command: "", args: [] }],
		["an empty args list", { command: null, args: [] }],
		["an empty command", { command: "", args: null }],
	])("uses the default start on %s", async (_, overrides) => {
		const { Command, Args, Env } = await containerSpec(fixture(overrides));

		expect(Command).toEqual(["/bin/sh"]);
		expect(Args[1]).toContain("--requirepass");
		expect(Env).toContain(`DOKPLOY_DB_PASSWORD=${PASSWORD}`);
	});
});

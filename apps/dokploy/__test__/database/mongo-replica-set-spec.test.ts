import {
	buildMongo,
	type MongoNested,
} from "@dokploy/server/utils/databases/mongo";
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

const PASSWORD = `we'ird"pass\\word $HOME`;

const fixture = (overrides: Partial<MongoNested> = {}) =>
	({
		mongoId: "mongo-1",
		name: "db",
		appName: "mongo-app",
		dockerImage: "mongo:8",
		databaseUser: "panel_user",
		databasePassword: PASSWORD,
		replicaSets: true,
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
	}) as unknown as MongoNested;

const containerSpec = async (mongo: MongoNested) => {
	await buildMongo(mongo);
	return mocks.createService.mock.calls[0]?.[0].TaskTemplate.ContainerSpec;
};

describe("buildMongo replica set spec", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.inspect.mockRejectedValue(new Error("no such service"));
	});

	it("starts mongod with access control and a key file", async () => {
		const { Command, Args } = await containerSpec(fixture());

		expect(Command).toEqual(["/bin/bash"]);
		expect(Args[1]).toContain('start_mongod --auth --keyFile "$KEY_FILE"');
	});

	it("keeps credentials out of the script and hands them over unparsed in Env", async () => {
		const { Args, Env } = await containerSpec(fixture());

		expect(Args[1]).not.toContain(PASSWORD);
		expect(Args[1]).not.toContain("panel_user");
		expect(Env).toContain(`DOKPLOY_DB_PASSWORD=${PASSWORD}`);
		expect(Env).toContain("DOKPLOY_DB_USER=panel_user");
		expect(Env).toContain("DOKPLOY_REPLICA_MEMBER=mongo-app:27017");
	});

	it("lets the stored credentials win over the same names in the service env", async () => {
		const { Env } = await containerSpec(
			fixture({ env: "DOKPLOY_DB_PASSWORD=from-env" }),
		);

		expect(Env.at(-2)).toBe(`DOKPLOY_DB_PASSWORD=${PASSWORD}`);
	});

	it("waits for mongod unless a custom command replaces the wait", async () => {
		const byDefault = await containerSpec(fixture());
		expect(byDefault.Args[1].trimEnd().endsWith('wait "$MONGOD_PID"')).toBe(
			true,
		);

		vi.clearAllMocks();
		const custom = await containerSpec(fixture({ command: "sleep infinity" }));
		expect(custom.Args[1].trimEnd().endsWith("sleep infinity")).toBe(true);
	});

	it("leaves a standalone database to the image entrypoint", async () => {
		const { Command, Args, Env } = await containerSpec(
			fixture({ replicaSets: false }),
		);

		expect(Command).toBeUndefined();
		expect(Args).toBeUndefined();
		expect(Env.join("\n")).not.toContain("DOKPLOY_DB_");
	});
});

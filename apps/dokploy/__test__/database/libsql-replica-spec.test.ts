import {
	buildLibsql,
	type LibsqlNested,
} from "@dokploy/server/utils/databases/libsql";
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

const PRIMARY_URL = "http://panel:p%40ss%3Aw%3Frd%231%2541@primary-app:5001";
const PRIMARY_COMMAND =
	"sqld --db-path iku.db --http-listen-addr 0.0.0.0:8080 --grpc-listen-addr 0.0.0.0:5001 --admin-listen-addr 0.0.0.0:5000";

const fixture = (overrides: Partial<LibsqlNested> = {}) =>
	({
		libsqlId: "libsql-1",
		name: "db",
		appName: "libsql-app",
		dockerImage: "ghcr.io/tursodatabase/libsql-server:v0.24.32",
		databaseUser: "panel",
		databasePassword: "stored-Passw0rd",
		sqldNode: "replica",
		sqldPrimaryUrl: PRIMARY_URL,
		enableNamespaces: false,
		serverId: null,
		env: null,
		command: null,
		externalPort: null,
		externalGRPCPort: null,
		externalAdminPort: null,
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
	}) as unknown as LibsqlNested;

const containerSpec = async (libsql: LibsqlNested) => {
	await buildLibsql(libsql);
	return mocks.createService.mock.calls[0]?.[0].TaskTemplate.ContainerSpec;
};

describe("buildLibsql replica spec", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.inspect.mockRejectedValue(new Error("no such service"));
	});

	it("hands the primary URL to sqld in Env", async () => {
		const { Env } = await containerSpec(fixture());

		expect(Env).toContain(`SQLD_PRIMARY_GRPC_URL=${PRIMARY_URL}`);
		expect(Env).toContain(`SQLD_PRIMARY_URL=${PRIMARY_URL}`);
	});

	it("keeps shell syntax in the primary URL out of the command and unchanged in Env", async () => {
		const url = "http://host:5001/$(touch$IFS/tmp/pwn);`id`'#&|";
		const { Args, Env } = await containerSpec(fixture({ sqldPrimaryUrl: url }));

		expect(Args[1]).not.toContain("/tmp/pwn");
		expect(Env).toContain(`SQLD_PRIMARY_GRPC_URL=${url}`);
	});

	it("lets the stored URL win over the same name in the service env", async () => {
		const { Env } = await containerSpec(
			fixture({ env: "SQLD_PRIMARY_GRPC_URL=http://from-env:5001" }),
		);

		expect(Env).toContain(`SQLD_PRIMARY_GRPC_URL=${PRIMARY_URL}`);
		expect(Env.join("\n")).not.toContain("from-env");
	});

	it("does not listen for gRPC, which sqld refuses on a replica", async () => {
		const { Command, Args } = await containerSpec(fixture());

		expect(Command).toEqual(["/bin/sh"]);
		expect(Args[1]).not.toContain("--grpc-listen-addr");
		expect(Args[1]).toContain("--db-path iku.db");
		expect(Args[1]).toContain("--admin-listen-addr 0.0.0.0:5000");
	});

	it("ends in exec, or sh stays PID 1 and a stop waits out the grace period", async () => {
		const { Args } = await containerSpec(fixture());

		expect(Args[1].split("\n").at(-1)).toMatch(/^exec sqld /);
	});

	it("adds --enable-namespaces to the sqld line", async () => {
		const { Args } = await containerSpec(fixture({ enableNamespaces: true }));

		expect(Args[1].split("\n").at(-1)).toMatch(
			/^exec sqld .* --enable-namespaces$/,
		);
	});

	it("runs a custom command as written and still hands it the URL", async () => {
		const command = "sqld --db-path custom.db --http-listen-addr 0.0.0.0:8080";
		const { Args, Env } = await containerSpec(fixture({ command }));

		expect(Args[1]).toBe(command);
		expect(Env).toContain(`SQLD_PRIMARY_GRPC_URL=${PRIMARY_URL}`);
	});

	it.each([
		["null", null],
		["empty", ""],
	])(
		"refuses a replica with a %s primary URL before touching the service",
		async (_, sqldPrimaryUrl) => {
			await expect(buildLibsql(fixture({ sqldPrimaryUrl }))).rejects.toThrow(
				"needs the URL of its primary",
			);

			expect(mocks.inspect).not.toHaveBeenCalled();
			expect(mocks.createService).not.toHaveBeenCalled();
		},
	);

	it("refuses a custom command that listens for gRPC before touching the service", async () => {
		await expect(
			buildLibsql(
				fixture({
					command:
						"sqld --db-path iku.db --http-listen-addr 0.0.0.0:8080 --grpc-listen-addr 0.0.0.0:5001",
				}),
			),
		).rejects.toThrow("cannot listen for gRPC");

		expect(mocks.inspect).not.toHaveBeenCalled();
		expect(mocks.createService).not.toHaveBeenCalled();
	});

	it.each([
		["null", null],
		["cleared", ""],
		["blank", "  "],
	])(
		"refuses https with a %s command, which is the default and has no TLS flags",
		async (_, command) => {
			await expect(
				buildLibsql(
					fixture({ command, sqldPrimaryUrl: "https://primary-app:5001" }),
				),
			).rejects.toThrow("without TLS");

			expect(mocks.inspect).not.toHaveBeenCalled();
			expect(mocks.createService).not.toHaveBeenCalled();
		},
	);

	it("refuses a primary URL without a scheme, on which sqld panics at every request", async () => {
		await expect(
			buildLibsql(fixture({ sqldPrimaryUrl: "primary-app:5001" })),
		).rejects.toThrow("full http:// URL");

		expect(mocks.inspect).not.toHaveBeenCalled();
		expect(mocks.createService).not.toHaveBeenCalled();
	});

	it.each([
		["null", null],
		["cleared", ""],
		["blank", "  "],
	])(
		"runs a replica's default command when the custom command is %s",
		async (_, command) => {
			const { Command, Args } = await containerSpec(fixture({ command }));

			expect(Command).toEqual(["/bin/sh"]);
			expect(Args[1]).toContain("iku.db.before-replica-");
			expect(Args[1].split("\n").at(-1)).toMatch(/^exec sqld /);
			expect(Args[1]).toContain("--admin-listen-addr 0.0.0.0:5000");
		},
	);

	it.each([
		["null", null],
		["cleared", ""],
		["blank", "  "],
	])(
		"runs a primary's default command with namespaces when the custom command is %s",
		async (_, command) => {
			const { Command, Args } = await containerSpec(
				fixture({
					sqldNode: "primary",
					sqldPrimaryUrl: null,
					enableNamespaces: true,
					command,
				}),
			);

			expect(Command).toEqual(["/bin/sh"]);
			expect(Args[1]).toBe(`${PRIMARY_COMMAND} --enable-namespaces`);
		},
	);

	it("runs a primary's default command when the custom command is cleared and namespaces are off", async () => {
		const { Args } = await containerSpec(
			fixture({ sqldNode: "primary", sqldPrimaryUrl: null, command: "" }),
		);

		expect(Args[1]).toBe(PRIMARY_COMMAND);
	});

	it("lets a custom command use https, since it can pass the TLS flags", async () => {
		const command =
			"sqld --db-path iku.db --http-listen-addr 0.0.0.0:8080 --primary-grpc-tls";
		const { Args, Env } = await containerSpec(
			fixture({ command, sqldPrimaryUrl: "https://primary-app:5001" }),
		);

		expect(Args[1]).toBe(command);
		expect(Env).toContain("SQLD_PRIMARY_GRPC_URL=https://primary-app:5001");
	});

	it("leaves a primary's custom command alone", async () => {
		const command = `${PRIMARY_COMMAND} --max-log-size 100`;
		const { Args } = await containerSpec(
			fixture({ sqldNode: "primary", sqldPrimaryUrl: null, command }),
		);

		expect(Args[1]).toBe(command);
	});

	it("leaves a primary's command as it was and gives it no primary URL", async () => {
		const { Args, Env } = await containerSpec(
			fixture({ sqldNode: "primary", sqldPrimaryUrl: null }),
		);

		expect(Args[1]).toBe(PRIMARY_COMMAND);
		expect(Env.join("\n")).not.toContain("SQLD_PRIMARY");
	});
});

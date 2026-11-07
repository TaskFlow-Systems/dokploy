import { X509Certificate } from "node:crypto";
import { LIBSQL_DEFAULT_IMAGE } from "@dokploy/server/db/schema/libsql";
import {
	buildLibsql,
	type LibsqlNested,
} from "@dokploy/server/utils/databases/libsql";
import {
	LIBSQL_GRPC_PRIMARY_FLAGS,
	LIBSQL_GRPC_REPLICA_FLAGS,
	LIBSQL_GRPC_TLS_SETUP,
} from "@dokploy/server/utils/databases/libsql-grpc-flags";
import { createLibsqlGrpcCa } from "@dokploy/server/utils/databases/libsql-grpc-tls";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createService: vi.fn(),
	inspect: vi.fn(),
	getLibsqlGrpcCa: vi.fn(),
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

vi.mock("@dokploy/server/services/libsql-grpc-ca", () => ({
	getLibsqlGrpcCa: mocks.getLibsqlGrpcCa,
}));

const ca = await createLibsqlGrpcCa("org");

const PRIMARY_URL = "http://panel:p%40ss%3Aw%3Frd%231%2541@primary-app:5001";
const TLS_PRIMARY_URL =
	"https://panel:p%40ss%3Aw%3Frd%231%2541@primary-app:5001";
const PRIMARY_SQLD =
	"sqld --db-path iku.db --http-listen-addr 0.0.0.0:8080 --grpc-listen-addr 0.0.0.0:5001 --admin-listen-addr 0.0.0.0:5000";
const PRIMARY_COMMAND = `${LIBSQL_GRPC_TLS_SETUP}\nexec ${PRIMARY_SQLD} ${LIBSQL_GRPC_PRIMARY_FLAGS}`;

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
		mocks.inspect.mockRejectedValue(
			Object.assign(new Error("no such service"), { statusCode: 404 }),
		);
		mocks.getLibsqlGrpcCa.mockResolvedValue(ca);
	});

	it("takes the image from the field, as the deploy pulls it", async () => {
		const { Image } = await containerSpec(
			fixture({ dockerImage: "registry.example/libsql-server:v9" }),
		);

		expect(Image).toBe("registry.example/libsql-server:v9");
	});

	it("falls back to the pinned image when the field is empty", async () => {
		const { Image } = await containerSpec(fixture({ dockerImage: "" }));

		expect(Image).toBe(LIBSQL_DEFAULT_IMAGE);
	});

	it.each([
		["primary", { sqldNode: "primary", sqldPrimaryUrl: null }],
		["replica", {}],
	] as const)(
		"gives a %s a certificate of its organization's authority",
		async (_, overrides) => {
			const { Env } = await containerSpec(fixture(overrides));
			const value = (name: string) =>
				Buffer.from(
					(Env as string[])
						.find((line) => line.startsWith(`${name}=`))
						?.slice(name.length + 1) ?? "",
					"base64",
				).toString("utf8");

			expect(mocks.getLibsqlGrpcCa).toHaveBeenCalledWith("org");
			expect(value("DOKPLOY_GRPC_CA")).toBe(ca.certificate);
			const certificate = new X509Certificate(value("DOKPLOY_GRPC_CERT"));
			expect(
				certificate.verify(new X509Certificate(ca.certificate).publicKey),
			).toBe(true);
			expect(certificate.subjectAltName).toContain("DNS:sqld");
			expect(value("DOKPLOY_GRPC_KEY")).toContain("BEGIN PRIVATE KEY");
		},
	);

	it("hands the primary URL to sqld in Env", async () => {
		const { Env } = await containerSpec(fixture());

		expect(Env).toContain(`SQLD_PRIMARY_GRPC_URL=${TLS_PRIMARY_URL}`);
		expect(Env).toContain(`SQLD_PRIMARY_URL=${TLS_PRIMARY_URL}`);
	});

	it("keeps shell syntax in the primary URL out of the command and unchanged in Env", async () => {
		const url = "http://host:5001/$(touch$IFS/tmp/pwn);`id`'#&|";
		const { Args, Env } = await containerSpec(fixture({ sqldPrimaryUrl: url }));

		expect(Args[1]).not.toContain("/tmp/pwn");
		expect(Env).toContain(
			`SQLD_PRIMARY_GRPC_URL=${url.replace("http://", "https://")}`,
		);
	});

	it("lets the stored URL win over the same name in the service env", async () => {
		const { Env } = await containerSpec(
			fixture({ env: "SQLD_PRIMARY_GRPC_URL=http://from-env:5001" }),
		);

		expect(Env).toContain(`SQLD_PRIMARY_GRPC_URL=${TLS_PRIMARY_URL}`);
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

	it("runs a custom command after the certificate files and still hands it the URL", async () => {
		const command = `sqld --db-path custom.db --http-listen-addr 0.0.0.0:8080 ${LIBSQL_GRPC_REPLICA_FLAGS}`;
		const { Args, Env } = await containerSpec(fixture({ command }));

		expect(Args[1]).toBe(`${LIBSQL_GRPC_TLS_SETUP}\n${command}`);
		expect(Env).toContain(`SQLD_PRIMARY_GRPC_URL=${TLS_PRIMARY_URL}`);
	});

	it("refuses a custom replica command without the certificate flags", async () => {
		await expect(
			buildLibsql(
				fixture({
					command: "sqld --db-path iku.db --http-listen-addr 0.0.0.0:8080",
				}),
			),
		).rejects.toThrow(LIBSQL_GRPC_REPLICA_FLAGS);

		expect(mocks.createService).not.toHaveBeenCalled();
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
					command: `sqld --db-path iku.db --http-listen-addr 0.0.0.0:8080 --grpc-listen-addr 0.0.0.0:5001 ${LIBSQL_GRPC_REPLICA_FLAGS}`,
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
		"takes https with a %s command, the default one, which connects with TLS",
		async (_, command) => {
			const { Args, Env } = await containerSpec(
				fixture({ command, sqldPrimaryUrl: "https://primary-app:5001" }),
			);

			expect(Args[1].split("\n").at(-1)).toContain(LIBSQL_GRPC_REPLICA_FLAGS);
			expect(Env).toContain("SQLD_PRIMARY_GRPC_URL=https://primary-app:5001");
		},
	);

	it("refuses a primary URL without a scheme, on which sqld panics at every request", async () => {
		await expect(
			buildLibsql(fixture({ sqldPrimaryUrl: "primary-app:5001" })),
		).rejects.toThrow("full http:// or https:// URL");

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

	it("runs a primary's custom command with the certificate flags after the files", async () => {
		const command = `${PRIMARY_SQLD} ${LIBSQL_GRPC_PRIMARY_FLAGS} --max-log-size 100`;
		const { Args } = await containerSpec(
			fixture({ sqldNode: "primary", sqldPrimaryUrl: null, command }),
		);

		expect(Args[1]).toBe(`${LIBSQL_GRPC_TLS_SETUP}\n${command}`);
	});

	it("refuses a primary's custom command that listens for gRPC without TLS", async () => {
		await expect(
			buildLibsql(
				fixture({
					sqldNode: "primary",
					sqldPrimaryUrl: null,
					command: `${PRIMARY_SQLD} --max-log-size 100`,
				}),
			),
		).rejects.toThrow(LIBSQL_GRPC_PRIMARY_FLAGS);

		expect(mocks.createService).not.toHaveBeenCalled();
	});

	it("leaves a primary's command as it was and gives it no primary URL", async () => {
		const { Args, Env } = await containerSpec(
			fixture({ sqldNode: "primary", sqldPrimaryUrl: null }),
		);

		expect(Args[1]).toBe(PRIMARY_COMMAND);
		expect(Env.join("\n")).not.toContain("SQLD_PRIMARY");
	});
});

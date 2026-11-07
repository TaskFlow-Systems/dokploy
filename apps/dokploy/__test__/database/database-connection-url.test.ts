import { DATABASE_PASSWORD_REGEX } from "@dokploy/server/db/schema/utils";
import type { FC } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShowExternalLibsqlCredentials } from "@/components/dashboard/libsql/general/show-external-libsql-credentials";
import { ShowInternalLibsqlCredentials } from "@/components/dashboard/libsql/general/show-internal-libsql-credentials";
import { ShowExternalMariadbCredentials } from "@/components/dashboard/mariadb/general/show-external-mariadb-credentials";
import { ShowInternalMariadbCredentials } from "@/components/dashboard/mariadb/general/show-internal-mariadb-credentials";
import { ShowExternalMysqlCredentials } from "@/components/dashboard/mysql/general/show-external-mysql-credentials";
import { ShowInternalMysqlCredentials } from "@/components/dashboard/mysql/general/show-internal-mysql-credentials";
import { ShowExternalPostgresCredentials } from "@/components/dashboard/postgres/general/show-external-postgres-credentials";
import { ShowInternalPostgresCredentials } from "@/components/dashboard/postgres/general/show-internal-postgres-credentials";
import { ShowExternalRedisCredentials } from "@/components/dashboard/redis/general/show-external-redis-credentials";
import { ShowInternalRedisCredentials } from "@/components/dashboard/redis/general/show-internal-redis-credentials";
import {
	buildLibsqlUrl,
	buildMariadbUrl,
	buildMysqlUrl,
	buildPostgresUrl,
	buildRedisUrl,
	formatUrlHost,
} from "@/lib/database-connection-url";

const databaseRow = vi.hoisted(() => ({
	current: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@/utils/api", () => {
	const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
	const router = {
		one: {
			useQuery: () => ({ data: databaseRow.current, refetch: vi.fn() }),
		},
		changePassword: { useMutation: mutation },
		revealCredentials: { useMutation: mutation },
		saveExternalPort: { useMutation: mutation },
		saveExternalPorts: { useMutation: mutation },
	};
	const invalidate = { one: { invalidate: vi.fn() } };
	return {
		api: {
			useUtils: () => ({
				postgres: invalidate,
				mysql: invalidate,
				mariadb: invalidate,
				redis: invalidate,
				libsql: invalidate,
			}),
			settings: {
				getIp: { useQuery: () => ({ data: "203.0.113.10" }) },
			},
			postgres: router,
			mysql: router,
			mariadb: router,
			redis: router,
			libsql: router,
		},
	};
});

const SPECIAL_PASSWORD = "p@ss:w?rd#1%41&^*()_+-=[]{}|,.<>~";
const ENCODED_PASSWORD = encodeURIComponent(SPECIAL_PASSWORD);
const ENDPOINT = { host: "203.0.113.10", port: 15432 };
const DATABASE = {
	databaseUser: "panel_user",
	databasePassword: "secret",
	databaseName: "app",
};

const allowedAscii = Array.from({ length: 0x7f - 0x20 }, (_, index) =>
	String.fromCharCode(0x20 + index),
).filter((char) => DATABASE_PASSWORD_REGEX.test(char));

const decodedParts = (url: string) => {
	const parsed = new URL(url);
	return {
		user: decodeURIComponent(parsed.username),
		password: decodeURIComponent(parsed.password),
		hostname: parsed.hostname,
		port: parsed.port,
		database: decodeURIComponent(parsed.pathname.slice(1)),
		search: parsed.search,
		hash: parsed.hash,
	};
};

it("takes the characters under test from the password validator", () => {
	expect(allowedAscii).toEqual(
		expect.arrayContaining([..."@:?#%^&*()_+-=[]{}|,.<>~"]),
	);
});

describe("formatUrlHost", () => {
	it.each([
		["2001:db8::1", "[2001:db8::1]"],
		["::1", "[::1]"],
		["[2001:db8::1]", "[2001:db8::1]"],
		["203.0.113.10", "203.0.113.10"],
		["db.example.com", "db.example.com"],
		["", ""],
	])("turns %s into %s", (host, expected) => {
		expect(formatUrlHost(host)).toBe(expected);
	});
});

describe.each([
	[
		"postgres",
		buildPostgresUrl,
		"postgresql://panel_user:secret@203.0.113.10:15432/app",
		"panel_user",
		"app",
	],
	[
		"mysql",
		buildMysqlUrl,
		"mysql://panel_user:secret@203.0.113.10:15432/app",
		"panel_user",
		"app",
	],
	[
		"mariadb",
		buildMariadbUrl,
		"mariadb://panel_user:secret@203.0.113.10:15432/app",
		"panel_user",
		"app",
	],
	[
		"redis",
		buildRedisUrl,
		"redis://default:secret@203.0.113.10:15432",
		"default",
		"",
	],
	[
		"libsql",
		buildLibsqlUrl,
		"http://panel_user:secret@203.0.113.10:15432",
		"panel_user",
		"",
	],
])("the %s string", (_kind, build, plainUrl, user, database) => {
	const expectIntact = (url: string, password: string) => {
		expect(decodedParts(url)).toEqual({
			user,
			password,
			hostname: ENDPOINT.host,
			port: String(ENDPOINT.port),
			database,
			search: "",
			hash: "",
		});
	};

	it("stays as it was for a plain password", () => {
		expect(build(DATABASE, ENDPOINT)).toBe(plainUrl);
	});

	it.each(allowedAscii)("survives %s in the password", (char) => {
		expectIntact(
			build({ ...DATABASE, databasePassword: `a${char}b` }, ENDPOINT),
			`a${char}b`,
		);
	});

	it("does not decode what only looks encoded", () => {
		expectIntact(
			build({ ...DATABASE, databasePassword: "100%41" }, ENDPOINT),
			"100%41",
		);
	});

	it("survives all of them in one password", () => {
		expectIntact(
			build({ ...DATABASE, databasePassword: SPECIAL_PASSWORD }, ENDPOINT),
			SPECIAL_PASSWORD,
		);
	});

	it("leaves no character that ends the credentials early", () => {
		const url = build(
			{ ...DATABASE, databasePassword: SPECIAL_PASSWORD },
			ENDPOINT,
		);
		const password = url.split(":")[2]?.split("@")[0];

		expect(password).toContain("%2541");
		expect(password).not.toMatch(/[:/?#[\]@]/);
	});

	it("puts an IPv6 address in brackets", () => {
		const parsed = new URL(
			build(DATABASE, { host: "2001:db8::1", port: 15432 }),
		);

		expect(parsed.hostname).toBe("[2001:db8::1]");
		expect(parsed.port).toBe("15432");
	});
});

describe.each([
	["postgres", buildPostgresUrl],
	["mysql", buildMysqlUrl],
	["mariadb", buildMariadbUrl],
])("the %s database name", (_kind, build) => {
	// The validators limit the user but not the name, and an old row can hold more.
	it("is encoded along with the user", () => {
		const url = build(
			{ ...DATABASE, databaseUser: "us@er:1/?#", databaseName: "my/db?x#1" },
			ENDPOINT,
		);

		expect(decodedParts(url)).toMatchObject({
			user: "us@er:1/?#",
			database: "my/db?x#1",
			search: "",
			hash: "",
		});
	});
});

describe("the libSQL user", () => {
	it("is encoded, because its validator allows any character", () => {
		expect(
			decodedParts(
				buildLibsqlUrl({ ...DATABASE, databaseUser: "us@er:1/?#" }, ENDPOINT),
			).user,
		).toBe("us@er:1/?#");
	});
});

describe("the credentials components", () => {
	const htmlOf = (component: unknown, props: Record<string, string>) =>
		renderToStaticMarkup(
			createElement(component as FC<Record<string, string>>, props),
		).replaceAll("&amp;", "&");

	const row = {
		databaseUser: "panel_user",
		databasePassword: SPECIAL_PASSWORD,
		databaseName: "app",
		appName: "db-abc",
		sqldNode: "primary",
		enableNamespaces: false,
		externalPort: 15432,
		externalGRPCPort: 15001,
		server: null,
		serverId: null,
	};

	const credentials = `panel_user:${ENCODED_PASSWORD}`;

	beforeEach(() => {
		databaseRow.current = row;
	});

	describe.each([
		[
			"postgres",
			ShowInternalPostgresCredentials,
			ShowExternalPostgresCredentials,
			{ postgresId: "d1" },
			`postgresql://${credentials}@db-abc:5432/app`,
			(host: string) => `postgresql://${credentials}@${host}:15432/app`,
		],
		[
			"mysql",
			ShowInternalMysqlCredentials,
			ShowExternalMysqlCredentials,
			{ mysqlId: "d1" },
			`mysql://${credentials}@db-abc:3306/app`,
			(host: string) => `mysql://${credentials}@${host}:15432/app`,
		],
		[
			"mariadb",
			ShowInternalMariadbCredentials,
			ShowExternalMariadbCredentials,
			{ mariadbId: "d1" },
			`mariadb://${credentials}@db-abc:3306/app`,
			(host: string) => `mariadb://${credentials}@${host}:15432/app`,
		],
		[
			"redis",
			ShowInternalRedisCredentials,
			ShowExternalRedisCredentials,
			{ redisId: "d1" },
			`redis://default:${ENCODED_PASSWORD}@db-abc:6379`,
			(host: string) => `redis://default:${ENCODED_PASSWORD}@${host}:15432`,
		],
		[
			"libsql",
			ShowInternalLibsqlCredentials,
			ShowExternalLibsqlCredentials,
			{ libsqlId: "d1" },
			`http://${credentials}@db-abc:8080`,
			(host: string) => `http://${credentials}@${host}:15432`,
		],
	])("%s", (_kind, Internal, External, props, internalUrl, externalUrl) => {
		it("shows the internal string", () => {
			expect(htmlOf(Internal, props)).toContain(`value="${internalUrl}"`);
		});

		it("shows the external string with the panel's IP", () => {
			expect(htmlOf(External, props)).toContain(
				`value="${externalUrl("203.0.113.10")}"`,
			);
		});

		it("uses the IP of the server that runs the database", () => {
			databaseRow.current = {
				...row,
				serverId: "s1",
				server: { ipAddress: "198.51.100.7" },
			};
			expect(htmlOf(External, props)).toContain(
				`value="${externalUrl("198.51.100.7")}"`,
			);
		});

		it("puts a server's IPv6 address in brackets", () => {
			databaseRow.current = {
				...row,
				serverId: "s1",
				server: { ipAddress: "2001:db8::7" },
			};
			expect(htmlOf(External, props)).toContain(
				`value="${externalUrl("[2001:db8::7]")}"`,
			);
		});

		it("shows no external string without a port", () => {
			databaseRow.current = {
				...row,
				externalPort: null,
				externalGRPCPort: null,
			};
			expect(htmlOf(External, props)).not.toContain(credentials);
			expect(htmlOf(External, props)).not.toContain(ENCODED_PASSWORD);
		});

		it("shows no half-built string while the row is loading", () => {
			databaseRow.current = undefined;
			expect(htmlOf(Internal, props)).not.toContain("undefined");
			expect(htmlOf(External, props)).not.toContain("undefined");
		});
	});

	describe("libsql replication", () => {
		const props = { libsqlId: "d1" };

		it("shows the internal replication string", () => {
			expect(htmlOf(ShowInternalLibsqlCredentials, props)).toContain(
				`value="http://${credentials}@db-abc:5001"`,
			);
		});

		it("shows the external replication string", () => {
			expect(htmlOf(ShowExternalLibsqlCredentials, props)).toContain(
				`value="http://${credentials}@203.0.113.10:15001"`,
			);
		});

		it("hides the external replication string on a replica", () => {
			databaseRow.current = { ...row, sqldNode: "replica" };
			expect(htmlOf(ShowExternalLibsqlCredentials, props)).not.toContain(
				"15001",
			);
		});
	});
});

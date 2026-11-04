import { DATABASE_PASSWORD_REGEX } from "@dokploy/server/db/schema/utils";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShowExternalMongoCredentials } from "@/components/dashboard/mongo/general/show-external-mongo-credentials";
import { ShowInternalMongoCredentials } from "@/components/dashboard/mongo/general/show-internal-mongo-credentials";
import {
	buildExternalMongoUrl,
	buildInternalMongoUrl,
} from "@/lib/mongo-connection-url";

const mongoRow = vi.hoisted(() => ({
	current: {} as Record<string, unknown>,
}));

vi.mock("@/utils/api", () => {
	const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
	return {
		api: {
			useUtils: () => ({ mongo: { one: { invalidate: vi.fn() } } }),
			settings: {
				getIp: { useQuery: () => ({ data: "203.0.113.10" }) },
			},
			mongo: {
				one: {
					useQuery: () => ({ data: mongoRow.current, refetch: vi.fn() }),
				},
				changePassword: { useMutation: mutation },
				saveExternalPort: { useMutation: mutation },
			},
		},
	};
});

const SPECIAL_PASSWORD = "p@ss:w?rd#1%41&^*()_+-=[]{}|,.<>~";
const CREDENTIALS = { databaseUser: "panel_user", databasePassword: "secret" };

const allowedAscii = Array.from({ length: 0x7f - 0x20 }, (_, index) =>
	String.fromCharCode(0x20 + index),
).filter((char) => DATABASE_PASSWORD_REGEX.test(char));

const decodedParts = (url: string) => {
	const parsed = new URL(url);
	return {
		user: decodeURIComponent(parsed.username),
		password: decodeURIComponent(parsed.password),
		host: parsed.host,
		pathname: parsed.pathname,
		params: Object.fromEntries(parsed.searchParams),
		hash: parsed.hash,
	};
};

it("takes the characters under test from the password validator", () => {
	expect(allowedAscii).toEqual(
		expect.arrayContaining([..."@:?#%^&*()_+-=[]{}|,.<>~"]),
	);
});

describe("buildInternalMongoUrl", () => {
	it("keeps discovery on for a replica set, whose member name resolves inside the network", () => {
		expect(
			buildInternalMongoUrl({
				...CREDENTIALS,
				appName: "db-abc",
				replicaSets: true,
			}),
		).toBe("mongodb://panel_user:secret@db-abc:27017/?authSource=admin");
	});

	it.each([false, null])(
		"connects directly when replicaSets is %s",
		(replicaSets) => {
			expect(
				buildInternalMongoUrl({
					...CREDENTIALS,
					appName: "db-abc",
					replicaSets,
				}),
			).toBe(
				"mongodb://panel_user:secret@db-abc:27017/?authSource=admin&directConnection=true",
			);
		},
	);
});

describe("buildExternalMongoUrl", () => {
	it("connects directly to a standalone database and to a replica set alike", () => {
		expect(
			buildExternalMongoUrl({
				...CREDENTIALS,
				host: "203.0.113.10",
				port: 27018,
			}),
		).toBe(
			"mongodb://panel_user:secret@203.0.113.10:27018/?authSource=admin&directConnection=true",
		);
	});
});

describe.each([
	[
		"internal",
		(databaseUser: string, databasePassword: string) =>
			buildInternalMongoUrl({
				databaseUser,
				databasePassword,
				appName: "db-abc",
				replicaSets: true,
			}),
		"db-abc:27017",
		{ authSource: "admin" },
	],
	[
		"external",
		(databaseUser: string, databasePassword: string) =>
			buildExternalMongoUrl({
				databaseUser,
				databasePassword,
				host: "203.0.113.10",
				port: 27018,
			}),
		"203.0.113.10:27018",
		{ authSource: "admin", directConnection: "true" },
	],
])("the %s string", (_kind, build, host, params) => {
	const expectIntact = (url: string, user: string, password: string) => {
		expect(decodedParts(url)).toEqual({
			user,
			password,
			host,
			pathname: "/",
			params,
			hash: "",
		});
	};

	it.each(allowedAscii)("survives %s in the password", (char) => {
		expectIntact(build("panel_user", `a${char}b`), "panel_user", `a${char}b`);
	});

	it("does not decode what only looks encoded", () => {
		expectIntact(build("panel_user", "100%41"), "panel_user", "100%41");
	});

	it("survives all of them in one password", () => {
		expectIntact(
			build("panel_user", SPECIAL_PASSWORD),
			"panel_user",
			SPECIAL_PASSWORD,
		);
	});

	// The validator allows only letters, digits and _ today, but an old row can hold more.
	it("encodes the user as well", () => {
		expectIntact(build("us@er:1/?#", "secret"), "us@er:1/?#", "secret");
	});

	it("escapes the characters the connection string format forbids", () => {
		const [, credentials] =
			build("us@er:1", SPECIAL_PASSWORD).match(/^mongodb:\/\/(.*)@[^@]*$/) ??
			[];
		const [user, password, ...rest] = (credentials ?? "").split(":");

		expect(rest).toEqual([]);
		expect(user).not.toMatch(/[:/?#[\]@]/);
		expect(password).not.toMatch(/[:/?#[\]@]/);
		expect(password).toContain("%2541");
	});
});

describe("the credentials components", () => {
	const htmlOf = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
		renderToStaticMarkup(element).replaceAll("&amp;", "&");

	beforeEach(() => {
		mongoRow.current = {
			databaseUser: "panel_user",
			databasePassword: SPECIAL_PASSWORD,
			appName: "db-abc",
			replicaSets: true,
			externalPort: 27018,
			server: null,
			serverId: null,
		};
	});

	const encoded = encodeURIComponent(SPECIAL_PASSWORD);

	it("shows the internal string of a replica set", () => {
		const html = htmlOf(
			createElement(ShowInternalMongoCredentials, { mongoId: "m1" }),
		);
		expect(html).toContain(
			`value="mongodb://panel_user:${encoded}@db-abc:27017/?authSource=admin"`,
		);
	});

	it("shows the internal string of a standalone database", () => {
		mongoRow.current = { ...mongoRow.current, replicaSets: false };
		const html = htmlOf(
			createElement(ShowInternalMongoCredentials, { mongoId: "m1" }),
		);
		expect(html).toContain(
			`value="mongodb://panel_user:${encoded}@db-abc:27017/?authSource=admin&directConnection=true"`,
		);
	});

	it("shows the external string of a replica set with the panel's IP", () => {
		const html = htmlOf(
			createElement(ShowExternalMongoCredentials, { mongoId: "m1" }),
		);
		expect(html).toContain(
			`value="mongodb://panel_user:${encoded}@203.0.113.10:27018/?authSource=admin&directConnection=true"`,
		);
	});

	it("uses the IP of the server that runs the database", () => {
		mongoRow.current = {
			...mongoRow.current,
			serverId: "s1",
			server: { ipAddress: "198.51.100.7" },
		};
		const html = htmlOf(
			createElement(ShowExternalMongoCredentials, { mongoId: "m1" }),
		);
		expect(html).toContain("@198.51.100.7:27018/");
	});

	it("shows no external string without a port", () => {
		mongoRow.current = { ...mongoRow.current, externalPort: null };
		const html = htmlOf(
			createElement(ShowExternalMongoCredentials, { mongoId: "m1" }),
		);
		expect(html).not.toContain("mongodb://");
	});
});

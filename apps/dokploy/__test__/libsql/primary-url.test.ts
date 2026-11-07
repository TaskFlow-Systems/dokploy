import {
	LIBSQL_GRPC_REPLICA_FLAGS,
	toLibsqlGrpcTlsUrl,
} from "@dokploy/server/utils/databases/libsql-grpc-flags";
import {
	getCustomLibsqlCommand,
	getLibsqlPrimaryUrlProblem,
} from "@dokploy/server/utils/databases/libsql-primary-url";
import {
	keepStoredUrlPassword,
	REDACTED_SECRET_VALUE,
	redactDatabaseServiceSecrets,
	redactUrlPassword,
} from "@dokploy/server/utils/security/redaction";
import { describe, expect, it } from "vitest";

describe("getCustomLibsqlCommand", () => {
	it.each([[null], [undefined], [""], ["  "], ["\n"]])(
		"treats %j as no override",
		(command) => {
			expect(getCustomLibsqlCommand(command)).toBeNull();
		},
	);

	it("keeps a real command as written", () => {
		expect(getCustomLibsqlCommand(" sqld --db-path a ")).toBe(
			" sqld --db-path a ",
		);
	});
});

describe("getLibsqlPrimaryUrlProblem", () => {
	it.each([
		["http://primary:5001"],
		["http://panel:p%40ss%3Aw%3Frd%231%2541@primary:5001"],
		[`http://panel:${REDACTED_SECRET_VALUE}@primary:5001`],
		["HTTP://primary:5001"],
		["https://primary:5001"],
	])("accepts %s", (url) => {
		expect(getLibsqlPrimaryUrlProblem(url, null)).toBeNull();
	});

	it.each([[null], [undefined], [""]])("needs a URL, not %j", (url) => {
		expect(getLibsqlPrimaryUrlProblem(url, null)).toContain(
			"needs the URL of its primary",
		);
	});

	it.each([
		["primary:5001"],
		["primary"],
		["http://"],
		["grpc://primary:5001"],
		["not a url"],
		["http://primary:5001 "],
		["http://u:p/ss@primary:5001"],
	])("refuses %j", (url) => {
		expect(getLibsqlPrimaryUrlProblem(url, null)).toContain(
			"full http:// or https:// URL",
		);
	});

	it.each([[null], [""], ["  "]])(
		"accepts https with the default command, which connects with TLS, here %j",
		(command) => {
			expect(
				getLibsqlPrimaryUrlProblem("https://primary:5001", command),
			).toBeNull();
		},
	);

	it("asks a custom command for the certificate flags", () => {
		expect(
			getLibsqlPrimaryUrlProblem(
				"https://primary:5001",
				"sqld --db-path iku.db",
			),
		).toContain(LIBSQL_GRPC_REPLICA_FLAGS);
		expect(
			getLibsqlPrimaryUrlProblem(
				"https://primary:5001",
				`sqld --db-path iku.db ${LIBSQL_GRPC_REPLICA_FLAGS}`,
			),
		).toBeNull();
	});
});

describe("toLibsqlGrpcTlsUrl", () => {
	it.each([
		["http://primary:5001", "https://primary:5001"],
		["HTTP://u:p@primary:5001", "https://u:p@primary:5001"],
		["https://primary:5001", "https://primary:5001"],
	])("dials %s as %s", (url, expected) => {
		expect(toLibsqlGrpcTlsUrl(url)).toBe(expected);
	});
});

describe("redactUrlPassword", () => {
	it.each([
		[null, null],
		[undefined, undefined],
		["", ""],
		["http://primary:5001", "http://primary:5001"],
		["primary:5001", "primary:5001"],
	])("leaves %j, which has no credentials", (url, expected) => {
		expect(redactUrlPassword(url)).toBe(expected);
	});

	it.each([
		[
			"http://panel:secret@primary:5001",
			`http://panel:${REDACTED_SECRET_VALUE}@primary:5001`,
		],
		[
			"http://panel:se@cr/et@primary:5001",
			`http://panel:${REDACTED_SECRET_VALUE}@primary:5001`,
		],
		[
			"http://token@primary:5001",
			`http://${REDACTED_SECRET_VALUE}@primary:5001`,
		],
		[
			"panel:secret@primary:5001",
			`panel:${REDACTED_SECRET_VALUE}@primary:5001`,
		],
	])("hides the password of %s and keeps the host", (url, expected) => {
		expect(redactUrlPassword(url)).toBe(expected);
	});

	it("hides it in a database service read, along with the other secrets", () => {
		expect(
			redactDatabaseServiceSecrets({
				databasePassword: "own",
				sqldPrimaryUrl: "http://panel:secret@primary:5001",
			}),
		).toEqual({
			databasePassword: REDACTED_SECRET_VALUE,
			sqldPrimaryUrl: `http://panel:${REDACTED_SECRET_VALUE}@primary:5001`,
		});
	});

	it("adds no field to a database that has no primary URL", () => {
		expect(redactDatabaseServiceSecrets({ databasePassword: "own" })).toEqual({
			databasePassword: REDACTED_SECRET_VALUE,
		});
	});
});

describe("keepStoredUrlPassword", () => {
	const stored = "http://panel:secret@primary:5001";

	it("keeps what is stored when the URL comes back as it was shown", () => {
		expect(keepStoredUrlPassword(redactUrlPassword(stored), stored)).toBe(
			stored,
		);
	});

	it("does not move the stored password to another host", () => {
		const edited = `http://panel:${REDACTED_SECRET_VALUE}@elsewhere:5001`;

		expect(keepStoredUrlPassword(edited, stored)).toBe(edited);
	});

	it("does not move the stored password to another user", () => {
		const edited = `http://other:${REDACTED_SECRET_VALUE}@primary:5001`;

		expect(keepStoredUrlPassword(edited, stored)).toBe(edited);
	});

	it("saves a new URL as sent", () => {
		expect(keepStoredUrlPassword("http://fixed:5001", stored)).toBe(
			"http://fixed:5001",
		);
	});

	it.each([[undefined], [null], [""]])(
		"leaves %j alone, so a save of other fields changes nothing",
		(next) => {
			expect(keepStoredUrlPassword(next, stored)).toBe(next);
		},
	);
});

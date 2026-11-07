import { quoteShellArg } from "@dokploy/server/utils/filesystem/safe-path";
import {
	REDACTED_SECRET_VALUE as R,
	redactSensitiveText,
} from "@dokploy/server/utils/security/redaction";
import { describe, expect, it } from "vitest";

const base64Line = Buffer.from(
	Array.from({ length: 300_000 }, (_, index) => (index * 37) % 251),
).toString("base64");

describe("redactSensitiveText under default options on long lines", () => {
	it.each([
		["short words", "a.".repeat(50_000)],
		["base64", base64Line],
		["a long path", "seg/".repeat(100_000)],
		["dashes", "ab-".repeat(200_000)],
		["dots", "ab.cd".repeat(120_000)],
		["assignments", "A=".repeat(300_000)],
		["keywords", "pass-".repeat(120_000)],
		["urls", "a://b".repeat(120_000)],
		["jwt heads", "eyJ-".repeat(150_000)],
		["token prefixes", "sk-".repeat(200_000)],
		["flags", " --a".repeat(150_000)],
		["clients", "mysql ".repeat(100_000)],
		["sensitive words in a run", "token-".repeat(100_000)],
		["short sensitive words in a run", "pwd.".repeat(150_000)],
		["sensitive words before a colon", `${"token-".repeat(100_000)}x: ,`],
		["sensitive words in a string", `"${"token ".repeat(100_000)}": ,`],
		["sensitive words in an open string", `'${"token ".repeat(100_000)}`],
		["a log after one quote", `"${"unexpected token\n".repeat(30_000)}`],
		["query separators", "?a".repeat(100_000)],
		["hashes", "#".repeat(200_000)],
		["ampersands", "&".repeat(200_000)],
		["a query key of keywords", `?${"token".repeat(40_000)}`],
		["a flag of keywords", ` -${"token-".repeat(33_000)}`],
		["an env name of keywords", "TOKEN_".repeat(33_000)],
		["redis clients", "redis-cli ".repeat(20_000)],
		["mongo clients", "mongosh ".repeat(25_000)],
	])("stays fast on a line of %s", (_name, input) => {
		const startedAt = performance.now();

		redactSensitiveText(input);

		expect(performance.now() - startedAt).toBeLessThan(2_000);
	});
});

describe("the default key: value rule", () => {
	it.each([
		["password: hunter2", `password: ${R}`],
		["DB_PASSWORD : hunter2", `DB_PASSWORD : ${R}`],
		[`"api_key":"abc"`, `"api_key":${R}`],
		[`'api_key' : 'abc'`, `'api_key' : ${R}`],
		[
			`{"a":{"refresh_token":"abc"},"b":1}`,
			`{"a":{"refresh_token":${R}},"b":1}`,
		],
		["my.app.secret.name: abc", `my.app.secret.name: ${R}`],
		["x-token_id: abc", `x-token_id: ${R}`],
		[`"a token: b": "c d"`, `"a token: b": ${R}`],
		[`"a\ntoken\nb": c`, `"a\ntoken\nb": ${R}`],
		[`a"token": b`, `a"token": ${R}`],
		[`token"b: c`, `token"b: ${R}`],
	])("masks the value of %s", (input, expected) => {
		expect(redactSensitiveText(input)).toBe(expected);
	});

	it.each([
		["token:abc}password:def", `token:${R}}password:${R}`],
		[`token:"abc"password:def`, `token:${R}password:${R}`],
		["[pwd:abc]secret:def", `[pwd:${R}]secret:${R}`],
		["token:abc}x:def", `token:${R}}x:def`],
	])("reads a key that starts where a value ended in %s", (input, expected) => {
		expect(redactSensitiveText(input)).toBe(expected);
	});

	it("takes a key of any length before the keyword or inside quotes", () => {
		const longHead = `${"a".repeat(5_000)}token: abc`;
		const dottedHead = `${"a.".repeat(5_000)}token: abc`;
		const longString = `"${"a ".repeat(5_000)}token${" b".repeat(5_000)}": "abc"`;

		expect(redactSensitiveText(longHead)).toBe(
			`${"a".repeat(5_000)}token: ${R}`,
		);
		expect(redactSensitiveText(dottedHead)).toBe(
			`${"a.".repeat(5_000)}token: ${R}`,
		);
		expect(redactSensitiveText(longString)).toBe(
			`"${"a ".repeat(5_000)}token${" b".repeat(5_000)}": ${R}`,
		);
	});

	it("stops reading a bare key 128 characters after the last keyword", () => {
		const within = `token${"a".repeat(128)}`;
		const past = `token${"a".repeat(129)}`;

		expect(redactSensitiveText(`${within}: abc`)).toBe(`${within}: ${R}`);
		expect(redactSensitiveText(`${past}: abc`)).toBe(`${past}: abc`);
		expect(redactSensitiveText(`${past}token: abc`)).toBe(`${past}token: ${R}`);
	});

	it.each([
		"token: ,",
		"token:",
		"token: }",
		`"token": ]`,
		"token-: abc",
		"token/ : abc",
		"author: abc",
		`"name": "token"`,
		`"token" = abc`,
	])("leaves %s as it is", (input) => {
		expect(redactSensitiveText(input)).toBe(input);
	});
});

describe("the mysql client rule", () => {
	it.each([
		["mysql mysql -phunter2 db", `mysql mysql -p${R} db`],
		[
			"mysql -u root db; mysql -phunter2 db",
			`mysql -u root db; mysql -p${R} db`,
		],
		["mysql db\nmysql -phunter2 db", `mysql db\nmysql -p${R} db`],
		["mysql db && mariadb -phunter2 db", `mysql db && mariadb -p${R} db`],
		[String.raw`mysql a\; mysql -phunter2`, String.raw`mysql a\; mysql -p${R}`],
		["mysql -p mysql -phunter2", `mysql -p mysql -p${R}`],
		["mysql db mysql db", "mysql db mysql db"],
	])("reads the client words of %s", (input, expected) => {
		expect(redactSensitiveText(input)).toBe(expected);
	});
});

describe("bounded key names", () => {
	it.each([
		["?api_key=abc&x=1", `?api_key=${R}&x=1`],
		["https://h/p?a=1&access_token=abc", `https://h/p?a=1&access_token=${R}`],
		["MY_SERVICE_SECRET_TOKEN=abc", `MY_SERVICE_SECRET_TOKEN=${R}`],
		["run --db-password=abc next", `run --db-password=${R} next`],
		["run --api-token abc next", `run --api-token ${R} next`],
	])("still masks %s", (input, expected) => {
		expect(redactSensitiveText(input)).toBe(expected);
	});
});

describe("client passwords written by shell-quote", () => {
	it.each([
		"ab&cd12",
		"x|yz|w",
		"p&&q",
		"a|b&c",
		"&start",
		"end|",
		"mid&dle|x",
	])("hides all of %s in a failed redis-cli command", (password) => {
		const command = `docker exec "$ID" redis-cli --no-auth-warning -a ${quoteShellArg("old&pw")} CONFIG SET requirepass ${quoteShellArg(password)}`;

		expect(redactSensitiveText(`Command failed: ${command}`)).toBe(
			`Command failed: docker exec "$ID" redis-cli --no-auth-warning -a ${R} CONFIG SET requirepass ${R}`,
		);
	});

	it("hides an escaped mongo password whole", () => {
		expect(redactSensitiveText("mongosh -u root -p pass\\&word; ls")).toBe(
			`mongosh -u root -p ${R}; ls`,
		);
	});

	it("leaves a client word without a password alone", () => {
		expect(redactSensitiveText("redis-cli ping && mongosh --eval 1")).toBe(
			"redis-cli ping && mongosh --eval 1",
		);
	});
});

describe("a quoted value over several lines with broad keys", () => {
	it("hides the whole value", () => {
		expect(
			redactSensitiveText(
				'PRIVATE_KEY="-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----"\nNEXT=1',
				{ broadKeys: true },
			),
		).toBe(`PRIVATE_KEY=${R}\nNEXT=1`);
	});

	it("keeps the rest of a one-line value hidden as before", () => {
		expect(
			redactSensitiveText('password = "abc" # set by hand', {
				broadKeys: true,
			}),
		).toBe(`password = ${R}`);
	});

	it("does not reach past an unclosed quote", () => {
		expect(
			redactSensitiveText('TOKEN="abc\nNAME=web\nPORT="80"', {
				broadKeys: true,
			}),
		).toBe(`TOKEN=${R}\nNAME=web\nPORT="80"`);
	});
});

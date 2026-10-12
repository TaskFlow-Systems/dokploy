import {
	applyEnvChanges,
	type EnvChange,
	getApplicationEnvRevision,
	getComposeEnvRevision,
	getEnvFieldRevision,
	getEnvVariableValue,
	listEnvVariables,
} from "@dokploy/server/utils/env-upsert";
import { parse } from "dotenv";
import { describe, expect, it } from "vitest";

const SENTINEL = "sentinel-value-0001";

describe("listEnvVariables", () => {
	it("lists every name once in file order with the last assignment deciding the flags", () => {
		const variables = listEnvVariables(`# header
SERVICE_URL=https://service.example.test
SERVICE_TOKEN=${SENTINEL}
EMPTY_FLAG=
export EXPORTED_KEY="${SENTINEL}"

SERVICE_URL=
QUOTED_EMPTY=""
`);

		expect(variables).toEqual([
			{ name: "SERVICE_URL", secret: false, empty: true },
			{ name: "SERVICE_TOKEN", secret: true, empty: false },
			{ name: "EMPTY_FLAG", secret: false, empty: true },
			{ name: "EXPORTED_KEY", secret: true, empty: false },
			{ name: "QUOTED_EMPTY", secret: false, empty: true },
		]);
		expect(JSON.stringify(variables)).not.toContain(SENTINEL);
	});

	it("does not mistake lines of a multi-line value or comments for variables", () => {
		const variables = listEnvVariables(`PRIVATE_BLOCK="first line
INNER_NAME=${SENTINEL}
last line"
# COMMENTED_OUT=${SENTINEL}
AFTER_BLOCK=1`);

		expect(variables.map(({ name }) => name)).toEqual([
			"PRIVATE_BLOCK",
			"AFTER_BLOCK",
		]);
	});

	it("does not list lines of an unquoted key block as variable names", () => {
		const fragment =
			"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
		const variables = listEnvVariables(`SERVICE_KEY=-----BEGIN PRIVATE KEY-----
${fragment}=
-----END PRIVATE KEY-----
AFTER_BLOCK=1
ApiUrlVersion2=x`);

		expect(variables.map(({ name }) => name)).toEqual([
			"SERVICE_KEY",
			"AFTER_BLOCK",
			"ApiUrlVersion2",
		]);
		expect(JSON.stringify(variables)).not.toContain(fragment);
	});

	it("treats a missing field as empty text", () => {
		expect(listEnvVariables(null)).toEqual([]);
		expect(listEnvVariables(undefined)).toEqual([]);
		expect(getEnvVariableValue(null, "ANY_NAME")).toBeUndefined();
	});
});

describe("applyEnvChanges", () => {
	it("creates, updates and leaves variables unchanged while keeping the layout", () => {
		const result = applyEnvChanges(
			`# Service settings
export SERVICE_URL = https://old.example.test # public address

  INDENTED_NAME=old
SERVICE_TOKEN=${SENTINEL}
`,
			[
				{
					name: "SERVICE_URL",
					source: "set",
					value: "https://new.example.test",
				},
				{ name: "INDENTED_NAME", source: "set", value: "two words" },
				{ name: "SERVICE_TOKEN", source: "set", value: SENTINEL },
				{ name: "NEW_NAME", source: "set", value: "created" },
			],
		);

		expect(result.changed).toBe(true);
		expect(result.env).toBe(`# Service settings
export SERVICE_URL = https://new.example.test # public address

  INDENTED_NAME="two words"
SERVICE_TOKEN=${SENTINEL}
NEW_NAME=created
`);
		expect(result.variables).toEqual([
			{ name: "SERVICE_URL", action: "updated", source: "set", secret: false },
			{
				name: "INDENTED_NAME",
				action: "updated",
				source: "set",
				secret: false,
			},
			{
				name: "SERVICE_TOKEN",
				action: "unchanged",
				source: "set",
				secret: true,
			},
			{ name: "NEW_NAME", action: "created", source: "set", secret: false },
		]);
	});

	it("returns the stored text untouched when nothing changes", () => {
		const env = "FIRST=1\r\nSECOND=2\r\n";
		const result = applyEnvChanges(env, [
			{ name: "FIRST", source: "set", value: "1" },
			{ name: "ABSENT", source: "remove" },
		]);

		expect(result).toEqual({
			env,
			changed: false,
			variables: [
				{ name: "FIRST", action: "unchanged", source: "set", secret: false },
				{ name: "ABSENT", action: "missing", source: "remove", secret: false },
			],
		});
	});

	it("starts a file from an empty or missing field", () => {
		for (const current of [null, undefined, ""]) {
			expect(
				applyEnvChanges(current, [
					{ name: "FIRST", source: "set", value: "1" },
					{ name: "SECOND", source: "copy", value: "" },
				]).env,
			).toBe("FIRST=1\nSECOND=");
		}
	});

	it("updates the effective assignment when a name is assigned twice", () => {
		const result = applyEnvChanges("NAME=first\nOTHER=1\nNAME=second\n", [
			{ name: "NAME", source: "set", value: "third" },
		]);

		expect(result.env).toBe("NAME=first\nOTHER=1\nNAME=third\n");
		expect(parse(result.env).NAME).toBe("third");
	});

	it("removes every assignment of a name and reports names that do not exist", () => {
		const result = applyEnvChanges(
			`# keep me
NAME=first
OTHER=1 # inline

export NAME=second
`,
			[
				{ name: "NAME", source: "remove" },
				{ name: "ABSENT", source: "remove" },
			],
		);

		expect(result.env).toBe(`# keep me
OTHER=1 # inline

`);
		expect(result.variables).toEqual([
			{ name: "NAME", action: "removed", source: "remove", secret: false },
			{ name: "ABSENT", action: "missing", source: "remove", secret: false },
		]);
	});

	it("keeps the trailing newline convention of the original text on removal", () => {
		expect(
			applyEnvChanges("FIRST=1\nLAST=2", [{ name: "LAST", source: "remove" }])
				.env,
		).toBe("FIRST=1");
		expect(
			applyEnvChanges("FIRST=1\nLAST=2\n", [{ name: "LAST", source: "remove" }])
				.env,
		).toBe("FIRST=1\n");
		expect(
			applyEnvChanges("ONLY=1\n", [{ name: "ONLY", source: "remove" }]).env,
		).toBe("");
	});

	it("replaces the whole span of a multi-line quoted value", () => {
		for (const quote of ['"', "'", "`"]) {
			const result = applyEnvChanges(
				`BEFORE=1
PRIVATE_BLOCK=${quote}first line
INNER_NAME=${SENTINEL}
last line${quote} # trailing note
AFTER=2
`,
				[{ name: "PRIVATE_BLOCK", source: "set", value: "single" }],
			);

			expect(result.env).toBe(`BEFORE=1
PRIVATE_BLOCK=single # trailing note
AFTER=2
`);
			expect(result.env).not.toContain(SENTINEL);
		}
	});

	it("removes the whole span of a multi-line quoted value", () => {
		for (const quote of ['"', "'", "`"]) {
			const result = applyEnvChanges(
				`BEFORE=1
PRIVATE_BLOCK=${quote}first line
INNER_NAME=${SENTINEL}
last line${quote}
AFTER=2`,
				[{ name: "PRIVATE_BLOCK", source: "remove" }],
			);

			expect(result.env).toBe("BEFORE=1\nAFTER=2");
		}
	});

	it("does not edit a line inside a multi-line value that looks like an assignment", () => {
		const env = `PRIVATE_BLOCK="first line
INNER_NAME=inside
last line"
`;
		const created = applyEnvChanges(env, [
			{ name: "INNER_NAME", source: "set", value: "outside" },
		]);
		const missing = applyEnvChanges(env, [
			{ name: "INNER_NAME", source: "remove" },
		]);

		expect(created.variables[0]?.action).toBe("created");
		expect(created.env).toBe(`${env}INNER_NAME=outside\n`);
		expect(parse(created.env).PRIVATE_BLOCK).toBe(
			"first line\nINNER_NAME=inside\nlast line",
		);
		expect(missing.variables[0]?.action).toBe("missing");
		expect(missing.env).toBe(env);
	});

	it("stores values so that the deploy-time parser reads back exactly what was sent", () => {
		const values = {
			JSON_VALUE: '{"name":"app-1","port":8080}',
			WINDOWS_PATH: "C:\\data\\new folder",
			MULTILINE_VALUE: "first line\nsecond line",
			MULTILINE_WITH_QUOTES: 'first "line"\nsecond line',
			SINGLE_QUOTED: "it's here",
			MIXED_QUOTES: 'it\'s "here"',
			HASH_VALUE: "value # not a comment",
			PADDED_VALUE: "  padded  ",
			ESCAPE_LOOKALIKE: "keep \\n as two characters",
			TRAILING_BACKSLASH: "ends with a backslash\\",
		};
		const result = applyEnvChanges(
			"EXISTING=1\n",
			Object.entries(values).map(([name, value]) => ({
				name,
				source: "set" as const,
				value,
			})),
		);

		expect(parse(result.env)).toEqual({ EXISTING: "1", ...values });
		expect(result.env).toContain('MULTILINE_VALUE="first line\\nsecond line"');
	});

	it("refuses a value it cannot store exactly and names only the variable", () => {
		const value = `${SENTINEL} 'one' "two" \`three\` # four`;

		expect(() =>
			applyEnvChanges("", [{ name: "ODD_VALUE", source: "set", value }]),
		).toThrow("Environment variable value cannot be stored safely: ODD_VALUE");
		try {
			applyEnvChanges("", [{ name: "ODD_VALUE", source: "set", value }]);
		} catch (error) {
			expect(String(error)).not.toContain(SENTINEL);
		}
	});

	it("refuses an edit that would change how other lines are parsed", () => {
		const edit = () =>
			applyEnvChanges(`BROKEN_QUOTE="${SENTINEL}`, [
				{ name: "NEXT_NAME", source: "set", value: " # note" },
			]);

		expect(edit).toThrow(
			"Environment variables cannot be edited safely: BROKEN_QUOTE, NEXT_NAME",
		);
		try {
			edit();
		} catch (error) {
			expect(String(error)).not.toContain(SENTINEL);
		}
	});

	it("previews a generated variable without touching the text", () => {
		const env = "SERVICE_TOKEN=current\n";
		const result = applyEnvChanges(env, [
			{ name: "SERVICE_TOKEN", source: "generate", value: null },
			{ name: "NEW_TOKEN", source: "generate", value: null },
		]);

		expect(result).toEqual({
			env,
			changed: true,
			variables: [
				{
					name: "SERVICE_TOKEN",
					action: "updated",
					source: "generate",
					secret: true,
				},
				{
					name: "NEW_TOKEN",
					action: "created",
					source: "generate",
					secret: true,
				},
			],
		});
	});

	it("reports a generated variable as updated even when it replaces an equal value", () => {
		const result = applyEnvChanges("SERVICE_TOKEN=same\n", [
			{ name: "SERVICE_TOKEN", source: "generate", value: "same" },
		]);

		expect(result.variables[0]?.action).toBe("updated");
		expect(result.env).toBe("SERVICE_TOKEN=same\n");
	});

	it("keeps well-formed files consistent under seeded random edits", () => {
		let seed = 0x9e3779b9;
		const random = () => {
			seed = (seed + 0x6d2b79f5) | 0;
			let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
			return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
		};
		const pick = <T>(items: readonly T[]) =>
			items[Math.floor(random() * items.length)] as T;
		const names = ["FIRST", "SECOND_KEY", "THIRD1", "lower_name", "FIFTH"];
		const values = [
			"plain",
			"two words",
			"",
			'{"port":8080}',
			"it's",
			"back\\slash",
			"hash # tag",
			"line one\nline two",
			"  padded ",
			"`ticks`",
			"name=value",
			"trailing\\",
			"\\n as text",
			"before\nSECOND_KEY=inner\nafter",
			"-----BEGIN BLOCK-----\nabc+/=\n-----END BLOCK-----\n",
		];
		const lines = [
			() => "# comment line",
			() => "",
			() => `${pick(names)}=${pick(["1", "abc", "", "x y", "v # c"])}`,
			() => `export ${pick(names)}=exported`,
			() => `  ${pick(names)} = spaced`,
			() => `${pick(names)}="quoted value" # note`,
			() => `${pick(names)}='single quoted'`,
			() => `${pick(names)}="multi\nINNER=1\nline"`,
			() => `${pick(names)}='multi\n# not a comment\nline'`,
			() => `${pick(names)}=\`multi\nline\``,
			() => "dotted.name=1",
		];
		const commentCount = (text: string) =>
			text.split("\n").filter((line) => line === "# comment line").length;

		for (let round = 0; round < 3000; round++) {
			const body = Array.from({ length: Math.floor(random() * 7) }, () =>
				pick(lines)(),
			).join("\n");
			const env = random() < 0.5 && body ? `${body}\n` : body;
			const changes = new Map<string, EnvChange>();
			for (let count = 1 + Math.floor(random() * 3); count > 0; count--) {
				const name = pick(names);
				changes.set(
					name,
					random() < 0.3
						? { name, source: "remove" }
						: { name, source: "set", value: pick(values) },
				);
			}

			const expected = new Map(Object.entries(parse(env)));
			for (const change of changes.values()) {
				if (change.source === "remove") {
					expected.delete(change.name);
				} else if (change.value !== null) {
					expected.set(change.name, change.value);
				}
			}

			const result = applyEnvChanges(env, [...changes.values()]);
			const repeated = applyEnvChanges(result.env, [...changes.values()]);

			expect(new Map(Object.entries(parse(result.env)))).toEqual(expected);
			expect(commentCount(result.env)).toBe(commentCount(env));
			expect(repeated.changed).toBe(false);
			expect(repeated.env).toBe(result.env);
			if (env.endsWith("\n") && result.env !== "") {
				expect(result.env.endsWith("\n")).toBe(true);
			}
		}
	});
});

describe("getEnvFieldRevision", () => {
	it("is stable and keyed by scope, id, field and text", () => {
		const revision = getEnvFieldRevision(
			"postgres",
			"postgres-1",
			"env",
			`SERVICE_TOKEN=${SENTINEL}`,
		);

		expect(revision).toMatch(/^env-field-v1:[A-Za-z0-9_-]{43}$/);
		expect(revision).not.toContain(SENTINEL);
		expect(revision).toBe(
			getEnvFieldRevision(
				"postgres",
				"postgres-1",
				"env",
				`SERVICE_TOKEN=${SENTINEL}`,
			),
		);

		const others = [
			getEnvFieldRevision("mysql", "postgres-1", "env", "A=1"),
			getEnvFieldRevision("postgres", "postgres-2", "env", "A=1"),
			getEnvFieldRevision("postgres", "postgres-1", "buildArgs", "A=1"),
			getEnvFieldRevision("postgres", "postgres-1", "env", "A=2"),
			getEnvFieldRevision("postgres", "postgres-1", "env", "A=1"),
			getApplicationEnvRevision("postgres-1", "A=1"),
			getComposeEnvRevision("postgres-1", "A=1"),
		];
		expect(new Set(others).size).toBe(others.length);
	});

	it("length-prefixes its parts so shifted boundaries give other revisions", () => {
		expect(getEnvFieldRevision("project", "ab", "env", "c")).not.toBe(
			getEnvFieldRevision("project", "a", "env", "bc"),
		);
		expect(getEnvFieldRevision("project", "id", "env", null)).toBe(
			getEnvFieldRevision("project", "id", "env", ""),
		);
	});
});

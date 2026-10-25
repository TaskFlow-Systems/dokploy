import {
	applyEnvLayout,
	type EnvLayoutInputItem,
	readEnvLayout,
} from "@dokploy/server/utils/env-layout";
import { parse } from "dotenv";
import { describe, expect, it } from "vitest";

const SENTINEL = "sentinel-value-0001";
const KEY_LINE =
	"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj=";

const ENV = `# Production settings
SERVICE_URL=https://app.example.test # public address
# OLD_TOKEN=${SENTINEL}
# Signs the session cookies
AUTH_SECRET=${SENTINEL}

SERVICE_KEY=-----BEGIN PRIVATE KEY-----
${KEY_LINE}
-----END PRIVATE KEY-----
NAME=first
MULTI_LINE="first line
second line"
NAME=second
`;

describe("readEnvLayout", () => {
	it("lists variables, comments and blank lines in file order without values", () => {
		const layout = readEnvLayout(ENV);

		expect(layout).toEqual([
			{ type: "comment", ref: "c1", text: "Production settings" },
			{ type: "variable", name: "SERVICE_URL" },
			{ type: "hidden", ref: "h1", kind: "comment", variable: "OLD_TOKEN" },
			{ type: "comment", ref: "c2", text: "Signs the session cookies" },
			{ type: "variable", name: "AUTH_SECRET" },
			{ type: "blank" },
			{ type: "variable", name: "SERVICE_KEY" },
			{ type: "hidden", ref: "h2", kind: "overridden", variable: "NAME" },
			{ type: "variable", name: "MULTI_LINE" },
			{ type: "variable", name: "NAME" },
		]);
		const text = JSON.stringify(layout);
		expect(text).not.toContain(SENTINEL);
		expect(text).not.toContain(KEY_LINE);
		expect(text).not.toContain("public address");
	});

	it("withholds comments that could hold a value", () => {
		const hidden = [
			`# export API_TOKEN = ${SENTINEL}`,
			`# DATABASE_PASSWORD: ${SENTINEL}`,
			"# admin password: hunter2",
			"# пароль=hunter2",
			"# mirror at https://deploy:hunter2@git.example.test/repo",
			"# -----BEGIN OPENSSH PRIVATE KEY-----",
			"# Authorization: Bearer abc",
			`# old one was ${SENTINEL}`,
			"# 0123456789abcdef0123",
		];
		const shown = [
			"# === Database ===",
			"# TODO: rotate before release",
			"# Secret used to sign sessions",
			"#no space after the hash",
			"# Docs: https://docs.example.test/env",
		];

		const layout = readEnvLayout([...hidden, ...shown, "LAST=1"].join("\n"));

		expect(layout.slice(0, hidden.length)).toEqual(
			hidden.map((_, index) =>
				expect.objectContaining({ ref: `h${index + 1}` }),
			),
		);
		expect(layout[0]).toEqual({
			type: "hidden",
			ref: "h1",
			kind: "comment",
			variable: "API_TOKEN",
		});
		expect(layout[1]).toEqual({
			type: "hidden",
			ref: "h2",
			kind: "comment",
			variable: "DATABASE_PASSWORD",
		});
		expect(layout.slice(hidden.length, -1)).toEqual([
			{ type: "comment", ref: "c1", text: "=== Database ===" },
			{ type: "comment", ref: "c2", text: "TODO: rotate before release" },
			{ type: "comment", ref: "c3", text: "Secret used to sign sessions" },
			{ type: "comment", ref: "c4", text: "no space after the hash" },
			{
				type: "comment",
				ref: "c5",
				text: "Docs: https://docs.example.test/env",
			},
		]);
		const text = JSON.stringify(layout);
		for (const secret of [SENTINEL, "hunter2", "0123456789abcdef0123"]) {
			expect(text).not.toContain(secret);
		}
	});

	it("hides lines dotenv cannot read when no variable comes right before them", () => {
		expect(
			readEnvLayout(`${KEY_LINE}
-----END PRIVATE KEY-----

FIRST=1
# note
stray text`),
		).toEqual([
			{ type: "hidden", ref: "h1", kind: "unreadable" },
			{ type: "blank" },
			{ type: "variable", name: "FIRST" },
			{ type: "comment", ref: "c1", text: "note" },
			{ type: "hidden", ref: "h2", kind: "unreadable" },
		]);
	});

	it("treats a missing field as an empty layout", () => {
		expect(readEnvLayout(null)).toEqual([]);
		expect(readEnvLayout(undefined)).toEqual([]);
		expect(readEnvLayout("")).toEqual([]);
	});

	it("refuses a text where an assignment shares a line with other text", () => {
		expect(() => readEnvLayout("# note NAME=1\n")).toThrow(
			"cannot be shown or rearranged safely",
		);
	});
});

describe("applyEnvLayout", () => {
	const sections: EnvLayoutInputItem[] = [
		{ type: "comment", ref: "c1" },
		{ type: "blank" },
		{ type: "comment", text: "=== Web ===" },
		{ type: "variable", name: "SERVICE_URL" },
		{ type: "hidden", ref: "h2" },
		{ type: "variable", name: "NAME" },
		{ type: "blank" },
		{ type: "comment", text: "=== Auth ===" },
		{ type: "comment", ref: "c2", text: "Signs session cookies" },
		{ type: "variable", name: "AUTH_SECRET" },
		{ type: "hidden", ref: "h1" },
		{ type: "variable", name: "SERVICE_KEY" },
		{ type: "comment", text: "" },
		{ type: "variable", name: "MULTI_LINE" },
	];

	it("arranges variables into sections and keeps every value byte for byte", () => {
		const result = applyEnvLayout(ENV, sections);

		expect(result.changed).toBe(true);
		expect(result.env).toBe(`# Production settings

# === Web ===
SERVICE_URL=https://app.example.test # public address
NAME=first
NAME=second

# === Auth ===
# Signs session cookies
AUTH_SECRET=${SENTINEL}
# OLD_TOKEN=${SENTINEL}
SERVICE_KEY=-----BEGIN PRIVATE KEY-----
${KEY_LINE}
-----END PRIVATE KEY-----
#
MULTI_LINE="first line
second line"
`);
		expect(parse(result.env)).toEqual(parse(ENV));
		expect(result.layout).toEqual([
			{ type: "comment", ref: "c1", text: "Production settings" },
			{ type: "blank" },
			{ type: "comment", ref: "c2", text: "=== Web ===" },
			{ type: "variable", name: "SERVICE_URL" },
			{ type: "hidden", ref: "h1", kind: "overridden", variable: "NAME" },
			{ type: "variable", name: "NAME" },
			{ type: "blank" },
			{ type: "comment", ref: "c3", text: "=== Auth ===" },
			{ type: "comment", ref: "c4", text: "Signs session cookies" },
			{ type: "variable", name: "AUTH_SECRET" },
			{ type: "hidden", ref: "h2", kind: "comment", variable: "OLD_TOKEN" },
			{ type: "variable", name: "SERVICE_KEY" },
			{ type: "comment", ref: "c5", text: "" },
			{ type: "variable", name: "MULTI_LINE" },
		]);
		expect(JSON.stringify(result.layout)).not.toContain(SENTINEL);
	});

	it("keeps the text untouched when the layout is sent back unchanged", () => {
		const env = "# Header\r\n#Tight comment\r\nFIRST=1\r\n\r\nSECOND=2\r\n";
		const layout = readEnvLayout(env);

		expect(applyEnvLayout(env, layout)).toEqual({
			env,
			changed: false,
			layout,
		});
	});

	it("rewrites a comment only when its text changes", () => {
		const env = "#   Indented note\nFIRST=1\n";

		expect(readEnvLayout(env)[0]).toEqual({
			type: "comment",
			ref: "c1",
			text: "  Indented note",
		});
		expect(
			applyEnvLayout(env, [
				{ type: "comment", ref: "c1", text: "  Indented note" },
				{ type: "variable", name: "FIRST" },
			]).changed,
		).toBe(false);
		expect(
			applyEnvLayout(env, [
				{ type: "comment", ref: "c1", text: "New note" },
				{ type: "variable", name: "FIRST" },
			]).env,
		).toBe("# New note\nFIRST=1\n");
	});

	it("drops a shown comment that the layout leaves out", () => {
		expect(
			applyEnvLayout("# old header\nFIRST=1", [
				{ type: "variable", name: "FIRST" },
			]).env,
		).toBe("FIRST=1");
	});

	it("starts an empty text with comments only", () => {
		expect(
			applyEnvLayout("", [{ type: "comment", text: "=== Settings ===" }]),
		).toEqual({
			env: "# === Settings ===",
			changed: true,
			layout: [{ type: "comment", ref: "c1", text: "=== Settings ===" }],
		});
	});

	it("names every problem with names and refs only", () => {
		const attempt = () =>
			applyEnvLayout(ENV, [
				{ type: "variable", name: "SERVICE_URL" },
				{ type: "variable", name: "SERVICE_URL" },
				{ type: "variable", name: "UNKNOWN_NAME" },
				{ type: "comment", ref: "c1" },
				{ type: "comment", ref: "c1" },
				{ type: "comment", ref: "c9" },
				{ type: "hidden", ref: "h7" },
			]);

		expect(attempt).toThrow(
			"The layout names variables that do not exist: UNKNOWN_NAME. " +
				"The layout places variables more than once: SERVICE_URL. " +
				"The layout leaves out variables: AUTH_SECRET, SERVICE_KEY, MULTI_LINE, NAME. Every variable has to be placed; delete one with remove instead. " +
				"The layout refers to lines that do not exist: c9, h7. " +
				"The layout places lines more than once: c1. " +
				"The layout leaves out hidden lines: h1, h2. Their text is not shown, so they can be moved but not dropped.",
		);
		const message = (() => {
			try {
				attempt();
			} catch (error) {
				return (error as Error).message;
			}
		})();
		expect(message).not.toContain(SENTINEL);
	});

	it("keeps an earlier assignment of a name above the one that counts", () => {
		const env = "NAME=first\nOTHER=1\nNAME=second\n";

		expect(readEnvLayout(env)).toEqual([
			{ type: "hidden", ref: "h1", kind: "overridden", variable: "NAME" },
			{ type: "variable", name: "OTHER" },
			{ type: "variable", name: "NAME" },
		]);
		expect(
			applyEnvLayout(env, [
				{ type: "variable", name: "OTHER" },
				{ type: "hidden", ref: "h1" },
				{ type: "variable", name: "NAME" },
			]).env,
		).toBe("OTHER=1\nNAME=first\nNAME=second\n");
		expect(() =>
			applyEnvLayout(env, [
				{ type: "variable", name: "NAME" },
				{ type: "hidden", ref: "h1" },
				{ type: "variable", name: "OTHER" },
			]),
		).toThrow(
			"These hidden lines are earlier assignments of a variable and have to stay above it: h1 (NAME).",
		);
	});

	it("refuses a layout after which dotenv would read another value", () => {
		const env = 'LATER=1 "\nOPEN="value\n';

		expect(() =>
			applyEnvLayout(env, [
				{ type: "variable", name: "OPEN" },
				{ type: "variable", name: "LATER" },
			]),
		).toThrow("Environment variables cannot be rearranged safely: LATER, OPEN");
	});
});

import { parse } from "dotenv";
import { describe, expect, it } from "vitest";
import {
	formatEnvValue,
	mergeComposeEnv,
	readComposeEnvState,
} from "@/lib/compose-env";

const HEADER = ["Defaults from ./docker-compose.yml (branch main)."];

describe("formatEnvValue", () => {
	it.each([
		["8080", "8080"],
		["", ""],
		["http://origin:80", "http://origin:80"],
		["a b", "'a b'"],
		["color #fff", "'color #fff'"],
		["it's", `"it's"`],
		[`it's "quoted"`, `\`it's "quoted"\``],
		["C:\\path's", "`C:\\path's`"],
	])("writes %j so dotenv reads it back unchanged", (value, formatted) => {
		expect(formatEnvValue(value)).toBe(formatted);
		expect(parse(`KEY=${formatted}`).KEY).toBe(value);
	});
});

describe("readComposeEnvState", () => {
	it("tells set, listed and absent variables apart", () => {
		const stateOf = readComposeEnvState(
			[
				"SET=1",
				"export EXPORTED=2",
				"# LISTED=3",
				"# BOTH=old",
				"BOTH=new",
				"# a note about PROSE = text",
			].join("\n"),
		);

		expect(stateOf("SET")).toEqual({ kind: "set" });
		expect(stateOf("EXPORTED")).toEqual({ kind: "set" });
		expect(stateOf("LISTED")).toEqual({ kind: "listed", value: "3" });
		expect(stateOf("BOTH")).toEqual({ kind: "set" });
		expect(stateOf("PROSE")).toEqual({ kind: "absent" });
		expect(stateOf("MISSING")).toEqual({ kind: "absent" });
	});
});

describe("mergeComposeEnv", () => {
	it("adds commented defaults that dotenv does not apply", () => {
		const merged = mergeComposeEnv(
			"",
			[
				{ name: "PORT", value: "8080", services: ["web"] },
				{ name: "MODE", value: "off", services: ["web"] },
			],
			{ active: false, header: HEADER },
		);

		expect(merged).toBe(
			[
				"# Defaults from ./docker-compose.yml (branch main).",
				"# PORT=8080",
				"# MODE=off",
				"",
			].join("\n"),
		);
		expect(parse(merged)).toEqual({});
	});

	it("adds active lines that dotenv applies", () => {
		const merged = mergeComposeEnv(
			"",
			[{ name: "MODE", value: "a b", services: ["web"] }],
			{ active: true, header: HEADER },
		);

		expect(parse(merged)).toEqual({ MODE: "a b" });
	});

	it("never changes a variable that is already set", () => {
		const merged = mergeComposeEnv(
			"PORT=9000\nSECRET=mine",
			[
				{ name: "PORT", value: "8080", services: ["web"] },
				{ name: "SECRET", value: "change-me", services: ["web"] },
			],
			{ active: true, header: HEADER },
		);

		expect(merged).toBe("PORT=9000\nSECRET=mine");
	});

	it("refreshes commented defaults in place instead of adding them again", () => {
		const env = "KEEP=1\n# LIMIT=60\n# my own note\nOTHER=2\n";

		expect(
			mergeComposeEnv(
				env,
				[{ name: "LIMIT", value: "100", services: ["engine"] }],
				{ active: false, header: HEADER },
			),
		).toBe("KEEP=1\n# LIMIT=100\n# my own note\nOTHER=2\n");

		expect(
			mergeComposeEnv(
				env,
				[{ name: "LIMIT", value: "100", services: ["engine"] }],
				{ active: true, header: HEADER },
			),
		).toBe("KEEP=1\nLIMIT=100\n# my own note\nOTHER=2\n");
	});

	it("appends after the existing text and groups lines by service", () => {
		const merged = mergeComposeEnv(
			"KEEP=1\n\n",
			[
				{ name: "HTTP_PORT", value: "8080", services: ["caddy"] },
				{
					name: "REDIS_URL",
					value: "redis://redis:6379",
					services: ["engine"],
				},
				{ name: "PATHS", value: "/hook", services: ["caddy", "engine"] },
				{ name: "TLS", value: "off", services: ["caddy"] },
				{ name: "NETWORK", value: "edge", services: [] },
			],
			{
				active: false,
				header: [...HEADER, "Remove the # to override a default."],
			},
		);

		expect(merged).toBe(
			[
				"KEEP=1",
				"",
				"# Defaults from ./docker-compose.yml (branch main).",
				"# Remove the # to override a default.",
				"",
				"# Used by caddy",
				"# HTTP_PORT=8080",
				"# TLS=off",
				"",
				"# Used by engine",
				"# REDIS_URL=redis://redis:6379",
				"",
				"# Used by caddy, engine",
				"# PATHS=/hook",
				"",
				"# Not tied to a service",
				"# NETWORK=edge",
				"",
			].join("\n"),
		);
		expect(parse(merged)).toEqual({ KEEP: "1" });
	});

	it("leaves the text alone when nothing is left to add", () => {
		expect(
			mergeComposeEnv("A=1", [{ name: "A", value: "2", services: [] }], {
				active: false,
				header: HEADER,
			}),
		).toBe("A=1");
	});
});

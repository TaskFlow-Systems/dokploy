import {
	extractComposeVariables,
	findVariableReferences,
} from "@dokploy/server/utils/docker/compose-variables";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const variablesOf = (yaml: string) =>
	extractComposeVariables(parse(yaml, { maxAliasCount: 10000 }));

describe("findVariableReferences", () => {
	it("reads every interpolation form compose supports", () => {
		expect(
			findVariableReferences(
				"${A} ${B:-one} ${C-two} ${D:?need D} ${E?need E} ${F:+on} $G",
			),
		).toEqual([
			{ name: "A", operator: null, value: null },
			{ name: "B", operator: ":-", value: "one" },
			{ name: "C", operator: "-", value: "two" },
			{ name: "D", operator: ":?", value: "need D" },
			{ name: "E", operator: "?", value: "need E" },
			{ name: "F", operator: ":+", value: "on" },
			{ name: "G", operator: null, value: null },
		]);
	});

	it("treats $$ as a literal dollar sign", () => {
		expect(findVariableReferences("echo $$HOME $${NOT_A_VAR} ${REAL}")).toEqual(
			[{ name: "REAL", operator: null, value: null }],
		);
	});

	it("keeps nested defaults whole and reads the variables inside them", () => {
		expect(
			findVariableReferences("${URL:-http://${HOST:-localhost}:80}"),
		).toEqual([
			{
				name: "URL",
				operator: ":-",
				value: "http://${HOST:-localhost}:80",
			},
			{ name: "HOST", operator: ":-", value: "localhost" },
		]);
	});

	it("ignores text that only looks like a reference", () => {
		expect(findVariableReferences("$ ${ ${1A} ${UNCLOSED:-x ${A B}")).toEqual(
			[],
		);
	});
});

describe("extractComposeVariables", () => {
	it("lists variables with their defaults and the services using them", () => {
		const variables = variablesOf(`
services:
  caddy:
    image: caddy
    ports:
      - "\${HTTP_PORT:-8080}:80"
    environment:
      MODE: \${MODE:-off}
      PATHS: \${PATHS:-/payments/webhook}
  engine:
    image: engine
    environment:
      PATHS: \${PATHS:-/payments/webhook}
      TOKEN: \${ADMIN_TOKEN:-}
      HOST: \${DB_HOST}
      REQUIRED: \${DB_PASSWORD:?set a password}
`);

		expect(variables).toEqual([
			{
				name: "HTTP_PORT",
				defaultValue: "8080",
				required: false,
				conflictingDefaults: false,
				services: ["caddy"],
				secret: false,
				placeholder: false,
			},
			{
				name: "MODE",
				defaultValue: "off",
				required: false,
				conflictingDefaults: false,
				services: ["caddy"],
				secret: false,
				placeholder: false,
			},
			{
				name: "PATHS",
				defaultValue: "/payments/webhook",
				required: false,
				conflictingDefaults: false,
				services: ["caddy", "engine"],
				secret: false,
				placeholder: false,
			},
			{
				name: "ADMIN_TOKEN",
				defaultValue: "",
				required: false,
				conflictingDefaults: false,
				services: ["engine"],
				secret: true,
				placeholder: false,
			},
			{
				name: "DB_HOST",
				defaultValue: null,
				required: false,
				conflictingDefaults: false,
				services: ["engine"],
				secret: false,
				placeholder: false,
			},
			{
				name: "DB_PASSWORD",
				defaultValue: null,
				required: true,
				conflictingDefaults: false,
				services: ["engine"],
				secret: true,
				placeholder: false,
			},
		]);
	});

	it("flags defaults that ask to be replaced", () => {
		const variables = variablesOf(`
services:
  engine:
    environment:
      SALT: \${HASH_SALT:-change-me-hash-salt}
      ADMIN: \${CAP_ADMIN_KEY:-replace_me}
      TTL: \${PASS_TTL_SECONDS:-1800}
`);

		expect(
			variables.map(({ name, secret, placeholder }) => [
				name,
				secret,
				placeholder,
			]),
		).toEqual([
			["HASH_SALT", false, true],
			["CAP_ADMIN_KEY", true, true],
			["PASS_TTL_SECONDS", true, false],
		]);
	});

	it("skips variables that appear only in YAML comments", () => {
		const variables = variablesOf(`
services:
  cap:
    # The dashboard listens on 127.0.0.1:\${DASHBOARD_PORT} of the host.
    ports:
      - "127.0.0.1:\${DASHBOARD_PORT:-3100}:3000"
    # \${ONLY_IN_A_COMMENT:-x}
`);

		expect(
			variables.map(({ name, defaultValue }) => [name, defaultValue]),
		).toEqual([["DASHBOARD_PORT", "3100"]]);
	});

	it("follows anchors into the services that use them", () => {
		const variables = variablesOf(`
x-common: &common
  environment:
    LOG_LEVEL: \${LOG_LEVEL:-info}
services:
  api:
    <<: *common
    image: api
  worker:
    <<: *common
    image: worker
`);

		expect(variables).toMatchObject([
			{ name: "LOG_LEVEL", defaultValue: "info", services: ["api", "worker"] },
		]);
	});

	it("flags a variable whose defaults differ between places", () => {
		const variables = variablesOf(`
services:
  a:
    environment:
      LIMIT: \${LIMIT:-60}
  b:
    environment:
      LIMIT: \${LIMIT:-120}
`);

		expect(variables).toMatchObject([
			{ name: "LIMIT", defaultValue: "60", conflictingDefaults: true },
		]);
	});

	it("keeps variables outside services and leaves out the ones Dokploy sets", () => {
		const variables = variablesOf(`
services:
  web:
    container_name: \${APP_NAME}-web
    image: \${COMPOSE_PROJECT_NAME}:latest
networks:
  edge:
    name: \${EDGE_NETWORK:-edge}
`);

		expect(variables).toMatchObject([
			{ name: "EDGE_NETWORK", defaultValue: "edge", services: [] },
		]);
	});

	it("returns nothing for an empty or non-mapping file", () => {
		expect(extractComposeVariables(null)).toEqual([]);
		expect(extractComposeVariables(["${A}"])).toEqual([]);
	});
});

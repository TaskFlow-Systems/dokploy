import { REDACTED_SECRET_VALUE as R } from "@dokploy/server/utils/security/redaction";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	rows: new Map<unknown, Record<string, unknown>[]>(),
	selects: 0,
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		select: () => ({
			from: async (table: unknown) => {
				state.selects += 1;
				return state.rows.get(table) ?? [];
			},
		}),
	},
}));

const schema = await import("@dokploy/server/db/schema");
const { getKnownSecretMatcher, resetKnownSecretMatcherCache } = await import(
	"@dokploy/server/services/known-secrets"
);
const { scrubSecretText } = await import(
	"@dokploy/server/utils/security/secret-scrub"
);

const TABLE_COUNT = 11;

beforeEach(() => {
	state.rows.clear();
	state.selects = 0;
	resetKnownSecretMatcherCache();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("getKnownSecretMatcher", () => {
	it("collects secrets from every place the panel stores them", async () => {
		state.rows.set(schema.applications, [
			{
				env: "API_TOKEN=App-Env-Value-1",
				previewEnv: "API_TOKEN=App-Preview-Value-1",
				buildArgs: "NPM_TOKEN=App-BuildArg-Value-1",
				buildSecrets: "SIGNING_KEY=App-BuildSecret-Value-1",
				previewBuildArgs: "NPM_TOKEN=App-PreviewArg-Value-1",
				previewBuildSecrets: "SIGNING_KEY=App-PreviewSecret-Value-1",
				password: "App-Registry-Pass-1",
			},
		]);
		state.rows.set(schema.compose, [
			{
				env: "JWT_SECRET=Compose-Value-1",
				composeFile:
					"services:\n  api:\n    environment:\n      API_TOKEN: Compose-Inline-1\n      - bad",
			},
			{
				env: null,
				composeFile:
					"services:\n  api:\n    environment:\n      API_TOKEN: Compose-Inline-2\n      COLOUR: teal\n    build:\n      args:\n        - NPM_TOKEN=Compose-Inline-3\n",
			},
		]);
		state.rows.set(schema.postgres, [
			{ env: null, password: "Postgres-Pass-1" },
		]);
		state.rows.set(schema.mysql, [
			{ env: "", password: "Mysql-Pass-1", rootPassword: "Mysql-Root-1" },
		]);
		state.rows.set(schema.mariadb, [
			{ env: "", password: "Maria-Pass-1", rootPassword: "Maria-Root-1" },
		]);
		state.rows.set(schema.mongo, [{ env: "", password: "Mongo-Pass-1" }]);
		state.rows.set(schema.redis, [{ env: "", password: "Redis-Pass-1" }]);
		state.rows.set(schema.libsql, [{ env: "", password: "Libsql-Pass-1" }]);
		state.rows.set(schema.projects, [{ env: "SHARED_KEY=Project-Value-1" }]);
		state.rows.set(schema.environments, [
			{ env: "SHARED_KEY=Environment-Value-1" },
		]);
		state.rows.set(schema.registry, [{ password: "Registry-Pass-1" }]);

		const matcher = await getKnownSecretMatcher();
		const secrets = [
			"App-Env-Value-1",
			"App-Preview-Value-1",
			"App-BuildArg-Value-1",
			"App-BuildSecret-Value-1",
			"App-PreviewArg-Value-1",
			"App-PreviewSecret-Value-1",
			"App-Registry-Pass-1",
			"Compose-Value-1",
			"Compose-Inline-2",
			"Compose-Inline-3",
			"Postgres-Pass-1",
			"Mysql-Pass-1",
			"Mysql-Root-1",
			"Maria-Pass-1",
			"Maria-Root-1",
			"Mongo-Pass-1",
			"Redis-Pass-1",
			"Libsql-Pass-1",
			"Project-Value-1",
			"Environment-Value-1",
			"Registry-Pass-1",
		];

		expect(matcher.size).toBe(secrets.length);
		expect(scrubSecretText(secrets.join(" | "), matcher)).toBe(
			secrets.map(() => R).join(" | "),
		);
	});

	it("reuses the result until the cache expires or is reset", async () => {
		vi.useFakeTimers();

		await getKnownSecretMatcher();
		await getKnownSecretMatcher();
		expect(state.selects).toBe(TABLE_COUNT);

		vi.advanceTimersByTime(31_000);
		await getKnownSecretMatcher();
		expect(state.selects).toBe(TABLE_COUNT * 2);

		resetKnownSecretMatcherCache();
		await getKnownSecretMatcher();
		expect(state.selects).toBe(TABLE_COUNT * 3);
	});

	it("shares one load between concurrent callers", async () => {
		await Promise.all([getKnownSecretMatcher(), getKnownSecretMatcher()]);

		expect(state.selects).toBe(TABLE_COUNT);
	});

	it("does not cache a failed load", async () => {
		const failure = new Error("db down");
		const original = state.rows.get;
		state.rows.get = () => {
			throw failure;
		};
		await expect(getKnownSecretMatcher()).rejects.toThrow("db down");

		state.rows.get = original;
		await expect(getKnownSecretMatcher()).resolves.toMatchObject({ size: 0 });
	});
});

import { REDACTED_SECRET_VALUE as R } from "@dokploy/server/utils/security/redaction";
import {
	buildKnownSecretMatcher,
	collectEnvSecretValues,
	collectSecretValue,
	isSensitiveOutputKey,
	scrubSecretOutput,
	scrubSecretText,
} from "@dokploy/server/utils/security/secret-scrub";
import { describe, expect, it } from "vitest";

const SENTINEL = "Zx9-sentinel-Value42";

describe("isSensitiveOutputKey", () => {
	it.each([
		"env",
		"previewEnv",
		"Env",
		"buildArgs",
		"buildSecrets",
		"previewBuildSecrets",
		"password",
		"databaseRootPassword",
		"refreshToken",
		"metricsToken",
		"clientSecret",
		"privateKey",
		"apiKey",
		"accessKey",
		"secretAccessKey",
		"webhookUrl",
		"headers",
		"licenseKey",
		"authorization",
	])("treats %s as secret-bearing", (key) => {
		expect(isSensitiveOutputKey(key)).toBe(true);
	});

	it.each([
		"environment",
		"environmentId",
		"secretName",
		"apiKeyId",
		"tokenType",
		"apiKeys",
		"passwordUpdatedAt",
		"publicKey",
		"createEnvFile",
		"composeFile",
		"content",
		"command",
	])("leaves %s to the text scrubber", (key) => {
		expect(isSensitiveOutputKey(key)).toBe(false);
	});
});

describe("scrubSecretOutput", () => {
	it("blanks secret fields at any depth and keeps the rest", () => {
		const scrubbed = scrubSecretOutput({
			applicationId: "app-1",
			name: "api",
			env: `TOKEN=${SENTINEL}\nPORT=3000`,
			environment: {
				name: "production",
				env: `SHARED=${SENTINEL}`,
				project: { name: "shop", env: `ROOT=${SENTINEL}` },
			},
			registry: { registryUrl: "registry.example.test", password: SENTINEL },
		});

		expect(scrubbed).toEqual({
			applicationId: "app-1",
			name: "api",
			env: R,
			environment: {
				name: "production",
				env: R,
				project: { name: "shop", env: R },
			},
			registry: { registryUrl: "registry.example.test", password: R },
		});
	});

	it("keeps flags, numbers, nulls and empty strings under secret-looking keys", () => {
		const value = {
			variables: [{ name: "API_TOKEN", secret: true, empty: false }],
			password: null,
			env: "",
			inputTokens: 12,
		};

		expect(scrubSecretOutput(value)).toEqual(value);
	});

	it("keeps the names of a docker Env list and of a header map", () => {
		const scrubbed = scrubSecretOutput({
			Config: {
				Env: [`API_TOKEN=${SENTINEL}`, "PATH=/usr/bin", "not an assignment"],
			},
			headers: { Authorization: `Bearer ${SENTINEL}`, "X-Trace": "on" },
		});

		expect(scrubbed).toEqual({
			Config: { Env: [`API_TOKEN=${R}`, `PATH=${R}`, R] },
			headers: { Authorization: R, "X-Trace": R },
		});
	});

	it("never rewrites identifiers and names", () => {
		const matcher = buildKnownSecretMatcher(["svc-auth-Prod1"]);
		const value = {
			appName: "svc-auth-Prod1",
			name: "svc-auth-Prod1",
			applicationId: "svc-auth-Prod1",
			containerName: "svc-auth-Prod1.1.abc",
			description: "runs svc-auth-Prod1",
		};

		expect(scrubSecretOutput(value, matcher)).toEqual({
			...value,
			description: `runs ${R}`,
		});
	});

	it("leaves dates and other non-plain values untouched", () => {
		const createdAt = new Date("2026-01-01T00:00:00Z");

		expect(scrubSecretOutput({ createdAt, count: 3, ok: true })).toEqual({
			createdAt,
			count: 3,
			ok: true,
		});
	});

	it("scrubs free text fields instead of blanking them", () => {
		const scrubbed = scrubSecretOutput({
			composeFile: [
				"services:",
				"  api:",
				"    environment:",
				"      DATABASE_PASSWORD: hunter2-hunter2",
				"      SESSION_SECRET: ${SESSION_SECRET}",
				"      PORT: 3000",
			].join("\n"),
			command: "server --api-token=abc123 --port 8080",
		}) as { composeFile: string; command: string };

		expect(scrubbed.composeFile).toContain(`DATABASE_PASSWORD: ${R}`);
		expect(scrubbed.composeFile).toContain("SESSION_SECRET: ${SESSION_SECRET}");
		expect(scrubbed.composeFile).toContain("PORT: 3000");
		expect(scrubbed.command).toBe(`server --api-token=${R} --port 8080`);
	});
});

describe("scrubSecretText", () => {
	it("removes known secret values wherever they appear", () => {
		const matcher = buildKnownSecretMatcher([SENTINEL]);

		expect(
			scrubSecretText(
				`connecting with ${SENTINEL}\nretry ${SENTINEL}!`,
				matcher,
			),
		).toBe(`connecting with ${R}\nretry ${R}!`);
	});

	it("replaces a secret that contains another one as a whole", () => {
		const matcher = buildKnownSecretMatcher(["abcd1234", "abcd1234-wxyz5678"]);

		expect(scrubSecretText("key abcd1234-wxyz5678 end", matcher)).toBe(
			`key ${R} end`,
		);
	});

	it.each([
		["DB_PASS=s3cr3tValue", `DB_PASS=${R}`],
		["export JWT_SIGNING_KEY='abc def'", `export JWT_SIGNING_KEY=${R}`],
		["SESSION_SALT=qwerty", `SESSION_SALT=${R}`],
		["SENTRY_DSN=https://key@sentry.example.test/1", `SENTRY_DSN=${R}`],
		['{"client_secret": "abc"}', `{"client_secret": ${R}}`],
		["postgres://app:pa55word@db:5432/app", `postgres://${R}@db:5432/app`],
		["Authorization: Bearer abc.def.ghi", `Authorization: ${R}`],
		[`token ghp_${"a".repeat(36)} used`, `token ${R} used`],
		[`github_pat_${"A1".repeat(20)}`, R],
		[`glpat-${"b".repeat(20)}`, R],
		["xoxb-1234567890-abcdefghij", R],
		[`sk-${"c".repeat(24)}`, R],
		["AKIAIOSFODNN7EXAMPLE", R],
		[`eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(12)}`, R],
	])("scrubs %s", (input, expected) => {
		expect(scrubSecretText(input)).toBe(expected);
	});

	it("removes a private key block, even a truncated one", () => {
		const block =
			"-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAK\n-----END RSA PRIVATE KEY-----";

		expect(scrubSecretText(`before\n${block}\nafter`)).toBe(
			`before\n${R}\nafter`,
		);
		expect(
			scrubSecretText("x\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn"),
		).toBe(`x\n${R}`);
	});

	it.each([
		"DB_PASSWORD=${DB_PASSWORD}",
		"API_TOKEN=$API_TOKEN",
		"JWT_SECRET: ${{project.JWT_SECRET}}",
		'SESSION_SECRET: "${SESSION_SECRET:?required}"',
		"postgres://${DB_USER}:${DB_PASSWORD}@db:5432/app",
	])("keeps the variable reference in %s", (input) => {
		expect(scrubSecretText(input)).toBe(input);
	});

	it("scrubs the inline default of a variable reference", () => {
		expect(scrubSecretText("DB_PASSWORD=${DB_PASSWORD:-hunter2}")).toBe(
			`DB_PASSWORD=${R}`,
		);
	});

	it.each([
		"redis://session-store:6379/0",
		"https://auth.example.test:8443/login",
		"SMTP_HOST: mail.auth.example:587",
		"upstream token-service:8080 is healthy",
		"listening on port 3000, workers: 4",
	])("does not read a host and port as a key and value in %s", (input) => {
		expect(scrubSecretText(input)).toBe(input);
	});

	it.each([
		['{"my secret key": "abc"}', `{"my secret key": ${R}}`],
		["password:abc123", `password:${R}`],
		["  - API_KEY: abc", `  - API_KEY: ${R}`],
		[
			"?next=/home&access-token-v2=abc&x=1",
			`?next=/home&access-token-v2=${R}&x=1`,
		],
	])("scrubs the value in %s", (input, expected) => {
		expect(scrubSecretText(input)).toBe(expected);
	});

	it("scrubs a very long line piece by piece without losing text", () => {
		const filler = "lorem ipsum dolor sit amet ".repeat(400);
		const line = `${filler}DB_PASS=first-Secret1 ${filler}{"api_key":"second-Secret2"},${"x".repeat(9000)}&token=third-Secret3`;
		const scrubbed = scrubSecretText(
			`head\n${line}\ntail DB_PASS=fourth-Secret4`,
		);

		expect(scrubbed).not.toMatch(/(?:first|second|third|fourth)-Secret/);
		expect(scrubbed.startsWith(`head\n${filler}DB_PASS=${R} ${filler}`)).toBe(
			true,
		);
		expect(scrubbed.endsWith(`\ntail DB_PASS=${R}`)).toBe(true);
		expect(scrubSecretText(`${filler}${filler}`)).toBe(`${filler}${filler}`);
	});

	it.each([
		["dashes", "ab-".repeat(200_000)],
		["dots", "ab.cd".repeat(120_000)],
		["assignments", "A=".repeat(300_000)],
		["keywords", "pass-".repeat(120_000)],
		["urls", "a://b".repeat(120_000)],
		["jwt heads", "eyJ-".repeat(150_000)],
		["token prefixes", "sk-".repeat(200_000)],
		["flags", " --a".repeat(150_000)],
		["clients", "mysql ".repeat(100_000)],
	])("stays fast on a hostile line of %s", (_name, input) => {
		const startedAt = performance.now();

		scrubSecretText(input);

		expect(performance.now() - startedAt).toBeLessThan(3_000);
	});

	it("is idempotent", () => {
		const once = scrubSecretText(
			"DB_PASS=abc postgres://u:p4ssw0rd@h/db Authorization: Bearer x.y.z",
		);

		expect(scrubSecretText(once)).toBe(once);
	});

	it("handles a large log quickly", () => {
		const matcher = buildKnownSecretMatcher(
			Array.from({ length: 300 }, (_, index) => `Secret-${index}-Value9`),
		);
		const line = `2026-01-01T00:00:00Z info request id=42 path=/health status=200 ${SENTINEL}\n`;
		const log = line.repeat(12_000);
		const startedAt = performance.now();

		const scrubbed = scrubSecretText(log, buildKnownSecretMatcher([SENTINEL]));
		scrubSecretText(log, matcher);

		expect(performance.now() - startedAt).toBeLessThan(5_000);
		expect(scrubbed).not.toContain(SENTINEL);
	});
});

describe("known secret values", () => {
	it("collects secret-looking variables, opaque values and URL passwords", () => {
		const opaque = "a1".repeat(20);
		const values = collectEnvSecretValues(
			[
				`API_TOKEN=${SENTINEL}`,
				`BUILD_STAMP=${opaque}`,
				"DATABASE_URL=postgres://app:Pa55-word@db:5432/app",
				"PORT=3000",
				"NODE_ENV=production",
				"APP_URL=https://app.example.test",
			].join("\n"),
		);

		expect(values.sort()).toEqual([SENTINEL, opaque, "Pa55-word"].sort());
	});

	it("skips values that would mangle ordinary output", () => {
		expect(collectSecretValue("DB_PASSWORD", "postgres")).toEqual([]);
		expect(collectSecretValue("DB_PASSWORD", "1234567890")).toEqual([]);
		expect(collectSecretValue("DB_PASSWORD", "short1")).toEqual([]);
		expect(collectSecretValue("DB_PASSWORD", "two words here")).toEqual([]);
		expect(collectSecretValue("DB_PASSWORD", "${DB_PASSWORD}")).toEqual([]);
		expect(collectSecretValue("DB_PASSWORD", R)).toEqual([]);
		expect(collectSecretValue("DB_PASSWORD", null)).toEqual([]);
	});

	it("also scrubs the decoded form of a URL-encoded password", () => {
		expect(
			collectSecretValue(
				"DATABASE_URL",
				"mysql://app:p%40ss-W0rd@db/app",
			).sort(),
		).toEqual(["p%40ss-W0rd", "p@ss-W0rd"].sort());
	});

	it("returns an empty matcher when nothing qualifies", () => {
		const matcher = buildKnownSecretMatcher(["short", "postgres"]);

		expect(matcher.size).toBe(0);
		expect(scrubSecretText("postgres short", matcher)).toBe("postgres short");
	});
});

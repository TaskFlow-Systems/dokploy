import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProcedureDeniedForApiKey } from "@/server/api/utils/api-key-output-guard";

describe("secret handling", () => {
	const read = (file: string) =>
		readFileSync(join(__dirname, "../..", file), "utf8");

	it.each(["application", "compose"])(
		"%s keeps the secret off the API and behind a browser session",
		(router) => {
			const source = read(`server/api/routers/${router}.ts`);
			for (const name of ["revealWebhookSecret", "regenerateWebhookSecret"]) {
				const start = source.indexOf(`${name}:`);
				const procedure = source.slice(start, source.indexOf("Procedure", start + 40));
				expect(procedure).toContain("assertBrowserSession(ctx)");
				expect(isProcedureDeniedForApiKey(`${router}.${name}`)).toBe(true);
			}
			const reveal = source.slice(source.indexOf("revealWebhookSecret:"));
			expect(reveal.slice(0, 600)).toContain('deployment: ["create"]');
			expect(reveal.slice(0, 900)).toContain('action: "reveal"');
		},
	);

	it("is encrypted, redacted on reads and not accepted by update schemas", () => {
		for (const schema of ["application", "compose"]) {
			const source = readFileSync(
				join(__dirname, `../../../../packages/server/src/db/schema/${schema}.ts`),
				"utf8",
			);
			expect(source).toContain('webhookSecret: encryptedText("webhookSecret")');
			expect(source).toMatch(/refreshToken: true,\s*webhookSecret: true/);
		}
		const redaction = readFileSync(
			join(__dirname, "../../../../packages/server/src/utils/security/redaction.ts"),
			"utf8",
		);
		expect(redaction).toContain('"webhookSecret"');
	});
});

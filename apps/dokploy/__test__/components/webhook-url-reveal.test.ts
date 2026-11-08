import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProcedureDeniedForApiKey } from "@/server/api/utils/api-key-output-guard";

const read = (file: string) =>
	readFileSync(join(__dirname, "../..", file), "utf8");

// `application.one` and `compose.one` answer refreshToken as a placeholder, so
// the Deployments tab used to show and copy `/api/deploy/__DOKPLOY_REDACTED_SECRET__`.
describe("deploy webhook URL", () => {
	it("is built from the revealed token, never from the placeholder", () => {
		const source = read(
			"components/dashboard/application/deployments/show-deployments.tsx",
		);
		expect(source).toContain("revealWebhookToken");
		expect(source).toContain("onRefreshed");
		expect(source).not.toMatch(/copy\(webhookUrl\)/);
	});

	it.each(["application", "compose"])(
		"%s.revealWebhookToken needs a browser session and the deploy permission, and writes an audit entry",
		(router) => {
			const source = read(`server/api/routers/${router}.ts`);
			const start = source.indexOf("revealWebhookToken:");
			const procedure = source.slice(
				start,
				source.indexOf("refreshToken:", start),
			);
			expect(procedure).toContain("assertBrowserSession(ctx)");
			expect(procedure).toContain('deployment: ["create"]');
			expect(procedure).toContain('action: "reveal"');
			expect(isProcedureDeniedForApiKey(`${router}.revealWebhookToken`)).toBe(
				true,
			);
		},
	);
});

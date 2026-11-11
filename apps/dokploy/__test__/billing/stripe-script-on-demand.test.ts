import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(appRoot, file), "utf8");

const clientSources = ["components", "hooks", "lib", "pages", "utils"].flatMap(
	(dir) =>
		readdirSync(path.join(appRoot, dir), { recursive: true, encoding: "utf8" })
			.filter((file) => /\.tsx?$/.test(file))
			.map((file) => path.join(dir, file)),
);

describe("Stripe in the browser", () => {
	it("is never loaded: checkout redirects to the session URL", () => {
		const planStep = "components/dashboard/onboarding/steps/plan-step.tsx";
		expect(clientSources).toContain(planStep);
		expect(read(planStep)).toContain("window.location.href = session.url");

		const importsStripeJs = clientSources.filter((file) =>
			/["']@stripe\/stripe-js(\/[a-z]+)?["']/.test(read(file)),
		);
		expect(importsStripeJs).toEqual([]);
	});

	it("does not declare the browser SDK", () => {
		const manifest = JSON.parse(read("package.json"));
		expect(manifest.dependencies["@stripe/stripe-js"]).toBeUndefined();
	});
});

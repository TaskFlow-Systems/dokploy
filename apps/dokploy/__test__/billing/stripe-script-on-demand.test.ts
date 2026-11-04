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

describe("Stripe's browser script", () => {
	it("is reached only through the entry that waits for loadStripe", () => {
		const planStep = "components/dashboard/onboarding/steps/plan-step.tsx";
		expect(clientSources).toContain(planStep);
		expect(read(planStep)).toContain('from "@stripe/stripe-js/pure"');

		const importsMainEntry = clientSources.filter((file) =>
			/["']@stripe\/stripe-js["']/.test(read(file)),
		);
		expect(importsMainEntry).toEqual([]);
	});
});

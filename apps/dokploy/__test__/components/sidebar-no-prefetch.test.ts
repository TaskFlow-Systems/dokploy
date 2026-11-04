import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(__dirname, "../..");
const linksIn = (file: string) =>
	readFileSync(path.join(appRoot, file), "utf8").match(/<Link\b[^>]*>/g) ?? [];

describe("links that stay on screen on every dashboard page", () => {
	it("do not prefetch from the sidebar", () => {
		const links = linksIn("components/layouts/side.tsx");
		expect(links.length).toBeGreaterThan(0);
		expect(links.filter((link) => !link.includes("prefetch={false}"))).toEqual(
			[],
		);
	});

	it("do not prefetch from the breadcrumb", () => {
		const [plainLink] = linksIn(
			"components/shared/breadcrumb-sidebar.tsx",
		).filter((link) => link.includes("href={item?.href}"));
		expect(plainLink).toContain("prefetch={false}");
	});
});

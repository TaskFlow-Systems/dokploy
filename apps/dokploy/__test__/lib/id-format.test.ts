import { generateAppName } from "@dokploy/server/db/schema/utils";
import { nanoid } from "nanoid";
import { describe, expect, it } from "vitest";

describe("id format", () => {
	it("nanoid returns 21 url-safe characters", () => {
		for (let i = 0; i < 100; i++) {
			expect(nanoid()).toMatch(/^[A-Za-z0-9_-]{21}$/);
		}
	});

	it("generateAppName ends with a 6-character lowercase suffix", () => {
		for (let i = 0; i < 100; i++) {
			const appName = generateAppName("app");
			expect(appName.startsWith("app-")).toBe(true);
			expect(appName).toMatch(/-[a-z1-9]{6}$/);
		}
	});
});

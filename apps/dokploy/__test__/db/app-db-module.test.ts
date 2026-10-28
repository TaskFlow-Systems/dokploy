import { db as sharedDb } from "@dokploy/server/db";
import { describe, expect, it } from "vitest";
import { db } from "@/server/db";

describe("@/server/db", () => {
	it("reuses the shared client instead of opening a second pool", () => {
		expect(db).toBe(sharedDb);
	});
});

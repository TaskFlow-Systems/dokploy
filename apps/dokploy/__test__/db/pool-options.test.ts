import { describe, expect, it, vi } from "vitest";

const postgres = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("postgres", () => ({ default: postgres }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: vi.fn(() => ({})) }));
vi.unmock("@dokploy/server/db");

describe("@dokploy/server/db", () => {
	it("closes connections that sit idle for a minute", async () => {
		delete (globalThis as { db?: unknown }).db;
		await import("@dokploy/server/db");

		expect(postgres).toHaveBeenCalledTimes(1);
		expect(postgres).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ idle_timeout: 60 }),
		);
	});
});

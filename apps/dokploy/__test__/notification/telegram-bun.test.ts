import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// The panel runs on Bun. The fixture runs the real sender there against a local
// TLS server standing in for api.telegram.org, with about half of the
// connections never answered. It needs a second loopback address, which Linux
// has by default.
const fixture = path.join(__dirname, "fixtures", "telegram-bun-check.ts");

describe.skipIf(process.platform !== "linux")("telegram sender on Bun", () => {
	it("delivers through random connect failures and stops when it should", async () => {
		const { stdout } = await promisify(execFile)("bun", [fixture], {
			timeout: 60_000,
		});
		const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");

		expect(result.runtime).toBe("object");

		// Six dropped connections in a row happen to 1.6% of the sends.
		expect(result.random.delivered).toBeGreaterThanOrEqual(
			result.random.total - 6,
		);
		expect(result.random.resolved).toBe(result.random.delivered);

		expect(result.outage.ok).toBe(false);
		expect(result.outage.error).toContain("UND_ERR_CONNECT_TIMEOUT");
		expect(result.outage.error).toContain("6 attempts");
		expect(result.outage.ms).toBeLessThan(15_000);

		expect(result.refused.ok).toBe(false);
		expect(result.refused.requests).toBe(1);

		expect(result.limited.ok).toBe(true);
		expect(result.limited.requests).toBe(2);
		expect(result.limited.ms).toBeGreaterThanOrEqual(900);

		expect(result.broken.ok).toBe(true);
		expect(result.broken.requests).toBe(2);

		expect(result.far.ok).toBe(false);
		expect(result.far.requests).toBe(1);
		expect(result.far.ms).toBeLessThan(1_000);
	}, 70_000);
});

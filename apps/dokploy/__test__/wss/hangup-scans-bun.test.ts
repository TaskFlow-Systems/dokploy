import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// Vitest runs on Node, so the scenario runs in a Bun process, the runtime of
// the panel's server: real child processes, real timers, and the process has
// to end by itself once the last scan is done.
const fixture = path.join(__dirname, "fixtures", "hangup-scans-check.ts");

describe("repeated hangup scans under Bun", () => {
	it("hangs up a shell that started after the first scans, then stops", async () => {
		const started = Date.now();
		const { stdout } = await promisify(execFile)("bun", [fixture], {
			timeout: 30_000,
		});
		const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");

		expect(result).toEqual({
			runtime: "bun",
			scans: 4,
			hangups: 1,
			elapsedOk: true,
		});
		// 0 + 0.5 + 2 + 5 s of schedule, then the process left on its own.
		expect(Date.now() - started).toBeLessThan(15_000);
	}, 35_000);
});

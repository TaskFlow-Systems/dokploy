import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// Vitest runs on Node, so the Bun branch of spawnPty runs in a Bun process.
const fixture = path.join(__dirname, "fixtures", "pty-bun-check.ts");

describe("spawnPty under Bun", () => {
	it("streams output, takes input and resizes through Bun's own PTY", async () => {
		const { stdout } = await promisify(execFile)("bun", [fixture], {
			timeout: 30_000,
		});
		const results = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
		const lines = (text: string) => text.split(/\r?\n/).filter(Boolean);

		expect(lines(results.lines.output)).toEqual(["a", "b"]);
		expect(results.lines.exitCode).toBe(0);
		expect(lines(results.unicode.output)).toEqual(["ж€😀"]);
		expect(lines(results.input.output)).toContain("got:hello");
		expect(lines(results.size.output)).toEqual(["40 100"]);
		expect(results.exitCode.exitCode).toBe(3);
		expect(results.killed).toBe(true);
	}, 40_000);
});

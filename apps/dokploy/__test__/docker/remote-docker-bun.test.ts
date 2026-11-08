import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// Vitest runs on Node, so the same calls run again in a Bun process, which is
// the runtime of the panel's server.
const fixture = path.join(__dirname, "fixtures", "remote-docker-check.ts");

describe("getRemoteDocker under Bun", () => {
	it("lists containers and reports a daemon error over ssh", async () => {
		const { stdout } = await promisify(execFile)("bun", [fixture], {
			timeout: 30_000,
		});
		const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");

		expect(result).toEqual({
			runtime: "bun",
			version: "string",
			containers: true,
			missing: true,
		});
	}, 40_000);
});

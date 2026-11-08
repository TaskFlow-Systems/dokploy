import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// Vitest runs on Node, so the same scenario runs again in a Bun process, which
// is the runtime of the panel's server.
const fixture = path.join(
	__dirname,
	"fixtures",
	"terminal-ssh-release-check.ts",
);

describe("server terminal ssh connection under Bun", () => {
	it("leaves no ssh connection after 20 open and close cycles", async () => {
		const { stdout } = await promisify(execFile)("bun", [fixture], {
			timeout: 60_000,
		});
		const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");

		expect(result).toEqual({ runtime: "bun", cycles: 20, live: 0 });
	}, 70_000);
});

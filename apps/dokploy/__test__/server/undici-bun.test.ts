import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// Vitest runs on Node; the panel's server runs on Bun, where an import of
// "undici" gives Bun's built-in module, whose Agent has no close() and whose
// fetch ignores the dispatcher.
const fixture = path.join(__dirname, "fixtures", "undici-bun-check.ts");

describe("undici on Bun", () => {
	it("keeps the package's Agent: its lookup decides the address, and close() works", async () => {
		const { stdout } = await promisify(execFile)("bun", [fixture], {
			timeout: 30_000,
		});
		const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");

		expect(result.runtime).toBe("object");
		expect(result.status).toBe(200);
		expect(result.body).toMatch(/^host=pinned\.invalid:\d+$/);
		expect(result.lookups).toEqual(["pinned.invalid"]);
		expect(result.closed).toBe(true);
	}, 40_000);

	it("leaves no other import of the package by its name in the server", async () => {
		const root = path.resolve(__dirname, "../../../..");
		const offenders: string[] = [];
		for (const dir of ["packages/server/src", "apps/dokploy/server"]) {
			const files = await readdir(path.join(root, dir), { recursive: true });
			for (const file of files) {
				if (!/\.(ts|tsx|mts|js|mjs)$/.test(file)) continue;
				const relative = path.join(dir, file);
				if (relative === path.join("packages/server/src", "utils/undici.ts")) {
					continue;
				}
				const text = await readFile(path.join(root, relative), "utf8");
				if (/(from\s+|import\(|require\()\s*["']undici["']/.test(text)) {
					offenders.push(relative);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});

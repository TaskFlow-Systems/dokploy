import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("the panel's server runs on Bun", () => {
	it("starts the server, the migration and the Postgres wait with bun in the image", () => {
		const cmd = read("Dockerfile").match(/^\s*CMD (\[.*\])\s*$/m)?.[1];
		expect(cmd).toBeDefined();
		const script = (JSON.parse(cmd ?? "[]") as string[]).at(-1) ?? "";
		expect(script).toMatch(/\bbun dist\/wait-for-postgres\.mjs\b/);
		expect(script).toMatch(/\bbun dist\/migration\.mjs\b/);
		expect(script).toMatch(/\bexec bun --smol dist\/server\.mjs\b/);
		expect(script).not.toMatch(/\bnode\b/);
	});

	it("keeps the start scripts on bun", () => {
		const { scripts } = JSON.parse(read("apps/dokploy/package.json")) as {
			scripts: Record<string, string>;
		};
		expect(scripts.start).toMatch(/^bun /);
		expect(scripts.start).not.toMatch(/\bnode\b/);
		expect(scripts["wait-for-postgres"]).toMatch(/^bun /);
	});

	// Bun answers an import of some packages with a built-in module, which
	// can lack what the package does: Bun's undici ignores `dispatcher`, and
	// that skipped the address checks of outbound requests. A package that
	// joins this list, after a Bun update or a new dependency, needs the same
	// check before the list here changes.
	it("meets no built-in replacement beyond the ones checked", async () => {
		const { stdout } = await promisify(execFile)(
			"bun",
			[path.join(__dirname, "fixtures", "bun-replaced-packages.ts")],
			{ timeout: 60_000 },
		);
		const replaced = JSON.parse(stdout.trim().split("\n").at(-1) ?? "[]");
		expect(replaced).toEqual(expect.arrayContaining(["undici"]));
		for (const name of replaced) {
			expect([
				"buffer",
				"node-fetch",
				"string_decoder",
				"undici",
				"ws",
			]).toContain(name);
		}
	}, 70_000);
});

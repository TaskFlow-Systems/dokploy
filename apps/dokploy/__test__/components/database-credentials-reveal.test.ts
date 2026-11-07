import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dashboard = join(__dirname, "../../components/dashboard");
const cards = ["postgres", "mysql", "mariadb", "mongo", "redis", "libsql"]
	.flatMap((type) =>
		readdirSync(join(dashboard, type, "general"))
			.filter((file) => file.endsWith("-credentials.tsx"))
			.map((file) => join(type, "general", file)),
	)
	.map((file) => [file, readFileSync(join(dashboard, file), "utf8")] as const);

describe("database credentials cards", () => {
	it("cover the internal and external card of every type", () => {
		expect(cards).toHaveLength(12);
	});

	it.each(cards)(
		"%s loads the passwords before showing or copying",
		(_, source) => {
			expect(source).toContain("useDatabaseCredentials(");
			const inputs = source.match(/<ToggleVisibilityInput[\s\S]*?\/>/g) ?? [];
			expect(inputs.length).toBeGreaterThan(0);
			for (const input of inputs) {
				expect(input).toContain("resolveValue=");
				expect(input).not.toMatch(/value=\{[^}]*\bdata\b/);
			}
		},
	);

	it.each(cards.filter(([, source]) => source.includes("changePassword")))(
		"%s forgets the shown passwords after a change",
		(_, source) => {
			expect(source).toContain("forget();");
		},
	);
});

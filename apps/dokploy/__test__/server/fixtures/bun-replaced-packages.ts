import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Lists the packages that Bun answers with a built-in module of its own
// instead of the copy in node_modules.
const root = path.resolve(import.meta.dir, "../../../../..");
const replaced = new Set<string>();
for (const dir of ["", "apps/dokploy", "packages/server"]) {
	const modules = path.join(root, dir, "node_modules");
	let entries: string[] = [];
	try {
		entries = readdirSync(modules);
	} catch {
		continue;
	}
	const names = entries.flatMap((entry) => {
		if (entry.startsWith(".")) return [];
		if (!entry.startsWith("@")) return [entry];
		try {
			return readdirSync(path.join(modules, entry)).map((s) => `${entry}/${s}`);
		} catch {
			return [];
		}
	});
	const require = createRequire(path.join(root, dir, "package.json"));
	for (const name of names) {
		try {
			if (!path.isAbsolute(require.resolve(name))) replaced.add(name);
		} catch {}
	}
}
console.log(JSON.stringify([...replaced].sort()));

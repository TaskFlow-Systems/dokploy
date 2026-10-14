export interface ComposeEnvEntry {
	name: string;
	value: string;
	services: string[];
}

export type ComposeEnvState =
	| { kind: "set" }
	| { kind: "listed"; value: string }
	| { kind: "absent" };

const ACTIVE_LINE = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=/;
// Only `# NAME=value` with nothing between the name and "=", so prose in
// comments is not taken for a variable.
const COMMENTED_LINE = /^\s*#\s*([A-Za-z_]\w*)=(.*)$/;

// dotenv ends an unquoted value at " #" and trims it, and expands escapes such
// as \n only inside double quotes.
export const formatEnvValue = (value: string) => {
	if (!/[\s#"'`\\]/.test(value)) {
		return value;
	}
	if (!value.includes("'")) {
		return `'${value}'`;
	}
	if (!value.includes('"') && !value.includes("\\")) {
		return `"${value}"`;
	}
	return `\`${value}\``;
};

const findCommentedLines = (lines: string[]) => {
	const commented = new Map<string, number>();
	lines.forEach((line, index) => {
		const name = COMMENTED_LINE.exec(line)?.[1];
		if (name && !commented.has(name)) {
			commented.set(name, index);
		}
	});
	return commented;
};

export const readComposeEnvState = (env: string) => {
	const lines = env.split("\n");
	const active = new Set<string>();
	for (const line of lines) {
		const name = ACTIVE_LINE.exec(line)?.[1];
		if (name) {
			active.add(name);
		}
	}
	const commented = findCommentedLines(lines);
	return (name: string): ComposeEnvState => {
		if (active.has(name)) {
			return { kind: "set" };
		}
		const index = commented.get(name);
		if (index !== undefined) {
			return {
				kind: "listed",
				value: COMMENTED_LINE.exec(lines[index] ?? "")?.[2] ?? "",
			};
		}
		return { kind: "absent" };
	};
};

// Variables already set stay as they are. A commented `# NAME=value` line is
// rewritten in place, so importing again refreshes the defaults it shows;
// the rest go to a block at the end, grouped by the services that use them.
export const mergeComposeEnv = (
	env: string,
	entries: ComposeEnvEntry[],
	{ active, header }: { active: boolean; header: string[] },
) => {
	const lines = env.split("\n");
	const state = readComposeEnvState(env);
	const commented = findCommentedLines(lines);
	const groups = new Map<string, string[]>();

	for (const entry of entries) {
		if (state(entry.name).kind === "set") {
			continue;
		}
		const assignment = `${entry.name}=${formatEnvValue(entry.value)}`;
		const line = active ? assignment : `# ${assignment}`;
		const index = commented.get(entry.name);
		if (index !== undefined) {
			lines[index] = line;
			continue;
		}
		const group = entry.services.join(", ");
		groups.set(group, [...(groups.get(group) ?? []), line]);
	}

	const merged = lines.join("\n");
	if (groups.size === 0) {
		return merged;
	}

	const block = header.map((line) => `# ${line}`);
	for (const [group, groupLines] of groups) {
		if (groups.size > 1) {
			block.push("", group ? `# Used by ${group}` : "# Not tied to a service");
		}
		block.push(...groupLines);
	}

	const base = merged.trimEnd();
	return `${base}${base ? "\n\n" : ""}${block.join("\n")}\n`;
};

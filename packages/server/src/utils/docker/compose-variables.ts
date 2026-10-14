import { isSecretEnvName } from "../env-upsert";

export interface ComposeVariableReference {
	name: string;
	operator: string | null;
	value: string | null;
}

export interface ComposeVariable {
	name: string;
	// null when the file gives no default, so the variable is empty unless set.
	defaultValue: string | null;
	// `${NAME:?message}`: compose refuses to start while the variable is unset.
	required: boolean;
	// Different places in the file fall back to different values.
	conflictingDefaults: boolean;
	services: string[];
	secret: boolean;
	// The default asks to be replaced, such as `change-me-salt`.
	placeholder: boolean;
}

// Dokploy writes these into the .env file of every compose service itself.
const DOKPLOY_PROVIDED_VARIABLES = new Set([
	"APP_NAME",
	"COMPOSE_PROJECT_NAME",
	"COMPOSE_PREFIX",
	"DOCKER_CONFIG",
]);

const PLACEHOLDER_PATTERN = /change[-_]?me|replace[-_]?me/i;

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*/;
const OPERATOR_PATTERN = /^:?[-?+]/;

const findClosingBrace = (text: string, start: number) => {
	let depth = 1;
	let index = start;
	while (index < text.length) {
		if (text[index] === "$" && text[index + 1] === "$") {
			index += 2;
			continue;
		}
		if (text[index] === "$" && text[index + 1] === "{") {
			depth++;
			index += 2;
			continue;
		}
		if (text[index] === "}" && --depth === 0) {
			return index;
		}
		index++;
	}
	return -1;
};

// Follows compose interpolation: `$$` is a literal dollar sign, and a value
// after an operator may hold further references (`${A:-${B:-x}}`).
export const findVariableReferences = (
	text: string,
): ComposeVariableReference[] => {
	const references: ComposeVariableReference[] = [];
	let index = text.indexOf("$");
	while (index !== -1) {
		const next = text[index + 1];
		let resumeAt = index + 1;
		if (next === "$") {
			resumeAt = index + 2;
		} else if (next === "{") {
			const name = NAME_PATTERN.exec(text.slice(index + 2))?.[0];
			const afterName = index + 2 + (name?.length ?? 0);
			const operator =
				OPERATOR_PATTERN.exec(text.slice(afterName))?.[0] ?? null;
			const valueStart = afterName + (operator?.length ?? 0);
			const end = name ? findClosingBrace(text, valueStart) : -1;
			if (name && end !== -1 && (operator || end === valueStart)) {
				const value = operator ? text.slice(valueStart, end) : null;
				references.push({ name, operator, value });
				if (value) {
					references.push(...findVariableReferences(value));
				}
				resumeAt = end + 1;
			}
		} else {
			const name = NAME_PATTERN.exec(text.slice(index + 1))?.[0];
			if (name) {
				references.push({ name, operator: null, value: null });
				resumeAt = index + 1 + name.length;
			}
		}
		index = text.indexOf("$", resumeAt);
	}
	return references;
};

const collectStrings = (
	value: unknown,
	strings: string[],
	ancestors = new Set<object>(),
) => {
	if (typeof value === "string") {
		strings.push(value);
		return;
	}
	if (!value || typeof value !== "object" || ancestors.has(value)) {
		return;
	}
	ancestors.add(value);
	for (const item of Array.isArray(value) ? value : Object.values(value)) {
		collectStrings(item, strings, ancestors);
	}
	ancestors.delete(value);
};

// Takes the parsed file, so YAML comments are already gone and anchors are
// expanded into the services that use them.
export const extractComposeVariables = (spec: unknown): ComposeVariable[] => {
	const found = new Map<
		string,
		{ defaults: string[]; required: boolean; services: Set<string> }
	>();

	const record = (value: unknown, service: string | null) => {
		const strings: string[] = [];
		collectStrings(value, strings);
		for (const text of strings) {
			for (const { name, operator, value: operand } of findVariableReferences(
				text,
			)) {
				const entry = found.get(name) ?? {
					defaults: [],
					required: false,
					services: new Set<string>(),
				};
				found.set(name, entry);
				if (service) {
					entry.services.add(service);
				}
				if (operator === ":-" || operator === "-") {
					if (!entry.defaults.includes(operand ?? "")) {
						entry.defaults.push(operand ?? "");
					}
				} else if (operator === ":?" || operator === "?") {
					entry.required = true;
				}
			}
		}
	};

	if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
		return [];
	}
	for (const [key, section] of Object.entries(spec)) {
		// Extension fields reach services through anchors, which the parser
		// has already expanded where they are used.
		if (key.startsWith("x-")) {
			continue;
		}
		if (key === "services" && section && typeof section === "object") {
			for (const [service, definition] of Object.entries(section)) {
				record(definition, service);
			}
		} else {
			record(section, null);
		}
	}

	return [...found.entries()]
		.filter(([name]) => !DOKPLOY_PROVIDED_VARIABLES.has(name))
		.map(([name, entry]) => ({
			name,
			defaultValue: entry.defaults[0] ?? null,
			required: entry.required,
			conflictingDefaults: entry.defaults.length > 1,
			services: [...entry.services],
			secret: isSecretEnvName(name),
			placeholder: entry.defaults.some((value) =>
				PLACEHOLDER_PATTERN.test(value),
			),
		}));
};

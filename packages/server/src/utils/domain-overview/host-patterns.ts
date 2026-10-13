const MAX_PATTERN_LENGTH = 200;
const MAX_UNBOUNDED_QUANTIFIERS = 3;

export const HOST_TEMPLATE_MARKER = "{{";

const REPEAT = /^(?:[*+]|\{\d+(?:,\d*)?\})/;

// The pattern comes from a container label or a config file, so it is not
// trusted: a pattern like (a+)+$ can run for minutes on a short name. Anything
// that could backtrack badly (a repeated group that itself repeats or has
// alternatives, backreferences, lookarounds, many unbounded quantifiers) is
// rejected, and a rejected pattern counts as matching every name.
const isSafePattern = (source: string) => {
	if (source.length > MAX_PATTERN_LENGTH) {
		return false;
	}
	if (/\\[1-9]|\(\?(?:=|!|<)/.test(source)) {
		return false;
	}
	const groups: { variable: boolean }[] = [];
	let unbounded = 0;
	let inClass = false;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (inClass) {
			inClass = char !== "]";
			continue;
		}
		const top = groups[groups.length - 1];
		if (char === "[") {
			inClass = true;
		} else if (char === "(") {
			groups.push({ variable: false });
		} else if (char === "|" && top) {
			top.variable = true;
		} else if (char === ")") {
			const closed = groups.pop();
			const repeated = REPEAT.test(source.slice(index + 1));
			if (closed?.variable && repeated) {
				return false;
			}
			const parent = groups[groups.length - 1];
			if (parent && closed?.variable) {
				parent.variable = true;
			}
		} else if (REPEAT.test(source.slice(index))) {
			if (
				char === "*" ||
				char === "+" ||
				/^\{\d+,\}/.test(source.slice(index))
			) {
				unbounded += 1;
			}
			if (top) {
				top.variable = true;
			}
		}
	}
	return unbounded <= MAX_UNBOUNDED_QUANTIFIERS;
};

// Traefik v2 writes named groups as {name:regexp}; Go's other syntax
// differences make some patterns fail to compile in JavaScript. Go templates
// ({{ ... }}) are filled in at run time, so they can produce any name.
export const compileHostPattern = (pattern: string): RegExp | null => {
	if (pattern.includes(HOST_TEMPLATE_MARKER)) {
		return null;
	}
	const converted = pattern
		.replace(/\{[A-Za-z_][\w-]*:([^{}]*)\}/g, "(?:$1)")
		.replace(/\{[A-Za-z_][\w-]*\}/g, "[^.]+");
	if (!isSafePattern(converted)) {
		return null;
	}
	try {
		return new RegExp(converted, "i");
	} catch {
		return null;
	}
};

// A pattern that cannot be evaluated safely could match anything, so it
// counts as matching every name. A wildcard certificate covers names a
// pattern may produce, and a pattern cannot be proven to stay outside a
// suffix, so any pattern on the server keeps wildcard certificates in use.
export const namesMatchPatterns = (
	names: readonly string[],
	patterns: readonly string[],
) => {
	if (patterns.length === 0) {
		return false;
	}
	if (names.some((name) => name.startsWith("*."))) {
		return true;
	}
	return patterns.some((pattern) => {
		const expression = compileHostPattern(pattern);
		if (!expression) {
			return true;
		}
		return names.some((name) => expression.test(name));
	});
};

// Traefik v2 writes named groups as {name:regexp}; Go's other syntax
// differences make some patterns fail to compile in JavaScript.
export const compileHostPattern = (pattern: string): RegExp | null => {
	const converted = pattern
		.replace(/\{[A-Za-z_][\w-]*:([^{}]*)\}/g, "(?:$1)")
		.replace(/\{[A-Za-z_][\w-]*\}/g, "[^.]+");
	try {
		return new RegExp(converted, "i");
	} catch {
		return null;
	}
};

// A pattern that cannot be compiled could match anything, so it counts as
// matching every name: a certificate is only offered for deletion when no
// regexp matcher can reach any of its names.
export const namesMatchPatterns = (
	names: readonly string[],
	patterns: readonly string[],
) =>
	patterns.some((pattern) => {
		const expression = compileHostPattern(pattern);
		if (!expression) {
			return true;
		}
		return names.some((name) => {
			const samples = name.startsWith("*.")
				? [name, `wildcard${name.slice(1)}`]
				: [name];
			return samples.some((sample) => expression.test(sample));
		});
	});

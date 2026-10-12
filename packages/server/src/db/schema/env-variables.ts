import { z } from "zod";

export const ENV_VARIABLE_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const ENV_SCOPES = [
	"application",
	"compose",
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"libsql",
	"project",
	"environment",
] as const;

export const ENV_FIELDS = ["env", "buildArgs", "buildSecrets"] as const;

export const ENV_GENERATE_FORMATS = [
	"base64url",
	"hex",
	"alphanumeric",
] as const;

export type EnvScope = (typeof ENV_SCOPES)[number];
export type EnvField = (typeof ENV_FIELDS)[number];
export type EnvGenerateFormat = (typeof ENV_GENERATE_FORMATS)[number];

const envScope = z.enum(ENV_SCOPES);
const envField = z.enum(ENV_FIELDS);
const envVariableName = z
	.string()
	.regex(
		ENV_VARIABLE_NAME_REGEX,
		"Environment variable names must start with a letter or underscore and contain only letters, numbers, and underscores",
	);

export const isEnvFieldSupported = (scope: EnvScope, field: EnvField) =>
	field === "env" || scope === "application";

const unsupportedFieldMessage = (scope: EnvScope, field: EnvField) =>
	`Field ${field} is only available for the application scope, not ${scope}`;

export const apiEnvKeys = z
	.object({
		scope: envScope,
		id: z.string().min(1),
		field: envField.default("env"),
	})
	.superRefine((input, ctx) => {
		if (!isEnvFieldSupported(input.scope, input.field)) {
			ctx.addIssue({
				code: "custom",
				path: ["field"],
				message: unsupportedFieldMessage(input.scope, input.field),
			});
		}
	});

export const apiEnvKeysResponse = z.object({
	scope: envScope,
	id: z.string(),
	field: envField,
	revision: z.string(),
	variables: z.array(
		z.object({
			name: z.string(),
			secret: z.boolean(),
			empty: z.boolean(),
		}),
	),
});

export const apiEnvApply = z
	.object({
		scope: envScope,
		id: z.string().min(1),
		field: envField.default("env"),
		set: z.record(envVariableName, z.string()).optional(),
		remove: z.array(envVariableName).optional(),
		generate: z
			.record(
				envVariableName,
				z.object({
					length: z.number().int().min(16).max(128).default(48),
					format: z.enum(ENV_GENERATE_FORMATS).default("base64url"),
				}),
			)
			.optional(),
		copy: z
			.record(
				envVariableName,
				z.object({
					fromScope: envScope,
					fromId: z.string().min(1),
					fromField: envField.default("env"),
					fromName: envVariableName,
				}),
			)
			.optional(),
		dryRun: z.boolean().optional(),
		expectedRevision: z.string().optional(),
	})
	.superRefine((input, ctx) => {
		if (!isEnvFieldSupported(input.scope, input.field)) {
			ctx.addIssue({
				code: "custom",
				path: ["field"],
				message: unsupportedFieldMessage(input.scope, input.field),
			});
		}

		for (const [name, source] of Object.entries(input.copy ?? {})) {
			if (!isEnvFieldSupported(source.fromScope, source.fromField)) {
				ctx.addIssue({
					code: "custom",
					path: ["copy", name, "fromField"],
					message: unsupportedFieldMessage(source.fromScope, source.fromField),
				});
			}
		}

		const operations = {
			set: Object.keys(input.set ?? {}),
			remove: input.remove ?? [],
			generate: Object.keys(input.generate ?? {}),
			copy: Object.keys(input.copy ?? {}),
		};
		const listsByName = new Map<string, Set<string>>();
		for (const [list, names] of Object.entries(operations)) {
			for (const name of names) {
				listsByName.set(name, (listsByName.get(name) ?? new Set()).add(list));
			}
		}

		if (listsByName.size === 0) {
			ctx.addIssue({
				code: "custom",
				message:
					"At least one of set, remove, generate or copy must name a variable",
			});
		}

		for (const [name, lists] of listsByName) {
			if (lists.size > 1) {
				ctx.addIssue({
					code: "custom",
					path: [[...lists][0] ?? "set", name],
					message: `Variable ${name} appears in more than one of: ${[...lists].join(", ")}`,
				});
			}
		}
	});

export const apiEnvApplyResponse = z.object({
	scope: envScope,
	id: z.string(),
	field: envField,
	changed: z.boolean(),
	revision: z.string(),
	dryRun: z.boolean(),
	variables: z.array(
		z.object({
			name: z.string(),
			action: z.enum(["created", "updated", "unchanged", "removed", "missing"]),
			source: z.enum(["set", "generate", "copy", "remove"]),
			secret: z.boolean(),
		}),
	),
});

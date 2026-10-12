import { TRPCError } from "@trpc/server";

export const REDACTED_SECRET_VALUE = "__DOKPLOY_REDACTED_SECRET__";
const MCP_REDACTED_SECRET_VALUE = "[REDACTED]";

export type SecretRecord = Record<string, unknown>;

const SENSITIVE_KEY_PATTERN =
	"(?:access[_-]?key|api[_-]?key|authorization|credential|private[_-]?key|refresh[_-]?token|secret|token|password|passwd|pwd)";

// shell-quote leaves values bare with backslash escapes (pa\&ss) or wraps them
// in double quotes with escaped quotes, so a value ends at the first unescaped
// separator, not at the first separator character.
const SHELL_VALUE_PATTERN = String.raw`"(?:\\.|[^"\\])*"|'[^']*'|(?:\\.|[^\s;&|\\])+`;

export const isRedactedSecretValue = (value: unknown) =>
	value === REDACTED_SECRET_VALUE;

export const isSecretPlaceholderValue = (value: unknown) =>
	typeof value === "string" &&
	(value.includes(REDACTED_SECRET_VALUE) ||
		value.includes(MCP_REDACTED_SECRET_VALUE));

// Callers send a redacted field back unchanged to mean "keep what is stored".
export const isExactSecretPlaceholder = (value: unknown) =>
	value === REDACTED_SECRET_VALUE || value === MCP_REDACTED_SECRET_VALUE;

export const redactSecretValue = <T>(value: T) => {
	if (value === null || value === undefined || value === "") {
		return value;
	}

	return REDACTED_SECRET_VALUE;
};

export const redactSecretFields = <T extends SecretRecord | null | undefined>(
	record: T,
	fields: string[],
) => {
	if (!record) {
		return record;
	}

	const redacted = { ...record };

	for (const field of fields) {
		if (field in redacted) {
			redacted[field] = redactSecretValue(redacted[field]);
		}
	}

	return redacted as T;
};

export const redactSecretFieldsList = <T extends SecretRecord>(
	records: T[],
	fields: string[],
) => records.map((record) => redactSecretFields(record, fields));

const redactNestedServerSecrets = <T>(server: T): T => {
	if (!server || typeof server !== "object") {
		return server;
	}

	const redacted = { ...(server as SecretRecord) };
	if ("command" in redacted) {
		redacted.command = redactSecretValue(redacted.command);
	}
	if (redacted.metricsConfig && typeof redacted.metricsConfig === "object") {
		const metricsConfig = { ...(redacted.metricsConfig as SecretRecord) };
		if (metricsConfig.server && typeof metricsConfig.server === "object") {
			metricsConfig.server = redactSecretFields(
				metricsConfig.server as SecretRecord,
				["token"],
			);
		}
		redacted.metricsConfig = metricsConfig;
	}
	if (redacted.sshKey && typeof redacted.sshKey === "object") {
		redacted.sshKey = redactSecretFields(redacted.sshKey as SecretRecord, [
			"privateKey",
		]);
	}

	return redacted as T;
};

export type SharedEnvReadAccess = {
	environmentEnv: boolean;
	projectEnv: boolean;
};

const NO_SHARED_ENV_READ_ACCESS: SharedEnvReadAccess = {
	environmentEnv: false,
	projectEnv: false,
};

// The env of an environment and its project is shared by every service in them,
// so it is only returned to callers with the matching
// environmentEnvVars/projectEnvVars read permission.
export const redactEnvironmentSharedEnvFor = <
	T extends SecretRecord | null | undefined,
>(
	environment: T,
	access: SharedEnvReadAccess,
) => {
	if (!environment) {
		return environment;
	}

	let redacted: SecretRecord = environment;
	if (!access.environmentEnv) {
		redacted = redactSecretFields(redacted, ["env"]);
	}
	if (
		!access.projectEnv &&
		redacted.project &&
		typeof redacted.project === "object"
	) {
		redacted = {
			...redacted,
			project: redactSecretFields(redacted.project as SecretRecord, ["env"]),
		};
	}

	return redacted as T;
};

// Service reads load environment.project for organization checks.
const redactServiceSharedEnv = <T extends SecretRecord | null | undefined>(
	record: T,
	access: SharedEnvReadAccess,
) => {
	if (!record?.environment || typeof record.environment !== "object") {
		return record;
	}

	return {
		...record,
		environment: redactEnvironmentSharedEnvFor(
			record.environment as SecretRecord,
			access,
		),
	} as T;
};

export const redactDeployableServiceSecrets = <
	T extends SecretRecord | null | undefined,
>(
	record: T,
) => redactDeployableServiceSecretsFor(record);

export const redactDeployableServiceSecretsFor = <
	T extends SecretRecord | null | undefined,
>(
	record: T,
	sharedEnvAccess: SharedEnvReadAccess = NO_SHARED_ENV_READ_ACCESS,
) => {
	const redacted = redactSecretFields(record, [
		"env",
		"previewEnv",
		"buildArgs",
		"buildSecrets",
		"previewBuildArgs",
		"previewBuildSecrets",
		"password",
		"refreshToken",
	]);
	if (!redacted) {
		return redacted;
	}

	const withRelations = { ...redacted };
	if ("customGitUrl" in withRelations) {
		withRelations.customGitUrl = redactSensitiveText(
			withRelations.customGitUrl as string | null | undefined,
		);
	}
	if (withRelations.security && typeof withRelations.security === "object") {
		withRelations.security = Array.isArray(withRelations.security)
			? withRelations.security.map(redactSecuritySecrets)
			: redactSecuritySecrets(withRelations.security as SecretRecord);
	}
	for (const key of ["server", "buildServer"]) {
		if (key in withRelations) {
			withRelations[key] = redactNestedServerSecrets(withRelations[key]);
		}
	}
	return redactServiceSharedEnv(withRelations as T, sharedEnvAccess);
};

export const redactDatabaseServiceSecrets = <
	T extends SecretRecord | null | undefined,
>(
	record: T,
) => redactDatabaseServiceSecretsFor(record);

export const redactDatabaseServiceSecretsFor = <
	T extends SecretRecord | null | undefined,
>(
	record: T,
	sharedEnvAccess: SharedEnvReadAccess = NO_SHARED_ENV_READ_ACCESS,
) => {
	const redacted = redactSecretFields(record, [
		"env",
		"databasePassword",
		"databaseRootPassword",
	]);
	if (!redacted) {
		return redacted;
	}

	const withRelations = { ...redacted };
	if ("server" in withRelations) {
		withRelations.server = redactNestedServerSecrets(withRelations.server);
	}
	return redactServiceSharedEnv(withRelations as T, sharedEnvAccess);
};

export const redactAiSettingsSecrets = <
	T extends SecretRecord | null | undefined,
>(
	record: T,
) => redactSecretFields(record, ["apiKey"]);

export const redactAiSettingsSecretsList = <T extends SecretRecord>(
	records: T[],
) => records.map(redactAiSettingsSecrets);

export const redactSecuritySecrets = <
	T extends SecretRecord | null | undefined,
>(
	record: T,
) => redactSecretFields(record, ["password"]);

const redactNestedSecretRecord = (
	record: SecretRecord | null | undefined,
	fields: string[],
) => redactSecretFields(record, fields);

export const redactBackupMetadataSecrets = <T>(metadata: T): T => {
	if (!metadata || typeof metadata !== "object") {
		return metadata;
	}

	const redacted = { ...(metadata as SecretRecord) };
	if (redacted.mariadb && typeof redacted.mariadb === "object") {
		redacted.mariadb = redactNestedSecretRecord(
			redacted.mariadb as SecretRecord,
			["databasePassword"],
		);
	}
	if (redacted.mongo && typeof redacted.mongo === "object") {
		redacted.mongo = redactNestedSecretRecord(redacted.mongo as SecretRecord, [
			"databasePassword",
		]);
	}
	if (redacted.mysql && typeof redacted.mysql === "object") {
		redacted.mysql = redactNestedSecretRecord(redacted.mysql as SecretRecord, [
			"databaseRootPassword",
		]);
	}
	return redacted as T;
};

export const redactComposeServiceSecrets = <
	T extends SecretRecord | null | undefined,
>(
	record: T,
) =>
	redactSecretFields(redactDeployableServiceSecrets(record), ["composeFile"]);

// For records such as backups, volume backups and schedules that load the
// service (and its environment/project) or server they are bound to.
export const redactServiceRelationSecrets = <
	T extends SecretRecord | null | undefined,
>(
	record: T,
) => {
	if (!record) {
		return record;
	}

	const redacted: SecretRecord = { ...record };
	if (redacted.application && typeof redacted.application === "object") {
		redacted.application = redactDeployableServiceSecrets(
			redacted.application as SecretRecord,
		);
	}
	if (redacted.compose && typeof redacted.compose === "object") {
		redacted.compose = redactComposeServiceSecrets(
			redacted.compose as SecretRecord,
		);
	}
	for (const key of [
		"postgres",
		"mysql",
		"mariadb",
		"mongo",
		"redis",
		"libsql",
	]) {
		if (redacted[key] && typeof redacted[key] === "object") {
			redacted[key] = redactDatabaseServiceSecrets(
				redacted[key] as SecretRecord,
			);
		}
	}
	if ("server" in redacted) {
		redacted.server = redactNestedServerSecrets(redacted.server);
	}

	return redacted as T;
};

export const redactBackupScheduleSecrets = <
	T extends SecretRecord | null | undefined,
>(
	record: T,
) => {
	if (!record) {
		return record;
	}

	return redactServiceRelationSecrets({
		...record,
		metadata: redactBackupMetadataSecrets(record.metadata),
	}) as T;
};

export const redactProjectNestedSecrets = <
	T extends SecretRecord | null | undefined,
>(
	project: T,
	options: { redactProjectEnv?: boolean; redactEnvironmentEnv?: boolean } = {},
) => {
	if (!project) {
		return project;
	}

	const redactedProject = { ...project };
	if (options.redactProjectEnv !== false && "env" in redactedProject) {
		redactedProject.env = redactSecretValue(redactedProject.env);
	}

	if (!Array.isArray(redactedProject.environments)) {
		return redactedProject as T;
	}

	redactedProject.environments = redactedProject.environments.map(
		(environment) => {
			if (!environment || typeof environment !== "object") {
				return environment;
			}

			const redactedEnvironment = { ...(environment as SecretRecord) };
			if (
				options.redactEnvironmentEnv !== false &&
				"env" in redactedEnvironment
			) {
				redactedEnvironment.env = redactSecretValue(redactedEnvironment.env);
			}

			if (Array.isArray(redactedEnvironment.applications)) {
				redactedEnvironment.applications = redactedEnvironment.applications.map(
					redactDeployableServiceSecrets,
				);
			}
			if (Array.isArray(redactedEnvironment.compose)) {
				redactedEnvironment.compose = redactedEnvironment.compose.map(
					(service) =>
						redactSecretFields(redactDeployableServiceSecrets(service), [
							"composeFile",
						]),
				);
			}
			for (const key of [
				"libsql",
				"mariadb",
				"mongo",
				"mysql",
				"postgres",
				"redis",
			]) {
				if (Array.isArray(redactedEnvironment[key])) {
					redactedEnvironment[key] = (
						redactedEnvironment[key] as SecretRecord[]
					).map(redactDatabaseServiceSecrets);
				}
			}

			return redactedEnvironment;
		},
	);

	return redactedProject as T;
};

type KeyPatterns = {
	beforeAuthorization: RegExp[];
	afterAuthorization: RegExp[];
};

const DEFAULT_KEY_PATTERNS: KeyPatterns = {
	beforeAuthorization: [
		new RegExp(
			`([?&#][^=\\s]*${SENSITIVE_KEY_PATTERN}[^=\\s]*=)([^&#\\s]+)`,
			"gi",
		),
		new RegExp(
			`(\\b[A-Z0-9_]*${SENSITIVE_KEY_PATTERN}[A-Z0-9_]*=)(${SHELL_VALUE_PATTERN})`,
			"gi",
		),
	],
	afterAuthorization: [
		new RegExp(
			`((?:"[^"]*${SENSITIVE_KEY_PATTERN}[^"]*"|'[^']*${SENSITIVE_KEY_PATTERN}[^']*'|\\b[^\\s:,{]*${SENSITIVE_KEY_PATTERN}[^\\s:,{]*\\b)\\s*:\\s*)("[^"]*"|'[^']*'|[^\\s,}\\]]+)`,
			"gi",
		),
		// Negated flags such as pg_dump's `--no-password` take no value, so the
		// word after them is a positional argument (the database name), not a
		// secret.
		new RegExp(
			`(\\s(?!--?no-)--?[a-z0-9-]*${SENSITIVE_KEY_PATTERN}[a-z0-9-]*(?:=|\\s+))(${SHELL_VALUE_PATTERN})`,
			"gi",
		),
	],
};

// Env-style names that hold secrets without saying "secret" or "token".
const BROAD_SENSITIVE_KEY_PATTERN =
	"(?:access[_-]?key|api[_-]?key|auth|credential|private[_-]?key|secret|token|pass|pwd|dsn|cookie|session|signature|salt|webhook|license|encrypt|jwt|[_-]key)";

// A `${...}` value is taken whole, so redacting it leaves no stray brace.
const BRACED_VALUE_PATTERN = String.raw`(?:\$\{\{[^}\s]*\}\}|\$\{[^}\s]*\})+`;
const KEY_VALUE_PATTERN = `${BRACED_VALUE_PATTERN}|"[^"]*"|'[^']*'|[^\\s,}\\]]+`;

// What follows `name:` in an image reference or a host is a tag or a port.
const TAG_OR_PORT_PATTERN = String.raw`(?:\d{1,5}|v?\d+(?:\.\d+)+[\w.-]*|latest|stable|main|master|canary|edge|nightly)(?:[/\s"',)\]]|$)`;

// The broad patterns run over whole logs and files, so each one anchors on the
// keyword and bounds what surrounds it: scanning a free prefix from every word
// boundary is quadratic on a long line without spaces. A key also has to look
// like a key with a scalar value on the same line. Otherwise the short
// keywords would read `auth-db:5432` in a URL, the image `auth-api:1.2.3` or
// the YAML mapping `auth-router:` as a secret.
const KEY_NAME_HEAD = String.raw`[\w.-]{0,60}?`;
const KEY_NAME_TAIL = String.raw`[\w.-]{0,80}`;
const BROAD_KEY = `${BROAD_SENSITIVE_KEY_PATTERN}${KEY_NAME_TAIL}`;
// `==`, `=>` and `=~` compare or map; they do not assign.
const ASSIGN = String.raw`[ \t]*=(?![=>~])[ \t]*`;

const BROAD_KEY_PATTERNS: KeyPatterns = {
	beforeAuthorization: [
		// A line that is one assignment: the value runs to the end of the line,
		// spaces included (`password = correct horse`).
		new RegExp(
			`^([ \\t]*(?:(?:export|set|setenv)[ \\t]+)?["']?${KEY_NAME_HEAD}${BROAD_KEY}["']?${ASSIGN})(\\S.*)$`,
			"gim",
		),
		new RegExp(
			`(${BROAD_SENSITIVE_KEY_PATTERN}[\\w.\\[\\]"'-]{0,80}${ASSIGN})(${SHELL_VALUE_PATTERN})`,
			"gi",
		),
		new RegExp(
			`(${BROAD_KEY}["']?[ \\t]*=>[ \\t]*)("[^"]*"|'[^']*'|[^\\s,;)\\]}]+)`,
			"gi",
		),
		new RegExp(
			`(<[\\w:.-]{0,60}?${BROAD_SENSITIVE_KEY_PATTERN}[\\w:.-]{0,80}>)([^<\\n]+)`,
			"gi",
		),
	],
	afterAuthorization: [
		new RegExp(
			`(${BROAD_SENSITIVE_KEY_PATTERN}[^"'\\n]{0,80}["'][ \\t]*:[ \\t]*)(?![{[])(${KEY_VALUE_PATTERN})`,
			"gi",
		),
		// `key: value` on its own line, the value again running to the end.
		new RegExp(
			`^([ \\t]*(?:-[ \\t]+)?${KEY_NAME_HEAD}${BROAD_KEY}[ \\t]*:[ \\t]+)(?!["'{[|>&*!])(\\S.*)$`,
			"gim",
		),
		new RegExp(
			`(?<=(?<![\\w.@/{$-])[\\w.-]{0,60})(${BROAD_KEY}[ \\t]*:[ \\t]+)(?![{[])(${KEY_VALUE_PATTERN})`,
			"gi",
		),
		// Without a space after the colon this may be `host:port` or `image:tag`.
		new RegExp(
			`(?<=(?<![\\w.@/{$-])[\\w.-]{0,60})(${BROAD_KEY}:)(?![{[\\s]|${TAG_OR_PORT_PATTERN})(${KEY_VALUE_PATTERN})`,
			"gi",
		),
		new RegExp(
			`(\\s(?!--?no-)--?[a-z0-9-]{0,60}?${BROAD_SENSITIVE_KEY_PATTERN}[a-z0-9-]{0,80}(?:=|\\s+))(${SHELL_VALUE_PATTERN})`,
			"gi",
		),
	],
};

// Config files also write a setting as `name value` (`requirepass hunter2`).
// In a log that shape is ordinary prose, so it is only read this way in a file.
const DIRECTIVE_PATTERN = new RegExp(
	`^([ \\t]*${KEY_NAME_HEAD}${BROAD_KEY}[ \\t]+)(?![=:{(<]|=>)(\\S.*?)(;?[ \\t\\r]*)$`,
	"gim",
);

const SECRET_LOOKING_NAME = new RegExp(BROAD_SENSITIVE_KEY_PATTERN, "i");

export const isSecretLookingName = (name: string) =>
	SECRET_LOOKING_NAME.test(name);

const VARIABLE_REFERENCE_PATTERN = String.raw`\$\{\{\s*[A-Za-z_][\w.-]*\s*\}\}|\$\{[A-Za-z_]\w*(?::?\?[^}]*)?\}|\$[A-Za-z_]\w*`;
const VARIABLE_REFERENCE_VALUE = new RegExp(
	`^(?:${VARIABLE_REFERENCE_PATTERN})+$`,
);

// `${VAR}`, `$VAR` and `${{project.VAR}}` name a secret without containing it.
// A reference with an inline default (`${VAR:-fallback}`) is not one of them.
export const isVariableReference = (value: string) => {
	const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
	return VARIABLE_REFERENCE_VALUE.test(quoted ? quoted[2]! : value);
};

const isVariableReferenceUserinfo = (userinfo: string) =>
	userinfo.split(":").every((part) => isVariableReference(part));

// A restorable placeholder: the plain placeholder followed by an id of the
// hidden value. The id lets the same caller send the text back and have the
// value put back where the token stands.
export const SECRET_TOKEN_PATTERN = `${REDACTED_SECRET_VALUE}[A-Z2-7]{12}__`;
const ALREADY_HIDDEN_VALUE = new RegExp(
	`^["']?${REDACTED_SECRET_VALUE}(?:[A-Z2-7]{12}__)?["']?$`,
);

export type RedactSensitiveTextOptions = {
	keepVariableReferences?: boolean;
	broadKeys?: boolean;
	// Read `name value` lines as settings; for files, not for logs.
	directives?: boolean;
	// Produces what stands in for a secret; defaults to the plain placeholder.
	replacement?: (secret: string) => string;
};

export function redactSensitiveText(
	value: string,
	options?: RedactSensitiveTextOptions,
): string;
export function redactSensitiveText(
	value: null,
	options?: RedactSensitiveTextOptions,
): null;
export function redactSensitiveText(
	value: undefined,
	options?: RedactSensitiveTextOptions,
): undefined;
export function redactSensitiveText(
	value: string | null,
	options?: RedactSensitiveTextOptions,
): string | null;
export function redactSensitiveText(
	value: string | undefined,
	options?: RedactSensitiveTextOptions,
): string | undefined;
export function redactSensitiveText(
	value: string | null | undefined,
	options?: RedactSensitiveTextOptions,
): string | null | undefined;
export function redactSensitiveText(
	value: string | null | undefined,
	options: RedactSensitiveTextOptions = {},
) {
	if (typeof value !== "string" || value === "") {
		return value;
	}

	const { replacement, keepVariableReferences } = options;
	const keyPatterns = options.broadKeys
		? BROAD_KEY_PATTERNS
		: DEFAULT_KEY_PATTERNS;
	// A token names its value, so a hidden value met again has to stay as it is:
	// a token of a token could not be resolved.
	const hide = (secret: string) => {
		if (!replacement) {
			return REDACTED_SECRET_VALUE;
		}
		return ALREADY_HIDDEN_VALUE.test(secret) ? secret : replacement(secret);
	};
	const hideValue = (match: string, prefix: string, secret: string) =>
		keepVariableReferences && isVariableReference(secret)
			? match
			: `${prefix}${hide(secret)}`;
	const hideRest = (match: string, prefix: string) =>
		`${prefix}${hide(match.slice(prefix.length))}`;

	let redacted = value;

	redacted = redacted.replace(
		/(\b[a-z][a-z0-9+.-]{0,30}:\/\/)([^@\s/?#]+)@/gi,
		(match, scheme: string, userinfo: string) =>
			keepVariableReferences && isVariableReferenceUserinfo(userinfo)
				? match
				: `${scheme}${hide(userinfo)}@`,
	);

	for (const pattern of keyPatterns.beforeAuthorization) {
		redacted = redacted.replace(pattern, hideValue);
	}

	redacted = redacted.replace(
		/(\bAuthorization\s*:\s*)(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi,
		hideRest,
	);

	for (const pattern of keyPatterns.afterAuthorization) {
		redacted = redacted.replace(pattern, hideValue);
	}

	if (options.directives) {
		redacted = redacted.replace(
			DIRECTIVE_PATTERN,
			(match, prefix: string, secret: string, end: string) =>
				keepVariableReferences && isVariableReference(secret)
					? match
					: `${prefix}${hide(secret)}${end}`,
		);
	}

	// mysql/mariadb clients take the password glued to -p. A separate word after
	// -p is not a password, uppercase -P is the port, and -p of other tools
	// (docker -p, ssh -p, compose -p) is a port or project name.
	redacted = redacted.replace(
		new RegExp(
			String.raw`(\b(?:mysql|mariadb)[a-z-]*(?:\\.|[^\n;&|\\])*?\s-p)(${SHELL_VALUE_PATTERN})`,
			"g",
		),
		hideRest,
	);

	redacted = redacted.replace(
		/(\b(?<!\bno-)(?:PASSWORD|IDENTIFIED\s+BY)\s+)(?![=:])('[^']*'|"[^"]*"|[^\s;&|]+)/gi,
		hideRest,
	);

	redacted = redacted.replace(
		/(\bredis-cli\b[^\n;&|]*?\s-a\s+)("[^"]*"|'[^']*'|[^\s;&|]+)/gi,
		hideRest,
	);

	redacted = redacted.replace(
		/(\bCONFIG\s+SET\s+requirepass\s+)("[^"]*"|'[^']*'|[^\s;&|]+)/gi,
		hideRest,
	);

	redacted = redacted.replace(
		/(\bmongo(?:dump|export|import|restore|sh)?\b[^\n;&|]*?\s-p\s+)[^\n;&|]+/gi,
		hideRest,
	);

	redacted = redacted.replace(
		/(\b(?:postgres(?:ql)?|mysql|mariadb|mongodb|redis):\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi,
		(match, prefix: string, password: string, at: string) =>
			keepVariableReferences && isVariableReference(password)
				? match
				: `${prefix}${hide(password)}${at}`,
	);

	redacted = redacted.replace(
		/\b(Bearer|Basic)\s+([A-Za-z0-9._~+/-]+=*)/gi,
		(_match, scheme: string, token: string) => `${scheme} ${hide(token)}`,
	);

	redacted = redacted.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, hide);

	return redacted;
}

export const secretUpdateValue = (value: unknown) => {
	if (
		typeof value !== "string" ||
		value.trim() === "" ||
		isSecretPlaceholderValue(value)
	) {
		return undefined;
	}

	return value;
};

type SecretTargetFields = Record<
	string,
	readonly [next: unknown, stored: unknown]
>;

const isUnsetSecretTargetValue = (value: unknown) =>
	value === undefined || value === null || value === "";

export const changedSecretTargetFields = (fields: SecretTargetFields) =>
	Object.entries(fields)
		.filter(([, [next, stored]]) =>
			isUnsetSecretTargetValue(next) && isUnsetSecretTargetValue(stored)
				? false
				: next !== stored,
		)
		.map(([field]) => field);

// A kept stored secret may only travel to the endpoint and identity it was
// saved with. Otherwise a caller who can edit the record but not read the
// secret could point it at a host they control and capture it.
export const assertStoredSecretTargetUnchanged = (
	secretLabel: string,
	fields: SecretTargetFields,
) => {
	const changed = changedSecretTargetFields(fields);
	if (changed.length > 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Re-enter the ${secretLabel} to change ${changed.join(", ")}`,
		});
	}
};

export const preserveSecretPlaceholderFields = <
	TUpdate extends object,
	TCurrent extends object,
>(
	update: TUpdate,
	current: TCurrent,
	fields: readonly (keyof TUpdate & keyof TCurrent)[],
) => {
	const next: Record<PropertyKey, unknown> = {
		...(update as unknown as Record<PropertyKey, unknown>),
	};
	const currentRecord = current as Record<PropertyKey, unknown>;

	for (const field of fields) {
		if (isSecretPlaceholderValue(next[field])) {
			next[field] = currentRecord[field];
		}
	}

	return next as TUpdate;
};

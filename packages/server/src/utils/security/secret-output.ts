import { hideComposeSecrets } from "./compose-secrets";
import { REDACTED_SECRET_VALUE } from "./redaction";
import {
	EMPTY_KNOWN_SECRET_MATCHER,
	type KnownSecretMatcher,
	scrubSecretText,
	secretTokenFor,
} from "./secret-scrub";

/**
 * An API key response never carries secret values: fields that hold secrets
 * are blanked, compose files keep their structure with every value hidden
 * behind a restorable token, and every other string (logs, mounted files,
 * commands) is scrubbed as text.
 */

const SENSITIVE_OUTPUT_KEY =
	/(?:env$|buildargs$|buildsecrets$|password|passwd|passphrase|secret|tokens?$|private_?key|api_?key$|access_?key|credential|authorization|^cookie$|dsn$|connection_?string|webhook_?url$|^dockerauth$|license_?key$|^userkey$|^headers$)/i;

// `secretName`, `apiKeyId` or `tokenType` describe a secret without holding it.
const DESCRIPTIVE_KEY_SUFFIX =
	/(?:Id|Ids|Name|Names|Path|Type|Count|At|Enabled|Status|Length|Prefix)$/;

// Identifiers, revisions and image references are never secrets, and a caller
// that gets one back mangled can no longer address the resource or pass the
// revision on.
const IDENTITY_KEY =
	/(?:^id$|Id$|Ids$|^name$|Name$|^revision$|Revision$|^image$|Image$)/;

export const isSensitiveOutputKey = (key: string) =>
	SENSITIVE_OUTPUT_KEY.test(key) && !DESCRIPTIVE_KEY_SUFFIX.test(key);

// Text the caller may edit and send back: its hidden values carry a token, so
// the panel can put them back on the matching write.
const COMPOSE_TEXT_KEY = /^composeFile$/;
const FILE_TEXT_KEY = /^content$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
};

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

// Under a secret-bearing key every value is blanked. The names in a list of
// assignments (a docker `Env` array) and the keys of a map stay readable.
const blankSecretValue = (value: unknown, listItem = false): unknown => {
	if (typeof value === "string") {
		if (value === "") {
			return value;
		}
		const assignment = listItem ? ENV_ASSIGNMENT.exec(value) : null;
		return assignment
			? `${assignment[1]}=${REDACTED_SECRET_VALUE}`
			: REDACTED_SECRET_VALUE;
	}
	if (Array.isArray(value)) {
		return value.map((item) => blankSecretValue(item, true));
	}
	if (isPlainObject(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, blankSecretValue(item)]),
		);
	}
	return value;
};

const scrubValue = (
	value: unknown,
	key: string | null,
	matcher: KnownSecretMatcher,
): unknown => {
	if (typeof value === "string") {
		if (key === null) {
			return scrubSecretText(value, matcher);
		}
		if (IDENTITY_KEY.test(key)) {
			return value;
		}
		if (COMPOSE_TEXT_KEY.test(key)) {
			return hideComposeSecrets(value, matcher, secretTokenFor);
		}
		return scrubSecretText(
			value,
			matcher,
			FILE_TEXT_KEY.test(key) ? secretTokenFor : undefined,
		);
	}
	if (Array.isArray(value)) {
		return value.map((item) => scrubValue(item, key, matcher));
	}
	if (!isPlainObject(value)) {
		return value;
	}
	return Object.fromEntries(
		Object.entries(value).map(([childKey, child]) => [
			childKey,
			isSensitiveOutputKey(childKey)
				? blankSecretValue(child)
				: scrubValue(child, childKey, matcher),
		]),
	);
};

export const scrubSecretOutput = <T>(
	value: T,
	matcher: KnownSecretMatcher = EMPTY_KNOWN_SECRET_MATCHER,
): T => scrubValue(value, null, matcher) as T;

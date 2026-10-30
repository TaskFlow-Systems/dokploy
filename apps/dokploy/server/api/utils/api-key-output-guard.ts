import { getKnownSecretMatcher } from "@dokploy/server/services/known-secrets";
import {
	hideComposeSecrets,
	restoreComposeSecrets,
	restoreTextSecrets,
	SecretRestoreError,
} from "@dokploy/server/utils/security/compose-secrets";
import {
	isExactSecretPlaceholder,
	isSecretPlaceholderValue,
} from "@dokploy/server/utils/security/redaction";
import {
	isSensitiveOutputKey,
	scrubSecretOutput,
} from "@dokploy/server/utils/security/secret-output";
import {
	EMPTY_KNOWN_SECRET_MATCHER,
	scrubSecretText,
} from "@dokploy/server/utils/security/secret-scrub";
import { TRPCError } from "@trpc/server";
import { isApiKeySession } from "@/server/api/utils/api-key-session";

// These hand back a stored secret or raw file bytes, which no scrubbing can
// make safe (a container file may be nothing but one token), so an API key
// cannot call them at all.
const API_KEY_DENIED_PROCEDURES = new Set([
	"compose.loadComposeVariables",
	"docker.getConfig",
	"docker.readContainerFile",
	"dockerVolume.readVolumeFile",
	"settings.readTraefikEnv",
	"user.revealApiKey",
]);

// The OpenAPI document describes fields named `password` or `env` without
// holding a value, and blanking it would break the clients generated from it.
const API_KEY_UNSCRUBBED_PROCEDURES = new Set(["settings.getOpenApiDocument"]);

export const isProcedureDeniedForApiKey = (path: string) =>
	API_KEY_DENIED_PROCEDURES.has(path) || path.endsWith(".revealEnvironment");

export const assertProcedureAllowedForApiKey = (path: string) => {
	if (isProcedureDeniedForApiKey(path)) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message:
				"This procedure returns secret values and is not available to API keys",
		});
	}
};

// These procedures answer with a compose file as a bare string.
const COMPOSE_TEXT_PROCEDURES = new Set([
	"compose.getConvertedCompose",
	"compose.isolatedDeployment",
	"compose.randomizeCompose",
]);

// The one field of each of these procedures that may carry tokens: the
// procedure puts the hidden values back from the stored text.
const RESTORED_INPUT_FIELDS: Record<string, string> = {
	"compose.update": "composeFile",
	"mounts.update": "content",
};

const findRedactedText = (value: unknown, key: string | null): boolean => {
	if (typeof value === "string") {
		if (!isSecretPlaceholderValue(value)) {
			return false;
		}
		return !(
			key !== null &&
			isSensitiveOutputKey(key) &&
			isExactSecretPlaceholder(value)
		);
	}
	if (Array.isArray(value)) {
		return value.some((item) => findRedactedText(item, key));
	}
	if (value !== null && typeof value === "object") {
		return Object.entries(value).some(([childKey, child]) =>
			findRedactedText(child, childKey),
		);
	}
	return false;
};

// Text that was scrubbed on the way out must not come back in: saving it would
// overwrite the real value with the placeholder. A whole secret field sent
// back as the bare placeholder still means "keep what is stored".
export const assertNoRedactedTextInInput = (path: string, input: unknown) => {
	const restoredField = RESTORED_INPUT_FIELDS[path];
	const checked =
		restoredField && input !== null && typeof input === "object"
			? { ...input, [restoredField]: undefined }
			: input;
	if (findRedactedText(checked, null)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"The input contains redacted text. Hidden values can only be sent back as tokens in a compose file (compose.update) or a file mount (mounts.update); change environment variables with env.apply",
		});
	}
};

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
	value !== null &&
	typeof value === "object" &&
	typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function";

async function* scrubStream(source: AsyncIterable<unknown>) {
	for await (const chunk of source) {
		yield scrubSecretOutput(chunk, await getKnownSecretMatcher());
	}
}

export const scrubApiKeyResult = async (path: string, data: unknown) => {
	if (API_KEY_UNSCRUBBED_PROCEDURES.has(path)) {
		return data;
	}
	if (isAsyncIterable(data)) {
		return scrubStream(data);
	}
	const matcher = await getKnownSecretMatcher();
	return typeof data === "string" && COMPOSE_TEXT_PROCEDURES.has(path)
		? hideComposeSecrets(data, matcher)
		: scrubSecretOutput(data, matcher);
};

type RestoreSession = Parameters<typeof isApiKeySession>[0];

// An API key reads these texts with their secrets replaced by tokens. When it
// sends the text back, the values behind the tokens are put back from what is
// stored, so the caller can edit the rest without ever seeing them.
export const restoreApiKeyText = async <T extends string | null | undefined>(
	session: RestoreSession,
	kind: "compose" | "file",
	submitted: T,
	stored: string | null | undefined,
): Promise<T | string> => {
	if (!isApiKeySession(session) || typeof submitted !== "string") {
		return submitted;
	}
	const restore =
		kind === "compose" ? restoreComposeSecrets : restoreTextSecrets;
	try {
		return restore(submitted, stored, await getKnownSecretMatcher());
	} catch (error) {
		if (error instanceof SecretRestoreError) {
			throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
		}
		throw error;
	}
};

export const scrubApiKeyError = async (error: TRPCError) => {
	const matcher = await getKnownSecretMatcher().catch(
		() => EMPTY_KNOWN_SECRET_MATCHER,
	);
	const message = scrubSecretText(error.message, matcher);
	return message === error.message
		? error
		: new TRPCError({ code: error.code, message, cause: error.cause });
};

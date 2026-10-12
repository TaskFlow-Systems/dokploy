import { getKnownSecretMatcher } from "@dokploy/server/services/known-secrets";
import {
	isExactSecretPlaceholder,
	isSecretPlaceholderValue,
} from "@dokploy/server/utils/security/redaction";
import {
	EMPTY_KNOWN_SECRET_MATCHER,
	isSensitiveOutputKey,
	scrubSecretOutput,
	scrubSecretText,
} from "@dokploy/server/utils/security/secret-scrub";
import { TRPCError } from "@trpc/server";

// These hand back a stored secret or raw file bytes, which no scrubbing can
// make safe (a container file may be nothing but one token), so an API key
// cannot call them at all.
const API_KEY_DENIED_PROCEDURES = new Set([
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
export const assertNoRedactedTextInInput = (input: unknown) => {
	if (findRedactedText(input, null)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"The input contains redacted text. Read values are scrubbed for API keys and cannot be written back; change environment variables with env.apply instead",
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
	return isAsyncIterable(data)
		? scrubStream(data)
		: scrubSecretOutput(data, await getKnownSecretMatcher());
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

import { timingSafeEqual } from "node:crypto";

export const isValidApiKey = (
	configuredKey: string | undefined,
	authHeader: string | undefined,
) => {
	const hasConfiguredKey =
		typeof configuredKey === "string" && configuredKey.trim().length > 0;
	const hasAuthHeader =
		typeof authHeader === "string" && authHeader.trim().length > 0;
	if (!hasConfiguredKey || !hasAuthHeader) {
		return false;
	}

	const expected = Buffer.from(configuredKey);
	const received = Buffer.from(authHeader);
	return (
		expected.length === received.length && timingSafeEqual(expected, received)
	);
};

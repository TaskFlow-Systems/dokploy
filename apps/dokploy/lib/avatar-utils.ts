/**
 * Checks if the given avatar value represents a solid color in hexadecimal format.
 *
 * @param value Avatar value to check.
 *
 * @return True if the avatar is a solid color, false otherwise.
 */
export function isSolidColorAvatar(value?: string | null) {
	return (
		(value?.startsWith("#") && /^#[0-9A-Fa-f]{6}$/.test(value)) ||
		value?.startsWith("color:") ||
		false
	);
}

const GRAVATAR_BASE_URL = "https://www.gravatar.com/avatar/";

export function getGravatarUrl(hash: string) {
	return `${GRAVATAR_BASE_URL}${hash}`;
}

export function isGravatarAvatar(value?: string | null): value is string {
	return value?.startsWith(GRAVATAR_BASE_URL) ?? false;
}

/**
 * Gets the avatar type for form selection (RadioGroup value).
 *
 * @param value Avatar value.
 *
 * @return "upload" for base64 images, "color" for solid colors, or the original value for other types.
 */
export function getAvatarType(value?: string | null) {
	if (!value) return "";

	if (value.startsWith("data:")) return "upload";
	if (isSolidColorAvatar(value)) return "color";

	return value;
}

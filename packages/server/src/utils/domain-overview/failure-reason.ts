const MAX_REASON_LENGTH = 200;

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi;
const PEM_BLOCK = /-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/g;
const SECRET_ASSIGNMENT =
	/\b(?:password|passwd|secret|token|api[_-]?key|authorization)\b\s*[=:]\s*\S+/gi;
const LONG_TOKEN = /[A-Za-z0-9+/_=-]{24,}/g;

export const sanitizeFailureText = (text: string) => {
	const firstLine =
		text
			.replace(PEM_BLOCK, "[key removed]")
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "";
	const cleaned = firstLine
		.replace(SECRET_ASSIGNMENT, "[removed]")
		.replace(IPV4, "[address]")
		.replace(IPV6, "[address]")
		.replace(LONG_TOKEN, "[removed]");
	return cleaned.length > MAX_REASON_LENGTH
		? `${cleaned.slice(0, MAX_REASON_LENGTH)}...`
		: cleaned;
};

export const buildFailureReason = (parts: {
	exitCode?: number | null;
	text?: string;
}) => {
	const pieces: string[] = [];
	if (typeof parts.exitCode === "number") {
		pieces.push(`exit code ${parts.exitCode}`);
	}
	const text = sanitizeFailureText(parts.text ?? "");
	if (text) {
		pieces.push(text);
	}
	return pieces.join(": ");
};

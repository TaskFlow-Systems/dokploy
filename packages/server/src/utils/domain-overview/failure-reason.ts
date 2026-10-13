const MAX_REASON_LENGTH = 200;

const PEM_BLOCK = /-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/g;
const SECRET_ASSIGNMENT =
	/\b(?:password|passwd|secret|token|api[_-]?key|authorization)\b\s*[=:]\s*\S+/gi;
const LONG_TOKEN = /[A-Za-z0-9+/_=-]{24,}/g;
const BRACKETED_ADDRESS = /\[[0-9a-f:.]*:[0-9a-f:.]*\](?::\d+)?/gi;
const IPV6 =
	/(?<![\w:])[0-9a-f]*(?::[0-9a-f]*){2,}(?:\.\d{1,3}){0,3}(?:%[\w.-]+)?(?![\w])/gi;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b(?::\d+)?/g;
const CONNECTION_TARGET =
	/\b(ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EPIPE)\b(\s+)(?!\[)[^\s,;]+/g;

const USER_AT_HOST = /[\w.-]+@[\w.-]+/g;
const HOST_PHRASE =
	/\b(connect to host|could not resolve hostname|resolve hostname|host key for|known_hosts for|no route to host)(\s+)[^\s,;:]+/gi;
const QUOTED_HOST = /(['"])[\w-]+(?:\.[\w-]+)+\1/g;

export const sanitizeFailureText = (text: string) => {
	const firstLine =
		text
			.replace(PEM_BLOCK, "[key removed]")
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "";
	const cleaned = firstLine
		.replace(SECRET_ASSIGNMENT, "[removed]")
		.replace(USER_AT_HOST, "[removed]")
		.replace(HOST_PHRASE, "$1$2[host]")
		.replace(QUOTED_HOST, "[host]")
		.replace(BRACKETED_ADDRESS, "[address]")
		.replace(CONNECTION_TARGET, "$1$2[host]")
		.replace(IPV6, "[address]")
		.replace(IPV4, "[address]")
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

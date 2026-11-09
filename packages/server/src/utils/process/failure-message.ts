import { redactSensitiveText } from "../security/redaction";
import { ExecError } from "./ExecError";

const MAX_STDERR_CHARS = 2000;
const RCLONE_NO_CONFIG_NOTICE = /^.*NOTICE: Config file .* not found.*$/gim;

// The exit code alone ("exit code 1") never says why a command failed; its
// output does. Commands run with their output captured, so it only exists on
// the error. The result is safe to show in the UI and to send in messages.
export const formatCommandFailure = (error: unknown): string => {
	if (error instanceof ExecError) {
		const stderr = (error.stderr ?? "")
			.replace(RCLONE_NO_CONFIG_NOTICE, "")
			.trim();
		const tail =
			stderr.length > MAX_STDERR_CHARS
				? `...${stderr.slice(-MAX_STDERR_CHARS)}`
				: stderr;
		const message = error.message;
		return redactSensitiveText(
			tail && !message.includes(tail) ? `${message}\n${tail}` : message,
		);
	}
	return redactSensitiveText(
		error instanceof Error ? error.message : String(error),
	);
};

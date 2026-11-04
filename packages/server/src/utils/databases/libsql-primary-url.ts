// The replica's form imports this too, so it stays free of server-only modules.

// The custom command form saves "" when left empty, even when the user only changed
// the image, so "" asks for no override, as null does.
export const getCustomLibsqlCommand = (command: string | null | undefined) =>
	command?.trim() ? command : null;

const getHttpProtocol = (url: string) => {
	if (/\s/.test(url)) return null;
	try {
		const { protocol } = new URL(url);
		return protocol === "http:" || protocol === "https:" ? protocol : null;
	} catch {
		return null;
	}
};

// Each of these starts a node that never replicates while the deployment reports
// success. Without a scheme sqld stays up and panics on every request.
export const getLibsqlPrimaryUrlProblem = (
	sqldPrimaryUrl: string | null | undefined,
	command: string | null | undefined,
) => {
	if (!sqldPrimaryUrl) {
		return "A libSQL replica needs the URL of its primary";
	}
	const protocol = getHttpProtocol(sqldPrimaryUrl);
	if (!protocol) {
		return "The URL of a libSQL replica's primary must be a full http:// URL: use the primary's Internal Replication Connection URL";
	}
	// sqld stays up and every request hangs. The field's placeholder used to suggest
	// https, and only a custom command can pass the TLS flags.
	if (protocol === "https:" && !getCustomLibsqlCommand(command)) {
		return "The default libSQL command connects to its primary without TLS: use the primary's http:// Internal Replication Connection URL, or a custom command with the --primary-grpc-tls flags";
	}
	return null;
};

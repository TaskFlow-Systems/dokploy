// The replica's form imports this too, so it stays free of server-only modules.

import { LIBSQL_GRPC_REPLICA_FLAGS } from "./libsql-grpc-flags";

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
	if (!getHttpProtocol(sqldPrimaryUrl)) {
		return "The URL of a libSQL replica's primary must be a full http:// or https:// URL: use the primary's Internal Replication Connection URL";
	}
	// The primary refuses a node without the panel's certificate, and sqld takes
	// the certificate only from these flags.
	const custom = getCustomLibsqlCommand(command);
	if (custom && !custom.includes("--primary-grpc-tls")) {
		return `A custom libSQL replica command has to connect with the panel's certificate: add ${LIBSQL_GRPC_REPLICA_FLAGS}`;
	}
	return null;
};

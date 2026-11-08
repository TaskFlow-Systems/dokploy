import path from "node:path";
import {
	normalizeRelativeFilePath,
	quoteShellArg,
} from "../filesystem/safe-path";

const SAFE_RESTORE_NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;

export const normalizeRestoreBackupFile = (
	backupFile: string,
	allowedExtensions: string[],
) => {
	const objectPath = normalizeRelativeFilePath(backupFile);

	if (!allowedExtensions.some((extension) => objectPath.endsWith(extension))) {
		throw new Error("Invalid backup file extension");
	}

	return {
		fileName: path.posix.basename(objectPath),
		objectPath,
	};
};

export const normalizeRestoreDatabaseName = (databaseName: string) => {
	const normalizedDatabaseName = databaseName.trim();

	if (!SAFE_RESTORE_NAME_PATTERN.test(normalizedDatabaseName)) {
		throw new Error("Invalid database name");
	}

	return normalizedDatabaseName;
};

export const normalizeRestoreServiceName = (serviceName?: string) => {
	if (!serviceName) {
		return undefined;
	}

	const normalizedServiceName = serviceName.trim();

	if (!SAFE_RESTORE_NAME_PATTERN.test(normalizedServiceName)) {
		throw new Error("Invalid service name");
	}

	return normalizedServiceName;
};

export const quoteRestoreShellArg = (value: string) => quoteShellArg(value);

// Scripts with pipes run under bash with pipefail, so a failing first stage is
// not hidden by a last stage that exits 0. The login shell of a remote host (or
// /bin/sh on a Debian panel image) may be dash, which has no pipefail.
// The script is carried in a quoted heredoc inside a command substitution, so
// its text is not quoted a second time (the redaction of secrets relies on the
// shapes quoting gives them) and bash's stdin stays free for `docker exec -i`.
export const wrapBashPipefail = (script: string) => {
	const delimiter = "DOKPLOY_SCRIPT_END";
	if (script.includes(delimiter)) {
		throw new Error("Script contains the heredoc delimiter.");
	}
	return `bash -c "$(cat <<'${delimiter}'\nset -o pipefail\n${script}\n${delimiter}\n)"`;
};

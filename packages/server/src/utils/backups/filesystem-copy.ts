import { ENCRYPTION_KEY_BACKUP_FILE } from "@dokploy/server/lib/encryption";
import { ACME_DELETE_BACKUP_EXCLUDES } from "../domain-overview/acme-delete";

export const buildFilesystemCopyCommand = (
	basePath: string,
	destination: string,
) => {
	const excludes = [
		"volume-backups/",
		ENCRYPTION_KEY_BACKUP_FILE,
		...ACME_DELETE_BACKUP_EXCLUDES,
	]
		.map((pattern) => `--exclude='${pattern}'`)
		.join(" ");
	return `rsync -a --ignore-errors --no-specials --no-devices ${excludes} ${basePath}/ ${destination}/`;
};

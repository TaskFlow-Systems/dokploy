import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildFilesystemCopyCommand } from "@dokploy/server/utils/backups/filesystem-copy";
import { afterEach, describe, expect, it } from "vitest";

const hasRsync = spawnSync("sh", ["-c", "command -v rsync"]).status === 0;
let root = "";

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("web server backup", () => {
	it.skipIf(!hasRsync)(
		"leaves the certificate backups, the lock, the marker and their temp files out of the archive",
		() => {
			root = mkdtempSync(path.join(tmpdir(), "web-backup-"));
			const base = path.join(root, "etc-dokploy");
			const dynamic = path.join(base, "traefik", "dynamic");
			mkdirSync(path.join(base, "acme-backups"), { recursive: true });
			mkdirSync(path.join(base, "volume-backups"), { recursive: true });
			mkdirSync(dynamic, { recursive: true });
			const kept = [
				path.join(base, "traefik", "traefik.yml"),
				path.join(dynamic, "acme.json"),
				path.join(dynamic, "app.yml"),
				path.join(base, "acme-notes.txt"),
			];
			const dropped = [
				path.join(base, "acme-backups", "acme.json.bak-20261012T101500Z"),
				path.join(base, "acme-delete.lock"),
				path.join(base, "acme-delete.lock.tmp.123"),
				path.join(base, "acme-delete.lock.out.123.rc"),
				path.join(base, "acme-delete.marker"),
				path.join(base, "acme-delete.marker.tmp.123"),
				path.join(dynamic, "acme.json.new-20261012T101500Z"),
				path.join(dynamic, "acme.json.restore-recovery"),
				path.join(base, "volume-backups", "x"),
			];
			for (const file of [...kept, ...dropped]) {
				writeFileSync(file, "content");
			}

			const destination = path.join(root, "out");
			mkdirSync(destination);
			const result = spawnSync(
				"sh",
				["-c", buildFilesystemCopyCommand(base, destination)],
				{ encoding: "utf8" },
			);

			expect(result.status).toBe(0);
			for (const file of kept) {
				expect(
					existsSync(path.join(destination, path.relative(base, file))),
				).toBe(true);
			}
			for (const file of dropped) {
				expect(
					existsSync(path.join(destination, path.relative(base, file))),
				).toBe(false);
			}
		},
	);

	it("names every excluded path in the command", () => {
		const command = buildFilesystemCopyCommand("/etc/dokploy", "/tmp/x");
		expect(command).toContain("--exclude='/acme-backups/'");
		expect(command).toContain("--exclude='/acme-delete.lock*'");
		expect(command).toContain("--exclude='/acme-delete.marker*'");
		expect(command).toContain("--exclude='volume-backups/'");
	});
});

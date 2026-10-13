import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import {
	buildDeletionStatusCommand,
	buildTraefikRecoveryScript,
	parseDeletionStatus,
	parseRecoveryStatus,
} from "@dokploy/server/utils/domain-overview/acme-delete";
import { beforeEach, describe, expect, it } from "vitest";
import {
	acmeDir,
	acmeFile,
	backupDir,
	baseEnv,
	callsOf,
	idOf,
	lockFile,
	logDir,
	markerFile,
	REAL_JQ,
	resultOf,
	run,
	running,
	SHELLS,
	setupBin,
	stateDir,
	targets,
	workDir,
	writeAcme,
} from "./acme-delete-harness";

const BACKUP_NAME = "acme.json.bak-20261012T101500Z";

const PRIMARY = SHELLS.slice(0, 1);

const recover = (shell: string, env: Record<string, string> = {}) =>
	spawnSync(
		shell,
		[
			"-c",
			buildTraefikRecoveryScript({
				acmeFile,
				lockFile,
				markerFile,
				backupDir,
				pollSeconds: 0,
				settleSeconds: 0,
				waitSeconds: 1,
				dockerSeconds: 2,
				stopSeconds: 2,
			}),
		],
		{ encoding: "utf8", env: baseEnv(env) },
	);

const statusOf = (shell: string, env: Record<string, string> = {}) =>
	spawnSync(
		shell,
		[
			"-c",
			buildDeletionStatusCommand({
				logDir,
				lockFile,
				markerFile,
				acmeFile,
				dockerSeconds: 2,
			}),
		],
		{ encoding: "utf8", env: baseEnv(env) },
	);

const writeMarker = (phase: string, backup = "", newId = "") =>
	writeFileSync(
		markerFile,
		`kind=container\nreplicas=1\nts=20261012T101500Z\nphase=${phase}\nbackup=${backup}\nnew=${newId}\n`,
	);

const putBackup = () => {
	mkdirSync(backupDir, { recursive: true });
	const backup = path.join(backupDir, BACKUP_NAME);
	writeFileSync(backup, readFileSync(acmeFile));
	return backup;
};

const liveOwner = () =>
	spawnSync(
		"sh",
		[
			"-c",
			`echo "${process.pid} $(if [ -r /proc/${process.pid}/stat ]; then sed 's/^.*) //' /proc/${process.pid}/stat | cut -d' ' -f20; else ps -o lstart= -p ${process.pid} | tr -s ' ' '_'; fi) $(if [ -r /proc/sys/kernel/random/boot_id ]; then cat /proc/sys/kernel/random/boot_id; else sysctl -n kern.boottime | tr -s ' ,{}=' '_'; fi)"`,
		],
		{ encoding: "utf8" },
	).stdout;

describe.skipIf(!REAL_JQ).each(PRIMARY)(
	"recovery guards, under $label",
	{ timeout: 60_000 },
	({ path: shell }) => {
		beforeEach(() => {
			setupBin({ jq: true, shell });
			writeFileSync(path.join(stateDir, "running"), "false\n");
		});

		const edited = () => {
			const backup = putBackup();
			writeAcme({ letsencrypt: { Account: {}, Certificates: [] } });
			return { backup, newId: idOf(acmeFile) };
		};

		it("does not overwrite a newer acme.json with an old backup", () => {
			const { backup, newId } = edited();
			writeMarker("edited", backup, newId);
			const newer = `{"letsencrypt":{"Certificates":[{"domain":{"main":"later.example.com"}}]}}`;
			writeFileSync(acmeFile, newer);

			const result = recover(shell, { FAKE_START_FAIL: "always" });

			expect(parseRecoveryStatus(result.stdout)).toBe("recovery_failed");
			expect(readFileSync(acmeFile, "utf8")).toBe(newer);
			expect(existsSync(markerFile)).toBe(true);
		});

		it("does not put the backup over a file that Traefik rewrote while failing to start", () => {
			writeFileSync(path.join(stateDir, "running"), "true\n");
			const result = run(shell, targets("one.example.com"), {
				FAKE_START_FAIL: "once",
				FAKE_START_WRITES: "1",
			});

			expect(resultOf(result.stdout)).toBe("start_failed_restore_failed");
			expect(readFileSync(acmeFile, "utf8")).toBe(
				'{"letsencrypt":{"Certificates":[]}}',
			);
			expect(running()).toBe("true");
		});

		it("does not restore when the file changed after the marker was written", () => {
			const { backup, newId } = edited();
			writeMarker("edited", backup, newId);
			const later = new Date(Date.now() + 60_000);
			utimesSync(acmeFile, later, later);
			const before = readFileSync(acmeFile, "utf8");

			const result = recover(shell, { FAKE_START_FAIL: "always" });

			expect(parseRecoveryStatus(result.stdout)).toBe("recovery_failed");
			expect(readFileSync(acmeFile, "utf8")).toBe(before);
		});

		it("does not restore without a recorded hash", () => {
			const { backup } = edited();
			writeMarker("edited", backup, "");
			const before = readFileSync(acmeFile, "utf8");

			const result = recover(shell, { FAKE_START_FAIL: "always" });

			expect(parseRecoveryStatus(result.stdout)).toBe("recovery_failed");
			expect(readFileSync(acmeFile, "utf8")).toBe(before);
		});

		it("leaves the original file alone when the interrupted edit never reached it", () => {
			const backup = putBackup();
			const original = readFileSync(acmeFile, "utf8");
			writeMarker("editing", backup, "0".repeat(64));

			const result = recover(shell, { FAKE_START_FAIL: "always" });

			expect(parseRecoveryStatus(result.stdout)).toBe("recovery_failed");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
		});

		it("falls back to size and modification time when no hash tool exists", () => {
			const { backup } = edited();
			const stat = spawnSync(
				"sh",
				[
					"-c",
					`stat -c '%s-%Y' '${acmeFile}' 2>/dev/null || stat -f '%z-%m' '${acmeFile}'`,
				],
				{ encoding: "utf8" },
			).stdout.trim();
			writeMarker("edited", backup, `stat:${stat}`);
			for (const tool of ["sha256sum", "shasum", "openssl"]) {
				rmSync(path.join(workDir, "bin", tool), { force: true });
			}
			const original = readFileSync(path.join(backupDir, BACKUP_NAME), "utf8");

			const result = recover(shell, { FAKE_START_FAIL: "once" });

			expect(parseRecoveryStatus(result.stdout)).toBe("recovered_restored");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
		});

		it("removes the leftovers of dead runs and nothing else", () => {
			writeMarker("stopped");
			const leftovers = [
				`${lockFile}.tmp.4242`,
				`${lockFile}.out.4242`,
				`${lockFile}.out.4242.rc`,
				`${lockFile}.out.4242.pid`,
				`${lockFile}.stale.4242`,
				`${markerFile}.tmp.4242`,
				`${acmeFile}.new-20250101T000000Z`,
				`${acmeFile}.restore-recovery`,
			];
			const others = [
				`${lockFile}.tmp.notapid`,
				`${acmeFile}.bak`,
				path.join(workDir, "acme-delete.other"),
				path.join(acmeDir, "app.yml"),
			];
			for (const file of [...leftovers, ...others]) {
				writeFileSync(file, "x");
			}

			recover(shell);

			for (const file of leftovers) {
				expect(existsSync(file)).toBe(false);
			}
			for (const file of others) {
				expect(existsSync(file)).toBe(true);
			}
		});
	},
);

describe.skipIf(!REAL_JQ).each(PRIMARY)(
	"the status read, under $label",
	{ timeout: 60_000 },
	({ path: shell }) => {
		beforeEach(() => {
			setupBin({ jq: true, shell });
		});

		it("clears a leftover marker when Traefik runs and no live script owns the lock", () => {
			writeMarker("edited", "", "abc");
			writeFileSync(`${lockFile}.tmp.4242`, "x");

			const parsed = parseDeletionStatus(statusOf(shell).stdout);

			expect(existsSync(markerFile)).toBe(false);
			expect(parsed.marker).toBeNull();
			expect(existsSync(`${lockFile}.tmp.4242`)).toBe(false);
			expect(existsSync(lockFile)).toBe(false);
		});

		it("also clears the stale lock of the dead run when Traefik runs", () => {
			writeMarker("stopped");
			writeFileSync(lockFile, "999999 none other-boot\n");

			const parsed = parseDeletionStatus(statusOf(shell).stdout);

			expect(existsSync(markerFile)).toBe(false);
			expect(parsed.stale).toBe(false);
		});

		it("keeps the marker while a live script owns the lock", () => {
			writeMarker("stopping");
			writeFileSync(lockFile, liveOwner());

			const parsed = parseDeletionStatus(statusOf(shell).stdout);

			expect(parsed.busy).toBe(true);
			expect(existsSync(markerFile)).toBe(true);
			expect(callsOf()).toEqual([]);
		});

		it("keeps the marker and the stale lock while Traefik is stopped", () => {
			writeMarker("stopped");
			writeFileSync(lockFile, "999999 none other-boot\n");
			writeFileSync(path.join(stateDir, "running"), "false\n");

			const parsed = parseDeletionStatus(statusOf(shell).stdout);

			expect(parsed.stale).toBe(true);
			expect(parsed.marker).toEqual({ kind: "container", phase: "stopped" });
			expect(existsSync(markerFile)).toBe(true);
		});

		it("keeps the marker when docker does not answer", () => {
			writeMarker("stopped");

			statusOf(shell, { FAKE_PS_FAILS: "1" });

			expect(existsSync(markerFile)).toBe(true);
		});

		it("does not touch docker at all when there is no marker", () => {
			statusOf(shell);

			expect(callsOf()).toEqual([]);
		});
	},
);

describe.skipIf(!REAL_JQ).each(PRIMARY)(
	"leftovers of dead runs, under $label",
	{ timeout: 60_000 },
	({ path: shell }) => {
		beforeEach(() => {
			setupBin({ jq: true, shell });
		});

		const files = () => ({
			dead: [
				`${lockFile}.tmp.4242`,
				`${lockFile}.out.4242`,
				`${lockFile}.out.4242.rc`,
				`${lockFile}.out.4242.pid`,
				`${markerFile}.tmp.4242`,
				`${acmeFile}.new-20250101T000000Z`,
			],
			other: [
				`${lockFile}.tmp.notapid`,
				path.join(workDir, "acme-delete.keep"),
				path.join(acmeDir, "app.yml"),
			],
		});

		it("removes them at the start of the next run, and only them", () => {
			const { dead, other } = files();
			for (const file of [...dead, ...other]) {
				writeFileSync(file, "x");
			}

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("ok");
			for (const file of dead) {
				expect(existsSync(file)).toBe(false);
			}
			for (const file of other) {
				expect(existsSync(file)).toBe(true);
			}
		});

		it("leaves them alone while a live script owns the lock", () => {
			const { dead } = files();
			for (const file of dead) {
				writeFileSync(file, "x");
			}
			writeFileSync(lockFile, liveOwner());

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("busy");
			for (const file of dead) {
				expect(existsSync(file)).toBe(true);
			}
		});
	},
);

describe.skipIf(!REAL_JQ || process.getuid?.() === 0).each(PRIMARY)(
	"docker through sudo, under $label",
	{ timeout: 60_000 },
	({ path: shell }) => {
		it("calls docker through sudo for a user who is not root", () => {
			setupBin({ jq: true, shell, sudo: true });

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("ok");
			const calls = readFileSync(path.join(stateDir, "sudo"), "utf8");
			expect(calls).toContain("docker stop");
			expect(calls).toContain("docker start");
		});
	},
);

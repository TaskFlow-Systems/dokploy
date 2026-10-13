import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import {
	buildClearStaleLockCommand,
	buildDeletionStatusCommand,
	buildTraefikRecoveryScript,
	parseClearLockOutcome,
	parseDeletionStatus,
	parseRecoveryStatus,
} from "@dokploy/server/utils/domain-overview/acme-delete";
import { beforeEach, describe, expect, it } from "vitest";
import {
	acmeFile,
	backupDir,
	baseEnv,
	callsOf,
	lockFile,
	logDir,
	mains,
	markerFile,
	markerText,
	REAL_JQ,
	readAcme,
	resultOf,
	run,
	running,
	SHELLS,
	setupBin,
	spawnScript,
	stateDir,
	targets,
	waitFor,
	workDir,
	writeAcme,
} from "./acme-delete-harness";

describe.skipIf(!REAL_JQ).each(SHELLS)(
	"signals and the marker, under $label",
	{ timeout: 90_000 },
	({ path: shell }) => {
		beforeEach(() => {
			setupBin({ jq: true, shell });
		});

		it("still restarts Traefik when a second TERM arrives during the restart", async () => {
			const run = spawnScript(shell, targets("one.example.com"), {
				FAKE_HANG: "stop",
				FAKE_START_SLOW: "1",
			});
			await waitFor(() => callsOf().some((c) => c.startsWith("stop ")));

			run.child.kill("SIGTERM");
			await new Promise((resolve) => setTimeout(resolve, 300));
			run.child.kill("SIGTERM");
			await run.exited;

			expect(running()).toBe("true");
			expect(existsSync(markerFile)).toBe(false);
			expect(existsSync(lockFile)).toBe(false);
		});

		it("reports ok, not interrupted, when TERM arrives after Traefik has started", async () => {
			const run = spawnScript(shell, targets("one.example.com"), {
				FAKE_LS_SLOW: "1",
			});
			await waitFor(() => callsOf().some((c) => c.startsWith("start ")));
			await waitFor(() => !existsSync(markerFile));
			await new Promise((resolve) => setTimeout(resolve, 150));

			run.child.kill("SIGTERM");
			await run.exited;

			expect(run.state.output).toContain("DOKPLOY_RESULT ok");
			expect(run.state.output).not.toContain("interrupted");
			expect(mains(readAcme())).not.toContain("one.example.com");
			expect(existsSync(markerFile)).toBe(false);
		});

		it("writes the marker before the stop and removes it after the start", () => {
			const result = run(shell, targets("one.example.com"), {
				FAKE_MARKER: markerFile,
			});

			expect(resultOf(result.stdout)).toBe("ok");
			const atStop = readFileSync(
				path.join(stateDir, "marker-at-stop"),
				"utf8",
			);
			expect(atStop).toContain("kind=container");
			expect(atStop).toContain("replicas=1");
			expect(atStop).toContain("phase=stopping");
			expect(existsSync(markerFile)).toBe(false);
		});

		it("records a swarm service with its replica count", () => {
			const result = run(shell, targets("one.example.com"), {
				FAKE_MODE: "service",
				FAKE_MARKER: markerFile,
			});

			expect(resultOf(result.stdout)).toBe("ok");
			const atStop = readFileSync(
				path.join(stateDir, "marker-at-stop"),
				"utf8",
			);
			expect(atStop).toBe(
				"kind=service\nreplicas=1\nts=20261012T101500Z\nphase=stopping\nbackup=\n",
			);
		});

		it("refuses without stopping when the marker cannot be written", () => {
			if (process.getuid?.() === 0) {
				return;
			}
			writeFileSync(markerFile, "x");
			chmodSync(workDir, 0o555);
			const result = run(shell, targets("one.example.com"));
			chmodSync(workDir, 0o755);

			expect(resultOf(result.stdout)).toBe("busy");
		});

		it("leaves the marker and a stale lock after a SIGKILL, and recovery starts Traefik", async () => {
			const run = spawnScript(shell, targets("one.example.com"), {
				FAKE_JQ_BREAK: "hang",
			});
			await waitFor(() => running() === "false");
			await waitFor(
				() => existsSync(markerFile) && /phase=stopped/.test(markerText()),
			);

			process.kill(-(run.child.pid as number), "SIGKILL");
			await run.exited;

			expect(running()).toBe("false");
			expect(existsSync(lockFile)).toBe(true);
			const status = parseDeletionStatus(
				spawnSync(
					shell,
					[
						"-c",
						buildDeletionStatusCommand({
							logDir,
							lockFile,
							markerFile,
						}),
					],
					{ encoding: "utf8", env: baseEnv() },
				).stdout,
			);
			expect(status.busy).toBe(false);
			expect(status.stale).toBe(true);
			expect(status.marker).toEqual({ kind: "container", phase: "stopped" });

			const recovery = spawnSync(
				shell,
				[
					"-c",
					buildTraefikRecoveryScript({
						acmeFile,
						lockFile,
						markerFile,
						backupDir,
						pollSeconds: 0,
						waitSeconds: 2,
					}),
				],
				{ encoding: "utf8", env: baseEnv() },
			);
			expect(parseRecoveryStatus(recovery.stdout)).toBe("recovered");
			expect(running()).toBe("true");
			expect(existsSync(markerFile)).toBe(false);
			expect(existsSync(lockFile)).toBe(false);
			expect(mains(readAcme())).toContain("one.example.com");
		});
	},
);
describe.skipIf(!REAL_JQ).each(SHELLS)(
	"recovery and stale lock commands, under $label",
	{ timeout: 90_000 },
	({ path: shell }) => {
		beforeEach(() => {
			setupBin({ jq: true, shell });
		});

		const recover = (env: Record<string, string> = {}) =>
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
						waitSeconds: 1,
						dockerSeconds: 2,
						stopSeconds: 2,
					}),
				],
				{ encoding: "utf8", env: baseEnv(env) },
			);

		const clear = () =>
			spawnSync(
				shell,
				[
					"-c",
					buildClearStaleLockCommand({
						lockFile,
						markerFile,
						dockerSeconds: 2,
					}),
				],
				{ encoding: "utf8", env: baseEnv() },
			);

		const writeMarker = (phase: string, backup = "") =>
			writeFileSync(
				markerFile,
				`kind=container\nreplicas=1\nts=20261012T101500Z\nphase=${phase}\nbackup=${backup}\n`,
			);

		it("does nothing without a marker", () => {
			const result = recover();

			expect(parseRecoveryStatus(result.stdout)).toBe("no_marker");
			expect(callsOf()).toEqual([]);
		});

		it("only removes the marker when Traefik already runs", () => {
			writeMarker("stopped");

			const result = recover();

			expect(parseRecoveryStatus(result.stdout)).toBe("already_running");
			expect(existsSync(markerFile)).toBe(false);
			expect(callsOf().filter((c) => /^(start|stop) /.test(c))).toEqual([]);
		});

		it("refuses while a live script owns the lock", () => {
			writeMarker("stopped");
			writeFileSync(path.join(stateDir, "running"), "false\n");
			const owner = spawnSync(
				"sh",
				[
					"-c",
					`echo "${process.pid} $(if [ -r /proc/${process.pid}/stat ]; then sed 's/^.*) //' /proc/${process.pid}/stat | cut -d' ' -f20; else ps -o lstart= -p ${process.pid} | tr -s ' ' '_'; fi) $(if [ -r /proc/sys/kernel/random/boot_id ]; then cat /proc/sys/kernel/random/boot_id; else sysctl -n kern.boottime | tr -s ' ,{}=' '_'; fi)"`,
				],
				{ encoding: "utf8" },
			).stdout;
			writeFileSync(lockFile, owner);

			const result = recover();

			expect(parseRecoveryStatus(result.stdout)).toBe("busy");
			expect(running()).toBe("false");
			expect(existsSync(markerFile)).toBe(true);
		});

		it("starts a stopped Traefik and clears the marker", () => {
			writeMarker("stopped");
			writeFileSync(path.join(stateDir, "running"), "false\n");

			const result = recover();

			expect(parseRecoveryStatus(result.stdout)).toBe("recovered");
			expect(running()).toBe("true");
			expect(existsSync(markerFile)).toBe(false);
		});

		it("puts the post-stop backup back when the edited file does not start", () => {
			mkdirSync(backupDir);
			const original = readFileSync(acmeFile, "utf8");
			const backup = path.join(backupDir, "acme.json.bak-20261012T101500Z");
			writeFileSync(backup, original);
			writeAcme({ letsencrypt: { Account: {}, Certificates: [] } });
			writeMarker("edited", backup);
			writeFileSync(path.join(stateDir, "running"), "false\n");

			const result = recover({ FAKE_START_FAIL: "once" });

			expect(parseRecoveryStatus(result.stdout)).toBe("recovered_restored");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(running()).toBe("true");
			expect(existsSync(markerFile)).toBe(false);
		});

		it("keeps the edited file when Traefik did not start but the edit was not in place yet", () => {
			mkdirSync(backupDir);
			const backup = path.join(backupDir, "acme.json.bak-20261012T101500Z");
			writeFileSync(backup, "{}");
			writeMarker("stopped", backup);
			writeFileSync(path.join(stateDir, "running"), "false\n");
			const before = readFileSync(acmeFile, "utf8");

			const result = recover({ FAKE_START_FAIL: "always" });

			expect(parseRecoveryStatus(result.stdout)).toBe("recovery_failed");
			expect(readFileSync(acmeFile, "utf8")).toBe(before);
			expect(existsSync(markerFile)).toBe(true);
		});

		it("refuses a marker with unexpected content", () => {
			writeFileSync(markerFile, "kind=$(id)\nreplicas=1\n");

			const result = recover();

			expect(parseRecoveryStatus(result.stdout)).toBe("invalid_marker");
			expect(callsOf()).toEqual([]);
		});

		it("refuses a backup path outside the backup file naming", () => {
			writeMarker("edited", "/etc/passwd");
			writeFileSync(path.join(stateDir, "running"), "false\n");

			const result = recover({ FAKE_START_FAIL: "always" });

			expect(parseRecoveryStatus(result.stdout)).toBe("recovery_failed");
		});

		it("clears a stale lock and reports Traefik's state", () => {
			writeFileSync(lockFile, "999999 none other-boot\n");
			writeFileSync(path.join(stateDir, "running"), "false\n");

			const result = parseClearLockOutcome(clear().stdout);

			expect(result).toEqual({ status: "cleared", traefik: "stopped" });
			expect(existsSync(lockFile)).toBe(false);
		});

		it("refuses to clear a lock whose process is alive", () => {
			const alive = spawn("sleep", ["30"], { stdio: "ignore" });
			try {
				const started = spawnSync(
					"sh",
					[
						"-c",
						`if [ -r /proc/${alive.pid}/stat ]; then sed 's/^.*) //' /proc/${alive.pid}/stat | cut -d' ' -f20; else ps -o lstart= -p ${alive.pid} | tr -s ' ' '_'; fi`,
					],
					{ encoding: "utf8" },
				).stdout.trim();
				const boot = spawnSync(
					"sh",
					[
						"-c",
						"if [ -r /proc/sys/kernel/random/boot_id ]; then cat /proc/sys/kernel/random/boot_id; else sysctl -n kern.boottime | tr -s ' ,{}=' '_'; fi",
					],
					{ encoding: "utf8" },
				).stdout.trim();
				writeFileSync(lockFile, `${alive.pid} ${started || "none"} ${boot}\n`);

				const result = parseClearLockOutcome(clear().stdout);

				expect(result.status).toBe("alive");
				expect(existsSync(lockFile)).toBe(true);
			} finally {
				alive.kill();
			}
		});

		it("says there is nothing to clear when no lock exists", () => {
			expect(parseClearLockOutcome(clear().stdout).status).toBe("none");
		});

		it("reports unknown instead of guessing when docker fails", () => {
			writeFileSync(lockFile, "999999 none other-boot\n");

			const result = spawnSync(
				shell,
				[
					"-c",
					buildClearStaleLockCommand({
						lockFile,
						markerFile,
						dockerSeconds: 2,
					}),
				],
				{ encoding: "utf8", env: baseEnv({ FAKE_PS_FAILS: "1" }) },
			);

			expect(parseClearLockOutcome(result.stdout)).toEqual({
				status: "cleared",
				traefik: "unknown",
			});
		});
	},
);

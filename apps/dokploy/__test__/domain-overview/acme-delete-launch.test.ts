import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import {
	type AcmeDeleteTarget,
	buildDeletionLauncher,
	buildDeletionStatusCommand,
	deletionState,
	parseDeletionStatus,
} from "@dokploy/server/utils/domain-overview/acme-delete";
import { beforeEach, describe, expect, it } from "vitest";
import {
	acmeFile,
	baseEnv,
	binDir,
	callsOf,
	firstShellOnly,
	leftovers,
	lockFile,
	logDir,
	mains,
	markerFile,
	mode,
	REAL_JQ,
	readAcme,
	resultOf,
	running,
	SHELLS,
	scriptFor,
	setupBin,
	targets,
	waitFor,
	workDir,
} from "./acme-delete-harness";

describe.skipIf(!REAL_JQ).each(SHELLS)(
	"detached launch under $label",
	// The tests wait up to 15 s for a detached process; vitest's default
	// 5 s cuts them first on a busy runner.
	{ timeout: 60_000 },
	({ path: shell }) => {
		const once = firstShellOnly(shell);
		const RUN_ID = "abc123";
		const LOG_NAME = `acme-delete-20261012T101500Z-${RUN_ID}.log`;

		beforeEach(() => {
			setupBin({ jq: true, shell });
		});

		const launch = (
			list: AcmeDeleteTarget[],
			logPath = logDir,
			runId = RUN_ID,
		) =>
			spawnSync(
				shell,
				[
					"-c",
					buildDeletionLauncher({
						script: scriptFor(list),
						logDir: logPath,
						timestamp: "20261012T101500Z",
						runId,
					}),
				],
				{ encoding: "utf8", env: baseEnv(), timeout: 30_000 },
			);

		const logText = (name = LOG_NAME) =>
			readFileSync(path.join(logDir, name), "utf8");

		const statusOf = (logFile?: string) =>
			parseDeletionStatus(
				spawnSync(
					shell,
					[
						"-c",
						buildDeletionStatusCommand({
							logDir,
							lockFile,
							markerFile,
							acmeFile,
							logFile,
						}),
					],
					{ encoding: "utf8", env: baseEnv() },
				).stdout,
			);

		it("returns at once, leaves nothing attached and the job finishes on its own", async () => {
			const started = Date.now();

			const result = launch(targets("one.example.com"));

			expect(result.signal).toBeNull();
			expect(result.status).toBe(0);
			expect(result.stdout).toContain(`DOKPLOY_LAUNCHED ${LOG_NAME}`);
			expect(Date.now() - started).toBeLessThan(10_000);
			await waitFor(() => /DOKPLOY_RESULT/.test(logText()));
			expect(logText()).toContain("DOKPLOY_RESULT ok");
			expect(mains(readAcme())).not.toContain("one.example.com");
			expect(mode(path.join(logDir, LOG_NAME))).toBe(0o600);
		});

		once(
			"reports a log directory that cannot be used and starts nothing",
			() => {
				writeFileSync(path.join(workDir, "plain-file"), "x");
				const original = readFileSync(acmeFile, "utf8");

				const result = launch(
					targets("one.example.com"),
					path.join(workDir, "plain-file", "logs"),
				);

				expect(result.status).toBe(1);
				expect(resultOf(result.stdout)).toBe("log_dir_failed");
				expect(readFileSync(acmeFile, "utf8")).toBe(original);
				expect(callsOf()).toEqual([]);
				expect(leftovers()).toEqual([]);
				expect(existsSync(lockFile)).toBe(false);
			},
		);

		once(
			"reports a result and leaves no edited copy when the job refuses",
			async () => {
				const result = launch(targets("missing.example.com"));

				expect(result.status).toBe(0);
				await waitFor(() => /DOKPLOY_RESULT/.test(logText()));
				expect(logText()).toContain("DOKPLOY_RESULT count_mismatch");
				expect(leftovers()).toEqual([]);
			},
		);

		once(
			"never reuses a log: two launches in the same second keep two logs",
			async () => {
				launch(targets("one.example.com"), logDir, "aaaaaa");
				await waitFor(() =>
					/DOKPLOY_RESULT/.test(
						logText("acme-delete-20261012T101500Z-aaaaaa.log"),
					),
				);
				launch(targets("one.example.com"), logDir, "bbbbbb");
				await waitFor(() =>
					/DOKPLOY_RESULT/.test(
						logText("acme-delete-20261012T101500Z-bbbbbb.log"),
					),
				);

				expect(logText("acme-delete-20261012T101500Z-aaaaaa.log")).toContain(
					"DOKPLOY_RESULT ok",
				);
				expect(logText("acme-delete-20261012T101500Z-bbbbbb.log")).toContain(
					"DOKPLOY_RESULT count_mismatch",
				);
			},
		);

		once("refuses to launch over an existing log of the same name", () => {
			mkdirSync(logDir);
			writeFileSync(path.join(logDir, LOG_NAME), "earlier run\n");

			const result = launch(targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("log_dir_failed");
			expect(logText()).toBe("earlier run\n");
		});

		once("keeps only the newest five logs", () => {
			mkdirSync(logDir);
			for (let day = 1; day <= 7; day += 1) {
				writeFileSync(
					path.join(
						logDir,
						`acme-delete-2026010${day}T000000Z-00000${day}.log`,
					),
					"DOKPLOY_RESULT ok\n",
				);
				const when = new Date(Date.UTC(2026, 0, day));
				utimesSync(
					path.join(
						logDir,
						`acme-delete-2026010${day}T000000Z-00000${day}.log`,
					),
					when,
					when,
				);
			}
			writeFileSync(path.join(logDir, "other.log"), "x");

			launch(targets("missing.example.com"));

			const logs = readdirSync(logDir).filter((n) =>
				n.startsWith("acme-delete-"),
			);
			expect(logs).toHaveLength(5);
			expect(existsSync(path.join(logDir, "other.log"))).toBe(true);
		});

		it("shows the running, finished and killed states", async () => {
			launch(targets("one.example.com"));
			await waitFor(() => /DOKPLOY_RESULT/.test(logText()));

			expect(deletionState(statusOf())).toBe("succeeded");
			expect(statusOf().backupFile).toBe("acme.json.bak-20261012T101500Z");

			const killedLog = "acme-delete-20261012T101600Z-def456.log";
			writeFileSync(
				path.join(logDir, killedLog),
				"DOKPLOY_STARTED\nDOKPLOY_PRECHECK ok\n",
			);
			expect(deletionState(statusOf())).toBe("interrupted");

			writeFileSync(lockFile, `${process.pid} none none\n`);
			expect(statusOf().stale).toBe(true);
			expect(deletionState(statusOf())).toBe("interrupted");
		});

		it("does not let a later busy run hide the result of the real run", async () => {
			launch(targets("one.example.com"), logDir, "aaaaaa");
			await waitFor(() =>
				/DOKPLOY_RESULT/.test(
					logText("acme-delete-20261012T101500Z-aaaaaa.log"),
				),
			);
			const busyLog = "acme-delete-20261012T101700Z-bbbbbb.log";
			writeFileSync(
				path.join(logDir, busyLog),
				"DOKPLOY_STARTED\nDOKPLOY_RESULT busy\n",
			);

			expect(statusOf().logFile).toBe(
				"acme-delete-20261012T101500Z-aaaaaa.log",
			);
			expect(deletionState(statusOf())).toBe("succeeded");
			expect(statusOf(busyLog).status).toBe("busy");
		});
	},
);
describe.skipIf(!REAL_JQ)(
	"launcher process groups",
	{ timeout: 90_000 },
	() => {
		const RUN_ID = "abc123";
		const LOG_NAME = `acme-delete-20261012T101500Z-${RUN_ID}.log`;

		const launchInGroup = (shell: string) => {
			const launcher = buildDeletionLauncher({
				script: scriptFor(targets("one.example.com"), 3),
				logDir,
				timestamp: "20261012T101500Z",
				runId: RUN_ID,
			});
			const child: ChildProcess = spawn(
				shell,
				["-c", `${shell} -c "$LAUNCHER"; sleep 30`],
				{
					env: { ...baseEnv(), LAUNCHER: launcher } as NodeJS.ProcessEnv,
					detached: true,
					stdio: ["ignore", "pipe", "ignore"],
				},
			);
			let output = "";
			child.stdout?.on("data", (chunk) => {
				output += chunk.toString();
			});
			return { child, output: () => output };
		};

		const logText = () => readFileSync(path.join(logDir, LOG_NAME), "utf8");

		it.each(SHELLS)(
			"survives a kill of the caller's process group when setsid is available ($label)",
			async ({ path: shell }) => {
				setupBin({ jq: true, shell, setsid: true });
				if (!existsSync(path.join(binDir, "setsid"))) {
					return;
				}
				const group = launchInGroup(shell);
				await waitFor(() => group.output().includes("DOKPLOY_LAUNCHED"));

				process.kill(-(group.child.pid as number), "SIGKILL");

				await waitFor(() => /DOKPLOY_RESULT/.test(logText()), 30_000);
				expect(logText()).toContain("DOKPLOY_RESULT ok");
				expect(running()).toBe("true");
				expect(mains(readAcme())).not.toContain("one.example.com");
			},
		);

		it.each(SHELLS)(
			"survives a hangup of the caller's process group without setsid ($label)",
			async ({ path: shell }) => {
				setupBin({ jq: true, shell, setsid: false });
				expect(existsSync(path.join(binDir, "setsid"))).toBe(false);
				const group = launchInGroup(shell);
				await waitFor(() => group.output().includes("DOKPLOY_LAUNCHED"));

				process.kill(-(group.child.pid as number), "SIGHUP");

				await waitFor(() => /DOKPLOY_RESULT/.test(logText()), 30_000);
				expect(logText()).toContain("DOKPLOY_RESULT ok");
				expect(mains(readAcme())).not.toContain("one.example.com");
			},
		);

		it("uses setsid in the launcher when it exists and nohup alone otherwise", () => {
			const launcher = buildDeletionLauncher({
				script: scriptFor(targets("one.example.com")),
				logDir,
				timestamp: "20261012T101500Z",
				runId: RUN_ID,
			});

			expect(launcher).toContain('setsid nohup sh -c "$SCRIPT"');
			expect(launcher).toContain('nohup sh -c "$SCRIPT" > "$LOG"');
		});
	},
);

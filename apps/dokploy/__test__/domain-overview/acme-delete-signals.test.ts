import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	buildAcmeDeleteScript,
	buildTraefikRecoveryScript,
	parseRecoveryStatus,
} from "@dokploy/server/utils/domain-overview/acme-delete";
import { beforeEach, describe, expect, it } from "vitest";
import {
	acmeFile,
	backupDir,
	baseEnv,
	callsOf,
	idOf,
	killLeftovers,
	lockFile,
	MODES,
	mains,
	markerFile,
	markerText,
	REAL_JQ,
	readAcme,
	resultOf,
	running,
	SHELLS,
	scriptFor,
	setupBin,
	spawnScript,
	stateDir,
	targets,
	waitFor,
	which,
	workDir,
	writeExecutable,
} from "./acme-delete-harness";

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
				// The script counts in whole seconds of the wall clock, so a
				// limit of 2 can be barely one second on a busy CI runner.
				waitSeconds: 5,
				dockerSeconds: 5,
				stopSeconds: 5,
			}),
		],
		{ encoding: "utf8", env: baseEnv(env) },
	);

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe.skipIf(!REAL_JQ).each(SHELLS)(
	"a TERM during a docker call, under $label",
	{ timeout: 60_000 },
	({ path: shell }) => {
		beforeEach(() => {
			setupBin({ jq: true, shell, timeout: true });
		});

		it("waits for a stop that is still in progress before it starts Traefik again", async () => {
			const job = spawnScript(shell, targets("one.example.com"), {
				FAKE_STOP_SLOW: "1.5",
			});
			await waitFor(() => callsOf().some((c) => c.startsWith("stop ")));
			await new Promise((resolve) => setTimeout(resolve, 300));

			job.child.kill("SIGTERM");
			await job.exited;
			await new Promise((resolve) => setTimeout(resolve, 2000));

			expect(running()).toBe("true");
			expect(existsSync(markerFile)).toBe(false);
			expect(existsSync(lockFile)).toBe(false);
			expect(job.state.output).toContain("DOKPLOY_RESULT interrupted");
			const calls = callsOf();
			const stopAt = calls.findIndex((c) => c.startsWith("stop "));
			const startAt = calls.findIndex((c) => c.startsWith("start "));
			expect(startAt).toBeGreaterThan(stopAt);
			expect(mains(readAcme())).toContain("one.example.com");
		});

		it("keeps the marker and says so when Traefik is not confirmed running", async () => {
			const job = spawnScript(shell, targets("one.example.com"), {
				FAKE_STOP_SLOW: "1",
				FAKE_START_FAIL: "always",
			});
			await waitFor(() => callsOf().some((c) => c.startsWith("stop ")));

			job.child.kill("SIGTERM");
			await job.exited;

			expect(running()).toBe("false");
			expect(existsSync(markerFile)).toBe(true);
			expect(markerText()).toContain("phase=stopping");
			expect(job.state.output).toContain("DOKPLOY_NOTE traefik_not_restarted");
			expect(resultOf(job.state.output)).toBe("traefik_not_restarted");
			expect(existsSync(lockFile)).toBe(false);
		});
	},
);

describe.skipIf(!REAL_JQ).each(SHELLS)(
	"a kill between the move and the marker, under $label",
	{ timeout: 60_000 },
	({ path: shell }) => {
		beforeEach(() => {
			setupBin({ jq: true, shell });
			writeExecutable(
				path.join(workDir, "bin", "mv"),
				`#!/bin/sh\n${which("mv")} "$@" || exit $?\nfor last; do :; done\ncase "$last" in */acme.json) [ -z "$KILL_AFTER_MOVE" ] || kill -9 $PPID ;; esac\n`,
			);
		});

		it("records the intent first, so recovery restores the backup only when the edited file is in place", () => {
			const original = readFileSync(acmeFile, "utf8");
			const killed = spawnSync(
				shell,
				["-c", scriptFor(targets("one.example.com"))],
				{
					encoding: "utf8",
					env: baseEnv({ KILL_AFTER_MOVE: "1" }),
				},
			);

			expect(killed.signal).toBe("SIGKILL");
			const marker = markerText();
			expect(marker).toContain("phase=editing");
			expect(marker).toContain(`new=${idOf(acmeFile)}`);
			expect(mains(readAcme())).not.toContain("one.example.com");
			expect(running()).toBe("false");

			const result = recover(shell, { FAKE_START_FAIL: "once" });

			expect(parseRecoveryStatus(result.stdout)).toBe("recovered_restored");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(running()).toBe("true");
			expect(existsSync(markerFile)).toBe(false);
		});
	},
);

describe.skipIf(!REAL_JQ).each(PRIMARY)(
	"time limits, under $label",
	{ timeout: 90_000 },
	({ path: shell }) => {
		describe.each(MODES)("$label", ({ timeout }) => {
			beforeEach(() => {
				setupBin({ jq: true, shell, timeout });
			});

			const script = (extra = {}) =>
				buildAcmeDeleteScript({
					acmeFile,
					lockFile,
					markerFile,
					backupDir,
					targets: targets("one.example.com"),
					timestamp: "20261012T101500Z",
					pollSeconds: 0,
					settleSeconds: 0,
					dockerSeconds: 4,
					stopSeconds: 5,
					...extra,
				});

			const exec = (extra: object, env: Record<string, string>) =>
				spawnSync(shell, ["-c", script(extra)], {
					encoding: "utf8",
					env: baseEnv(env),
					timeout: 80_000,
				});

			// Where only "inspect" hangs, stop and start answer at once, so a wide
			// limit for them costs no time. A narrow one turns a start that stalls
			// on a busy runner into traefik_not_restarted.
			const wideStopLimit = { stopSeconds: 30 };

			it("counts the wait for the stop in time, not in rounds", () => {
				const result = exec(
					{ waitSeconds: 1, ...wideStopLimit },
					{ FAKE_STATE_HANG: "1" },
				);

				expect(resultOf(result.stdout), result.stdout).toBe("stop_failed");
				const calls = callsOf();
				const stopAt = calls.findIndex((c) => c.startsWith("stop "));
				const startAt = calls.findIndex((c) => c.startsWith("start "));
				const waiting = calls
					.slice(stopAt, startAt)
					.filter((c) => c.startsWith("inspect -f"));
				expect(waiting).toHaveLength(1);
			});

			it("checks the global deadline inside the wait loop", () => {
				const started = Date.now();

				const result = exec(
					{ waitSeconds: 60, deadlineSeconds: 2, ...wideStopLimit },
					{ FAKE_STATE_HANG: "1" },
				);

				expect(["stop_failed", "deadline_exceeded"], result.stdout).toContain(
					resultOf(result.stdout),
				);
				expect(Date.now() - started).toBeLessThan(20_000);
				expect(existsSync(lockFile)).toBe(false);
			});

			it("leaves no orphaned docker client behind when it gives up", async () => {
				exec({ waitSeconds: 1 }, { FAKE_HANG: "stop" });

				const pids = readFileSync(path.join(stateDir, "hung.pids"), "utf8")
					.split("\n")
					.filter(Boolean)
					.map(Number);
				await waitFor(() => pids.every((pid) => !alive(pid)));
				expect(pids.length).toBeGreaterThan(0);
			});
		});
	},
);

describe.skipIf(!REAL_JQ).each(SHELLS)(
	"a script a test leaves running, under $label",
	{ timeout: 60_000 },
	({ path: shell }) => {
		it("is killed by the cleanup that runs after every test", async () => {
			const job = spawnScript(shell, targets("one.example.com"), {
				FAKE_HANG: "stop",
			});
			await waitFor(() => existsSync(path.join(stateDir, "hung.pids")));
			const pid = job.child.pid as number;
			expect(alive(pid)).toBe(true);

			killLeftovers();

			await waitFor(() => !alive(pid));
			expect(job.child.signalCode).toBe("SIGKILL");
		});
	},
);

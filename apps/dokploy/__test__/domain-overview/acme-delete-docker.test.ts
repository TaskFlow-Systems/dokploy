import { spawn } from "node:child_process";
import {
	existsSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	acmeFile,
	baseEnv,
	binDir,
	callsOf,
	fastScript,
	firstShellOnly,
	lockFile,
	MODES,
	markerFile,
	markerText,
	REAL_JQ,
	resultOf,
	runFast,
	running,
	SHELLS,
	setupBin,
	spawnScript,
	stateDir,
	targets,
	waitFor,
} from "./acme-delete-harness";

describe.skipIf(!REAL_JQ).each(SHELLS)(
	"docker that hangs or fails, under $label",
	{ timeout: 90_000 },
	({ path: shell }) => {
		const once = firstShellOnly(shell);
		describe.each(MODES)("$label", ({ timeout }) => {
			beforeEach(() => {
				setupBin({ jq: true, shell, timeout });
			});

			once(
				"gives up on a stop that hangs, leaves the file alone and starts Traefik",
				() => {
					const original = readFileSync(acmeFile, "utf8");

					const result = runFast(shell, targets("one.example.com"), {
						FAKE_HANG: "stop",
					});

					expect(resultOf(result.stdout)).toBe("stop_failed");
					expect(result.seconds).toBeLessThan(30);
					expect(readFileSync(acmeFile, "utf8")).toBe(original);
					expect(running()).toBe("true");
					expect(existsSync(lockFile)).toBe(false);
				},
			);

			once(
				"gives up on a start that hangs and reports it, keeping the marker for recovery",
				() => {
					const result = runFast(shell, targets("one.example.com"), {
						FAKE_HANG: "start",
					});

					expect(resultOf(result.stdout)).toBe("start_failed_after_restore");
					expect(result.seconds).toBeLessThan(40);
					expect(running()).toBe("false");
					expect(markerText()).toContain("kind=container");
					expect(markerText()).toContain("phase=edited");
					expect(existsSync(lockFile)).toBe(false);
				},
			);

			it("reacts to TERM while docker hangs and starts Traefik once", async () => {
				const hung = spawn(
					shell,
					[
						"-c",
						fastScript(targets("one.example.com"), {
							stopSeconds: 30,
							cleanupWaitSeconds: 2,
						}),
					],
					{
						env: baseEnv({ FAKE_HANG: "stop" }),
						stdio: ["ignore", "pipe", "ignore"],
					},
				);
				let output = "";
				hung.stdout?.on("data", (chunk) => {
					output += chunk.toString();
				});
				const exited = new Promise<void>((resolve) =>
					hung.on("close", () => resolve()),
				);
				await waitFor(() => callsOf().some((c) => c.startsWith("stop ")));

				const signalled = Date.now();
				hung.kill("SIGTERM");
				await exited;

				expect(Date.now() - signalled).toBeLessThan(8_000);
				expect(output).toContain("DOKPLOY_RESULT interrupted");
				expect(running()).toBe("true");
				expect(existsSync(lockFile)).toBe(false);
			});

			// CI saw the TERM test above take 20 s once: the signal came between
			// the fork of docker and CHILD=$!, so cleanup neither waited for nor
			// killed the hung docker, whose subshell kept stdout open until its
			// sleep ended. Once the marker says stopping, this date waits for the
			// stop to show and sends TERM from the first call that sees it, so the
			// signal lands at the first date after that fork.
			it("reacts to TERM that comes right after docker starts", async () => {
				const realDate = path.join(binDir, "date.real");
				renameSync(path.join(binDir, "date"), realDate);
				writeFileSync(
					path.join(binDir, "date"),
					`#!/bin/sh
if [ ! -e "$FAKE_STATE/termed" ] && grep -q '^phase=stopping' ${JSON.stringify(markerFile)} 2>/dev/null; then
	n=0
	while ! grep -q '^stop ' "$FAKE_STATE/calls" 2>/dev/null && [ "$n" -lt 30 ]; do
		sleep 0.01
		n=$((n + 1))
	done
	if grep -q '^stop ' "$FAKE_STATE/calls" 2>/dev/null; then
		: > "$FAKE_STATE/termed"
		kill -TERM "$(cat "$FAKE_STATE/main.pid")"
	fi
fi
exec ${JSON.stringify(realDate)} "$@"
`,
					{ mode: 0o755 },
				);
				const hung = spawn(
					shell,
					[
						"-c",
						fastScript(targets("one.example.com"), {
							stopSeconds: 30,
							cleanupWaitSeconds: 2,
						}),
					],
					{
						env: baseEnv({ FAKE_HANG: "stop" }),
						stdio: ["ignore", "pipe", "ignore"],
					},
				);
				writeFileSync(path.join(stateDir, "main.pid"), String(hung.pid));
				let output = "";
				hung.stdout?.on("data", (chunk) => {
					output += chunk.toString();
				});
				const exited = new Promise<void>((resolve) =>
					hung.on("close", () => resolve()),
				);
				await waitFor(() => existsSync(path.join(stateDir, "termed")));

				const signalled = Date.now();
				await exited;

				expect(Date.now() - signalled).toBeLessThan(8_000);
				expect(output).toContain("DOKPLOY_RESULT interrupted");
				expect(running()).toBe("true");
				expect(existsSync(lockFile)).toBe(false);
			});

			it("gives up instead of spinning when date and sleep disappear mid-run", async () => {
				const job = spawnScript(shell, targets("one.example.com"), {
					FAKE_HANG: "stop",
				});
				await waitFor(() => existsSync(path.join(stateDir, "hung.pids")));

				const removed = Date.now();
				rmSync(binDir, { recursive: true });
				await job.exited;

				expect(Date.now() - removed).toBeLessThan(8_000);
				expect(resultOf(job.state.output)).not.toBe("ok");
			});
		});
	},
);

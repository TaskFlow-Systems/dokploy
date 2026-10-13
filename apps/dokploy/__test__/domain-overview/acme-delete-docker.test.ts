import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
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

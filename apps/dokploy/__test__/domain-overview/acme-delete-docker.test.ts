import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
	acmeFile,
	backups,
	baseEnv,
	callsOf,
	fastScript,
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
	targets,
	waitFor,
} from "./acme-delete-harness";

describe.skipIf(!REAL_JQ).each(SHELLS)(
	"docker that hangs or fails, under $label",
	{ timeout: 90_000 },
	({ path: shell }) => {
		describe.each(MODES)("$label", ({ timeout }) => {
			beforeEach(() => {
				setupBin({ jq: true, shell, timeout });
			});

			it("gives up on a stop that hangs, leaves the file alone and starts Traefik", () => {
				const original = readFileSync(acmeFile, "utf8");

				const result = runFast(shell, targets("one.example.com"), {
					FAKE_HANG: "stop",
				});

				expect(resultOf(result.stdout)).toBe("stop_failed");
				expect(result.seconds).toBeLessThan(30);
				expect(readFileSync(acmeFile, "utf8")).toBe(original);
				expect(running()).toBe("true");
				expect(existsSync(lockFile)).toBe(false);
			});

			it("gives up on a start that hangs and reports it, keeping the marker for recovery", () => {
				const result = runFast(shell, targets("one.example.com"), {
					FAKE_HANG: "start",
				});

				expect(resultOf(result.stdout)).toBe("start_failed_after_restore");
				expect(result.seconds).toBeLessThan(40);
				expect(running()).toBe("false");
				expect(markerText()).toContain("kind=container");
				expect(markerText()).toContain("phase=edited");
				expect(existsSync(lockFile)).toBe(false);
			});

			it("does nothing when docker ps hangs before the stop", () => {
				const original = readFileSync(acmeFile, "utf8");

				const result = runFast(shell, targets("one.example.com"), {
					FAKE_MODE: "service",
					FAKE_HANG: "ps",
				});

				expect(resultOf(result.stdout)).toBe("traefik_state_unknown");
				expect(readFileSync(acmeFile, "utf8")).toBe(original);
				expect(result.calls.some((c) => c.startsWith("service scale"))).toBe(
					false,
				);
				expect(existsSync(markerFile)).toBe(false);
			});

			it("does nothing when docker inspect hangs, instead of assuming there is no Traefik", () => {
				const original = readFileSync(acmeFile, "utf8");

				const result = runFast(shell, targets("one.example.com"), {
					FAKE_HANG: "inspect",
				});

				expect(resultOf(result.stdout)).toBe("docker_unavailable");
				expect(readFileSync(acmeFile, "utf8")).toBe(original);
				expect(result.calls.filter((c) => /^(stop|start) /.test(c))).toEqual(
					[],
				);
			});

			it("does nothing when docker info hangs", () => {
				const result = runFast(shell, targets("one.example.com"), {
					FAKE_HANG: "info",
				});

				expect(resultOf(result.stdout)).toBe("docker_unavailable");
			});

			it("stops waiting at the global deadline and starts Traefik", () => {
				const result = runFast(
					shell,
					targets("one.example.com"),
					{},
					{ deadlineSeconds: 1, startDelaySeconds: 3 },
				);

				expect(resultOf(result.stdout)).toBe("deadline_exceeded");
				expect(running()).toBe("true");
				expect(result.calls.filter((c) => /^stop /.test(c))).toEqual([]);
			});

			it("treats a docker error before the stop as unknown, not as stopped", () => {
				const original = readFileSync(acmeFile, "utf8");

				const result = runFast(shell, targets("one.example.com"), {
					FAKE_PS_FAILS: "1",
				});

				expect(resultOf(result.stdout)).toBe("traefik_state_unknown");
				expect(readFileSync(acmeFile, "utf8")).toBe(original);
				expect(result.calls.filter((c) => /^(stop|start) /.test(c))).toEqual(
					[],
				);
			});

			it("does not edit the file when the state cannot be read after the stop", () => {
				const original = readFileSync(acmeFile, "utf8");

				const result = runFast(shell, targets("one.example.com"), {
					FAKE_STATE_FAILS: "1",
				});

				expect(resultOf(result.stdout)).toBe("stop_failed");
				expect(readFileSync(acmeFile, "utf8")).toBe(original);
				expect(backups()).toEqual([]);
				expect(running()).toBe("true");
				expect(result.calls.filter((c) => /^start /.test(c)).length).toBe(1);
			});

			it("reacts to TERM while docker hangs and starts Traefik once", async () => {
				const hung = spawn(
					shell,
					["-c", fastScript(targets("one.example.com"), { stopSeconds: 30 })],
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
		});
	},
);

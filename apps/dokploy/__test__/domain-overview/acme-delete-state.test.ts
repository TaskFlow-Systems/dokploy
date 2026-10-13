import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
	acmeFile,
	backups,
	markerFile,
	REAL_JQ,
	resultOf,
	runFast,
	running,
	SHELLS,
	setupBin,
	targets,
} from "./acme-delete-harness";

describe.skipIf(!REAL_JQ).each(SHELLS.slice(0, 1))(
	"docker that answers late or wrongly, under $label",
	{ timeout: 90_000 },
	({ path: shell }) => {
		beforeEach(() => {
			setupBin({ jq: true, shell, timeout: true });
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
			expect(result.calls.filter((c) => /^(stop|start) /.test(c))).toEqual([]);
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
			expect(result.calls.filter((c) => /^(stop|start) /.test(c))).toEqual([]);
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
	},
);

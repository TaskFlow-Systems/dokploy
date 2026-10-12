import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: vi.fn(),
}));
vi.mock("@dokploy/server/utils/servers/destination", () => ({
	resolveServerDestinationHost: vi.fn(),
}));

const { CommandTimeoutError, execAsync } = await import(
	"@dokploy/server/utils/process/execAsync"
);

const aliveCount = (marker: string) =>
	spawnSync("pgrep", ["-f", marker], { encoding: "utf8" })
		.stdout.split("\n")
		.filter(Boolean).length;

describe("execAsync with a time limit", () => {
	it("kills the whole process tree when the time limit passes", async () => {
		const marker = "sleep 31.4159";

		await expect(
			execAsync(`${marker} | cat; ${marker}`, { timeoutMs: 400 }),
		).rejects.toBeInstanceOf(CommandTimeoutError);

		for (
			let attempt = 0;
			attempt < 20 && aliveCount(marker) > 0;
			attempt += 1
		) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(aliveCount(marker)).toBe(0);
	});

	it("returns the output of a command that finishes in time", async () => {
		const result = await execAsync("echo ready", { timeoutMs: 5_000 });

		expect(result.stdout.trim()).toBe("ready");
	});

	it("keeps the exit code and the output of a failing command", async () => {
		await expect(
			execAsync("echo partial; exit 3", { timeoutMs: 5_000 }),
		).rejects.toMatchObject({ exitCode: 3, stdout: "partial\n" });
	});
});

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	findServer: vi.fn(),
	getWebServerSettings: vi.fn(),
	updateWhere: vi.fn(),
	updateSet: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: { server: { findFirst: mocks.findServer } },
		update: vi.fn(() => ({
			set: (values: unknown) => {
				mocks.updateSet(values);
				return { where: mocks.updateWhere };
			},
		})),
	},
}));
vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: mocks.getWebServerSettings,
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

import {
	BuildTimeoutError,
	createBuildRunner,
	killDockerBuild,
	recordBuildFailure,
	wrapBuildCommand,
} from "@dokploy/server/utils/process/build-process";
import { ExecError } from "@dokploy/server/utils/process/ExecError";

const runInShell = (script: string) =>
	spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });

const hasTimeout = runInShell("timeout -k 1 1 true").status === 0;

const isPkillCommand = ([, command]: unknown[]) =>
	String(command).startsWith("pkill");

const buildCalls = () =>
	mocks.execAsyncRemote.mock.calls.filter((call) => !isPkillCommand(call));

const uniqueAppName = () => `dk1-test-${randomBytes(4).toString("hex")}`;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.findServer.mockResolvedValue({ buildTimeoutMinutes: 30 });
	mocks.getWebServerSettings.mockResolvedValue({ buildTimeoutMinutes: 45 });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("wrapBuildCommand", () => {
	it("leaves the script unchanged for the shell", () => {
		const script = `set -e; if ! false; then echo 'a "b" $HOME \\ c!'; fi
printf '%s\\n' second-line`;

		const wrapped = runInShell(wrapBuildCommand(script, "app", 60));

		expect(wrapped.status).toBe(0);
		expect(wrapped.stdout).toBe(runInShell(script).stdout);
	});

	it("uses the login shell over ssh and /bin/sh locally", async () => {
		const remote = await createBuildRunner(
			"application",
			"build-server",
			"app",
		);
		await remote("build");
		const local = await createBuildRunner("application", null, "app");
		await local("build");

		expect(buildCalls()[0]?.[1]).toContain('"${SHELL:-sh}" -c ');
		expect(
			mocks.execAsync.mock.calls.find(
				([command]) => !String(command).startsWith("pkill"),
			)?.[0],
		).toContain('"$@" /bin/sh -c ');
	});

	it("keeps the exit code of the build", () => {
		expect(runInShell(wrapBuildCommand("exit 7", "app", 60)).status).toBe(7);
	});

	it("still builds on a server without a usable timeout", () => {
		const wrapped = runInShell(
			`timeout() { return 127; }; ${wrapBuildCommand("echo built", "app", 60)}`,
		);

		expect(wrapped.status).toBe(0);
		expect(wrapped.stdout).toBe("built\n");
	});

	it.skipIf(!hasTimeout)("stops a build that runs too long", () => {
		const startedAt = Date.now();

		const wrapped = runInShell(wrapBuildCommand("sleep 30", "app", 1));

		expect(wrapped.status).toBe(124);
		expect(Date.now() - startedAt).toBeLessThan(15_000);
	});
});

describe("createBuildRunner", () => {
	it("runs on the build server with the timeout of that server", async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });

		const run = await createBuildRunner("application", "build-server", "app");
		await run("(docker build .) >> /log 2>&1");

		const [[serverId, command, onData, options]] = buildCalls() as [
			[string, string, undefined, { timeoutMs: number }],
		];
		expect(serverId).toBe("build-server");
		expect(onData).toBeUndefined();
		expect(command).toContain("timeout -k 30 1800;");
		expect(command).toContain(": dokploy-build:app; (docker build .)");
		expect(options.timeoutMs).toBe(30 * 60_000 + 60_000);
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("uses the web server setting for a local build", async () => {
		const run = await createBuildRunner("application", null, "app");
		await run("build");

		const [, options] = mocks.execAsync.mock.calls.find(
			([command]) => !String(command).startsWith("pkill"),
		) as [string, { timeoutMs: number }];
		expect(options.timeoutMs).toBeGreaterThan(45 * 60_000);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("falls back to 60 minutes when the setting cannot be read", async () => {
		mocks.findServer.mockRejectedValue(new Error("db down"));
		vi.spyOn(console, "error").mockImplementationOnce(() => {});

		const run = await createBuildRunner("application", "build-server", "app");
		await run("build");

		expect(buildCalls()[0]?.[1]).toContain("timeout -k 30 3600;");
	});

	it("stops a build the panel lost before starting a new one", async () => {
		const run = await createBuildRunner("application", "build-server", "app");
		await run("build");

		const [first, second] = mocks.execAsyncRemote.mock.calls;
		expect(first?.[1]).toBe("pkill -f '[:] dokploy-build:app;' || true");
		expect(second?.[1]).toContain(": dokploy-build:app;");
	});

	it("starts the build even when the orphan cannot be stopped", async () => {
		mocks.execAsyncRemote.mockRejectedValueOnce(new Error("no route"));
		vi.spyOn(console, "error").mockImplementationOnce(() => {});

		const run = await createBuildRunner("application", "build-server", "app");

		await expect(run("build")).resolves.toBeDefined();
	});

	it("shares one budget between the steps of a build", async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
		const run = await createBuildRunner("compose", "build-server", "app");

		await run("clone");
		vi.setSystemTime(1_000_000 + 10 * 60_000);
		await run("build");

		expect(buildCalls()[1]?.[1]).toContain("timeout -k 30 1200;");
	});

	it("does not start a step after the budget is spent", async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
		const run = await createBuildRunner("compose", "build-server", "app");
		vi.setSystemTime(1_000_000 + 31 * 60_000);

		await expect(run("build")).rejects.toBeInstanceOf(BuildTimeoutError);
		expect(buildCalls()).toHaveLength(0);
	});

	it("reports a failure past the deadline as a timeout", async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
		const run = await createBuildRunner("application", "build-server", "app");
		mocks.execAsyncRemote.mockImplementationOnce(async () => {
			vi.setSystemTime(1_000_000 + 30 * 60_000 + 1);
			throw new ExecError("Remote command failed with exit code 124", {
				command: "build",
				exitCode: 124,
			});
		});

		await expect(run("build")).rejects.toThrow(
			"Build timed out after 30 minutes",
		);
		expect(mocks.execAsyncRemote).toHaveBeenLastCalledWith(
			"build-server",
			"pkill -2 -f 'docker build.*app|[:] dokploy-build:app;'",
		);
	});

	it("passes through a failure before the deadline", async () => {
		const lost = new ExecError("SSH connection error: Keepalive timeout", {
			command: "build",
		});
		const run = await createBuildRunner("application", "build-server", "app");
		mocks.execAsyncRemote.mockRejectedValueOnce(lost);

		await expect(run("build")).rejects.toBe(lost);
	});
});

describe("killDockerBuild", () => {
	const startBuild = (appName: string, sleepSeconds: string) => {
		const child = spawn(
			"/bin/sh",
			["-c", wrapBuildCommand(`sleep ${sleepSeconds}`, appName, 60)],
			{ stdio: "ignore" },
		);
		const exited = new Promise<void>((resolve) =>
			child.once("close", () => resolve()),
		);
		return { child, exited };
	};

	const isRunning = (pattern: string) =>
		runInShell(`pgrep -f '${pattern}'`).status === 0;

	it("targets the given server", async () => {
		await killDockerBuild("application", "build-server", "my.app");

		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"build-server",
			"pkill -2 -f 'docker build.*my\\.app|[:] dokploy-build:my\\.app;'",
		);
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("looks for docker compose in a compose build", async () => {
		await killDockerBuild("compose", null, "app");

		expect(mocks.execAsync).toHaveBeenCalledWith(
			"pkill -2 -f 'docker compose.*app|[:] dokploy-build:app;'",
		);
	});

	it("does not fail when no build is running", async () => {
		mocks.execAsyncRemote.mockRejectedValueOnce(new Error("exit code 1"));
		vi.spyOn(console, "error").mockImplementationOnce(() => {});

		await expect(
			killDockerBuild("application", "build-server", "app"),
		).resolves.toBeUndefined();
	});

	it.skipIf(!hasTimeout)(
		"stops the whole build of that application and no other",
		async () => {
			const appName = uniqueAppName();
			const targetSleep = `3${randomBytes(2).readUInt16BE()}.1`;
			const neighbourSleep = `3${randomBytes(2).readUInt16BE()}.2`;
			const target = startBuild(appName, targetSleep);
			const neighbour = startBuild(`${appName}-2`, neighbourSleep);
			await vi.waitFor(() => {
				expect(isRunning(`^sleep ${targetSleep}`)).toBe(true);
				expect(isRunning(`^sleep ${neighbourSleep}`)).toBe(true);
			});
			mocks.execAsync.mockImplementationOnce(async (command: string) => {
				runInShell(command);
				return { stdout: "", stderr: "" };
			});

			await killDockerBuild("application", null, appName);
			await target.exited;

			await vi.waitFor(() => {
				expect(isRunning(`^sleep ${targetSleep}`)).toBe(false);
			});
			expect(neighbour.child.exitCode).toBeNull();
			expect(isRunning(`^sleep ${neighbourSleep}`)).toBe(true);

			runInShell(`pkill -f '[:] dokploy-build:${appName}-2;'`);
			await neighbour.exited;
		},
	);
});

describe("recordBuildFailure", () => {
	const failure = {
		deploymentId: "dep-1",
		logPath: "/logs/app.log",
		serverId: "build-server",
	};

	it("writes the reason of a timeout to the build log", async () => {
		const error = new BuildTimeoutError(60);

		await recordBuildFailure({ ...failure, error });

		const command = String(mocks.execAsyncRemote.mock.calls[0]?.[1]);
		const encoded = Buffer.from(error.message).toString("base64");
		expect(command).toContain(`echo "${encoded}" | base64 -d`);
		expect(command).toContain("Error occurred");
		expect(mocks.updateSet).not.toHaveBeenCalled();
	});

	it("keeps the build output out of the message for a failed command", async () => {
		await recordBuildFailure({
			...failure,
			error: new ExecError("Remote command failed with exit code 1", {
				command: "build",
			}),
		});

		expect(String(mocks.execAsyncRemote.mock.calls[0]?.[1])).not.toContain(
			"base64",
		);
	});

	it("keeps the reason on the deployment when the server is out of reach", async () => {
		mocks.execAsyncRemote.mockRejectedValueOnce(new Error("no route"));
		vi.spyOn(console, "error").mockImplementationOnce(() => {});

		await expect(
			recordBuildFailure({
				...failure,
				error: new ExecError("SSH connection error: Keepalive timeout", {
					command: "build",
				}),
			}),
		).resolves.toBeUndefined();

		expect(mocks.updateSet).toHaveBeenCalledWith({
			errorMessage: "SSH connection error: Keepalive timeout",
		});
	});
});

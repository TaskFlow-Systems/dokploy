import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	buildKillScheduleRunCommand,
	buildServerScheduleCommand,
} from "@dokploy/server/utils/schedules/run-process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const runInShell = (script: string) =>
	spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });

// A zombie still answers process.kill(pid, 0), so ask ps for the state.
const isRunning = (pid: number) => {
	const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
		encoding: "utf8",
	}).stdout.trim();
	return state !== "" && !state.startsWith("Z");
};

const waitUntil = async (condition: () => boolean, timeoutMs = 3000) => {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("Condition was not met in time");
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

const exited = (child: ChildProcess) =>
	new Promise<number | null>((resolve) => {
		child.once("close", (code) => resolve(code));
	});

const wrapperTimeout = () =>
	new Promise<string>((resolve) => {
		setTimeout(() => resolve("still running"), 3000);
	});

let dir: string;
let scriptPath: string;
let logPath: string;
let pidsPath: string;
const started: ChildProcess[] = [];

const readPids = () =>
	existsSync(pidsPath)
		? readFileSync(pidsPath, "utf8").trim().split("\n").map(Number)
		: [];

// The script records its own PID and those of its children and a grandchild.
const TREE_SCRIPT = (pids: string) => `echo $$ >> '${pids}'
bash -c 'sleep 300 & echo $! >> "$0"; wait' '${pids}' &
echo $! >> '${pids}'
sleep 300 &
echo $! >> '${pids}'
wait
`;
const TREE_SIZE = 4;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "schedule run;"));
	scriptPath = path.join(dir, "script.sh");
	logPath = path.join(dir, "deployment log;id.log");
	pidsPath = path.join(dir, "pids");
});

afterEach(() => {
	for (const pid of readPids()) {
		if (isRunning(pid)) {
			process.kill(pid, "SIGKILL");
		}
	}
	for (const child of started.splice(0)) {
		child.kill("SIGKILL");
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("buildKillScheduleRunCommand", () => {
	it("stops the script and everything it started", async () => {
		writeFileSync(scriptPath, TREE_SCRIPT(pidsPath));
		const script = spawn("bash", [scriptPath], { stdio: "ignore" });
		started.push(script);
		await waitUntil(() => readPids().length === TREE_SIZE);
		expect(readPids().every(isRunning)).toBe(true);

		const result = runInShell(buildKillScheduleRunCommand(String(script.pid)));

		expect(result.status).toBe(0);
		await waitUntil(() => !readPids().some(isRunning));
	});

	it("leaves alone a process that is not a schedule script", () => {
		const other = spawn("sleep", ["300"], { stdio: "ignore" });
		started.push(other);

		const result = runInShell(buildKillScheduleRunCommand(String(other.pid)));

		expect(result.status).not.toBe(0);
		expect(isRunning(other.pid as number)).toBe(true);
	});

	it("refuses a process that is gone", () => {
		const gone = spawnSync("true");

		expect(
			runInShell(buildKillScheduleRunCommand(String(gone.pid))).status,
		).not.toBe(0);
	});

	it("refuses a PID that is not a number", () => {
		expect(() => buildKillScheduleRunCommand("1; touch /tmp/x")).toThrow();
	});
});

describe("buildServerScheduleCommand", () => {
	const runScript = (content: string) => {
		writeFileSync(scriptPath, content);
		const result = runInShell(buildServerScheduleCommand(scriptPath, logPath));
		return { ...result, log: readFileSync(logPath, "utf8") };
	};

	it("reports a script that succeeded", () => {
		const result = runScript("echo from the script\n");

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("from the script");
		expect(result.log).toContain("from the script");
		expect(result.log).toContain("✅ Command executed successfully");
	});

	it("reports a script that failed", () => {
		const result = runScript("echo before the failure\nexit 3\n");

		expect(result.status).toBe(1);
		expect(result.log).toContain("before the failure");
		expect(result.log).toContain("❌ Command failed");
		expect(result.log).not.toContain("✅");
	});

	it("ends and reports a failure at once when the run is killed", async () => {
		writeFileSync(scriptPath, `echo "PID: $$"\n${TREE_SCRIPT(pidsPath)}`);
		const wrapper = spawn(
			"/bin/sh",
			["-c", buildServerScheduleCommand(scriptPath, logPath)],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		started.push(wrapper);
		const finished = exited(wrapper);
		let output = "";
		wrapper.stdout?.on("data", (data) => {
			output += data.toString();
		});
		await waitUntil(() => readPids().length === TREE_SIZE);
		await waitUntil(() => /PID: \d+/.test(output));
		const pid = output.match(/PID: (\d+)/)?.[1] as string;

		expect(runInShell(buildKillScheduleRunCommand(pid)).status).toBe(0);

		expect(await Promise.race([finished, wrapperTimeout()])).toBe(1);
		const log = readFileSync(logPath, "utf8");
		expect(log).toContain("❌ Command failed");
		expect(log).not.toContain("✅");
		expect(readPids().some(isRunning)).toBe(false);
	});
});

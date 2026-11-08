import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHangupScans } from "../../../server/wss/hangup-scans";

// A fake `docker` whose "daemon" starts the shell 1.2 s after the session
// closed, later than the first scan and the one after 0.5 s. A scan that runs
// once the shell exists hangs it up (writes `hup`), as the real scan would.
const dir = mkdtempSync(path.join(tmpdir(), "hangup-scans-"));
const started = path.join(dir, "shell-started");
const hup = path.join(dir, "hup");
const calls = path.join(dir, "calls");
const docker = path.join(dir, "docker");
writeFileSync(
	docker,
	`#!/bin/sh
echo scan >> "${calls}"
if [ -e "${started}" ]; then echo hup >> "${hup}"; rm "${started}"; fi
exit 0
`,
);
chmodSync(docker, 0o755);

const closedAt = Date.now();
setTimeout(() => writeFileSync(started, ""), 1200).unref();

// Only the unref'd timers of the schedule are left to keep the process alive
// after the last scan, so it must end on its own.
const scans = runHangupScans(
	() =>
		new Promise<void>((resolve) => {
			execFile(docker, ["exec"], () => resolve());
		}),
);
await scans.done;
// The shell appeared at 1.2 s; the scan at about 2.5 s hung it up, once.
const lines = async (file: string) =>
	existsSync(file)
		? (await readFile(file, "utf8")).split("\n").filter(Boolean)
		: [];
console.log(
	JSON.stringify({
		runtime: "Bun" in globalThis ? "bun" : "node",
		scans: (await lines(calls)).length,
		hangups: (await lines(hup)).length,
		elapsedOk: Date.now() - closedAt >= 7400,
	}),
);

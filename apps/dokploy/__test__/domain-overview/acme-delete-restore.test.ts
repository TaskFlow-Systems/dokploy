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
import { parseDeletionStatus } from "@dokploy/server/utils/domain-overview/acme-delete";
import { beforeEach, describe, expect, it } from "vitest";
import {
	acmeDir,
	acmeFile,
	backupDir,
	backups,
	baseEnv,
	callsOf,
	expectNoKeyText,
	firstShellOnly,
	leftovers,
	lockFile,
	mains,
	mode,
	REAL_JQ,
	readAcme,
	resultOf,
	run,
	running,
	SHELLS,
	scriptFor,
	setupBin,
	stateDir,
	targets,
	waitFor,
} from "./acme-delete-harness";

describe.skipIf(!REAL_JQ).each(SHELLS)(
	"acme delete script locks, backups and restores under $label",
	{ timeout: 60_000 },
	({ path: shell }) => {
		const once = firstShellOnly(shell);
		beforeEach(() => {
			setupBin({ jq: true, shell });
		});

		once(
			"keeps the edited copy beside acme.json only while Traefik is stopped",
			() => {
				const result = run(shell, targets("one.example.com"));

				expect(resultOf(result.stdout)).toBe("ok");
				expect(
					readFileSync(path.join(stateDir, "dir-at-start"), "utf8").trim(),
				).toBe("acme.json");
			},
		);

		once(
			"writes a 600 backup that equals the original and keeps the file at 600",
			() => {
				const original = readFileSync(acmeFile, "utf8");

				const result = run(shell, targets("one.example.com"));

				expect(backups()).toEqual(["acme.json.bak-20261012T101500Z"]);
				const backup = path.join(backupDir, "acme.json.bak-20261012T101500Z");
				expect(readFileSync(backup, "utf8")).toBe(original);
				expect(mode(backup)).toBe(0o600);
				expect(mode(acmeFile)).toBe(0o600);
				expect(mode(backupDir)).toBe(0o700);
				expect(readdirSync(acmeDir)).toEqual(["acme.json"]);
				expect(parseDeletionStatus(result.stdout).backupFile).toBe(
					"acme.json.bak-20261012T101500Z",
				);
				expect(leftovers()).toEqual([]);
			},
		);

		once(
			"keeps only the newest five backups and leaves other files alone",
			() => {
				mkdirSync(backupDir);
				for (let day = 1; day <= 7; day += 1) {
					writeFileSync(
						path.join(backupDir, `acme.json.bak-2026010${day}T000000Z`),
						"{}",
					);
				}
				writeFileSync(path.join(backupDir, "acme.json.bak-keepme"), "x");
				writeFileSync(path.join(backupDir, "notes.txt"), "x");

				run(shell, targets("one.example.com"));

				expect(backups().sort()).toEqual([
					"acme.json.bak-20260104T000000Z",
					"acme.json.bak-20260105T000000Z",
					"acme.json.bak-20260106T000000Z",
					"acme.json.bak-20260107T000000Z",
					"acme.json.bak-20261012T101500Z",
					"acme.json.bak-keepme",
				]);
				expect(existsSync(path.join(backupDir, "notes.txt"))).toBe(true);
			},
		);

		it("restores the backup and starts Traefik when it fails to start", () => {
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, targets("one.example.com"), {
				FAKE_START_FAIL: "once",
			});

			expect(resultOf(result.stdout)).toBe("start_failed_restored");
			expect(result.status).toBe(1);
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(mode(acmeFile)).toBe(0o600);
			expect(running()).toBe("true");
			expectNoKeyText(result);
		});

		once("restores the file taken after the stop, not an older copy", () => {
			const result = run(shell, targets("one.example.com"), {
				FAKE_START_FAIL: "once",
				FAKE_STOP_WRITES: "1",
			});

			expect(resultOf(result.stdout)).toBe("start_failed_restored");
			expect(mains(readAcme())).toContain("added.example.com");
			expect(mains(readAcme())).toContain("one.example.com");
		});

		once(
			"reports it when Traefik does not start even with the restored file",
			() => {
				const original = readFileSync(acmeFile, "utf8");

				const result = run(shell, targets("one.example.com"), {
					FAKE_START_FAIL: "always",
				});

				expect(resultOf(result.stdout)).toBe("start_failed_after_restore");
				expect(readFileSync(acmeFile, "utf8")).toBe(original);
				expect(existsSync(lockFile)).toBe(false);
			},
		);

		const ownerLine = (pid: number) => {
			const started = spawnSync(
				"sh",
				[
					"-c",
					`if [ -r /proc/${pid}/stat ]; then sed 's/^.*) //' /proc/${pid}/stat | cut -d' ' -f20; else ps -o lstart= -p ${pid} | tr -s ' ' '_'; fi`,
				],
				{ encoding: "utf8" },
			).stdout.trim();
			const boot = spawnSync(
				"sh",
				[
					"-c",
					"if [ -r /proc/sys/kernel/random/boot_id ]; then cat /proc/sys/kernel/random/boot_id; else sysctl -n kern.boottime | tr -s ' ,{}=' '_'; fi",
				],
				{ encoding: "utf8" },
			).stdout.trim();
			return `${pid} ${started || "none"} ${boot || "none"}\n`;
		};

		it("refuses while another deletion holds the lock", () => {
			writeFileSync(lockFile, ownerLine(process.pid));
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("busy");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(existsSync(lockFile)).toBe(true);
			expect(readFileSync(lockFile, "utf8")).toBe(ownerLine(process.pid));
			expect(result.calls.filter((c) => c.startsWith("stop "))).toEqual([]);
		});

		it("takes over a lock whose owner is gone and removes the lock when done", () => {
			writeFileSync(lockFile, ownerLine(999999));

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("ok");
			expect(existsSync(lockFile)).toBe(false);
		});

		it("does not trust a live pid that is not the recorded process", () => {
			writeFileSync(
				lockFile,
				ownerLine(process.pid).replace(/^(\d+) \S+/, "$1 not-the-start-time"),
			);

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("ok");
		});

		it("does not trust a lock written before the last boot", () => {
			writeFileSync(
				lockFile,
				ownerLine(process.pid).replace(/\S+\n$/, "another-boot\n"),
			);

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("ok");
		});

		it("treats a lock without an owner yet as held, then as stale after a minute", () => {
			writeFileSync(lockFile, "");
			const fresh = run(shell, targets("one.example.com"));
			expect(resultOf(fresh.stdout)).toBe("busy");
			expect(existsSync(lockFile)).toBe(true);

			const old = new Date(Date.now() - 5 * 60_000);
			utimesSync(lockFile, old, old);
			const aged = run(shell, targets("one.example.com"));
			expect(resultOf(aged.stdout)).toBe("ok");
		});

		it("lets only one of several simultaneous scripts take the lock", async () => {
			const outputs: string[] = [];
			const children = [1, 2, 3, 4].map(
				() =>
					new Promise<void>((resolve) => {
						const child = spawn(
							shell,
							["-c", scriptFor(targets("one.example.com"))],
							{
								env: baseEnv(),
								stdio: ["ignore", "pipe", "ignore"],
							},
						);
						let output = "";
						child.stdout?.on("data", (chunk) => {
							output += chunk.toString();
						});
						child.on("close", () => {
							outputs.push(output);
							resolve();
						});
					}),
			);
			await Promise.all(children);

			const results = outputs.map((output) => resultOf(output));
			expect(results.filter((r) => r === "ok")).toHaveLength(1);
			expect(callsOf().filter((c) => c.startsWith("stop "))).toHaveLength(1);
		});

		it("starts Traefik again when the script is killed after the stop", async () => {
			const child: ChildProcess = spawn(
				shell,
				["-c", scriptFor(targets("one.example.com"))],
				{
					env: baseEnv({ FAKE_JQ_BREAK: "hang" }),
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let output = "";
			child.stdout?.on("data", (chunk) => {
				output += chunk.toString();
			});
			const exited = new Promise<void>((resolve) =>
				child.on("close", () => resolve()),
			);

			await waitFor(() => running() === "false");
			process.kill(-(child.pid as number), "SIGTERM");
			await exited;

			expect(running()).toBe("true");
			expect(existsSync(lockFile)).toBe(false);
			expect(leftovers()).toEqual([]);
			expect(output).toMatch(/DOKPLOY_RESULT (interrupted|verify_failed)/);
			expect(callsOf().filter((c) => c.startsWith("start "))).toHaveLength(1);
		});

		it("removes the edited copy when the script is killed", async () => {
			const child = spawn(
				shell,
				["-c", scriptFor(targets("one.example.com"))],
				{
					env: baseEnv({ FAKE_JQ_BREAK: "hang" }),
					detached: true,
					stdio: "ignore",
				},
			);
			const exited = new Promise<void>((resolve) =>
				child.on("close", () => resolve()),
			);
			await waitFor(() => running() === "false");

			process.kill(-(child.pid as number), "SIGTERM");
			await exited;

			expect(readdirSync(acmeDir).filter((n) => n.includes(".new-"))).toEqual(
				[],
			);
		});
	},
);

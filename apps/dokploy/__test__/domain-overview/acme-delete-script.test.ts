import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import {
	isValidCertificateDomain,
	parseDeletionStatus,
} from "@dokploy/server/utils/domain-overview/acme-delete";
import { beforeEach, describe, expect, it } from "vitest";
import {
	acmeDir,
	acmeFile,
	backupDir,
	backups,
	baseEnv,
	callsOf,
	entry,
	expectNoKeyText,
	fixture,
	KEY_ONE,
	KEY_THREE,
	KEY_TWO,
	leftovers,
	lockFile,
	mains,
	markerFile,
	mode,
	OTHER_ACCOUNT_KEY,
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
	writeAcme,
} from "./acme-delete-harness";

describe("acme delete script builder", () => {
	it("accepts hostnames and wildcard names only", () => {
		expect(isValidCertificateDomain("app.example.com")).toBe(true);
		expect(isValidCertificateDomain("*.example.com")).toBe(true);
		for (const bad of [
			"",
			"example",
			"a b.example.com",
			"a.example.com'; rm -rf /",
			"a.example.com$(id)",
			"a`id`.example.com",
			'a".example.com',
			"a\\.example.com",
			"-a.example.com",
			"a.example.com.",
			"*.*.example.com",
			`${"a".repeat(64)}.example.com`,
		]) {
			expect(isValidCertificateDomain(bad)).toBe(false);
		}
	});

	it("refuses to build a script for a name that is not a hostname", () => {
		expect(() => scriptFor(targets("a.example.com'; id; '"))).toThrow();
	});

	it("refuses a resolver name that is not a plain identifier", () => {
		expect(() =>
			scriptFor([{ resolver: "x'; id; '", domain: "a.example.com" }]),
		).toThrow();
	});

	it("never uses bash-only syntax", () => {
		expect(scriptFor(targets("a.example.com"))).not.toMatch(
			/PIPESTATUS|pipefail|\[\[|\blocal\b|<\(/,
		);
	});

	it("does not mention port 80 or an HTTP challenge", () => {
		expect(scriptFor(targets("a.example.com"))).not.toMatch(
			/httpChallenge|:80\b/,
		);
	});

	it("never removes a path built from an empty or unchecked variable", () => {
		const script = scriptFor(targets("a.example.com"));
		for (const line of script.split("\n").filter((l) => /\brm\b/.test(l))) {
			expect(line).toMatch(
				/\$NEW|\$RESTORE|\$BAK|\$LOCK|\$STALE_COPY|\$OUT|\$TMPLOCK|\$MARKER|\$BACKUP_DIR\/\$old|acme\.json\.bak-\*\)/,
			);
		}
	});
});

describe.skipIf(!REAL_JQ).each(SHELLS)(
	"acme delete script under $label",
	({ path: shell }) => {
		beforeEach(() => {
			setupBin({ jq: true, shell });
		});

		it("deletes one certificate, keeps the others and the account", () => {
			const before = readAcme();

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("ok");
			expect(result.status).toBe(0);
			const after = readAcme();
			expect(mains(after)).toEqual(["two.example.com", "three.example.com"]);
			expect(after.letsencrypt.Account).toEqual(before.letsencrypt.Account);
			expect(after.letsencrypt.Certificates[0]).toEqual(
				before.letsencrypt.Certificates[1],
			);
			expectNoKeyText(result);
		});

		it("keeps a certificate that Traefik writes while it shuts down", () => {
			const result = run(shell, targets("one.example.com"), {
				FAKE_STOP_WRITES: "1",
			});

			expect(resultOf(result.stdout)).toBe("ok");
			expect(mains(readAcme())).toEqual([
				"two.example.com",
				"three.example.com",
				"added.example.com",
			]);
			const backup = JSON.parse(
				readFileSync(path.join(backupDir, backups()[0] ?? ""), "utf8"),
			);
			expect(mains(backup)).toContain("added.example.com");
		});

		it("refuses and starts Traefik again when the target changes while Traefik shuts down", () => {
			const result = run(shell, targets("one.example.com"), {
				FAKE_STOP_DROPS: "1",
			});

			expect(resultOf(result.stdout)).toBe("count_mismatch");
			expect(mains(readAcme())).not.toContain("one.example.com");
			expect(backups()).toEqual([]);
			expect(result.calls.filter((call) => /^start /.test(call))).toHaveLength(
				1,
			);
		});

		it("reads, backs up and edits the file only after Traefik has stopped", () => {
			const result = run(shell, targets("one.example.com"));

			const order = result.calls.filter((call) => /^(stop|start) /.test(call));
			expect(order).toEqual(["stop dokploy-traefik", "start dokploy-traefik"]);
			expect(result.stdout.indexOf("DOKPLOY_PRECHECK")).toBeLessThan(
				result.stdout.indexOf("DOKPLOY_BACKUP"),
			);
		});

		it("scales a swarm service to zero and back", () => {
			const result = run(shell, targets("one.example.com"), {
				FAKE_MODE: "service",
			});

			expect(resultOf(result.stdout)).toBe("ok");
			expect(
				result.calls.filter((call) => call.startsWith("service scale")),
			).toEqual([
				"service scale dokploy-traefik=0",
				"service scale dokploy-traefik=1",
			]);
		});

		it("refuses a swarm service in global mode before changing anything", () => {
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, targets("one.example.com"), {
				FAKE_MODE: "global",
			});

			expect(resultOf(result.stdout)).toBe("unsupported_traefik_mode");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(backups()).toEqual([]);
		});

		it("does not start a Traefik that was stopped on purpose", () => {
			writeFileSync(path.join(stateDir, "running"), "false\n");
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("traefik_not_running");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(backups()).toEqual([]);
			expect(
				result.calls.filter((call) => /^(stop|start) /.test(call)),
			).toEqual([]);
			expect(running()).toBe("false");
		});

		it("deletes several certificates with one stop and one start", () => {
			const result = run(
				shell,
				targets("one.example.com", "three.example.com"),
			);

			expect(resultOf(result.stdout)).toBe("ok");
			expect(mains(readAcme())).toEqual(["two.example.com"]);
			expect(result.calls.filter((c) => c.startsWith("stop "))).toHaveLength(1);
			expect(result.calls.filter((c) => c.startsWith("start "))).toHaveLength(
				1,
			);
			expectNoKeyText(result);
		});

		it("addresses the resolver as well as the main domain", () => {
			const document = fixture() as Record<string, unknown>;
			document.other = {
				Account: { Email: "ops@example.com", PrivateKey: OTHER_ACCOUNT_KEY },
				Certificates: [entry("one.example.com", [], KEY_TWO)],
			};
			writeAcme(document);

			const result = run(shell, [
				{ resolver: "other", domain: "one.example.com" },
			]);

			expect(resultOf(result.stdout)).toBe("ok");
			const after = readAcme();
			expect(mains(after)).toEqual([
				"one.example.com",
				"two.example.com",
				"three.example.com",
			]);
			expect(after.other.Certificates).toEqual([]);
			expect(after.other.Account.PrivateKey).toBe(OTHER_ACCOUNT_KEY);
			expectNoKeyText(result);
		});

		it("keeps the edited copy beside acme.json only while Traefik is stopped", () => {
			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("ok");
			expect(
				readFileSync(path.join(stateDir, "dir-at-start"), "utf8").trim(),
			).toBe("acme.json");
		});

		it("writes a 600 backup that equals the original and keeps the file at 600", () => {
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
		});

		it("keeps only the newest five backups and leaves other files alone", () => {
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
		});

		it("does nothing when a requested name is not in the file", () => {
			const original = readFileSync(acmeFile, "utf8");

			const result = run(
				shell,
				targets("one.example.com", "missing.example.com"),
			);

			expect(resultOf(result.stdout)).toBe("count_mismatch");
			expect(result.status).toBe(1);
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(backups()).toEqual([]);
			expect(result.calls.filter((c) => c.startsWith("stop "))).toEqual([]);
		});

		it("does not delete an entry that only lists the name as an alternative name", () => {
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, targets("www.two.example.com"));

			expect(resultOf(result.stdout)).toBe("count_mismatch");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
		});

		it("does nothing when the file is not valid JSON", () => {
			writeAcme(`{"letsencrypt": {"Account": "${KEY_ONE}"`);
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("invalid_json");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(backups()).toEqual([]);
			expectNoKeyText(result);
		});

		it("says jq is missing and does not edit the file", () => {
			setupBin({ jq: false, shell });
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("jq_missing");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(backups()).toEqual([]);
			expect(result.calls).toEqual([]);
		});

		it("stops nothing when the backup directory cannot be used", () => {
			writeFileSync(backupDir, "not a directory");
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("backup_failed");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(result.calls.filter((c) => /^(stop|start) /.test(c))).toEqual([]);
			expect(existsSync(markerFile)).toBe(false);
			expect(existsSync(lockFile)).toBe(false);
		});

		it("starts Traefik again and leaves nothing behind when the edited copy cannot be written", () => {
			if (process.getuid?.() === 0) {
				return;
			}
			const original = readFileSync(acmeFile, "utf8");
			chmodSync(acmeDir, 0o555);

			const result = run(shell, targets("one.example.com"));
			chmodSync(acmeDir, 0o755);

			expect(resultOf(result.stdout)).toBe("verify_failed");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(running()).toBe("true");
			expect(leftovers()).toEqual([]);
			expect(existsSync(lockFile)).toBe(false);
			expect(existsSync(markerFile)).toBe(false);
		});

		it("keeps the original and restarts Traefik when the count does not drop as requested", () => {
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, targets("one.example.com"), {
				FAKE_JQ_BREAK: "count",
			});

			expect(resultOf(result.stdout)).toBe("verify_failed");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(running()).toBe("true");
			expect(leftovers()).toEqual([]);
		});

		it("keeps the original when the account section would change", () => {
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, targets("one.example.com"), {
				FAKE_JQ_BREAK: "account",
			});

			expect(resultOf(result.stdout)).toBe("verify_failed");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(running()).toBe("true");
			expectNoKeyText(result);
		});

		it("refuses when two entries share the requested main domain", () => {
			const document = fixture();
			document.letsencrypt.Certificates.push(
				entry("one.example.com", [], KEY_THREE),
			);
			writeAcme(document);
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("count_mismatch");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
		});

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

		it("restores the file taken after the stop, not an older copy", () => {
			const result = run(shell, targets("one.example.com"), {
				FAKE_START_FAIL: "once",
				FAKE_STOP_WRITES: "1",
			});

			expect(resultOf(result.stdout)).toBe("start_failed_restored");
			expect(mains(readAcme())).toContain("added.example.com");
			expect(mains(readAcme())).toContain("one.example.com");
		});

		it("reports it when Traefik does not start even with the restored file", () => {
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, targets("one.example.com"), {
				FAKE_START_FAIL: "always",
			});

			expect(resultOf(result.stdout)).toBe("start_failed_after_restore");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(existsSync(lockFile)).toBe(false);
		});

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

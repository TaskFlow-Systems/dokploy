import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	ACME_DELETE_MESSAGES,
	isValidCertificateDomain,
	RECOVERY_MESSAGES,
} from "@dokploy/server/utils/domain-overview/acme-delete";
import { beforeEach, describe, expect, it } from "vitest";
import {
	acmeDir,
	acmeFile,
	backupDir,
	backups,
	entry,
	expectNoKeyText,
	firstShellOnly,
	fixture,
	KEY_ONE,
	KEY_THREE,
	KEY_TWO,
	leftovers,
	lockFile,
	mains,
	markerFile,
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

	it("says what state Traefik is in and which button to press when it is not confirmed running", () => {
		for (const code of [
			"traefik_not_restarted",
			"start_failed_after_restore",
			"start_failed_restore_failed",
		] as const) {
			expect(ACME_DELETE_MESSAGES[code]).toMatch(/stopped|stopping/);
			expect(ACME_DELETE_MESSAGES[code]).toContain("Start Traefik again");
		}
		expect(RECOVERY_MESSAGES.recovery_failed).toContain("still stopped");
		expect(RECOVERY_MESSAGES.recovery_failed).toContain("Start Traefik again");
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
	{ timeout: 60_000 },
	({ path: shell }) => {
		const once = firstShellOnly(shell);
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

		once("keeps a certificate that Traefik writes while it shuts down", () => {
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

		once(
			"refuses and starts Traefik again when the target changes while Traefik shuts down",
			() => {
				const result = run(shell, targets("one.example.com"), {
					FAKE_STOP_DROPS: "1",
				});

				expect(resultOf(result.stdout)).toBe("count_mismatch");
				expect(mains(readAcme())).not.toContain("one.example.com");
				expect(backups()).toEqual([]);
				expect(
					result.calls.filter((call) => /^start /.test(call)),
				).toHaveLength(1);
			},
		);

		it("reads, backs up and edits the file only after Traefik has stopped", () => {
			const result = run(shell, targets("one.example.com"));

			const order = result.calls.filter((call) => /^(stop|start) /.test(call));
			expect(order).toEqual(["stop dokploy-traefik", "start dokploy-traefik"]);
			expect(result.stdout.indexOf("DOKPLOY_PRECHECK")).toBeLessThan(
				result.stdout.indexOf("DOKPLOY_BACKUP"),
			);
		});

		once("scales a swarm service to zero and back", () => {
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

		once(
			"refuses a swarm service in global mode before changing anything",
			() => {
				const original = readFileSync(acmeFile, "utf8");

				const result = run(shell, targets("one.example.com"), {
					FAKE_MODE: "global",
				});

				expect(resultOf(result.stdout)).toBe("unsupported_traefik_mode");
				expect(readFileSync(acmeFile, "utf8")).toBe(original);
				expect(backups()).toEqual([]);
			},
		);

		once("does not start a Traefik that was stopped on purpose", () => {
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

		once("deletes several certificates with one stop and one start", () => {
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

		once("addresses the resolver as well as the main domain", () => {
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

		once("does nothing when a requested name is not in the file", () => {
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

		once(
			"does not delete an entry that only lists the name as an alternative name",
			() => {
				const original = readFileSync(acmeFile, "utf8");

				const result = run(shell, targets("www.two.example.com"));

				expect(resultOf(result.stdout)).toBe("count_mismatch");
				expect(readFileSync(acmeFile, "utf8")).toBe(original);
			},
		);

		once("does nothing when the file is not valid JSON", () => {
			writeAcme(`{"letsencrypt": {"Account": "${KEY_ONE}"`);
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("invalid_json");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(backups()).toEqual([]);
			expectNoKeyText(result);
		});

		once("says jq is missing and does not edit the file", () => {
			setupBin({ jq: false, shell });
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("jq_missing");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(backups()).toEqual([]);
			expect(result.calls).toEqual([]);
		});

		once("stops nothing when the backup directory cannot be used", () => {
			writeFileSync(backupDir, "not a directory");
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("backup_failed");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(result.calls.filter((c) => /^(stop|start) /.test(c))).toEqual([]);
			expect(existsSync(markerFile)).toBe(false);
			expect(existsSync(lockFile)).toBe(false);
		});

		once(
			"starts Traefik again and leaves nothing behind when the edited copy cannot be written",
			() => {
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
			},
		);

		once(
			"keeps the original and restarts Traefik when the count does not drop as requested",
			() => {
				const original = readFileSync(acmeFile, "utf8");

				const result = run(shell, targets("one.example.com"), {
					FAKE_JQ_BREAK: "count",
				});

				expect(resultOf(result.stdout)).toBe("verify_failed");
				expect(readFileSync(acmeFile, "utf8")).toBe(original);
				expect(running()).toBe("true");
				expect(leftovers()).toEqual([]);
			},
		);

		once("keeps the original when the account section would change", () => {
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, targets("one.example.com"), {
				FAKE_JQ_BREAK: "account",
			});

			expect(resultOf(result.stdout)).toBe("verify_failed");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(running()).toBe("true");
			expectNoKeyText(result);
		});

		once("refuses when two entries share the requested main domain", () => {
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
	},
);

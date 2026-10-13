import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type AcmeDeleteStatus,
	type AcmeDeleteTarget,
	buildAcmeDeleteScript,
	buildDeletionLauncher,
	buildDeletionStatusCommand,
	deletionState,
	isValidCertificateDomain,
	parseDeletionStatus,
} from "@dokploy/server/utils/domain-overview/acme-delete";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const which = (name: string) => {
	const found = spawnSync("sh", ["-c", `command -v ${name}`], {
		encoding: "utf8",
	}).stdout.trim();
	return found || null;
};

const REAL_JQ = which("jq");
const SHELLS = [
	{ label: "/bin/sh", path: "/bin/sh" },
	{ label: "dash", path: which("dash") ?? "/bin/dash" },
	{ label: "bash", path: which("bash") ?? "/bin/bash" },
].filter((shell) => existsSync(shell.path));

const TOOLS = [
	"cp",
	"mv",
	"rm",
	"rmdir",
	"chmod",
	"chown",
	"stat",
	"cmp",
	"date",
	"basename",
	"sleep",
	"id",
	"cat",
	"touch",
	"grep",
	"mkdir",
	"dirname",
	"sort",
	"tail",
	"ls",
	"nohup",
	"setsid",
];

const KEY_ONE = "DUMMY-PRIVATE-KEY-ONE-0f9a8c7d6e5b4a3f";
const KEY_TWO = "DUMMY-PRIVATE-KEY-TWO-1a2b3c4d5e6f7a8b";
const KEY_THREE = "DUMMY-PRIVATE-KEY-THREE-9e8d7c6b5a4f3e2d";
const ACCOUNT_KEY = "DUMMY-ACCOUNT-KEY-aa11bb22cc33dd44";
const OTHER_ACCOUNT_KEY = "DUMMY-OTHER-ACCOUNT-KEY-55ee66ff77aa88bb";
const ALL_KEYS = [KEY_ONE, KEY_TWO, KEY_THREE, ACCOUNT_KEY, OTHER_ACCOUNT_KEY];

const entry = (main: string, sans: string[], key: string) => ({
	domain: { main, sans },
	certificate: Buffer.from(`certificate for ${main}`).toString("base64"),
	key,
	Store: "default",
});

const fixture = () => ({
	letsencrypt: {
		Account: {
			Email: "ops@example.com",
			Registration: { uri: "https://acme.example.com/acct/1" },
			PrivateKey: ACCOUNT_KEY,
			KeyType: "4096",
		},
		Certificates: [
			entry("one.example.com", [], KEY_ONE),
			entry("two.example.com", ["www.two.example.com"], KEY_TWO),
			entry("three.example.com", [], KEY_THREE),
		],
	},
});

const FAKE_DOCKER = `#!/bin/sh
state="$FAKE_STATE"
echo "$*" >> "$state/calls"
drop_certificate() {
	[ -z "$FAKE_STOP_DROPS" ] || {
		"$REAL_JQ" '.letsencrypt.Certificates |= map(select(.domain.main != "one.example.com"))' "$FAKE_ACME" > "$FAKE_ACME.late" && mv "$FAKE_ACME.late" "$FAKE_ACME"
	}
}
add_certificate() {
	[ -z "$FAKE_STOP_WRITES" ] || {
		"$REAL_JQ" '.letsencrypt.Certificates += [{"domain":{"main":"added.example.com","sans":[]},"certificate":"AA==","key":"DUMMY-ADDED-KEY"}]' "$FAKE_ACME" > "$FAKE_ACME.late" && mv "$FAKE_ACME.late" "$FAKE_ACME"
	}
}
if [ "$1" = service ] && [ "$2" = inspect ]; then
	[ "$FAKE_MODE" = service ] || [ "$FAKE_MODE" = global ] || exit 1
	case "$*" in
		*Replicated.Replicas*) [ "$FAKE_MODE" = global ] || echo 1 ;;
	esac
	exit 0
fi
if [ "$1" = service ] && [ "$2" = scale ]; then
	case "$3" in
		*=0) echo false > "$state/running"; add_certificate; drop_certificate ;;
		*) [ -z "$FAKE_START_FAIL" ] || exit 1; echo true > "$state/running" ;;
	esac
	exit 0
fi
if [ "$1" = ps ]; then
	[ "$(cat "$state/running")" = true ] && echo abc123
	exit 0
fi
if [ "$1" = inspect ]; then
	if [ "$2" = -f ]; then cat "$state/running"; exit 0; fi
	[ "$FAKE_MODE" != none ] || exit 1
	exit 0
fi
if [ "$1" = stop ]; then
	echo false > "$state/running"
	add_certificate
	drop_certificate
	exit 0
fi
if [ "$1" = start ]; then
	if [ "$FAKE_START_FAIL" = always ]; then exit 1; fi
	if [ "$FAKE_START_FAIL" = once ] && [ ! -e "$state/failed-once" ]; then
		touch "$state/failed-once"
		exit 1
	fi
	echo true > "$state/running"
	exit 0
fi
exit 0
`;

const FAKE_JQ = `#!/bin/sh
case "$*" in
	*"|= map(select"*)
		case "$FAKE_JQ_BREAK" in
			count) exec cat "$FAKE_ACME" ;;
			account) "$REAL_JQ" "$@" | "$REAL_JQ" '.letsencrypt.Account.Email = "other@example.com"' ; exit $? ;;
			hang) sleep 30; exit 1 ;;
		esac
		;;
esac
exec "$REAL_JQ" "$@"
`;

type Run = {
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	calls: string[];
};

let workDir: string;
let binDir: string;
let stateDir: string;
let acmeDir: string;
let acmeFile: string;
let lockDir: string;
let logDir: string;

const writeExecutable = (file: string, content: string) => {
	writeFileSync(file, content);
	chmodSync(file, 0o755);
};

const setupBin = (options: { jq: boolean; shell: string }) => {
	rmSync(binDir, { recursive: true, force: true });
	mkdirSync(binDir);
	for (const tool of TOOLS) {
		const found = which(tool);
		if (found) {
			symlinkSync(found, path.join(binDir, tool));
		}
	}
	symlinkSync(options.shell, path.join(binDir, "sh"));
	writeExecutable(path.join(binDir, "docker"), FAKE_DOCKER);
	writeExecutable(path.join(binDir, "sudo"), '#!/bin/sh\nexec "$@"\n');
	if (options.jq && REAL_JQ) {
		writeExecutable(path.join(binDir, "jq"), FAKE_JQ);
	}
};

const writeAcme = (document: unknown | string) => {
	writeFileSync(
		acmeFile,
		typeof document === "string" ? document : JSON.stringify(document),
	);
	chmodSync(acmeFile, 0o600);
};

const readAcme = () => JSON.parse(readFileSync(acmeFile, "utf8"));

const mains = (document: { letsencrypt: { Certificates: unknown[] } }) =>
	document.letsencrypt.Certificates.map(
		(item) => (item as { domain: { main: string } }).domain.main,
	);

const targets = (...domains: string[]): AcmeDeleteTarget[] =>
	domains.map((domain) => ({ resolver: "letsencrypt", domain }));

const scriptFor = (list: AcmeDeleteTarget[], startDelaySeconds = 0) =>
	buildAcmeDeleteScript({
		acmeFile,
		lockDir,
		targets: list,
		timestamp: "20261012T101500Z",
		pollSeconds: 0,
		waitSeconds: 3,
		startDelaySeconds,
	});

const baseEnv = (extra: Record<string, string> = {}) =>
	({
		PATH: binDir,
		FAKE_STATE: stateDir,
		FAKE_ACME: acmeFile,
		REAL_JQ: REAL_JQ ?? "",
		...extra,
	}) as unknown as NodeJS.ProcessEnv;

const callsOf = () => {
	const callsFile = path.join(stateDir, "calls");
	return existsSync(callsFile)
		? readFileSync(callsFile, "utf8").split("\n").filter(Boolean)
		: [];
};

const run = (
	shell: string,
	list: AcmeDeleteTarget[],
	env: Record<string, string> = {},
): Run => {
	const result = spawnSync(shell, ["-c", scriptFor(list)], {
		encoding: "utf8",
		env: baseEnv(env),
		timeout: 60_000,
	});
	return {
		status: result.status,
		signal: result.signal,
		stdout: result.stdout,
		stderr: result.stderr,
		calls: callsOf(),
	};
};

const resultOf = (output: string) =>
	parseDeletionStatus(output).status as AcmeDeleteStatus | null;

const backups = () =>
	readdirSync(acmeDir).filter((name) => name.startsWith("acme.json.bak-"));

const leftovers = () =>
	readdirSync(acmeDir).filter(
		(name) => name.includes(".new-") || name.includes(".restore-"),
	);

const mode = (file: string) => statSync(file).mode & 0o777;

const running = () =>
	readFileSync(path.join(stateDir, "running"), "utf8").trim();

const expectNoKeyText = (result: { stdout: string; stderr: string }) => {
	for (const key of ALL_KEYS) {
		expect(result.stdout).not.toContain(key);
		expect(result.stderr).not.toContain(key);
	}
};

const waitFor = async (check: () => boolean, ms = 15_000) => {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) {
			throw new Error("condition not reached");
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
};

beforeEach(() => {
	workDir = mkdtempSync(path.join(tmpdir(), "acme-delete-"));
	binDir = path.join(workDir, "bin");
	stateDir = path.join(workDir, "state");
	acmeDir = path.join(workDir, "dynamic");
	lockDir = path.join(workDir, "acme-delete.lock");
	logDir = path.join(workDir, "logs");
	mkdirSync(stateDir);
	mkdirSync(acmeDir);
	writeFileSync(path.join(stateDir, "running"), "true\n");
	acmeFile = path.join(acmeDir, "acme.json");
	setupBin({ jq: true, shell: "/bin/sh" });
	writeAcme(fixture());
});

afterEach(() => {
	chmodSync(acmeDir, 0o755);
	rmSync(workDir, { recursive: true, force: true });
});

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
				/\$NEW|\$RESTORE|\$BAK|\$LOCK\/pid|acme\.json\.bak-\*\)|rmdir/,
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
				readFileSync(path.join(acmeDir, backups()[0] ?? ""), "utf8"),
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

		it("writes a 600 backup that equals the original and keeps the file at 600", () => {
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, targets("one.example.com"));

			expect(backups()).toEqual(["acme.json.bak-20261012T101500Z"]);
			const backup = path.join(acmeDir, "acme.json.bak-20261012T101500Z");
			expect(readFileSync(backup, "utf8")).toBe(original);
			expect(mode(backup)).toBe(0o600);
			expect(mode(acmeFile)).toBe(0o600);
			expect(parseDeletionStatus(result.stdout).backupFile).toBe(
				"acme.json.bak-20261012T101500Z",
			);
			expect(leftovers()).toEqual([]);
		});

		it("keeps only the newest five backups and leaves other files alone", () => {
			for (let day = 1; day <= 7; day += 1) {
				writeFileSync(
					path.join(acmeDir, `acme.json.bak-2026010${day}T000000Z`),
					"{}",
				);
			}
			writeFileSync(path.join(acmeDir, "acme.json.bak-keepme"), "x");
			writeFileSync(path.join(acmeDir, "notes.txt"), "x");

			run(shell, targets("one.example.com"));

			expect(backups().sort()).toEqual([
				"acme.json.bak-20260104T000000Z",
				"acme.json.bak-20260105T000000Z",
				"acme.json.bak-20260106T000000Z",
				"acme.json.bak-20260107T000000Z",
				"acme.json.bak-20261012T101500Z",
				"acme.json.bak-keepme",
			]);
			expect(existsSync(path.join(acmeDir, "notes.txt"))).toBe(true);
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

		it("stops, starts Traefik again and leaves nothing behind when the backup cannot be written", () => {
			if (process.getuid?.() === 0) {
				return;
			}
			const original = readFileSync(acmeFile, "utf8");
			chmodSync(acmeDir, 0o555);

			const result = run(shell, targets("one.example.com"));
			chmodSync(acmeDir, 0o755);

			expect(resultOf(result.stdout)).toBe("backup_failed");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(running()).toBe("true");
			expect(leftovers()).toEqual([]);
			expect(existsSync(lockDir)).toBe(false);
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
			expect(existsSync(lockDir)).toBe(false);
		});

		it("refuses while another deletion holds the lock", () => {
			mkdirSync(lockDir);
			writeFileSync(path.join(lockDir, "pid"), `${process.pid}\n`);
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("busy");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(existsSync(lockDir)).toBe(true);
			expect(result.calls.filter((c) => c.startsWith("stop "))).toEqual([]);
		});

		it("takes over a lock whose owner is gone and removes the lock when done", () => {
			mkdirSync(lockDir);
			writeFileSync(path.join(lockDir, "pid"), "999999\n");

			const result = run(shell, targets("one.example.com"));

			expect(resultOf(result.stdout)).toBe("ok");
			expect(existsSync(lockDir)).toBe(false);
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
			expect(existsSync(lockDir)).toBe(false);
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

describe.skipIf(!REAL_JQ).each(SHELLS)(
	"detached launch under $label",
	({ path: shell }) => {
		beforeEach(() => {
			setupBin({ jq: true, shell });
		});

		const launch = (list: AcmeDeleteTarget[], logPath = logDir) =>
			spawnSync(
				shell,
				[
					"-c",
					buildDeletionLauncher({
						script: scriptFor(list),
						logDir: logPath,
						timestamp: "20261012T101500Z",
					}),
				],
				{ encoding: "utf8", env: baseEnv(), timeout: 30_000 },
			);

		const logText = () =>
			readFileSync(
				path.join(logDir, "acme-delete-20261012T101500Z.log"),
				"utf8",
			);

		it("returns at once, leaves nothing attached and the job finishes on its own", async () => {
			const started = Date.now();

			const result = launch(targets("one.example.com"));

			expect(result.signal).toBeNull();
			expect(result.status).toBe(0);
			expect(result.stdout).toContain(
				"DOKPLOY_LAUNCHED acme-delete-20261012T101500Z.log",
			);
			expect(Date.now() - started).toBeLessThan(10_000);
			await waitFor(() => /DOKPLOY_RESULT/.test(logText()));
			expect(logText()).toContain("DOKPLOY_RESULT ok");
			expect(mains(readAcme())).not.toContain("one.example.com");
			expect(mode(path.join(logDir, "acme-delete-20261012T101500Z.log"))).toBe(
				0o600,
			);
		});

		it("reports a log directory that cannot be used and starts nothing", () => {
			writeFileSync(path.join(workDir, "plain-file"), "x");
			const original = readFileSync(acmeFile, "utf8");

			const result = launch(
				targets("one.example.com"),
				path.join(workDir, "plain-file", "logs"),
			);

			expect(result.status).toBe(1);
			expect(resultOf(result.stdout)).toBe("log_dir_failed");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(callsOf()).toEqual([]);
			expect(leftovers()).toEqual([]);
			expect(existsSync(lockDir)).toBe(false);
		});

		it("reports a result and leaves no edited copy when the job refuses", async () => {
			const result = launch(targets("missing.example.com"));

			expect(result.status).toBe(0);
			await waitFor(() => /DOKPLOY_RESULT/.test(logText()));
			expect(logText()).toContain("DOKPLOY_RESULT count_mismatch");
			expect(leftovers()).toEqual([]);
		});

		it("keeps only the newest five logs", () => {
			mkdirSync(logDir);
			for (let day = 1; day <= 7; day += 1) {
				writeFileSync(
					path.join(logDir, `acme-delete-2026010${day}T000000Z.log`),
					"x",
				);
			}
			writeFileSync(path.join(logDir, "other.log"), "x");

			launch(targets("missing.example.com"));

			const logs = readdirSync(logDir).filter((n) =>
				n.startsWith("acme-delete-"),
			);
			expect(logs).toHaveLength(5);
			expect(existsSync(path.join(logDir, "other.log"))).toBe(true);
		});

		it("lets the status command show the running, finished and killed states", async () => {
			launch(targets("one.example.com"));
			await waitFor(() => /DOKPLOY_RESULT/.test(logText()));
			const status = (lock = lockDir) =>
				parseDeletionStatus(
					spawnSync(shell, ["-c", buildDeletionStatusCommand(logDir, lock)], {
						encoding: "utf8",
						env: baseEnv(),
					}).stdout,
				);

			expect(deletionState(status())).toBe("succeeded");
			expect(status().backupFile).toBe("acme.json.bak-20261012T101500Z");

			writeFileSync(
				path.join(logDir, "acme-delete-20261012T101600Z.log"),
				"DOKPLOY_STARTED\nDOKPLOY_PRECHECK ok\n",
			);
			expect(deletionState(status())).toBe("interrupted");

			mkdirSync(lockDir);
			writeFileSync(path.join(lockDir, "pid"), `${process.pid}\n`);
			expect(deletionState(status())).toBe("in_progress");
		});
	},
);

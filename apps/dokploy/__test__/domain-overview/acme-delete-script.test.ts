import { spawnSync } from "node:child_process";
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
	buildAcmeDeleteScript,
	isValidCertificateDomain,
	parseAcmeDeleteOutput,
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
].filter((shell) => existsSync(shell.path));

const TOOLS = [
	"cp",
	"mv",
	"rm",
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
];

const KEY_ONE = "DUMMY-PRIVATE-KEY-ONE-0f9a8c7d6e5b4a3f";
const KEY_TWO = "DUMMY-PRIVATE-KEY-TWO-1a2b3c4d5e6f7a8b";
const KEY_THREE = "DUMMY-PRIVATE-KEY-THREE-9e8d7c6b5a4f3e2d";
const ACCOUNT_KEY = "DUMMY-ACCOUNT-KEY-aa11bb22cc33dd44";
const ALL_KEYS = [KEY_ONE, KEY_TWO, KEY_THREE, ACCOUNT_KEY];

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
if [ "$1" = service ] && [ "$2" = inspect ]; then
	[ "$FAKE_MODE" = service ] || [ "$FAKE_MODE" = global ] || exit 1
	case "$*" in
		*Replicated.Replicas*) [ "$FAKE_MODE" = global ] || echo 1 ;;
	esac
	exit 0
fi
if [ "$1" = service ] && [ "$2" = scale ]; then
	case "$3" in
		*=0) echo false > "$state/running" ;;
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
		esac
		;;
esac
exec "$REAL_JQ" "$@"
`;

type Run = {
	status: number | null;
	stdout: string;
	stderr: string;
	calls: string[];
};

let workDir: string;
let binDir: string;
let stateDir: string;
let acmeDir: string;
let acmeFile: string;

const writeExecutable = (file: string, content: string) => {
	writeFileSync(file, content);
	chmodSync(file, 0o755);
};

const setupBin = (withJq: boolean) => {
	rmSync(binDir, { recursive: true, force: true });
	mkdirSync(binDir);
	for (const tool of TOOLS) {
		const found = which(tool);
		if (found) {
			symlinkSync(found, path.join(binDir, tool));
		}
	}
	writeExecutable(path.join(binDir, "docker"), FAKE_DOCKER);
	writeExecutable(path.join(binDir, "sudo"), '#!/bin/sh\nexec "$@"\n');
	if (withJq && REAL_JQ) {
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

const run = (
	shell: string,
	domains: string[],
	options: {
		phase?: "all" | "prepare" | "apply";
		env?: Record<string, string>;
	} = {},
): Run => {
	const script = buildAcmeDeleteScript({
		acmeFile,
		domains,
		timestamp: "20261012T101500Z",
		phase: options.phase ?? "all",
		pollSeconds: 0,
		waitSeconds: 3,
	});
	const result = spawnSync(shell, ["-c", script], {
		encoding: "utf8",
		env: {
			PATH: binDir,
			FAKE_STATE: stateDir,
			FAKE_ACME: acmeFile,
			REAL_JQ: REAL_JQ ?? "",
			...options.env,
		} as unknown as NodeJS.ProcessEnv,
	});
	const callsFile = path.join(stateDir, "calls");
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		calls: existsSync(callsFile)
			? readFileSync(callsFile, "utf8").split("\n").filter(Boolean)
			: [],
	};
};

const backups = () =>
	readdirSync(acmeDir).filter((name) => name.startsWith("acme.json.bak-"));

const mode = (file: string) => statSync(file).mode & 0o777;

const expectNoKeyText = (result: Run) => {
	for (const key of ALL_KEYS) {
		expect(result.stdout).not.toContain(key);
		expect(result.stderr).not.toContain(key);
	}
};

beforeEach(() => {
	workDir = mkdtempSync(path.join(tmpdir(), "acme-delete-"));
	binDir = path.join(workDir, "bin");
	stateDir = path.join(workDir, "state");
	acmeDir = path.join(workDir, "dynamic");
	mkdirSync(stateDir);
	mkdirSync(acmeDir);
	writeFileSync(path.join(stateDir, "running"), "true\n");
	acmeFile = path.join(acmeDir, "acme.json");
	setupBin(true);
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
		expect(() =>
			buildAcmeDeleteScript({
				acmeFile,
				domains: ["a.example.com'; id; '"],
				timestamp: "20261012T101500Z",
				phase: "all",
			}),
		).toThrow();
	});

	it("never uses bash-only syntax", () => {
		const script = buildAcmeDeleteScript({
			acmeFile,
			domains: ["a.example.com"],
			timestamp: "20261012T101500Z",
			phase: "all",
		});

		expect(script).not.toMatch(/PIPESTATUS|pipefail|\[\[|\blocal\b|<\(/);
	});

	it("does not mention port 80 or an HTTP challenge", () => {
		const script = buildAcmeDeleteScript({
			acmeFile,
			domains: ["a.example.com"],
			timestamp: "20261012T101500Z",
			phase: "all",
		});

		expect(script).not.toMatch(/httpChallenge|:80\b/);
	});
});

describe.skipIf(!REAL_JQ).each(SHELLS)(
	"acme delete script under $label",
	({ path: shell }) => {
		it("deletes one certificate, keeps the others and the account", () => {
			const before = readAcme();

			const result = run(shell, ["one.example.com"]);

			expect(parseAcmeDeleteOutput(result.stdout).status).toBe("ok");
			expect(result.status).toBe(0);
			const after = readAcme();
			expect(
				after.letsencrypt.Certificates.map(
					(item: { domain: { main: string } }) => item.domain.main,
				),
			).toEqual(["two.example.com", "three.example.com"]);
			expect(after.letsencrypt.Account).toEqual(before.letsencrypt.Account);
			expect(after.letsencrypt.Certificates[0]).toEqual(
				before.letsencrypt.Certificates[1],
			);
			expectNoKeyText(result);
		});

		it("stops Traefik before the file is replaced and starts it again", () => {
			const result = run(shell, ["one.example.com"]);

			expect(
				result.calls.filter((call) => /^(stop|start) /.test(call)),
			).toEqual(["stop dokploy-traefik", "start dokploy-traefik"]);
			expect(readFileSync(path.join(stateDir, "running"), "utf8").trim()).toBe(
				"true",
			);
		});

		it("scales a swarm service to zero and back", () => {
			const result = run(shell, ["one.example.com"], {
				env: { FAKE_MODE: "service" },
			});

			expect(parseAcmeDeleteOutput(result.stdout).status).toBe("ok");
			expect(
				result.calls.filter((call) => call.startsWith("service scale")),
			).toEqual([
				"service scale dokploy-traefik=0",
				"service scale dokploy-traefik=1",
			]);
		});

		it("refuses a swarm service in global mode before changing anything", () => {
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, ["one.example.com"], {
				env: { FAKE_MODE: "global" },
			});

			expect(parseAcmeDeleteOutput(result.stdout).status).toBe(
				"unsupported_traefik_mode",
			);
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(backups()).toEqual([]);
		});

		it("deletes several certificates with one stop and one start", () => {
			const result = run(shell, ["one.example.com", "three.example.com"]);

			expect(parseAcmeDeleteOutput(result.stdout).status).toBe("ok");
			expect(
				readAcme().letsencrypt.Certificates.map(
					(item: { domain: { main: string } }) => item.domain.main,
				),
			).toEqual(["two.example.com"]);
			expect(
				result.calls.filter((call) => call.startsWith("stop ")),
			).toHaveLength(1);
			expect(
				result.calls.filter((call) => call.startsWith("start ")),
			).toHaveLength(1);
			expectNoKeyText(result);
		});

		it("writes a 600 backup that equals the original and keeps the file at 600", () => {
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, ["one.example.com"]);

			expect(backups()).toEqual(["acme.json.bak-20261012T101500Z"]);
			const backup = path.join(acmeDir, "acme.json.bak-20261012T101500Z");
			expect(readFileSync(backup, "utf8")).toBe(original);
			expect(mode(backup)).toBe(0o600);
			expect(mode(acmeFile)).toBe(0o600);
			expect(parseAcmeDeleteOutput(result.stdout).backupFile).toBe(
				"acme.json.bak-20261012T101500Z",
			);
			expect(
				readdirSync(acmeDir).filter((name) => name.includes(".new-")),
			).toEqual([]);
		});

		it("does nothing when a requested name is not in the file", () => {
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, ["one.example.com", "missing.example.com"]);

			expect(parseAcmeDeleteOutput(result.stdout).status).toBe(
				"count_mismatch",
			);
			expect(result.status).toBe(1);
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(backups()).toEqual([]);
			expect(result.calls.filter((call) => call.startsWith("stop "))).toEqual(
				[],
			);
		});

		it("does not delete an entry that only lists the name as an alternative name", () => {
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, ["www.two.example.com"]);

			expect(parseAcmeDeleteOutput(result.stdout).status).toBe(
				"count_mismatch",
			);
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
		});

		it("does nothing when the file is not valid JSON", () => {
			writeAcme(`{"letsencrypt": {"Account": "${KEY_ONE}"`);
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, ["one.example.com"]);

			expect(parseAcmeDeleteOutput(result.stdout).status).toBe("invalid_json");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(backups()).toEqual([]);
			expectNoKeyText(result);
		});

		it("says jq is missing and does not edit the file", () => {
			setupBin(false);
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, ["one.example.com"]);

			expect(parseAcmeDeleteOutput(result.stdout).status).toBe("jq_missing");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(backups()).toEqual([]);
			expect(result.calls).toEqual([]);
		});

		it("stops when the backup cannot be written", () => {
			if (process.getuid?.() === 0) {
				return;
			}
			const original = readFileSync(acmeFile, "utf8");
			chmodSync(acmeDir, 0o555);

			const result = run(shell, ["one.example.com"]);
			chmodSync(acmeDir, 0o755);

			expect(parseAcmeDeleteOutput(result.stdout).status).toBe("backup_failed");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(result.calls.filter((call) => call.startsWith("stop "))).toEqual(
				[],
			);
		});

		it("keeps the original when the certificate count does not drop as requested", () => {
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, ["one.example.com"], {
				env: { FAKE_JQ_BREAK: "count" },
			});

			expect(parseAcmeDeleteOutput(result.stdout).status).toBe("verify_failed");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(result.calls.filter((call) => call.startsWith("stop "))).toEqual(
				[],
			);
			expect(
				readdirSync(acmeDir).filter((name) => name.includes(".new-")),
			).toEqual([]);
		});

		it("keeps the original when the account section would change", () => {
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, ["one.example.com"], {
				env: { FAKE_JQ_BREAK: "account" },
			});

			expect(parseAcmeDeleteOutput(result.stdout).status).toBe("verify_failed");
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expectNoKeyText(result);
		});

		it("refuses when two entries share the requested main domain", () => {
			const document = fixture();
			document.letsencrypt.Certificates.push(
				entry("one.example.com", [], KEY_THREE),
			);
			writeAcme(document);
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, ["one.example.com"]);

			expect(parseAcmeDeleteOutput(result.stdout).status).toBe(
				"count_mismatch",
			);
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
		});

		it("restores the backup and starts Traefik when it fails to start", () => {
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, ["one.example.com"], {
				env: { FAKE_START_FAIL: "once" },
			});

			expect(parseAcmeDeleteOutput(result.stdout).status).toBe(
				"start_failed_restored",
			);
			expect(result.status).toBe(1);
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
			expect(mode(acmeFile)).toBe(0o600);
			expect(readFileSync(path.join(stateDir, "running"), "utf8").trim()).toBe(
				"true",
			);
			expectNoKeyText(result);
		});

		it("reports it when Traefik does not start even with the restored file", () => {
			const original = readFileSync(acmeFile, "utf8");

			const result = run(shell, ["one.example.com"], {
				env: { FAKE_START_FAIL: "always" },
			});

			expect(parseAcmeDeleteOutput(result.stdout).status).toBe(
				"start_failed_after_restore",
			);
			expect(readFileSync(acmeFile, "utf8")).toBe(original);
		});

		it("works in two phases for the panel host", () => {
			const prepared = run(shell, ["one.example.com"], { phase: "prepare" });

			expect(parseAcmeDeleteOutput(prepared.stdout).status).toBe("prepared");
			expect(prepared.status).toBe(0);
			expect(prepared.calls.filter((call) => call.startsWith("stop "))).toEqual(
				[],
			);
			expect(readAcme().letsencrypt.Certificates).toHaveLength(3);

			const applied = run(shell, ["one.example.com"], { phase: "apply" });

			expect(parseAcmeDeleteOutput(applied.stdout).status).toBe("ok");
			expect(readAcme().letsencrypt.Certificates).toHaveLength(2);
		});
	},
);

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
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
	parseDeletionStatus,
} from "@dokploy/server/utils/domain-overview/acme-delete";
import { afterEach, beforeEach, expect } from "vitest";

export const which = (name: string) => {
	const found = spawnSync("sh", ["-c", `command -v ${name}`], {
		encoding: "utf8",
	}).stdout.trim();
	return found || null;
};

export const REAL_JQ = which("jq");
const shellCandidates = [
	{ label: "/bin/sh", path: "/bin/sh" },
	{ label: "dash", path: which("dash") ?? "/bin/dash" },
].filter((shell) => existsSync(shell.path));

// On Debian-based systems /bin/sh is dash; running both would only repeat
// the same shell.
export const SHELLS = shellCandidates.filter(
	(shell, index) =>
		shellCandidates.findIndex(
			(other) => realpathSync(other.path) === realpathSync(shell.path),
		) === index,
);

export const TOOLS = [
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
	"ln",
	"sed",
	"cut",
	"tr",
	"head",
	"find",
	"ps",
	"sysctl",
];

export const KEY_ONE = "DUMMY-PRIVATE-KEY-ONE-0f9a8c7d6e5b4a3f";
export const KEY_TWO = "DUMMY-PRIVATE-KEY-TWO-1a2b3c4d5e6f7a8b";
export const KEY_THREE = "DUMMY-PRIVATE-KEY-THREE-9e8d7c6b5a4f3e2d";
export const ACCOUNT_KEY = "DUMMY-ACCOUNT-KEY-aa11bb22cc33dd44";
export const OTHER_ACCOUNT_KEY = "DUMMY-OTHER-ACCOUNT-KEY-55ee66ff77aa88bb";
export const ALL_KEYS = [
	KEY_ONE,
	KEY_TWO,
	KEY_THREE,
	ACCOUNT_KEY,
	OTHER_ACCOUNT_KEY,
];

export const entry = (main: string, sans: string[], key: string) => ({
	domain: { main, sans },
	certificate: Buffer.from(`certificate for ${main}`).toString("base64"),
	key,
	Store: "default",
});

export const fixture = () => ({
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

export const FAKE_DOCKER = `#!/bin/sh
state="$FAKE_STATE"
echo "$*" >> "$state/calls"
case "$FAKE_HANG" in
	"$1" | "$1 $2") exec sleep 20 ;;
esac
state_fails() {
	[ -n "$FAKE_STATE_FAILS" ] && [ -e "$state/stopped-once" ] && [ ! -e "$state/restarted" ]
}
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
		*=0) [ -z "$FAKE_MARKER" ] || cp "$FAKE_MARKER" "$state/marker-at-stop" 2>/dev/null; echo false > "$state/running"; touch "$state/stopped-once"; add_certificate; drop_certificate ;;
		*) [ -z "$FAKE_START_FAIL" ] || exit 1; touch "$state/restarted"; echo true > "$state/running" ;;
	esac
	exit 0
fi
if [ "$1" = ps ]; then
	state_fails && exit 1
	[ "$FAKE_PS_FAILS" != 1 ] || exit 1
	[ "$(cat "$state/running")" = true ] && echo abc123
	exit 0
fi
if [ "$1" = inspect ]; then
	if [ "$2" = -f ]; then state_fails && exit 1; [ "$FAKE_PS_FAILS" != 1 ] || exit 1; cat "$state/running"; exit 0; fi
	[ "$FAKE_MODE" != none ] || exit 1
	exit 0
fi
if [ "$1" = stop ]; then
	[ -z "$FAKE_MARKER" ] || cp "$FAKE_MARKER" "$state/marker-at-stop" 2>/dev/null
	touch "$state/stopped-once"
	echo false > "$state/running"
	add_certificate
	drop_certificate
	exit 0
fi
if [ "$1" = start ]; then
	[ -z "$FAKE_START_SLOW" ] || sleep 1
	ls "$(dirname "$FAKE_ACME")" > "$state/dir-at-start" 2>/dev/null
	touch "$state/restarted"
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

export const FAKE_JQ = `#!/bin/sh
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

export type Run = {
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	calls: string[];
};

export let workDir: string;
export let binDir: string;
export let stateDir: string;
export let acmeDir: string;
export let acmeFile: string;
export let lockFile: string;
export let markerFile: string;
export let backupDir: string;
export let logDir: string;

export const writeExecutable = (file: string, content: string) => {
	writeFileSync(file, content);
	chmodSync(file, 0o755);
};

export const TIMEOUT_SHIM = `#!/bin/sh
[ "$1" = -k ] && shift 2
secs=$1
shift
"$@" &
pid=$!
( sleep "$secs"; kill "$pid" 2>/dev/null ) &
guard=$!
wait "$pid"
rc=$?
kill "$guard" 2>/dev/null
[ "$rc" -gt 128 ] && exit 124
exit "$rc"
`;

export const SETSID_SHIM = `import os, sys
os.setsid()
os.execvp(sys.argv[1], sys.argv[1:])
`;

export const SLOW_LS = `#!/bin/sh
[ -z "$FAKE_LS_SLOW" ] || sleep 1
exec "$REAL_LS" "$@"
`;

export const setupBin = (options: {
	jq: boolean;
	shell: string;
	timeout?: boolean;
	setsid?: boolean;
}) => {
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
	if (options.timeout) {
		writeExecutable(path.join(binDir, "timeout"), TIMEOUT_SHIM);
	}
	const realSetsid = which("setsid");
	if (options.setsid && realSetsid) {
		symlinkSync(realSetsid, path.join(binDir, "setsid"));
	} else if (options.setsid && which("python3")) {
		writeFileSync(path.join(binDir, "setsid.py"), SETSID_SHIM);
		writeExecutable(
			path.join(binDir, "setsid"),
			`#!/bin/sh\nexec ${which("python3")} ${path.join(binDir, "setsid.py")} "$@"\n`,
		);
	}
	rmSync(path.join(binDir, "ls"), { force: true });
	writeExecutable(path.join(binDir, "ls"), SLOW_LS);
};

export const writeAcme = (document: unknown | string) => {
	writeFileSync(
		acmeFile,
		typeof document === "string" ? document : JSON.stringify(document),
	);
	chmodSync(acmeFile, 0o600);
};

export const readAcme = () => JSON.parse(readFileSync(acmeFile, "utf8"));

export const mains = (document: { letsencrypt: { Certificates: unknown[] } }) =>
	document.letsencrypt.Certificates.map(
		(item) => (item as { domain: { main: string } }).domain.main,
	);

export const targets = (...domains: string[]): AcmeDeleteTarget[] =>
	domains.map((domain) => ({ resolver: "letsencrypt", domain }));

export const scriptFor = (list: AcmeDeleteTarget[], startDelaySeconds = 0) =>
	buildAcmeDeleteScript({
		acmeFile,
		lockFile,
		markerFile,
		backupDir,
		targets: list,
		timestamp: "20261012T101500Z",
		pollSeconds: 0,
		waitSeconds: 3,
		startDelaySeconds,
	});

export const baseEnv = (extra: Record<string, string> = {}) =>
	({
		PATH: binDir,
		FAKE_STATE: stateDir,
		FAKE_ACME: acmeFile,
		REAL_JQ: REAL_JQ ?? "",
		REAL_LS: which("ls") ?? "/bin/ls",
		...extra,
	}) as unknown as NodeJS.ProcessEnv;

export const callsOf = () => {
	const callsFile = path.join(stateDir, "calls");
	return existsSync(callsFile)
		? readFileSync(callsFile, "utf8").split("\n").filter(Boolean)
		: [];
};

export const run = (
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

export const resultOf = (output: string) =>
	parseDeletionStatus(output).status as AcmeDeleteStatus | null;

export const backups = () =>
	existsSync(backupDir)
		? readdirSync(backupDir).filter((name) => name.startsWith("acme.json.bak-"))
		: [];

export const leftovers = () =>
	readdirSync(acmeDir).filter(
		(name) => name.includes(".new-") || name.includes(".restore-"),
	);

export const mode = (file: string) => statSync(file).mode & 0o777;

export const running = () =>
	readFileSync(path.join(stateDir, "running"), "utf8").trim();

export const expectNoKeyText = (result: { stdout: string; stderr: string }) => {
	for (const key of ALL_KEYS) {
		expect(result.stdout).not.toContain(key);
		expect(result.stderr).not.toContain(key);
	}
};

export const waitFor = async (check: () => boolean, ms = 15_000) => {
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
	lockFile = path.join(workDir, "acme-delete.lock");
	markerFile = path.join(workDir, "acme-delete.marker");
	backupDir = path.join(workDir, "acme-backups");
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

export const MODES = [
	{ label: "without timeout", timeout: false },
	{ label: "with timeout", timeout: true },
];

export const spawnScript = (
	shell: string,
	list: AcmeDeleteTarget[],
	env: Record<string, string> = {},
	delay = 0,
) => {
	const child: ChildProcess = spawn(shell, ["-c", scriptFor(list, delay)], {
		env: baseEnv(env),
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const state = { output: "" };
	child.stdout?.on("data", (chunk) => {
		state.output += chunk.toString();
	});
	const exited = new Promise<void>((resolve) =>
		child.on("close", () => resolve()),
	);
	return { child, state, exited };
};

export const fastScript = (list: AcmeDeleteTarget[], extra = {}) =>
	buildAcmeDeleteScript({
		acmeFile,
		lockFile,
		markerFile,
		backupDir,
		targets: list,
		timestamp: "20261012T101500Z",
		pollSeconds: 0,
		waitSeconds: 1,
		dockerSeconds: 2,
		stopSeconds: 2,
		...extra,
	});

export const runFast = (
	shell: string,
	list: AcmeDeleteTarget[],
	env: Record<string, string> = {},
	extra = {},
) => {
	const started = Date.now();
	const result = spawnSync(shell, ["-c", fastScript(list, extra)], {
		encoding: "utf8",
		env: baseEnv(env),
		timeout: 60_000,
	});
	return {
		status: result.status,
		stdout: result.stdout,
		calls: callsOf(),
		seconds: (Date.now() - started) / 1000,
	};
};

export const markerText = () => readFileSync(markerFile, "utf8");

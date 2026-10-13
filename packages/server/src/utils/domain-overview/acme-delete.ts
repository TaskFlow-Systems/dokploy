import { shellQuote } from "./acme";
import {
	DOCKER_FUNCTIONS,
	LOCK_FUNCTIONS,
	TIMEOUT_SETUP,
} from "./acme-delete-shell";

export const TRAEFIK_RESOURCE_NAME = "dokploy-traefik";
export const ACME_DELETE_MAX_DOMAINS = 50;
export const ACME_DELETE_KEEP_FILES = 5;
export const ACME_DELETE_LOCK_NAME = "acme-delete.lock";
export const ACME_DELETE_MARKER_NAME = "acme-delete.marker";
export const ACME_BACKUP_DIR_NAME = "acme-backups";
const LOG_NAME = "acme-delete-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}\\.log";
export const ACME_DELETE_LOG_PATTERN = LOG_NAME;
const LOG_FILE = /^acme-delete-\d{8}T\d{6}Z-[0-9a-f]{6}\.log$/;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_NAME = new RegExp(`^(?:\\*\\.)?(?:${LABEL}\\.)+${LABEL}$`);
const RESOLVER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const TIMESTAMP = /^\d{8}T\d{6}Z$/;
const RUN_ID = /^[0-9a-f]{6}$/;

export const isValidCertificateDomain = (name: string) =>
	name.length <= 253 && DOMAIN_NAME.test(name);

export const isValidResolverName = (name: string) => RESOLVER_NAME.test(name);

export const isValidDeletionLogFile = (name: string) => LOG_FILE.test(name);

export const formatBackupTimestamp = (date: Date) =>
	date
		.toISOString()
		.replace(/\.\d{3}Z$/, "Z")
		.replace(/[-:]/g, "");

export type AcmeDeleteStatus =
	| "ok"
	| "busy"
	| "jq_missing"
	| "no_file"
	| "invalid_json"
	| "count_mismatch"
	| "traefik_not_running"
	| "traefik_state_unknown"
	| "docker_unavailable"
	| "deadline_exceeded"
	| "marker_failed"
	| "unsupported_traefik_mode"
	| "backup_failed"
	| "verify_failed"
	| "stop_failed"
	| "move_failed"
	| "start_failed_restored"
	| "start_failed_after_restore"
	| "start_failed_restore_failed"
	| "interrupted"
	| "log_dir_failed"
	| "launch_failed";

export type AcmeDeleteTarget = { resolver: string; domain: string };

export type AcmeDeleteScriptOptions = {
	acmeFile: string;
	lockFile: string;
	markerFile: string;
	backupDir: string;
	targets: AcmeDeleteTarget[];
	timestamp: string;
	waitSeconds?: number;
	pollSeconds?: number;
	startDelaySeconds?: number;
	dockerSeconds?: number;
	stopSeconds?: number;
	deadlineSeconds?: number;
};

const dirnameOf = (file: string) => {
	const index = file.lastIndexOf("/");
	return index > 0 ? file.slice(0, index) : ".";
};

const wholeSeconds = (value: number | undefined, fallback: number) =>
	Math.max(1, Math.floor(value ?? fallback));

const assertSafePath = (value: string, suffix: string, what: string) => {
	if (
		!value.startsWith("/") ||
		!value.endsWith(suffix) ||
		/[\0\n]/.test(value)
	) {
		throw new Error(`Invalid ${what}`);
	}
};

// The names are validated against hostname and resolver patterns before they
// reach this function, so the JSON contains no quote or backslash. Everything
// that reads or edits the storage file happens after Traefik has stopped:
// Traefik rewrites the file while it runs, so an earlier copy would be stale.
// Backups live outside the Traefik directory the file editor can open.
export const buildAcmeDeleteScript = (options: AcmeDeleteScriptOptions) => {
	const { acmeFile, lockFile, markerFile, backupDir, targets, timestamp } =
		options;
	if (!TIMESTAMP.test(timestamp)) {
		throw new Error("Invalid backup timestamp");
	}
	if (
		targets.length === 0 ||
		!targets.every(
			(item) =>
				isValidCertificateDomain(item.domain) &&
				isValidResolverName(item.resolver),
		)
	) {
		throw new Error("Invalid certificate domain");
	}
	assertSafePath(lockFile, `/${ACME_DELETE_LOCK_NAME}`, "lock file");
	assertSafePath(markerFile, `/${ACME_DELETE_MARKER_NAME}`, "marker file");
	assertSafePath(backupDir, `/${ACME_BACKUP_DIR_NAME}`, "backup directory");
	const pairs = JSON.stringify(
		targets.map((item) => ({ r: item.resolver, m: item.domain })),
	);
	const wait = wholeSeconds(options.waitSeconds, 60);
	const poll = Math.max(0, options.pollSeconds ?? 1);
	const delay = Math.max(0, Math.floor(options.startDelaySeconds ?? 0));

	return `
umask 077
ACME=${shellQuote(acmeFile)}
ACME_DIR=${shellQuote(dirnameOf(acmeFile))}
LOCK=${shellQuote(lockFile)}
MARKER=${shellQuote(markerFile)}
BACKUP_DIR=${shellQuote(backupDir)}
DEL=${shellQuote(pairs)}
EXPECTED=${targets.length}
TS=${shellQuote(timestamp)}
TRAEFIK=${shellQuote(TRAEFIK_RESOURCE_NAME)}
WAIT_SECONDS=${wait}
POLL_SECONDS=${poll}
START_DELAY=${delay}
DOCKER_SECONDS=${wholeSeconds(options.dockerSeconds, 20)}
STOP_SECONDS=${wholeSeconds(options.stopSeconds, 60)}
DEADLINE_SECONDS=${wholeSeconds(options.deadlineSeconds, 300)}
KEEP_FILES=${ACME_DELETE_KEEP_FILES}
BAK="$BACKUP_DIR/acme.json.bak-$TS"
NEW="$ACME.new-$TS"
RESTORE="$ACME.restore-$TS"
OUT="$LOCK.out.$$"
KIND=none
REPLICAS=1
STOPPED=0
HAVE_LOCK=0
RESULT_DONE=0
COMPLETED=0
CHILD=""
MYOWNER=""
TMPLOCK=""
DEADLINE_AT=$(($(date +%s) + DEADLINE_SECONDS))
${TIMEOUT_SETUP}
${LOCK_FUNCTIONS}
${DOCKER_FUNCTIONS}
HIT='def hit($r): (.domain.main // "" | ascii_downcase) as $m | any($del[]; .r == $r and .m == $m);'
COUNT_PROG="$HIT"' [to_entries[] | .key as $r | .value | objects | (.Certificates // [])[] | select(hit($r))] | length'
TOTAL_PROG='[to_entries[] | .value | objects | (.Certificates // [])[]] | length'
EDIT_PROG="$HIT"' with_entries(.key as $r | if (.value | type) == "object" and (.value.Certificates | type) == "array" then .value.Certificates |= map(select(hit($r) | not)) else . end)'
REST_PROG='with_entries(if (.value | type) == "object" then .value |= del(.Certificates) else . end)'

finish() {
	RESULT_DONE=1
	echo "DOKPLOY_RESULT $1"
	[ "$1" = ok ] && exit 0
	exit 1
}

check_deadline() {
	[ "$(date +%s)" -lt "$DEADLINE_AT" ] || finish deadline_exceeded
}

release_lock() {
	[ "$HAVE_LOCK" = 1 ] || return 0
	if [ "$(cat "$LOCK" 2>/dev/null)" = "$MYOWNER" ]; then
		rm -f "$LOCK" 2>/dev/null
	fi
}

cleanup() {
	trap ':' HUP INT TERM
	[ -z "$CHILD" ] || kill "$CHILD" 2>/dev/null
	if [ "$STOPPED" = 1 ]; then
		traefik_start || echo "DOKPLOY_NOTE traefik_not_restarted"
	fi
	rm -f "$NEW" "$RESTORE" "$OUT" "$OUT.rc" "$TMPLOCK" 2>/dev/null
	release_lock
	if [ "$RESULT_DONE" != 1 ]; then
		if [ "$COMPLETED" = 1 ]; then
			echo "DOKPLOY_RESULT ok"
		else
			echo "DOKPLOY_RESULT interrupted"
		fi
	fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

take_lock() {
	ps_start="$(proc_start $$)"
	[ -n "$ps_start" ] || ps_start=none
	MYOWNER="$$ $ps_start $(boot_id)"
	TMPLOCK="$LOCK.tmp.$$"
	( echo "$MYOWNER" > "$TMPLOCK" ) 2>/dev/null || finish busy
	if ln "$TMPLOCK" "$LOCK" 2>/dev/null; then
		HAVE_LOCK=1
		return 0
	fi
	lock_state
	if [ "$LOCK_STATE" = stale ] && release_stale_lock && ln "$TMPLOCK" "$LOCK" 2>/dev/null; then
		HAVE_LOCK=1
		return 0
	fi
	finish busy
}

write_marker() {
	( printf 'kind=%s\\nreplicas=%s\\nts=%s\\nphase=%s\\nbackup=%s\\n' "$KIND" "$REPLICAS" "$TS" "$1" "$2" > "$MARKER.tmp.$$" ) 2>/dev/null && mv -f "$MARKER.tmp.$$" "$MARKER" 2>/dev/null
}

ensure_backup_dir() {
	mkdir -p "$BACKUP_DIR" 2>/dev/null && chmod 700 "$BACKUP_DIR" 2>/dev/null && [ -d "$BACKUP_DIR" ] && [ -w "$BACKUP_DIR" ]
}

check_file() {
	jq -e 'type == "object"' "$ACME" >/dev/null 2>&1 || finish invalid_json
	matched="$(jq --argjson del "$DEL" "$COUNT_PROG" "$ACME" 2>/dev/null)" || finish invalid_json
	[ "$matched" = "$EXPECTED" ] || finish count_mismatch
}

prune_backups() {
	ls -1 "$BACKUP_DIR" 2>/dev/null | grep -E '^acme\\.json\\.bak-[0-9]{8}T[0-9]{6}Z$' | sort -r | tail -n +$((KEEP_FILES + 1)) | while read -r old; do
		case "$old" in
			acme.json.bak-*) rm -f "$BACKUP_DIR/$old" 2>/dev/null ;;
		esac
	done
}

echo "DOKPLOY_STARTED"
take_lock
command -v jq >/dev/null 2>&1 || finish jq_missing
[ -f "$ACME" ] || finish no_file
ensure_backup_dir || finish backup_failed
check_deadline
detect_traefik
check_file
if [ "$KIND" != none ]; then
	traefik_state
	case "$STATE" in
		running) ;;
		stopped) finish traefik_not_running ;;
		*) finish traefik_state_unknown ;;
	esac
fi
check_deadline
echo "DOKPLOY_PRECHECK ok"
[ "$START_DELAY" -le 0 ] || sleep "$START_DELAY"
check_deadline

if [ "$KIND" != none ]; then
	write_marker stopping "" || finish marker_failed
	STOPPED=1
	traefik_stop || finish stop_failed
fi

check_deadline
check_file
before="$(jq "$TOTAL_PROG" "$ACME" 2>/dev/null)"
[ ! -e "$BAK" ] || finish backup_failed
if ! ( umask 077; cp "$ACME" "$BAK" ) 2>/dev/null || ! chmod 600 "$BAK" 2>/dev/null; then
	rm -f "$BAK" 2>/dev/null
	finish backup_failed
fi
if command -v cmp >/dev/null 2>&1 && ! cmp -s "$ACME" "$BAK"; then
	rm -f "$BAK" 2>/dev/null
	finish backup_failed
fi
echo "DOKPLOY_BACKUP $(basename "$BAK")"
[ "$KIND" = none ] || write_marker stopped "$BAK"
( set -C; umask 077; jq --argjson del "$DEL" "$EDIT_PROG" "$ACME" > "$NEW" ) 2>/dev/null || finish verify_failed
jq -e . "$NEW" >/dev/null 2>&1 || finish verify_failed
after="$(jq "$TOTAL_PROG" "$NEW" 2>/dev/null)"
case "$before:$after" in
	*[!0-9:]* | :* | *:) finish verify_failed ;;
esac
[ $((before - after)) -eq "$EXPECTED" ] || finish verify_failed
[ "$(jq -c "$REST_PROG" "$ACME" 2>/dev/null)" = "$(jq -c "$REST_PROG" "$NEW" 2>/dev/null)" ] || finish verify_failed
chmod 600 "$NEW" 2>/dev/null || finish verify_failed
owner="$(stat -c '%u:%g' "$ACME" 2>/dev/null || stat -f '%u:%g' "$ACME" 2>/dev/null)"
[ -z "$owner" ] || chown "$owner" "$NEW" 2>/dev/null || true
mv -f "$NEW" "$ACME" 2>/dev/null || finish move_failed
[ "$KIND" = none ] || write_marker edited "$BAK"

if traefik_start; then
	COMPLETED=1
	prune_backups
	finish ok
fi
if ( umask 077; cp "$BAK" "$RESTORE" ) 2>/dev/null && chmod 600 "$RESTORE" 2>/dev/null && mv -f "$RESTORE" "$ACME" 2>/dev/null; then
	if traefik_start; then
		finish start_failed_restored
	fi
	finish start_failed_after_restore
fi
finish start_failed_restore_failed
`;
};

export type DeletionStatusFile = {
	busy: boolean;
	stale: boolean;
	logFile: string | null;
	status: AcmeDeleteStatus | null;
	backupFile: string | null;
	prechecked: boolean;
	marker: { kind: string; phase: string } | null;
};

export const buildDeletionStatusCommand = (options: {
	logDir: string;
	lockFile: string;
	markerFile: string;
	logFile?: string;
}) => {
	if (options.logFile !== undefined && !LOG_FILE.test(options.logFile)) {
		throw new Error("Invalid log file name");
	}
	return [
		`LOGDIR=${shellQuote(options.logDir)}`,
		`LOCK=${shellQuote(options.lockFile)}`,
		`MARKER=${shellQuote(options.markerFile)}`,
		LOCK_FUNCTIONS,
		"lock_state",
		'if [ "$LOCK_STATE" = held ]; then echo "DOKPLOY_LOCK 1"; else echo "DOKPLOY_LOCK 0"; fi',
		'[ "$LOCK_STATE" != stale ] || echo "DOKPLOY_STALE 1"',
		'if [ -f "$MARKER" ]; then',
		`\tmk="$(sed -n 's/^kind=\\([a-z]*\\)$/\\1/p' "$MARKER" 2>/dev/null | head -n 1)"`,
		`\tmp="$(sed -n 's/^phase=\\([a-z]*\\)$/\\1/p' "$MARKER" 2>/dev/null | head -n 1)"`,
		'\techo "DOKPLOY_MARKER ${mk:-unknown} ${mp:-unknown}"',
		"fi",
		options.logFile
			? `latest=${shellQuote(options.logFile)}; [ -f "$LOGDIR/$latest" ] || latest=""`
			: [
					'latest=""',
					`for f in $(ls -1t "$LOGDIR" 2>/dev/null | grep -E '^${LOG_NAME}$'); do`,
					`\tif grep -q '^DOKPLOY_RESULT busy$' "$LOGDIR/$f" 2>/dev/null; then continue; fi`,
					'\tlatest="$f"',
					"\tbreak",
					"done",
				].join("\n"),
		'if [ -n "$latest" ]; then',
		'echo "DOKPLOY_LOGFILE $latest"',
		"grep -E '^DOKPLOY_(RESULT|BACKUP|PRECHECK|NOTE) ' \"$LOGDIR/$latest\" 2>/dev/null",
		"fi",
		"exit 0",
	].join("\n");
};

export const parseDeletionStatus = (stdout: string): DeletionStatusFile => {
	const parsed: DeletionStatusFile = {
		busy: false,
		stale: false,
		logFile: null,
		status: null,
		backupFile: null,
		prechecked: false,
		marker: null,
	};
	for (const line of stdout.split("\n")) {
		const lock = line.match(/^DOKPLOY_LOCK ([01])$/);
		if (lock) {
			parsed.busy = lock[1] === "1";
		}
		if (line === "DOKPLOY_STALE 1") {
			parsed.stale = true;
		}
		const marker = line.match(/^DOKPLOY_MARKER ([a-z]+) ([a-z]+)$/);
		if (marker) {
			parsed.marker = { kind: marker[1] ?? "", phase: marker[2] ?? "" };
		}
		const log = line.match(/^DOKPLOY_LOGFILE (\S+)$/);
		if (log && LOG_FILE.test(log[1] ?? "")) {
			parsed.logFile = log[1] ?? null;
		}
		const result = line.match(/^DOKPLOY_RESULT ([a-z_]+)$/);
		if (result) {
			parsed.status = result[1] as AcmeDeleteStatus;
		}
		const backup = line.match(
			/^DOKPLOY_BACKUP (acme\.json\.bak-\d{8}T\d{6}Z)$/,
		);
		if (backup) {
			parsed.backupFile = backup[1] ?? null;
		}
		if (line === "DOKPLOY_PRECHECK ok") {
			parsed.prechecked = true;
		}
	}
	return parsed;
};

export type DeletionState =
	| "in_progress"
	| "succeeded"
	| "failed"
	| "interrupted";

// A log without a result and without a running script means the script was
// killed before it could write one.
export const deletionState = (
	parsed: DeletionStatusFile,
): DeletionState | null => {
	if (!parsed.logFile) {
		return null;
	}
	if (parsed.status === "busy") {
		return null;
	}
	if (parsed.status) {
		return parsed.status === "ok" ? "succeeded" : "failed";
	}
	return parsed.busy ? "in_progress" : "interrupted";
};

export const deletionTime = (logFile: string) => {
	const match = logFile.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
	return match
		? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`
		: null;
};

// Nothing stays attached to the caller (no stdin, stdout or stderr): an open
// exec channel or pipe keeps the caller waiting, and a dropped channel must
// not take the script with it. setsid puts the script in its own session so a
// kill of the caller's process group does not reach it; without setsid only
// the hangup is ignored. The log name carries a random part so two launches
// in the same second cannot share a log.
export const buildDeletionLauncher = (options: {
	script: string;
	logDir: string;
	timestamp: string;
	runId: string;
}) => {
	if (!TIMESTAMP.test(options.timestamp) || !RUN_ID.test(options.runId)) {
		throw new Error("Invalid backup timestamp");
	}
	const logName = `acme-delete-${options.timestamp}-${options.runId}.log`;
	return [
		`LOGDIR=${shellQuote(options.logDir)}`,
		`LOG="$LOGDIR/${logName}"`,
		`SCRIPT=${shellQuote(options.script)}`,
		"prune_logs() {",
		"\tfor kind in busy other; do",
		`\t\tfor f in $(ls -1t "$LOGDIR" 2>/dev/null | grep -E '^${LOG_NAME}$'); do`,
		`\t\t\tif grep -q '^DOKPLOY_RESULT busy$' "$LOGDIR/$f" 2>/dev/null; then c=busy; else c=other; fi`,
		'\t\t\t[ "$c" = "$kind" ] && echo "$f"',
		`\t\tdone | tail -n +${ACME_DELETE_KEEP_FILES + 1} | while read -r old; do`,
		'\t\t\tcase "$old" in acme-delete-*.log) rm -f "$LOGDIR/$old" 2>/dev/null ;; esac',
		"\t\tdone",
		"\tdone",
		"}",
		'mkdir -p "$LOGDIR" 2>/dev/null && [ -d "$LOGDIR" ] && [ -w "$LOGDIR" ] || { echo "DOKPLOY_RESULT log_dir_failed"; exit 1; }',
		'( umask 077; set -C; : > "$LOG" ) 2>/dev/null || { echo "DOKPLOY_RESULT log_dir_failed"; exit 1; }',
		"if command -v setsid >/dev/null 2>&1; then",
		'\tsetsid nohup sh -c "$SCRIPT" > "$LOG" 2>&1 < /dev/null &',
		"else",
		'\tnohup sh -c "$SCRIPT" > "$LOG" 2>&1 < /dev/null &',
		"fi",
		"i=0",
		'while [ "$i" -lt 15 ]; do',
		'\tif grep -q "^DOKPLOY_STARTED" "$LOG" 2>/dev/null; then',
		"\t\tprune_logs",
		`\t\techo "DOKPLOY_LAUNCHED ${logName}"`,
		"\t\texit 0",
		"\tfi",
		"\ti=$((i + 1))",
		"\tsleep 1",
		"done",
		'echo "DOKPLOY_RESULT launch_failed"',
		"exit 1",
	].join("\n");
};

export type ClearLockOutcome = {
	status: "cleared" | "none" | "alive" | "failed";
	traefik: "running" | "stopped" | "unknown" | "absent";
};

const MINIMAL_FINISH = `
finish() {
	echo "DOKPLOY_RESULT $1"
	exit 0
}
`;

// Removes a lock file whose owner is gone. It refuses while the recorded
// process is alive, and reports Traefik's state so the operator knows whether
// the interrupted run left it stopped.
export const buildClearStaleLockCommand = (options: {
	lockFile: string;
	markerFile: string;
	dockerSeconds?: number;
}) => {
	assertSafePath(options.lockFile, `/${ACME_DELETE_LOCK_NAME}`, "lock file");
	return `
umask 077
LOCK=${shellQuote(options.lockFile)}
MARKER=${shellQuote(options.markerFile)}
TRAEFIK=${shellQuote(TRAEFIK_RESOURCE_NAME)}
DOCKER_SECONDS=${wholeSeconds(options.dockerSeconds, 20)}
STOP_SECONDS=60
WAIT_SECONDS=1
POLL_SECONDS=0
KIND=none
REPLICAS=1
STOPPED=0
CHILD=""
OUT="$LOCK.out.$$"
${TIMEOUT_SETUP}
${LOCK_FUNCTIONS}
${DOCKER_FUNCTIONS}
${MINIMAL_FINISH}
trap 'rm -f "$OUT" "$OUT.rc"' EXIT
report_traefik() {
	detect_traefik
	if [ "$KIND" = none ]; then
		echo "DOKPLOY_TRAEFIK absent"
		return 0
	fi
	traefik_state
	echo "DOKPLOY_TRAEFIK $STATE"
}
lock_state
case "$LOCK_STATE" in
	free) outcome=none ;;
	held) outcome=alive ;;
	*)
		if release_stale_lock; then outcome=cleared; else outcome=failed; fi
		;;
esac
echo "DOKPLOY_LOCKCLEAR $outcome"
report_traefik
exit 0
`;
};

export const parseClearLockOutcome = (stdout: string): ClearLockOutcome => {
	const outcome: ClearLockOutcome = { status: "failed", traefik: "unknown" };
	for (const line of stdout.split("\n")) {
		const clear = line.match(/^DOKPLOY_LOCKCLEAR (cleared|none|alive|failed)$/);
		if (clear) {
			outcome.status = clear[1] as ClearLockOutcome["status"];
		}
		const state = line.match(
			/^DOKPLOY_TRAEFIK (running|stopped|unknown|absent)$/,
		);
		if (state) {
			outcome.traefik = state[1] as ClearLockOutcome["traefik"];
		}
	}
	return outcome;
};

export type RecoveryStatus =
	| "recovered"
	| "recovered_restored"
	| "already_running"
	| "no_marker"
	| "invalid_marker"
	| "busy"
	| "docker_unavailable"
	| "recovery_failed";

export type TraefikRecoveryOptions = {
	acmeFile: string;
	lockFile: string;
	markerFile: string;
	backupDir: string;
	waitSeconds?: number;
	pollSeconds?: number;
	dockerSeconds?: number;
	stopSeconds?: number;
};

// Starts Traefik again after a run that was killed hard (SIGKILL, OOM, panel
// restart, reboot) between the stop and the start. It only acts on the state
// the marker recorded, refuses while a live script owns the lock, and puts the
// post-stop backup back only when the edited file was already in place and
// Traefik still does not start.
export const buildTraefikRecoveryScript = (options: TraefikRecoveryOptions) => {
	assertSafePath(options.lockFile, `/${ACME_DELETE_LOCK_NAME}`, "lock file");
	assertSafePath(
		options.markerFile,
		`/${ACME_DELETE_MARKER_NAME}`,
		"marker file",
	);
	assertSafePath(
		options.backupDir,
		`/${ACME_BACKUP_DIR_NAME}`,
		"backup directory",
	);
	return `
umask 077
ACME=${shellQuote(options.acmeFile)}
LOCK=${shellQuote(options.lockFile)}
MARKER=${shellQuote(options.markerFile)}
BACKUP_DIR=${shellQuote(options.backupDir)}
TRAEFIK=${shellQuote(TRAEFIK_RESOURCE_NAME)}
WAIT_SECONDS=${wholeSeconds(options.waitSeconds, 60)}
POLL_SECONDS=${Math.max(0, options.pollSeconds ?? 1)}
DOCKER_SECONDS=${wholeSeconds(options.dockerSeconds, 20)}
STOP_SECONDS=${wholeSeconds(options.stopSeconds, 60)}
KIND=none
REPLICAS=1
STOPPED=0
HAVE_LOCK=0
CHILD=""
MYOWNER=""
TMPLOCK=""
RESTORE="$ACME.restore-recovery"
OUT="$LOCK.out.$$"
${TIMEOUT_SETUP}
${LOCK_FUNCTIONS}
${DOCKER_FUNCTIONS}
finish() {
	echo "DOKPLOY_RESULT $1"
	case "$1" in recovered | recovered_restored | already_running) exit 0 ;; esac
	exit 1
}
cleanup() {
	trap ':' HUP INT TERM
	[ -z "$CHILD" ] || kill "$CHILD" 2>/dev/null
	rm -f "$OUT" "$OUT.rc" "$TMPLOCK" "$RESTORE" 2>/dev/null
	if [ "$HAVE_LOCK" = 1 ] && [ "$(cat "$LOCK" 2>/dev/null)" = "$MYOWNER" ]; then
		rm -f "$LOCK" 2>/dev/null
	fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

[ -f "$MARKER" ] || finish no_marker
lock_state
[ "$LOCK_STATE" != held ] || finish busy
ps_start="$(proc_start $$)"
[ -n "$ps_start" ] || ps_start=none
MYOWNER="$$ $ps_start $(boot_id)"
TMPLOCK="$LOCK.tmp.$$"
( echo "$MYOWNER" > "$TMPLOCK" ) 2>/dev/null || finish busy
if ! ln "$TMPLOCK" "$LOCK" 2>/dev/null; then
	if [ "$LOCK_STATE" = stale ] && release_stale_lock && ln "$TMPLOCK" "$LOCK" 2>/dev/null; then
		:
	else
		finish busy
	fi
fi
HAVE_LOCK=1

KIND="$(sed -n 's/^kind=//p' "$MARKER" 2>/dev/null | head -n 1)"
REPLICAS="$(sed -n 's/^replicas=//p' "$MARKER" 2>/dev/null | head -n 1)"
PHASE="$(sed -n 's/^phase=//p' "$MARKER" 2>/dev/null | head -n 1)"
BACKUP_NAME="$(sed -n 's/^backup=//p' "$MARKER" 2>/dev/null | head -n 1)"
BACKUP_NAME="$(basename "$BACKUP_NAME" 2>/dev/null)"
case "$KIND" in container | service) ;; *) finish invalid_marker ;; esac
case "$REPLICAS" in '' | *[!0-9]*) finish invalid_marker ;; esac
case "$BACKUP_NAME" in acme.json.bak-????????T??????Z) ;; *) BACKUP_NAME="" ;; esac
dk "$DOCKER_SECONDS" info --format '{{.ID}}' || finish docker_unavailable
traefik_state
if [ "$STATE" = running ]; then
	rm -f "$MARKER" 2>/dev/null
	finish already_running
fi
[ "$STATE" = stopped ] || finish docker_unavailable
if traefik_start; then
	finish recovered
fi
if [ "$PHASE" = edited ] && [ -n "$BACKUP_NAME" ] && [ -f "$BACKUP_DIR/$BACKUP_NAME" ]; then
	if ( cp "$BACKUP_DIR/$BACKUP_NAME" "$RESTORE" ) 2>/dev/null && chmod 600 "$RESTORE" 2>/dev/null && mv -f "$RESTORE" "$ACME" 2>/dev/null; then
		if traefik_start; then
			finish recovered_restored
		fi
	fi
fi
finish recovery_failed
`;
};

export const parseRecoveryStatus = (stdout: string): RecoveryStatus | null => {
	const match = stdout.match(
		/^DOKPLOY_RESULT (recovered|recovered_restored|already_running|no_marker|invalid_marker|busy|docker_unavailable|recovery_failed)$/m,
	);
	return (match?.[1] as RecoveryStatus | undefined) ?? null;
};

export const RECOVERY_MESSAGES: Record<RecoveryStatus, string> = {
	recovered: "Traefik was started again.",
	recovered_restored:
		"Traefik did not start with the edited file. The backup was restored and Traefik was started again.",
	already_running:
		"Traefik is already running. The leftover marker was removed.",
	no_marker: "There is nothing to recover on this server.",
	invalid_marker:
		"The recovery marker could not be read. Start dokploy-traefik by hand and remove the marker file.",
	busy: "A certificate deletion is still running on this server.",
	docker_unavailable:
		"Docker did not answer, so Traefik was not touched. Try again in a moment.",
	recovery_failed:
		"Traefik could not be started. Check docker ps and the Traefik log on the server.",
};

export const ACME_DELETE_MESSAGES: Record<AcmeDeleteStatus, string> = {
	ok: "The certificates were removed and Traefik is running again.",
	busy: "Another certificate deletion is running on this server.",
	jq_missing:
		"jq is not installed on this server, so the certificate file cannot be edited safely. Nothing was changed.",
	no_file: "The ACME certificate file was not found. Nothing was changed.",
	invalid_json:
		"The ACME certificate file is not valid JSON. Nothing was changed.",
	count_mismatch:
		"The certificate file does not hold exactly the requested certificates. Nothing was changed.",
	traefik_not_running:
		"Traefik is not running on this server, so it was left alone. Nothing was changed.",
	traefik_state_unknown:
		"Docker did not say whether Traefik is running, so nothing was changed.",
	docker_unavailable: "Docker did not answer in time, so nothing was changed.",
	deadline_exceeded:
		"The deletion took longer than its time limit. The original file was not changed and Traefik was started again.",
	marker_failed:
		"The recovery marker could not be written, so Traefik was not stopped. Nothing was changed.",
	unsupported_traefik_mode:
		"Traefik runs as a swarm service that cannot be stopped by scaling. Nothing was changed.",
	backup_failed:
		"The backup of the certificate file could not be made. The original file was not changed and Traefik was started again.",
	verify_failed:
		"The edited certificate file failed its checks. The original file was not changed and Traefik was started again.",
	stop_failed:
		"Traefik could not be stopped. The original file was not changed and Traefik was started again.",
	move_failed:
		"The edited file could not be put in place. The original file was not changed and Traefik was started again.",
	start_failed_restored:
		"Traefik did not start with the edited file. The backup was restored and Traefik was started again.",
	start_failed_after_restore:
		"Traefik did not start with the edited file. The backup was restored, but Traefik still does not start. Check it with docker ps and the Traefik log.",
	start_failed_restore_failed:
		"Traefik did not start and the backup could not be restored automatically. Restore the backup file by hand and start dokploy-traefik.",
	interrupted:
		"The deletion was interrupted. Check that Traefik is running and look at the backup file before trying again.",
	log_dir_failed:
		"The log directory could not be used, so nothing was started. Nothing was changed.",
	launch_failed: "The deletion did not start. Nothing was changed.",
};

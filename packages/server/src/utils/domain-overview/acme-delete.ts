import { shellQuote } from "./acme";

export const TRAEFIK_RESOURCE_NAME = "dokploy-traefik";
export const ACME_DELETE_MAX_DOMAINS = 50;
export const ACME_DELETE_KEEP_FILES = 5;
export const ACME_DELETE_LOCK_NAME = "acme-delete.lock";
export const ACME_DELETE_LOG_PATTERN = "acme-delete-[0-9]{8}T[0-9]{6}Z\\.log";

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_NAME = new RegExp(`^(?:\\*\\.)?(?:${LABEL}\\.)+${LABEL}$`);
const RESOLVER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const TIMESTAMP = /^\d{8}T\d{6}Z$/;

export const isValidCertificateDomain = (name: string) =>
	name.length <= 253 && DOMAIN_NAME.test(name);

export const isValidResolverName = (name: string) => RESOLVER_NAME.test(name);

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
	lockDir: string;
	targets: AcmeDeleteTarget[];
	timestamp: string;
	waitSeconds?: number;
	pollSeconds?: number;
	startDelaySeconds?: number;
};

const dirnameOf = (file: string) => {
	const index = file.lastIndexOf("/");
	return index > 0 ? file.slice(0, index) : ".";
};

// The names are validated against hostname and resolver patterns before they
// reach this function, so the JSON contains no quote or backslash. Everything
// that reads or edits the storage file happens after Traefik has stopped:
// Traefik rewrites the file while it runs, so an earlier copy would be stale.
export const buildAcmeDeleteScript = (options: AcmeDeleteScriptOptions) => {
	const { acmeFile, lockDir, targets, timestamp } = options;
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
	if (!lockDir.endsWith(`/${ACME_DELETE_LOCK_NAME}`)) {
		throw new Error("Invalid lock directory");
	}
	const pairs = JSON.stringify(
		targets.map((item) => ({ r: item.resolver, m: item.domain })),
	);
	const wait = Math.max(1, Math.floor(options.waitSeconds ?? 60));
	const poll = Math.max(0, options.pollSeconds ?? 1);
	const delay = Math.max(0, Math.floor(options.startDelaySeconds ?? 0));

	return `
ACME=${shellQuote(acmeFile)}
ACME_DIR=${shellQuote(dirnameOf(acmeFile))}
LOCK=${shellQuote(lockDir)}
DEL=${shellQuote(pairs)}
EXPECTED=${targets.length}
TS=${shellQuote(timestamp)}
TRAEFIK=${shellQuote(TRAEFIK_RESOURCE_NAME)}
WAIT_SECONDS=${wait}
POLL_SECONDS=${poll}
START_DELAY=${delay}
KEEP_FILES=${ACME_DELETE_KEEP_FILES}
BAK="$ACME.bak-$TS"
NEW="$ACME.new-$TS"
RESTORE="$ACME.restore-$TS"
KIND=none
REPLICAS=1
STOPPED=0
HAVE_LOCK=0
RESULT_DONE=0
if [ "$(id -u)" -eq 0 ] || ! command -v sudo >/dev/null 2>&1; then SUDO=""; else SUDO="sudo"; fi

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

traefik_running() {
	case "$KIND" in
		service) [ -n "$($SUDO docker ps -q --filter "label=com.docker.swarm.service.name=$TRAEFIK" --filter status=running 2>/dev/null)" ] ;;
		container) [ "$($SUDO docker inspect -f '{{.State.Running}}' "$TRAEFIK" 2>/dev/null)" = true ] ;;
		*) return 1 ;;
	esac
}

traefik_stop() {
	case "$KIND" in
		service) $SUDO docker service scale "$TRAEFIK=0" >/dev/null 2>&1 ;;
		container) $SUDO docker stop "$TRAEFIK" >/dev/null 2>&1 ;;
		*) return 0 ;;
	esac || return 1
	i=0
	while traefik_running; do
		i=$((i + 1))
		[ "$i" -le "$WAIT_SECONDS" ] || return 1
		sleep "$POLL_SECONDS"
	done
}

traefik_start() {
	case "$KIND" in
		service) $SUDO docker service scale "$TRAEFIK=$REPLICAS" >/dev/null 2>&1 ;;
		container) $SUDO docker start "$TRAEFIK" >/dev/null 2>&1 ;;
		*) return 0 ;;
	esac || return 1
	i=0
	until traefik_running; do
		i=$((i + 1))
		[ "$i" -le "$WAIT_SECONDS" ] || return 1
		sleep "$POLL_SECONDS"
	done
	sleep "$POLL_SECONDS"
	traefik_running || return 1
	STOPPED=0
}

prune_backups() {
	[ -n "$ACME_DIR" ] || return 0
	ls -1 "$ACME_DIR" 2>/dev/null | grep -E '^acme\\.json\\.bak-[0-9]{8}T[0-9]{6}Z$' | sort -r | tail -n +$((KEEP_FILES + 1)) | while read -r old; do
		case "$old" in
			acme.json.bak-*) rm -f "$ACME_DIR/$old" 2>/dev/null ;;
		esac
	done
}

cleanup() {
	trap - EXIT HUP INT TERM
	if [ "$STOPPED" = 1 ]; then
		traefik_start || echo "DOKPLOY_NOTE traefik_not_restarted"
	fi
	rm -f "$NEW" "$RESTORE" 2>/dev/null
	if [ "$HAVE_LOCK" = 1 ]; then
		rm -f "$LOCK/pid" 2>/dev/null
		rmdir "$LOCK" 2>/dev/null
	fi
	[ "$RESULT_DONE" = 1 ] || echo "DOKPLOY_RESULT interrupted"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

take_lock() {
	if ! mkdir "$LOCK" 2>/dev/null; then
		holder="$(cat "$LOCK/pid" 2>/dev/null)"
		if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
			finish busy
		fi
		rm -f "$LOCK/pid" 2>/dev/null
		rmdir "$LOCK" 2>/dev/null
		mkdir "$LOCK" 2>/dev/null || finish busy
	fi
	HAVE_LOCK=1
	echo "$$" > "$LOCK/pid"
}

detect_traefik() {
	if $SUDO docker service inspect "$TRAEFIK" >/dev/null 2>&1; then
		KIND=service
		REPLICAS="$($SUDO docker service inspect -f '{{.Spec.Mode.Replicated.Replicas}}' "$TRAEFIK" 2>/dev/null)"
		case "$REPLICAS" in
			'' | *[!0-9]*) finish unsupported_traefik_mode ;;
		esac
	elif $SUDO docker inspect "$TRAEFIK" >/dev/null 2>&1; then
		KIND=container
	else
		KIND=none
	fi
}

check_file() {
	jq -e 'type == "object"' "$ACME" >/dev/null 2>&1 || finish invalid_json
	matched="$(jq --argjson del "$DEL" "$COUNT_PROG" "$ACME" 2>/dev/null)" || finish invalid_json
	[ "$matched" = "$EXPECTED" ] || finish count_mismatch
}

echo "DOKPLOY_STARTED"
take_lock
command -v jq >/dev/null 2>&1 || finish jq_missing
[ -f "$ACME" ] || finish no_file
detect_traefik
check_file
if [ "$KIND" != none ] && ! traefik_running; then
	finish traefik_not_running
fi
echo "DOKPLOY_PRECHECK ok"
[ "$START_DELAY" -le 0 ] || sleep "$START_DELAY"

if [ "$KIND" != none ]; then
	STOPPED=1
	traefik_stop || finish stop_failed
fi

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

if traefik_start; then
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
	logFile: string | null;
	status: AcmeDeleteStatus | null;
	backupFile: string | null;
	prechecked: boolean;
};

export const buildDeletionStatusCommand = (logDir: string, lockDir: string) =>
	[
		`LOGDIR=${shellQuote(logDir)}`,
		`LOCK=${shellQuote(lockDir)}`,
		"busy=0",
		'holder="$(cat "$LOCK/pid" 2>/dev/null)"',
		'if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then busy=1; fi',
		'echo "DOKPLOY_LOCK $busy"',
		`latest="$(ls -1 "$LOGDIR" 2>/dev/null | grep -E '^${ACME_DELETE_LOG_PATTERN}$' | sort | tail -n 1)"`,
		'if [ -n "$latest" ]; then',
		'echo "DOKPLOY_LOGFILE $latest"',
		"grep -E '^DOKPLOY_(RESULT|BACKUP|PRECHECK|NOTE) ' \"$LOGDIR/$latest\" 2>/dev/null",
		"fi",
		"exit 0",
	].join("\n");

export const parseDeletionStatus = (stdout: string): DeletionStatusFile => {
	const parsed: DeletionStatusFile = {
		busy: false,
		logFile: null,
		status: null,
		backupFile: null,
		prechecked: false,
	};
	for (const line of stdout.split("\n")) {
		const lock = line.match(/^DOKPLOY_LOCK ([01])$/);
		if (lock) {
			parsed.busy = lock[1] === "1";
		}
		const log = line.match(/^DOKPLOY_LOGFILE (acme-delete-\d{8}T\d{6}Z\.log)$/);
		if (log) {
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
	if (parsed.status === "busy" && parsed.busy) {
		return "in_progress";
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
// not take the script with it. The log is checked before and after the start.
export const buildDeletionLauncher = (options: {
	script: string;
	logDir: string;
	timestamp: string;
}) => {
	if (!TIMESTAMP.test(options.timestamp)) {
		throw new Error("Invalid backup timestamp");
	}
	const logName = `acme-delete-${options.timestamp}.log`;
	return [
		`LOGDIR=${shellQuote(options.logDir)}`,
		`LOG="$LOGDIR/${logName}"`,
		`SCRIPT=${shellQuote(options.script)}`,
		"prune_logs() {",
		`\tls -1 "$LOGDIR" 2>/dev/null | grep -E '^${ACME_DELETE_LOG_PATTERN}$' | sort -r | tail -n +${ACME_DELETE_KEEP_FILES + 1} | while read -r old; do`,
		'\t\tcase "$old" in acme-delete-*.log) rm -f "$LOGDIR/$old" 2>/dev/null ;; esac',
		"\tdone",
		"}",
		'mkdir -p "$LOGDIR" 2>/dev/null && [ -d "$LOGDIR" ] && [ -w "$LOGDIR" ] || { echo "DOKPLOY_RESULT log_dir_failed"; exit 1; }',
		'( umask 077; : > "$LOG" ) 2>/dev/null || { echo "DOKPLOY_RESULT log_dir_failed"; exit 1; }',
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

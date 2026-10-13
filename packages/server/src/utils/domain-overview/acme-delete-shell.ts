// Shell fragments shared by the deletion script, the status command and the
// recovery commands. They are plain POSIX sh and rely on the caller to define
// finish(), LOCK, MARKER, OUT, TRAEFIK and the timing variables.

export const LOCK_FUNCTIONS = `
proc_start() {
	if [ -r "/proc/$1/stat" ]; then
		sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f20
	else
		ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' '_'
	fi
}

boot_id() {
	b=""
	if [ -r /proc/sys/kernel/random/boot_id ]; then
		b="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"
	else
		b="$(sysctl -n kern.boottime 2>/dev/null | tr -s ' ,{}=' '_')"
	fi
	[ -n "$b" ] || b=none
	echo "$b"
}

pid_alive() {
	kill -0 "$1" 2>/dev/null || [ -d "/proc/$1" ]
}

lock_state() {
	LOCK_STATE=free
	LOCK_OWNER=""
	[ -e "$LOCK" ] || return 0
	LOCK_OWNER="$(cat "$LOCK" 2>/dev/null)"
	set -- $LOCK_OWNER
	l_pid="$1"
	l_start="$2"
	l_boot="$3"
	case "$l_pid" in
		'' | *[!0-9]*)
			if [ -n "$(find "$LOCK" -mmin +1 2>/dev/null)" ]; then LOCK_STATE=stale; else LOCK_STATE=held; fi
			return 0
			;;
	esac
	if [ "$l_boot" != "$(boot_id)" ]; then
		LOCK_STATE=stale
		return 0
	fi
	if ! pid_alive "$l_pid"; then
		LOCK_STATE=stale
		return 0
	fi
	if [ "$l_start" != none ] && [ "$l_start" != "$(proc_start "$l_pid")" ]; then
		LOCK_STATE=stale
		return 0
	fi
	LOCK_STATE=held
}

release_stale_lock() {
	seen="$LOCK_OWNER"
	STALE_COPY="$LOCK.stale.$$"
	mv "$LOCK" "$STALE_COPY" 2>/dev/null || return 1
	if [ "$(cat "$STALE_COPY" 2>/dev/null)" = "$seen" ]; then
		rm -f "$STALE_COPY" 2>/dev/null
		return 0
	fi
	ln "$STALE_COPY" "$LOCK" 2>/dev/null
	rm -f "$STALE_COPY" 2>/dev/null
	return 1
}

create_lock() {
	ln "$TMPLOCK" "$LOCK" 2>/dev/null && return 0
	[ ! -e "$LOCK" ] && ( set -C; echo "$MYOWNER" > "$LOCK" ) 2>/dev/null
}

take_lock() {
	ps_start="$(proc_start $$)"
	[ -n "$ps_start" ] || ps_start=none
	MYOWNER="$$ $ps_start $(boot_id)"
	TMPLOCK="$LOCK.tmp.$$"
	( echo "$MYOWNER" > "$TMPLOCK" ) 2>/dev/null || return 1
	if create_lock; then
		HAVE_LOCK=1
		return 0
	fi
	lock_state
	if [ "$LOCK_STATE" = stale ] && release_stale_lock && create_lock; then
		HAVE_LOCK=1
		return 0
	fi
	return 1
}

release_lock() {
	[ "$HAVE_LOCK" = 1 ] || return 0
	if [ "$(cat "$LOCK" 2>/dev/null)" = "$MYOWNER" ]; then
		rm -f "$LOCK" 2>/dev/null
	fi
	HAVE_LOCK=0
}

sweep_leftovers() {
	for f in "$LOCK".tmp.[0-9]* "$LOCK".out.[0-9]* "$LOCK".stale.[0-9]* "$MARKER".tmp.[0-9]* "$ACME".new-[0-9]*Z "$ACME".restore-*; do
		[ "$f" != "$TMPLOCK" ] && [ -f "$f" ] && rm -f "$f" 2>/dev/null
	done
	return 0
}

file_id() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" 2>/dev/null | cut -d' ' -f1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1
	elif command -v openssl >/dev/null 2>&1; then
		openssl dgst -sha256 "$1" 2>/dev/null | sed 's/^.*= *//'
	else
		f_stat="$(stat -c '%s-%Y' "$1" 2>/dev/null || stat -f '%z-%m' "$1" 2>/dev/null)"
		[ -z "$f_stat" ] || echo "stat:$f_stat"
	fi
}
`;

export const DOCKER_FUNCTIONS = `
nap() {
	if [ "$DK_I" -le 25 ]; then
		sleep 0.02 2>/dev/null || sleep 1
	else
		sleep 0.2 2>/dev/null || sleep 1
	fi
}

dk_launch() {
	DK_SECS="$1"
	shift
	rm -f "$OUT.rc" "$OUT.pid" 2>/dev/null
	if [ -n "$TO" ]; then
		( $TO "$DK_SECS" $SUDO docker "$@" >"$OUT" 2>/dev/null & echo $! >"$OUT.pid"; wait $!; echo $? >"$OUT.rc" ) &
		DK_END=$(($(date +%s) + DK_SECS + 4))
	else
		( $SUDO docker "$@" >"$OUT" 2>/dev/null & echo $! >"$OUT.pid"; wait $!; echo $? >"$OUT.rc" ) &
		DK_END=$(($(date +%s) + DK_SECS + 1))
	fi
	CHILD=$!
}

dk_wait() {
	DK_I=0
	until [ -s "$OUT.rc" ]; do
		if [ "$(date +%s)" -ge "$DK_END" ]; then
			k_pid="$(cat "$OUT.pid" 2>/dev/null)"
			case "$k_pid" in
				'' | *[!0-9]*) ;;
				*) kill "$k_pid" 2>/dev/null ;;
			esac
			kill "$CHILD" 2>/dev/null
			CHILD=""
			return 124
		fi
		DK_I=$((DK_I + 1))
		nap
	done
	wait "$CHILD" 2>/dev/null
	CHILD=""
	DK_RC="$(cat "$OUT.rc" 2>/dev/null)"
	case "$DK_RC" in
		'' | *[!0-9]*) DK_RC=124 ;;
	esac
	return "$DK_RC"
}

dk() {
	dk_launch "$@"
	dk_wait
}

dk_settle() {
	[ -n "$CHILD" ] || return 0
	c_end=$(($(date +%s) + CLEANUP_WAIT))
	[ "$DK_END" -le "$c_end" ] || DK_END="$c_end"
	dk_wait
}

traefik_state() {
	STATE=unknown
	case "$KIND" in
		service)
			dk "$DOCKER_SECONDS" ps -q --filter "label=com.docker.swarm.service.name=$TRAEFIK" --filter status=running || return 0
			if [ -s "$OUT" ]; then STATE=running; else STATE=stopped; fi
			;;
		container)
			dk "$DOCKER_SECONDS" inspect -f '{{.State.Running}}' "$TRAEFIK" || return 0
			case "$(cat "$OUT" 2>/dev/null)" in
				true) STATE=running ;;
				false) STATE=stopped ;;
			esac
			;;
	esac
	return 0
}

wait_state() {
	w_want="$1"
	w_end="$2"
	while :; do
		traefik_state
		[ "$STATE" = "$w_want" ] && return 0
		[ "$(date +%s)" -lt "$w_end" ] || return 1
		sleep "$POLL_SECONDS"
	done
}

detect_traefik() {
	dk "$DOCKER_SECONDS" info --format '{{.ID}}' || finish docker_unavailable
	dk "$DOCKER_SECONDS" service inspect "$TRAEFIK"
	rc=$?
	[ "$rc" -lt 124 ] || finish docker_unavailable
	if [ "$rc" -eq 0 ]; then
		KIND=service
		dk "$DOCKER_SECONDS" service inspect -f '{{.Spec.Mode.Replicated.Replicas}}' "$TRAEFIK" || finish docker_unavailable
		REPLICAS="$(cat "$OUT" 2>/dev/null)"
		case "$REPLICAS" in
			'' | *[!0-9]*) finish unsupported_traefik_mode ;;
		esac
		return 0
	fi
	dk "$DOCKER_SECONDS" inspect "$TRAEFIK"
	rc=$?
	[ "$rc" -lt 124 ] || finish docker_unavailable
	if [ "$rc" -eq 0 ]; then KIND=container; else KIND=none; fi
}

traefik_stop() {
	case "$KIND" in
		service) dk "$STOP_SECONDS" service scale "$TRAEFIK=0" ;;
		container) dk "$STOP_SECONDS" stop "$TRAEFIK" ;;
		*) return 0 ;;
	esac
	w_cap=$(($(date +%s) + WAIT_SECONDS))
	[ "$w_cap" -le "$DEADLINE_AT" ] || w_cap="$DEADLINE_AT"
	wait_state stopped "$w_cap"
}

traefik_start() {
	case "$KIND" in
		service) dk "$STOP_SECONDS" service scale "$TRAEFIK=$REPLICAS" ;;
		container) dk "$STOP_SECONDS" start "$TRAEFIK" ;;
		*) return 0 ;;
	esac
	s_rc=$?
	traefik_state
	if [ "$STATE" != running ]; then
		[ "$s_rc" -eq 0 ] || return 1
		wait_state running $(($(date +%s) + WAIT_SECONDS)) || return 1
	fi
	sleep "$SETTLE_SECONDS"
	traefik_state
	[ "$STATE" = running ] || return 1
	STOPPED=0
	rm -f "$MARKER" 2>/dev/null
	return 0
}
`;

export const TIMEOUT_SETUP = `
TO=""
if command -v timeout >/dev/null 2>&1; then TO="timeout -k 2"; fi
if [ "$(id -u)" -eq 0 ] || ! command -v sudo >/dev/null 2>&1; then SUDO=""; else SUDO="sudo"; fi
`;

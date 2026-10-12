import { shellQuote } from "./acme";

export const TRAEFIK_RESOURCE_NAME = "dokploy-traefik";
export const ACME_DELETE_MAX_DOMAINS = 50;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_NAME = new RegExp(`^(?:\\*\\.)?(?:${LABEL}\\.)+${LABEL}$`);
const TIMESTAMP = /^\d{8}T\d{6}Z$/;

export const isValidCertificateDomain = (name: string) =>
	name.length <= 253 && DOMAIN_NAME.test(name);

export const formatBackupTimestamp = (date: Date) =>
	date
		.toISOString()
		.replace(/\.\d{3}Z$/, "Z")
		.replace(/[-:]/g, "");

export type AcmeDeleteStatus =
	| "ok"
	| "jq_missing"
	| "no_file"
	| "invalid_json"
	| "count_mismatch"
	| "unsupported_traefik_mode"
	| "backup_failed"
	| "verify_failed"
	| "apply_missing_files"
	| "stop_failed"
	| "move_failed"
	| "start_failed_restored"
	| "start_failed_after_restore"
	| "start_failed_restore_failed"
	| "prepared";

export type AcmeDeletePhase = "all" | "prepare" | "apply";

export type AcmeDeleteScriptOptions = {
	acmeFile: string;
	domains: string[];
	timestamp: string;
	phase: AcmeDeletePhase;
	waitSeconds?: number;
	pollSeconds?: number;
	startDelaySeconds?: number;
};

// The domains are validated against a hostname pattern before they reach this
// function, so the JSON array contains no quote or backslash.
export const buildAcmeDeleteScript = (options: AcmeDeleteScriptOptions) => {
	const { acmeFile, domains, timestamp, phase } = options;
	if (!TIMESTAMP.test(timestamp)) {
		throw new Error("Invalid backup timestamp");
	}
	if (domains.length === 0 || !domains.every(isValidCertificateDomain)) {
		throw new Error("Invalid certificate domain");
	}
	const domainsJson = JSON.stringify(domains);
	const wait = Math.max(1, Math.floor(options.waitSeconds ?? 60));
	const poll = Math.max(0, options.pollSeconds ?? 1);
	const delay = Math.max(0, Math.floor(options.startDelaySeconds ?? 0));

	return `
ACME=${shellQuote(acmeFile)}
DOMAINS=${shellQuote(domainsJson)}
EXPECTED=${domains.length}
TS=${shellQuote(timestamp)}
TRAEFIK=${shellQuote(TRAEFIK_RESOURCE_NAME)}
PHASE=${shellQuote(phase)}
WAIT_SECONDS=${wait}
POLL_SECONDS=${poll}
START_DELAY=${delay}
BAK="$ACME.bak-$TS"
NEW="$ACME.new-$TS"
RESTORE="$ACME.restore-$TS"
KIND=none
REPLICAS=1
if [ "$(id -u)" -eq 0 ] || ! command -v sudo >/dev/null 2>&1; then SUDO=""; else SUDO="sudo"; fi

finish() {
	echo "DOKPLOY_RESULT $1"
	[ "$1" = ok ] || [ "$1" = prepared ] || exit 1
	exit 0
}

drop_new() {
	rm -f "$NEW" 2>/dev/null
	finish "$1"
}

detect_traefik() {
	if $SUDO docker service inspect "$TRAEFIK" >/dev/null 2>&1; then
		KIND=service
		REPLICAS="$($SUDO docker service inspect -f '{{.Spec.Mode.Replicated.Replicas}}' "$TRAEFIK" 2>/dev/null)"
		case "$REPLICAS" in
			'' | *[!0-9]* | 0) finish unsupported_traefik_mode ;;
		esac
	elif $SUDO docker inspect "$TRAEFIK" >/dev/null 2>&1; then
		KIND=container
	else
		KIND=none
	fi
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
	[ "$KIND" != none ] || return 0
	i=0
	until traefik_running; do
		i=$((i + 1))
		[ "$i" -le "$WAIT_SECONDS" ] || return 1
		sleep "$POLL_SECONDS"
	done
	sleep "$POLL_SECONDS"
	traefik_running
}

prepare() {
	command -v jq >/dev/null 2>&1 || finish jq_missing
	[ -f "$ACME" ] || finish no_file
	jq -e '.letsencrypt.Certificates | type == "array"' "$ACME" >/dev/null 2>&1 || finish invalid_json
	detect_traefik
	matched="$(jq --argjson del "$DOMAINS" '[.letsencrypt.Certificates[] | select((.domain.main // "" | ascii_downcase) as $m | any($del[]; . == $m))] | length' "$ACME" 2>/dev/null)" || finish invalid_json
	[ "$matched" = "$EXPECTED" ] || finish count_mismatch
	before="$(jq '.letsencrypt.Certificates | length' "$ACME" 2>/dev/null)"
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
	( set -C; umask 077; jq --argjson del "$DOMAINS" '.letsencrypt.Certificates |= map(select((.domain.main // "" | ascii_downcase) as $m | any($del[]; . == $m) | not))' "$ACME" > "$NEW" ) 2>/dev/null || drop_new verify_failed
	jq -e . "$NEW" >/dev/null 2>&1 || drop_new verify_failed
	after="$(jq '.letsencrypt.Certificates | length' "$NEW" 2>/dev/null)"
	case "$before:$after" in
		*[!0-9:]* | :* | *:) drop_new verify_failed ;;
	esac
	[ $((before - after)) -eq "$EXPECTED" ] || drop_new verify_failed
	[ "$(jq -c 'del(.letsencrypt.Certificates)' "$ACME" 2>/dev/null)" = "$(jq -c 'del(.letsencrypt.Certificates)' "$NEW" 2>/dev/null)" ] || drop_new verify_failed
	chmod 600 "$NEW" 2>/dev/null || drop_new verify_failed
	owner="$(stat -c '%u:%g' "$ACME" 2>/dev/null || stat -f '%u:%g' "$ACME" 2>/dev/null)"
	[ -z "$owner" ] || chown "$owner" "$NEW" 2>/dev/null || true
}

apply() {
	[ -f "$NEW" ] && [ -f "$BAK" ] || finish apply_missing_files
	detect_traefik
	[ "$START_DELAY" -le 0 ] || sleep "$START_DELAY"
	if ! traefik_stop; then
		traefik_start || true
		drop_new stop_failed
	fi
	if ! mv -f "$NEW" "$ACME" 2>/dev/null; then
		traefik_start || true
		drop_new move_failed
	fi
	if traefik_start; then
		finish ok
	fi
	if ( umask 077; cp "$BAK" "$RESTORE" ) 2>/dev/null && chmod 600 "$RESTORE" 2>/dev/null && mv -f "$RESTORE" "$ACME" 2>/dev/null; then
		if traefik_start; then
			finish start_failed_restored
		fi
		finish start_failed_after_restore
	fi
	rm -f "$RESTORE" 2>/dev/null
	finish start_failed_restore_failed
}

case "$PHASE" in
	prepare) prepare; finish prepared ;;
	apply) apply ;;
	*) prepare; apply ;;
esac
`;
};

export type AcmeDeleteOutcome = {
	status: AcmeDeleteStatus | null;
	backupFile: string | null;
};

export const parseAcmeDeleteOutput = (stdout: string): AcmeDeleteOutcome => {
	let status: AcmeDeleteStatus | null = null;
	let backupFile: string | null = null;
	for (const line of stdout.split("\n")) {
		const result = line.match(/^DOKPLOY_RESULT ([a-z_]+)$/);
		if (result) {
			status = result[1] as AcmeDeleteStatus;
		}
		const backup = line.match(
			/^DOKPLOY_BACKUP (acme\.json\.bak-\d{8}T\d{6}Z)$/,
		);
		if (backup) {
			backupFile = backup[1] ?? null;
		}
	}
	return { status, backupFile };
};

export const ACME_DELETE_MESSAGES: Record<AcmeDeleteStatus, string> = {
	ok: "The certificates were removed and Traefik is running again.",
	prepared: "The new certificate file is ready.",
	jq_missing:
		"jq is not installed on this server, so the certificate file cannot be edited safely. Nothing was changed.",
	no_file: "The ACME certificate file was not found. Nothing was changed.",
	invalid_json:
		"The ACME certificate file is not valid JSON. Nothing was changed.",
	count_mismatch:
		"The certificate file does not hold exactly the requested certificates. Nothing was changed.",
	unsupported_traefik_mode:
		"Traefik runs as a swarm service that cannot be stopped by scaling. Nothing was changed.",
	backup_failed:
		"The backup of the certificate file could not be made. Nothing was changed.",
	verify_failed:
		"The edited certificate file failed its checks. The original file was not changed.",
	apply_missing_files:
		"The prepared files are missing. The original file was not changed.",
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
};

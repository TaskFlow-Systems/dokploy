import { quoteShellArg } from "../filesystem/safe-path";

// The script's PID goes to the panel through stdout, so the output has to stay
// on a pipe. Without pipefail that line reports the status of tee, and a script
// that failed or was killed counts as a success.
const SCRIPT_PIPELINE = quoteShellArg(
	'set -o pipefail; bash "$1" 2>&1 | tee -a "$2"',
);

export const buildServerScheduleCommand = (
	scriptPath: string,
	logPath: string,
) => {
	const quotedLogPath = quoteShellArg(logPath);
	return `
		set -e
		echo "Running script" >> ${quotedLogPath};
		bash -c ${SCRIPT_PIPELINE} _ ${quoteShellArg(scriptPath)} ${quotedLogPath} || {
			echo "❌ Command failed" >> ${quotedLogPath};
			exit 1;
		  }
		echo "✅ Command executed successfully" >> ${quotedLogPath};
	`;
};

/**
 * Stops a schedule run: the script and every process it started, which keep
 * running after a kill of the script alone. Each process stops before its
 * children are read, so it cannot start new ones during the walk.
 *
 * The PID stays on the deployment row and may belong to another process by now,
 * so anything but a schedule script is refused. /proc also works where ps comes
 * from busybox and has no -p; ps covers systems without /proc.
 */
export const buildKillScheduleRunCommand = (pid: string) => {
	if (!/^\d+$/.test(pid)) {
		throw new Error(`Invalid PID: ${pid}`);
	}
	return `kill_tree() {
	kill -STOP "$1" 2>/dev/null
	for child in $(pgrep -P "$1" 2>/dev/null); do
		kill_tree "$child"
	done
	kill -9 "$1" 2>/dev/null
}
args=$(cat /proc/${pid}/cmdline 2>/dev/null | tr '\\0' ' ')
[ -n "$args" ] || args=$(ps -o args= -p ${pid} 2>/dev/null)
case "$args" in
	*script.sh*) kill_tree ${pid} ;;
	*)
		echo "Process ${pid} is not a schedule script" >&2
		exit 1
		;;
esac`;
};

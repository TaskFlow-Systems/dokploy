// `docker exec` creates the shell inside the container on the daemon's own time.
// A slow daemon can start it after the session has closed and the first hangup
// scan has finished, and then nothing would ever end it. So a closed session is
// scanned again a few times; the marker in the shell's environment keeps every
// scan on that one session.
export const HANGUP_SCAN_DELAYS_MS = [500, 2_000, 5_000] as const;

/**
 * Runs `scan` now and again after each delay (counted from the previous scan's
 * end), never two at once, and stops when a scan answers `false`. At most `delays.length + 1` scans run and the timers
 * do not keep the process alive. `cancel()` stops the schedule; `done` settles
 * after the last scan or after the cancel, whichever comes first.
 */
export const runHangupScans = (
	scan: () => Promise<boolean | undefined | void>,
	delays: readonly number[] = HANGUP_SCAN_DELAYS_MS,
) => {
	let cancelled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let finish!: () => void;
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});

	const step = async (index: number) => {
		if (cancelled) return;
		let usable = true;
		try {
			// A scan answering false could not run at all (dead connection).
			usable = (await scan()) !== false;
		} catch {
			// A scan that threw must not stop the next one.
		}
		const delay = delays[index];
		if (cancelled || !usable || delay === undefined) {
			finish();
			return;
		}
		timer = setTimeout(() => void step(index + 1), delay);
		timer.unref?.();
	};

	void step(0);

	return {
		done,
		cancel: () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
			finish();
		},
	};
};

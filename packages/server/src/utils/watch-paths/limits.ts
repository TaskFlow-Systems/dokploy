import { z } from "zod";

// picomatch's parse time grows with the square of the nesting of braces, and it runs on
// the event loop: a 40 000 character pattern blocked it for 9 s under Bun. Real globs
// stay far below these limits.
export const WATCH_PATH_MAX_LENGTH = 256;
export const WATCH_PATHS_MAX_COUNT = 64;

export const watchPathsSchema = z
	.array(
		z
			.string()
			.max(
				WATCH_PATH_MAX_LENGTH,
				`A watch path can have at most ${WATCH_PATH_MAX_LENGTH} characters`,
			),
	)
	.max(
		WATCH_PATHS_MAX_COUNT,
		`At most ${WATCH_PATHS_MAX_COUNT} watch paths are allowed`,
	);

export const areWatchPathsWithinLimits = (watchPaths: string[]): boolean =>
	watchPaths.length <= WATCH_PATHS_MAX_COUNT &&
	watchPaths.every((path) => path.length <= WATCH_PATH_MAX_LENGTH);

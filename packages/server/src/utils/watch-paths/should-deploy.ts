import micromatch from "micromatch";
import { areWatchPathsWithinLimits } from "./limits";

export const shouldDeploy = (
	watchPaths: string[] | null,
	modifiedFiles: (string | null | undefined)[] | null | undefined,
): boolean => {
	if (!watchPaths || watchPaths?.length === 0) return true;
	// Watch paths that cannot be evaluated must not stop deployments without a trace.
	if (!areWatchPathsWithinLimits(watchPaths)) {
		console.warn("Watch paths are over the size limits, deploying anyway");
		return true;
	}
	const files = (modifiedFiles ?? []).filter(
		(file): file is string => typeof file === "string",
	);
	try {
		return micromatch(files, watchPaths).length > 0;
	} catch (error) {
		console.warn(
			"Watch paths could not be evaluated, deploying anyway:",
			error instanceof Error ? error.message : error,
		);
		return true;
	}
};

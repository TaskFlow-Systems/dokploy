const pending = new Set<Promise<void>>();

// A notification goes out after the status it reports is written and must not
// hold what called it: a deployment's queue slot, a backup's status, a cron run
// or startup. A channel that is down is logged, not thrown.
export const notifyInBackground = (
	label: string,
	task: () => Promise<unknown> | unknown,
): void => {
	const run = (async () => {
		try {
			await task();
		} catch (error) {
			console.error(`Failed to send the ${label} notification:`, error);
		}
	})();
	pending.add(run);
	void run.finally(() => pending.delete(run));
};

export const settleBackgroundNotifications = async () => {
	await Promise.allSettled([...pending]);
};

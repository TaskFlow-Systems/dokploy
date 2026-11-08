import { logger } from "@dokploy/server/lib/logger";
import { redactSensitiveText } from "@dokploy/server/utils/security/redaction";

// node-schedule drops the promise of an async callback, so an error that leaves
// a job ends as an `unhandledRejection`; Next's process listeners keep the panel
// up, but every failing run then logs one. The `run*Backup` functions record a
// failure (deployment `error`, one failure message) and rethrow because a manual
// run needs the error, which is why this guard exists. Every async callback given
// to `scheduleJob` goes through it: it logs the error once and does not rethrow.
export const guardScheduledRun =
	(jobId: string, run: () => Promise<unknown>) => async (): Promise<void> => {
		try {
			await run();
		} catch (error) {
			logger.error(
				{
					jobId,
					error: redactSensitiveText(
						error instanceof Error ? error.message : String(error),
					),
				},
				"Scheduled job failed",
			);
		}
	};

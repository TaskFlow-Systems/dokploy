import { logger } from "@dokploy/server/lib/logger";
import { redactSensitiveText } from "@dokploy/server/utils/security/redaction";

// The `run*Backup` functions record the failure (deployment `error`, failure
// notification) and then rethrow, because the manual run needs the error. A
// scheduled job has no caller to hand it to: node-schedule drops the promise of
// an async callback, so the rethrow ended as an `unhandledRejection` for every
// failing run, kept from killing the panel only by Next's process listeners.
export const guardScheduledRun =
	(backupId: string, run: () => Promise<void>) => async (): Promise<void> => {
		try {
			await run();
		} catch (error) {
			logger.error(
				{
					backupId,
					error: redactSensitiveText(
						error instanceof Error ? error.message : String(error),
					),
				},
				"Scheduled backup failed",
			);
		}
	};

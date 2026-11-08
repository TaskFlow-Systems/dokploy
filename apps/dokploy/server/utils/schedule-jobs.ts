import { IS_CLOUD } from "@dokploy/server/constants";
import { findSchedulesByOwner } from "@dokploy/server/services/schedule";
import { removeScheduleJobsByOwner } from "@dokploy/server/utils/schedules/utils";
import { removeJob } from "@/server/utils/backup";

// Schedule rows are deleted by cascade with their owner, so the jobs have to
// be cancelled before the owner goes. A failure here must not block the delete.
export const cancelScheduleJobsByOwner = async (owner: {
	applicationId?: string;
	composeId?: string;
	serverId?: string;
}) => {
	try {
		if (!IS_CLOUD) {
			await removeScheduleJobsByOwner(owner);
			return;
		}
		for (const ownedSchedule of await findSchedulesByOwner(owner)) {
			await removeJob({
				cronSchedule: ownedSchedule.cronExpression,
				scheduleId: ownedSchedule.scheduleId,
				type: "schedule",
				timezone: ownedSchedule.timezone,
			});
		}
	} catch (error) {
		console.error("Failed to cancel schedule jobs:", error);
	}
};

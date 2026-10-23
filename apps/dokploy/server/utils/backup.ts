import {
	type BackupScheduleList,
	IS_CLOUD,
	removeScheduleBackup,
} from "@dokploy/server/index";
import {
	type ScheduledQueueJob,
	type SignedScheduledQueueJob,
	signScheduledQueueJob,
} from "@dokploy/server/utils/schedules/signed-job";

type QueueJob =
	| {
			type: "backup";
			cronSchedule: string;
			backupId: string;
	  }
	| {
			type: "server";
			cronSchedule: string;
			serverId: string;
	  }
	| {
			type: "schedule";
			cronSchedule: string;
			scheduleId: string;
			timezone?: string | null;
	  }
	| {
			type: "volume-backup";
			cronSchedule: string;
			volumeBackupId: string;
	  };

const normalizeQueueJob = (job: QueueJob): ScheduledQueueJob => {
	if (job.type === "backup") {
		return job;
	}
	if (job.type === "server") {
		return job;
	}
	if (job.type === "volume-backup") {
		return job;
	}
	return {
		type: job.type,
		cronSchedule: job.cronSchedule,
		scheduleId: job.scheduleId,
		timezone: job.timezone ?? undefined,
	};
};

const postJob = async (path: string, signedJob: SignedScheduledQueueJob) => {
	const result = await fetch(`${process.env.JOBS_URL}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-API-Key": process.env.API_KEY || "NO-DEFINED",
		},
		body: JSON.stringify(signedJob),
	});
	const data = await result.json();
	if (!result.ok) {
		throw new Error(
			`Jobs service ${path} failed (${result.status}): ${JSON.stringify(data)}`,
		);
	}
	return data;
};

export const schedule = async (job: QueueJob) =>
	postJob(
		"/create-backup",
		await signScheduledQueueJob(normalizeQueueJob(job), {
			operation: "create",
		}),
	);

export const removeJob = async (job: QueueJob) =>
	removeSignedJob(
		await signScheduledQueueJob(normalizeQueueJob(job), {
			operation: "remove",
			requireEnabled: false,
			requireActiveServer: false,
		}),
	);

export const removeSignedJob = (signedJob: SignedScheduledQueueJob) =>
	postJob("/remove-job", signedJob);

export const updateJob = async (job: QueueJob) =>
	postJob(
		"/update-backup",
		await signScheduledQueueJob(normalizeQueueJob(job), {
			operation: "update",
		}),
	);

export const cancelJobs = async (backups: BackupScheduleList) => {
	for (const backup of backups) {
		if (backup.enabled) {
			if (IS_CLOUD) {
				await removeJob({
					cronSchedule: backup.schedule,
					backupId: backup.backupId,
					type: "backup",
				});
			} else {
				removeScheduleBackup(backup.backupId);
			}
		}
	}
};

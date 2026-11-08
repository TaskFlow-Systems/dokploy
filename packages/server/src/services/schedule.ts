import path from "node:path";
import { TRPCError } from "@trpc/server";
import { eq, or } from "drizzle-orm";
import type { z } from "zod";
import { IS_CLOUD, paths } from "../constants";
import { db } from "../db";
import type {
	createScheduleSchema,
	updateScheduleSchema,
} from "../db/schema/schedule";
import { type Schedule, schedules } from "../db/schema/schedule";
import { APP_NAME_REGEX } from "../db/schema/utils";
import { encodeBase64 } from "../utils/docker/utils";
import { quoteShellArg } from "../utils/filesystem/safe-path";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";
import { findMemberByUserId } from "./permission";
import { findServerById } from "./server";

export type ScheduleExtended = Awaited<ReturnType<typeof findScheduleById>>;

export const normalizeScheduleAppName = (appName?: string | null) => {
	const safeAppName = appName?.trim() || "";
	if (
		!APP_NAME_REGEX.test(safeAppName) ||
		safeAppName === "." ||
		safeAppName === ".."
	) {
		throw new Error("Invalid schedule app name");
	}

	return safeAppName;
};

const resolveSchedulePathInsideBase = (
	basePath: string,
	...segments: string[]
) => {
	const absoluteBasePath = path.resolve(basePath);
	const fullPath = path.resolve(absoluteBasePath, ...segments);
	const relativePath = path.relative(absoluteBasePath, fullPath);
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativePath)
	) {
		throw new Error("Invalid schedule app name");
	}
	return fullPath;
};

export const getScheduleDirectory = (
	basePath: string,
	appName?: string | null,
) => resolveSchedulePathInsideBase(basePath, normalizeScheduleAppName(appName));

export const getScheduleScriptPath = (
	basePath: string,
	appName?: string | null,
) =>
	resolveSchedulePathInsideBase(
		basePath,
		normalizeScheduleAppName(appName),
		"script.sh",
	);

export const getScheduleDeploymentLogPath = (
	basePath: string,
	appName: string,
	formattedDateTime: string,
) => {
	const safeAppName = normalizeScheduleAppName(appName);
	return resolveSchedulePathInsideBase(
		basePath,
		safeAppName,
		`${safeAppName}-${formattedDateTime}.log`,
	);
};

export const buildDeleteScheduleCommand = (
	basePath: string,
	appName?: string | null,
) => `rm -rf -- ${quoteShellArg(getScheduleDirectory(basePath, appName))}`;

export const buildScheduleScriptCommand = (
	basePath: string,
	schedule: Pick<Schedule, "appName" | "scheduleId" | "script">,
) => {
	const fullPath = getScheduleDirectory(basePath, schedule.appName);
	const scriptPath = getScheduleScriptPath(basePath, schedule.appName);
	const scriptWithPid = `echo "PID: $$ | Schedule ID: ${schedule.scheduleId}"
${schedule.script || ""}`;
	const encodedContent = encodeBase64(scriptWithPid);

	return `
	 	 mkdir -p ${quoteShellArg(fullPath)}
	 	 rm -f ${quoteShellArg(scriptPath)}
		 touch ${quoteShellArg(scriptPath)}
		 chmod +x ${quoteShellArg(scriptPath)}
		 printf %s ${quoteShellArg(encodedContent)} | base64 -d > ${quoteShellArg(scriptPath)}
	`;
};
// Host-level schedules (server / dokploy-server) run their script as root on the
// host and must stay restricted to owners/admins, regardless of whether the
// request is also tied to a service. Attaching an accessible applicationId must
// not downgrade this to a service-access check.
export const assertHostScheduleAccess = async (
	ctx: { user: { id: string }; session: { activeOrganizationId: string } },
	scheduleType: Schedule["scheduleType"] | null | undefined,
	serverId: string | null | undefined,
) => {
	if (scheduleType !== "server" && scheduleType !== "dokploy-server") return;

	if (scheduleType === "dokploy-server" && IS_CLOUD) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Host-level schedules are not available in the cloud version.",
		});
	}

	const member = await findMemberByUserId(
		ctx.user.id,
		ctx.session.activeOrganizationId,
	);
	if (member.role !== "owner" && member.role !== "admin") {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Only owners and admins can manage server-level schedules.",
		});
	}

	if (scheduleType === "server" && serverId) {
		const targetServer = await findServerById(serverId);
		if (targetServer.organizationId !== ctx.session.activeOrganizationId) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You don't have access to this server.",
			});
		}
	}
};

export const createSchedule = async (
	input: z.infer<typeof createScheduleSchema>,
) => {
	const { scheduleId, ...rest } = input;
	const [newSchedule] = await db
		.insert(schedules)
		.values(rest as typeof schedules.$inferInsert)
		.returning();

	if (
		newSchedule &&
		(newSchedule.scheduleType === "dokploy-server" ||
			newSchedule.scheduleType === "server")
	) {
		await handleScript(newSchedule);
	}

	return newSchedule;
};

export const findScheduleById = async (scheduleId: string) => {
	const schedule = await db.query.schedules.findFirst({
		where: eq(schedules.scheduleId, scheduleId),
		with: {
			application: {
				columns: {
					applicationId: true,
					appName: true,
					serverId: true,
				},
				with: {
					environment: {
						with: {
							project: true,
						},
					},
				},
			},
			compose: {
				with: {
					environment: {
						with: {
							project: true,
						},
					},
				},
			},
			server: {
				with: {
					organization: true,
				},
			},
		},
	});

	if (!schedule) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Schedule not found",
		});
	}
	return schedule;
};

export const scheduleExists = async (scheduleId: string) => {
	const schedule = await db.query.schedules.findFirst({
		where: eq(schedules.scheduleId, scheduleId),
		columns: { scheduleId: true },
	});
	return !!schedule;
};

export const findSchedulesByOwner = async (owner: {
	applicationId?: string;
	composeId?: string;
	serverId?: string;
}) => {
	const conditions = [
		owner.applicationId
			? eq(schedules.applicationId, owner.applicationId)
			: undefined,
		owner.composeId ? eq(schedules.composeId, owner.composeId) : undefined,
		owner.serverId ? eq(schedules.serverId, owner.serverId) : undefined,
	].filter((condition) => condition !== undefined);
	if (conditions.length === 0) {
		return [];
	}
	return await db.query.schedules.findMany({
		where: or(...conditions),
	});
};

export const findScheduleOrganizationId = async (scheduleId: string) => {
	const schedule = await findScheduleById(scheduleId);

	if (schedule?.application) {
		return schedule?.application?.environment?.project?.organizationId;
	}
	if (schedule?.compose) {
		return schedule?.compose?.environment?.project?.organizationId;
	}
	if (schedule?.server) {
		return schedule?.server?.organization?.id;
	}
	if (schedule?.organizationId) {
		return schedule.organizationId;
	}
	return null;
};

export const deleteSchedule = async (scheduleId: string) => {
	const schedule = await findScheduleById(scheduleId);
	const serverId =
		schedule?.serverId ||
		schedule?.application?.serverId ||
		schedule?.compose?.serverId;
	const { SCHEDULES_PATH } = paths(!!serverId);

	const command = buildDeleteScheduleCommand(SCHEDULES_PATH, schedule?.appName);
	if (serverId) {
		await execAsyncRemote(serverId, command);
	} else {
		await execAsync(command);
	}

	const scheduleResult = await db
		.delete(schedules)
		.where(eq(schedules.scheduleId, scheduleId));
	if (!scheduleResult) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Schedule not found",
		});
	}

	return true;
};

export const updateSchedule = async (
	input: z.infer<typeof updateScheduleSchema>,
) => {
	const { scheduleId, ...rest } = input;
	const [updatedSchedule] = await db
		.update(schedules)
		.set(rest as Partial<typeof schedules.$inferInsert>)
		.where(eq(schedules.scheduleId, scheduleId))
		.returning();

	if (!updatedSchedule) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Schedule not found",
		});
	}

	if (
		updatedSchedule?.scheduleType === "dokploy-server" ||
		updatedSchedule?.scheduleType === "server"
	) {
		await handleScript(updatedSchedule);
	}

	return updatedSchedule;
};

const handleScript = async (schedule: Schedule) => {
	const { SCHEDULES_PATH } = paths(!!schedule?.serverId);
	const script = buildScheduleScriptCommand(SCHEDULES_PATH, schedule);

	if (schedule?.scheduleType === "dokploy-server") {
		await execAsync(script);
	} else if (schedule?.scheduleType === "server") {
		await execAsyncRemote(schedule?.serverId || "", script);
	}
};

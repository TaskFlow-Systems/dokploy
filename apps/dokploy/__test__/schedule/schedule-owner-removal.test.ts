import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createDeploymentSchedule: vi.fn(),
	findScheduleById: vi.fn(),
	findSchedulesByOwner: vi.fn(),
	scheduleExists: vi.fn(),
	jobs: {} as Record<string, { cancel: ReturnType<typeof vi.fn> }>,
	callbacks: {} as Record<string, () => Promise<void>>,
}));

vi.mock("@dokploy/server/constants", () => ({
	IS_CLOUD: false,
	paths: () => ({ SCHEDULES_PATH: "/local-schedules" }),
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	createDeploymentSchedule: mocks.createDeploymentSchedule,
	updateDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
}));

vi.mock("@dokploy/server/services/schedule", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/services/schedule")>();
	return {
		...actual,
		findScheduleById: mocks.findScheduleById,
		findSchedulesByOwner: mocks.findSchedulesByOwner,
		scheduleExists: mocks.scheduleExists,
	};
});

vi.mock("node-schedule", () => ({
	scheduledJobs: mocks.jobs,
	scheduleJob: (
		name: string,
		_spec: unknown,
		callback: () => Promise<void>,
	) => {
		mocks.callbacks[name] = callback;
		mocks.jobs[name] = { cancel: vi.fn() };
	},
}));

const { scheduleJob, removeScheduleJobsByOwner } = await import(
	"@dokploy/server/utils/schedules/utils"
);

const baseSchedule = {
	cronExpression: "* * * * *",
	timezone: null,
} as never;

describe("schedule jobs follow their schedule and owner", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		for (const key of Object.keys(mocks.jobs)) delete mocks.jobs[key];
		for (const key of Object.keys(mocks.callbacks)) delete mocks.callbacks[key];
	});

	it("cancels itself quietly when its schedule no longer exists", async () => {
		scheduleJob({ ...(baseSchedule as object), scheduleId: "gone" } as never);
		const job = mocks.jobs.gone;
		mocks.scheduleExists.mockResolvedValue(false);

		await expect(mocks.callbacks.gone?.()).resolves.toBeUndefined();

		expect(job?.cancel).toHaveBeenCalledTimes(1);
		expect(mocks.findScheduleById).not.toHaveBeenCalled();
		expect(mocks.createDeploymentSchedule).not.toHaveBeenCalled();
	});

	it("does not reject when the run itself fails", async () => {
		scheduleJob({ ...(baseSchedule as object), scheduleId: "broken" } as never);
		mocks.scheduleExists.mockResolvedValue(true);
		mocks.findScheduleById.mockRejectedValue(new Error("database down"));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(mocks.callbacks.broken?.()).resolves.toBeUndefined();

		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});

	it("cancels the jobs of every schedule an owner has", async () => {
		scheduleJob({ ...(baseSchedule as object), scheduleId: "one" } as never);
		scheduleJob({ ...(baseSchedule as object), scheduleId: "two" } as never);
		scheduleJob({ ...(baseSchedule as object), scheduleId: "other" } as never);
		mocks.findSchedulesByOwner.mockResolvedValue([
			{ scheduleId: "one" },
			{ scheduleId: "two" },
		]);

		await removeScheduleJobsByOwner({ applicationId: "app-1" });

		expect(mocks.findSchedulesByOwner).toHaveBeenCalledWith({
			applicationId: "app-1",
		});
		expect(mocks.jobs.one?.cancel).toHaveBeenCalledTimes(1);
		expect(mocks.jobs.two?.cancel).toHaveBeenCalledTimes(1);
		expect(mocks.jobs.other?.cancel).not.toHaveBeenCalled();
	});
});

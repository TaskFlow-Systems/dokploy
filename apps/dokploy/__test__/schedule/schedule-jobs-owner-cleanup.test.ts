import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	isCloud: false,
	findSchedulesByOwner: vi.fn(),
	removeScheduleJobsByOwner: vi.fn(),
	removeJob: vi.fn(),
}));

vi.mock("@dokploy/server/constants", () => ({
	get IS_CLOUD() {
		return mocks.isCloud;
	},
}));
vi.mock("@dokploy/server/services/schedule", () => ({
	findSchedulesByOwner: mocks.findSchedulesByOwner,
}));
vi.mock("@dokploy/server/utils/schedules/utils", () => ({
	removeScheduleJobsByOwner: mocks.removeScheduleJobsByOwner,
}));
vi.mock("@/server/utils/backup", () => ({ removeJob: mocks.removeJob }));

const { cancelScheduleJobsByOwner } = await import(
	"@/server/utils/schedule-jobs"
);

describe("cancelScheduleJobsByOwner", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isCloud = false;
	});

	it("cancels local jobs by owner", async () => {
		await cancelScheduleJobsByOwner({ composeId: "compose-1" });
		expect(mocks.removeScheduleJobsByOwner).toHaveBeenCalledWith({
			composeId: "compose-1",
		});
		expect(mocks.removeJob).not.toHaveBeenCalled();
	});

	it("removes the queued jobs in cloud mode", async () => {
		mocks.isCloud = true;
		mocks.findSchedulesByOwner.mockResolvedValue([
			{ scheduleId: "s1", cronExpression: "* * * * *", timezone: "UTC" },
		]);
		await cancelScheduleJobsByOwner({ serverId: "server-1" });
		expect(mocks.removeJob).toHaveBeenCalledWith({
			cronSchedule: "* * * * *",
			scheduleId: "s1",
			type: "schedule",
			timezone: "UTC",
		});
	});

	it("does not throw when cancelling fails", async () => {
		mocks.removeScheduleJobsByOwner.mockRejectedValue(new Error("db down"));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			cancelScheduleJobsByOwner({ applicationId: "app-1" }),
		).resolves.toBeUndefined();
		error.mockRestore();
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createDeploymentSchedule: vi.fn(),
	findScheduleById: vi.fn(),
	spawnAsync: vi.fn(),
	updateDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	streams: [] as Array<{
		write: ReturnType<typeof vi.fn>;
		end: ReturnType<typeof vi.fn>;
		writable: boolean;
	}>,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		createWriteStream: () => {
			const stream = {
				write: vi.fn(),
				end: vi.fn(),
				writable: true,
			};
			mocks.streams.push(stream);
			return stream;
		},
	};
});

vi.mock("@dokploy/server/constants", () => ({
	IS_CLOUD: false,
	paths: () => ({ SCHEDULES_PATH: "/local-schedules" }),
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	createDeploymentSchedule: mocks.createDeploymentSchedule,
	updateDeployment: mocks.updateDeployment,
	updateDeploymentStatus: mocks.updateDeploymentStatus,
}));

vi.mock("@dokploy/server/services/schedule", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/services/schedule")>();
	return { ...actual, findScheduleById: mocks.findScheduleById };
});

vi.mock("@dokploy/server/utils/process/spawnAsync", () => ({
	spawnAsync: mocks.spawnAsync,
}));

vi.mock("node-schedule", () => ({
	scheduledJobs: {},
	scheduleJob: vi.fn(),
}));

const { runCommand } = await import("@dokploy/server/utils/schedules/utils");

describe("host schedule run log stream", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.streams.length = 0;
		mocks.createDeploymentSchedule.mockResolvedValue({
			deploymentId: "deployment-1",
			logPath: "/tmp/host-schedule.log",
		});
		mocks.findScheduleById.mockResolvedValue({
			appName: "host-schedule",
			scheduleType: "dokploy-server",
		});
	});

	it("ends the log stream after a successful run", async () => {
		mocks.spawnAsync.mockResolvedValue(undefined);

		await expect(runCommand("schedule-1")).resolves.toMatchObject({
			status: "done",
		});

		expect(mocks.streams).toHaveLength(1);
		expect(mocks.streams[0]?.end).toHaveBeenCalledTimes(1);
	});

	it("ends the log stream after a failed run", async () => {
		mocks.spawnAsync.mockRejectedValue(new Error("script failed"));

		await expect(runCommand("schedule-1")).resolves.toMatchObject({
			status: "error",
		});

		expect(mocks.streams).toHaveLength(1);
		expect(mocks.streams[0]?.end).toHaveBeenCalledTimes(1);
	});

	it("ends the log stream when the schedule directory is invalid", async () => {
		mocks.findScheduleById.mockResolvedValue({
			appName: "../escape",
			scheduleType: "dokploy-server",
		});

		await expect(runCommand("schedule-1")).resolves.toMatchObject({
			status: "error",
		});

		expect(mocks.streams[0]?.end).toHaveBeenCalledTimes(1);
	});
});

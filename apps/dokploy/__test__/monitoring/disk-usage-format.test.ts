import { describe, expect, it } from "vitest";
import {
	DISK_CATEGORIES,
	DISK_CATEGORY_ORDER,
	describeDiskBucket,
	formatDiskBucket,
	formatDiskBytes,
	formatDiskDelta,
	formatDiskTimeTick,
	getDiskAxisTicks,
	getDiskMoverCategory,
	getDiskMoverLabel,
	getDiskTimeTicks,
} from "@/components/dashboard/monitoring/free/container/disk-usage/disk-usage-format";

const GB = 1e9;
const HOUR = 60 * 60 * 1000;
const localTime = (day: number, hour: number) =>
	new Date(2026, 9, day, hour).getTime();

describe("disk usage formatting", () => {
	it("counts in decimal units, like Docker does", () => {
		expect(formatDiskBytes(48_043_151_360)).toBe("48.0 GB");
		expect(formatDiskBytes(9_603_361_573)).toBe("9.60 GB");
		expect(formatDiskBytes(433_033_216)).toBe("433 MB");
		expect(formatDiskBytes(4096)).toBe("4 KB");
		expect(formatDiskBytes(0)).toBe("0 B");
	});

	it("signs a change and calls a rounding-sized one no change", () => {
		expect(formatDiskDelta(7.6 * GB)).toBe("+7.60 GB");
		expect(formatDiskDelta(-1.2 * GB)).toBe("−1.20 GB");
		expect(formatDiskDelta(300_000)).toBe("no change");
		expect(formatDiskDelta(0)).toBe("no change");
	});

	it("keeps the stacking order the colours were checked in", () => {
		expect(DISK_CATEGORY_ORDER).toEqual([
			"images",
			"buildCache",
			"volumes",
			"containerLogs",
			"containers",
			"dokployData",
			"swap",
			"other",
		]);
		expect(
			new Set(Object.values(DISK_CATEGORIES).map((meta) => meta.color)).size,
		).toBe(8);
	});

	it("names what a bar covers", () => {
		expect(describeDiskBucket(HOUR)).toBe("an hour");
		expect(describeDiskBucket(4 * HOUR)).toBe("4 hours");
		expect(describeDiskBucket(24 * HOUR)).toBe("a day");
		expect(formatDiskBucket(localTime(13, 16), 4 * HOUR)).toBe(
			"13 Oct, 16:00–20:00",
		);
		expect(formatDiskBucket(localTime(13, 0), 24 * HOUR)).toBe("13 Oct");
	});
});

describe("disk chart axes", () => {
	it("puts round values under the disk size", () => {
		expect(getDiskAxisTicks(52.74 * GB)).toEqual([0, 20 * GB, 40 * GB]);
		expect(getDiskAxisTicks(500 * GB)).toEqual([0, 200 * GB, 400 * GB]);
		expect(getDiskAxisTicks(0)).toEqual([0]);
	});

	it("drops a value that would sit right under the disk size", () => {
		// 100 GB would touch the "Disk size 105 GB" label.
		expect(getDiskAxisTicks(105 * GB)).toEqual([0, 50 * GB]);
	});

	it("labels every third hour of a day", () => {
		const starts = Array.from({ length: 24 }, (_, hour) => localTime(13, hour));

		expect(
			getDiskTimeTicks(starts, HOUR)?.map((from) =>
				formatDiskTimeTick(from, HOUR),
			),
		).toEqual([
			"13 Oct",
			"03:00",
			"06:00",
			"09:00",
			"12:00",
			"15:00",
			"18:00",
			"21:00",
		]);
	});

	it("labels only the midnights of a week", () => {
		const starts = Array.from({ length: 12 }, (_, index) =>
			localTime(12, index * 4),
		);

		expect(
			getDiskTimeTicks(starts, 4 * HOUR)?.map((from) =>
				formatDiskTimeTick(from, 4 * HOUR),
			),
		).toEqual(["12 Oct", "13 Oct"]);
	});

	it("leaves day-long bars to the chart", () => {
		expect(getDiskTimeTicks([localTime(13, 0)], 24 * HOUR)).toBeUndefined();
		expect(formatDiskTimeTick(localTime(13, 0), 24 * HOUR)).toBe("13 Oct");
	});
});

describe("disk movers", () => {
	it("labels an item with its kind and takes the colour of its category", () => {
		const mover = {
			kind: "containerLog" as const,
			name: "web",
			bytes: 1,
			deltaBytes: 1,
		};

		expect(getDiskMoverLabel(mover)).toEqual({
			kind: "Container logs",
			name: "web",
		});
		expect(getDiskMoverCategory(mover)).toBe("containerLogs");
	});

	it("shows a whole category by its own name", () => {
		const mover = {
			kind: "category" as const,
			name: "buildCache",
			bytes: 1,
			deltaBytes: 1,
		};

		expect(getDiskMoverLabel(mover)).toEqual({
			kind: null,
			name: "Build cache",
		});
		expect(getDiskMoverCategory(mover)).toBe("buildCache");
	});
});

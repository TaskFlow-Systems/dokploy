import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DiskUsageProbe } from "@dokploy/server/monitoring/disk-usage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	monitoringPath: "",
	getRootDiskStat: vi.fn(),
	probeDockerUsage: vi.fn(),
	probeSlowUsage: vi.fn(),
}));

vi.mock("@dokploy/server/constants", () => ({
	docker: {},
	paths: () => ({ MONITORING_PATH: mocks.monitoringPath }),
}));

vi.mock("@dokploy/server/monitoring/disk-usage", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/monitoring/disk-usage")
	>()),
	getRootDiskStat: mocks.getRootDiskStat,
	probeDockerUsage: mocks.probeDockerUsage,
	probeSlowUsage: mocks.probeSlowUsage,
}));

type DiskHistoryModule =
	typeof import("@dokploy/server/monitoring/disk-history");

const GB = 1e9;
const MB = 1e6;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TOTAL = 50 * GB;
const START = Date.UTC(2026, 9, 13, 12, 0, 0);

const diskUsed = (usedBytes: number) => {
	mocks.getRootDiskStat.mockResolvedValue({
		totalBytes: TOTAL,
		usedBytes,
		availableBytes: TOTAL - usedBytes,
	});
};

const dockerProbe = (
	images: number,
	buildCache: number,
	items: DiskUsageProbe["items"] = {},
): DiskUsageProbe => ({
	parts: { images, buildCache, containers: 0 },
	items,
	itemKinds: ["image", "container"],
});

const slowProbe = (
	volumes: number,
	items: DiskUsageProbe["items"] = {},
): DiskUsageProbe => ({
	parts: { volumes, containerLogs: 0, dokployData: 0, swap: 2 * GB },
	items,
	itemKinds: ["volume", "containerLog", "dokployData"],
});

const readLines = async (file: string) =>
	(
		await readFile(
			path.join(mocks.monitoringPath, "disk-history", file),
			"utf-8",
		)
	)
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

describe("disk history sampler", () => {
	let history: DiskHistoryModule;

	beforeEach(async () => {
		mocks.monitoringPath = await mkdtemp(path.join(tmpdir(), "disk-history-"));
		vi.clearAllMocks();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(START);
		// The sampler keeps its state on globalThis so that bundled copies share it.
		delete (globalThis as { diskHistorySampler?: unknown }).diskHistorySampler;
		vi.resetModules();
		history = await import("@dokploy/server/monitoring/disk-history");

		diskUsed(30 * GB);
		mocks.probeDockerUsage.mockResolvedValue(dockerProbe(10 * GB, 5 * GB));
		mocks.probeSlowUsage.mockResolvedValue(slowProbe(8 * GB));
	});

	afterEach(async () => {
		vi.useRealTimers();
		await rm(mocks.monitoringPath, { recursive: true, force: true });
	});

	it("saves a sample with every part and the item sizes on the first run", async () => {
		mocks.probeDockerUsage.mockResolvedValue(
			dockerProbe(10 * GB, 5 * GB, { "image:web": 4 * GB }),
		);
		mocks.probeSlowUsage.mockResolvedValue(
			slowProbe(8 * GB, { "volume:pg-data": 8 * GB }),
		);

		await history.refreshDiskUsage();

		expect(await readLines("samples.jsonl")).toEqual([
			{
				at: START,
				totalBytes: TOTAL,
				usedBytes: 30 * GB,
				images: 10 * GB,
				buildCache: 5 * GB,
				containers: 0,
				volumes: 8 * GB,
				containerLogs: 0,
				dokployData: 0,
				swap: 2 * GB,
			},
		]);
		expect(await readLines("items.jsonl")).toEqual([
			{
				at: START,
				items: { "image:web": 4 * GB, "volume:pg-data": 8 * GB },
			},
		]);
	});

	it("asks Docker every five minutes and walks the disk every hour", async () => {
		await history.refreshDiskUsage();

		for (let minute = 1; minute <= 60; minute++) {
			vi.setSystemTime(START + minute * MINUTE);
			await history.refreshDiskUsage();
		}

		expect(mocks.getRootDiskStat).toHaveBeenCalledTimes(61);
		expect(mocks.probeDockerUsage).toHaveBeenCalledTimes(13);
		expect(mocks.probeSlowUsage).toHaveBeenCalledTimes(2);
		expect(await readLines("samples.jsonl")).toHaveLength(13);
		expect(await readLines("items.jsonl")).toHaveLength(2);
	});

	it("samples right away when the used space jumps", async () => {
		await history.refreshDiskUsage();

		vi.setSystemTime(START + MINUTE);
		diskUsed(30 * GB + 100 * MB);
		await history.refreshDiskUsage();
		expect(mocks.probeDockerUsage).toHaveBeenCalledTimes(1);

		vi.setSystemTime(START + 2 * MINUTE);
		diskUsed(33 * GB);
		mocks.probeDockerUsage.mockResolvedValue(dockerProbe(13 * GB, 5 * GB));
		await history.refreshDiskUsage();

		expect(mocks.probeDockerUsage).toHaveBeenCalledTimes(2);
		// The disk was walked two minutes ago; a jump repeats that after ten.
		expect(mocks.probeSlowUsage).toHaveBeenCalledTimes(1);
		expect((await readLines("samples.jsonl")).at(-1)).toMatchObject({
			at: START + 2 * MINUTE,
			usedBytes: 33 * GB,
			images: 13 * GB,
			volumes: 8 * GB,
		});
	});

	it("waits fifty times as long as a slow probe took", async () => {
		mocks.probeDockerUsage.mockImplementation(async () => {
			vi.setSystemTime(Date.now() + 20_000);
			return dockerProbe(10 * GB, 5 * GB);
		});
		await history.refreshDiskUsage();

		for (let minute = 1; minute <= 16; minute++) {
			vi.setSystemTime(START + minute * MINUTE);
			await history.refreshDiskUsage();
		}
		expect(mocks.probeDockerUsage).toHaveBeenCalledTimes(1);

		vi.setSystemTime(START + 17 * MINUTE);
		await history.refreshDiskUsage();
		expect(mocks.probeDockerUsage).toHaveBeenCalledTimes(2);
	});

	it("keeps the last known value of a part that a probe could not read", async () => {
		await history.refreshDiskUsage();

		vi.setSystemTime(START + 5 * MINUTE);
		mocks.probeDockerUsage.mockResolvedValue({
			parts: {},
			items: {},
			itemKinds: [],
		});
		await history.refreshDiskUsage();

		expect((await readLines("samples.jsonl")).at(-1)).toMatchObject({
			at: START + 5 * MINUTE,
			images: 10 * GB,
			buildCache: 5 * GB,
		});
	});

	it("probes Docker after a cleanup even though it just did", async () => {
		await history.refreshDiskUsage();

		vi.setSystemTime(START + 10_000);
		diskUsed(25 * GB);
		mocks.probeDockerUsage.mockResolvedValue(dockerProbe(10 * GB, 0));
		await history.refreshDiskUsage({ force: true });

		expect((await readLines("samples.jsonl")).at(-1)).toMatchObject({
			usedBytes: 25 * GB,
			buildCache: 0,
		});
	});

	it("drops samples older than thirty days", async () => {
		await history.refreshDiskUsage();
		const samplesFile = path.join(
			mocks.monitoringPath,
			"disk-history",
			"samples.jsonl",
		);
		const old = { at: START - 31 * 24 * HOUR, totalBytes: TOTAL, usedBytes: 1 };
		const recent = { at: START - 24 * HOUR, totalBytes: TOTAL, usedBytes: 2 };
		await writeFile(
			samplesFile,
			`${JSON.stringify(old)}\n${JSON.stringify(recent)}\n{"at":12`,
		);

		vi.setSystemTime(START + 6 * HOUR);
		await history.refreshDiskUsage();

		expect(
			(await readLines("samples.jsonl")).map((sample) => sample.at),
		).toEqual([recent.at, START + 6 * HOUR]);
	});

	it("reports the period, what takes the space and what grew", async () => {
		mocks.probeDockerUsage.mockResolvedValue(
			dockerProbe(10 * GB, 5 * GB, {
				"image:web": 4 * GB,
				"image:api": 6 * GB,
			}),
		);
		mocks.probeSlowUsage.mockResolvedValue(
			slowProbe(8 * GB, { "volume:pg-data": 8 * GB }),
		);
		await history.refreshDiskUsage();

		vi.setSystemTime(START + 3 * HOUR);
		diskUsed(38 * GB);
		mocks.probeDockerUsage.mockResolvedValue(
			dockerProbe(13 * GB, 9 * GB, {
				"image:web": 7 * GB,
				"image:api": 6 * GB + 1 * MB,
			}),
		);
		mocks.probeSlowUsage.mockResolvedValue(
			slowProbe(9 * GB, { "volume:pg-data": 9 * GB }),
		);
		await history.refreshDiskUsage();

		const result = await history.getDiskUsageHistory("1d", 180);

		expect(result.current).toMatchObject({
			usedBytes: 38 * GB,
			totalBytes: TOTAL,
			availableBytes: 12 * GB,
			parts: {
				images: 13 * GB,
				buildCache: 9 * GB,
				volumes: 9 * GB,
				swap: 2 * GB,
				other: 5 * GB,
			},
		});
		expect(result.changeSince).toBe(START);
		expect(result.usedDeltaBytes).toBe(8 * GB);
		expect(
			Object.fromEntries(
				result.categories.map((row) => [row.category, row.deltaBytes]),
			),
		).toMatchObject({
			images: 3 * GB,
			buildCache: 4 * GB,
			volumes: 1 * GB,
			swap: 0,
			other: 0,
		});
		// Build cache has no items, so it is listed as a whole; the 1 MB of
		// "api" is below what counts as a change.
		expect(result.movers).toEqual([
			{
				kind: "category",
				name: "buildCache",
				bytes: 9 * GB,
				deltaBytes: 4 * GB,
			},
			{ kind: "image", name: "web", bytes: 7 * GB, deltaBytes: 3 * GB },
			{ kind: "volume", name: "pg-data", bytes: 9 * GB, deltaBytes: 1 * GB },
		]);

		expect(result.buckets).toHaveLength(24);
		expect(result.bucketMs).toBe(HOUR);
		const filled = result.buckets.filter((bucket) => bucket.sample);
		expect(filled.map((bucket) => bucket.from)).toEqual([
			START,
			START + 3 * HOUR,
		]);
		expect(result.to).toBe(START + 4 * HOUR);
	});

	it("has no changes to report while there is a single sample", async () => {
		const result = await history.getDiskUsageHistory("7d");

		expect(mocks.probeDockerUsage).toHaveBeenCalledTimes(1);
		expect(result.current?.usedBytes).toBe(30 * GB);
		expect(result.changeSince).toBeNull();
		expect(result.usedDeltaBytes).toBeNull();
		expect(result.movers).toEqual([]);
		expect(result.categories.every((row) => row.deltaBytes === null)).toBe(
			true,
		);
	});

	it("answers without data when the disk cannot be read", async () => {
		mocks.getRootDiskStat.mockRejectedValue(new Error("no such device"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await history.getDiskUsageHistory("1d");

		expect(result.current).toBeNull();
		expect(result.categories).toEqual([]);
		expect(result.buckets.every((bucket) => bucket.sample === null)).toBe(true);
	});
});

describe("disk history maths", () => {
	let history: DiskHistoryModule;

	beforeEach(async () => {
		history = await import("@dokploy/server/monitoring/disk-history");
	});

	it("treats half a percent of the disk, but at least 256 MiB, as a jump", () => {
		const { isDiskUsageJump } = history;

		expect(isDiskUsageJump(10 * GB, 10 * GB + 200 * MB, 20 * GB)).toBe(false);
		expect(isDiskUsageJump(10 * GB, 10 * GB + 300 * MB, 20 * GB)).toBe(true);
		expect(isDiskUsageJump(10 * GB, 10 * GB - 300 * MB, 20 * GB)).toBe(true);
		expect(isDiskUsageJump(100 * GB, 104 * GB, 1000 * GB)).toBe(false);
		expect(isDiskUsageJump(100 * GB, 106 * GB, 1000 * GB)).toBe(true);
	});

	it("puts the space no part explains into other, never below zero", () => {
		const { toDiskUsageBreakdown } = history;

		expect(
			toDiskUsageBreakdown({
				at: 1,
				totalBytes: TOTAL,
				usedBytes: 10 * GB,
				images: 6 * GB,
			}).parts,
		).toEqual({
			images: 6 * GB,
			buildCache: null,
			volumes: null,
			containerLogs: null,
			containers: null,
			dokployData: null,
			swap: null,
			other: 4 * GB,
		});
		expect(
			toDiskUsageBreakdown({
				at: 1,
				totalBytes: TOTAL,
				usedBytes: 10 * GB,
				images: 12 * GB,
			}).parts.other,
		).toBe(0);
	});

	it("starts day-long bars at the viewer's midnight", () => {
		const { getDiskHistoryRange } = history;
		// 13 Oct 2026 22:30 UTC is 14 Oct 01:30 in UTC+3.
		const now = Date.UTC(2026, 9, 13, 22, 30);

		const range = getDiskHistoryRange("30d", now, 180);

		expect(new Date(range.to).toISOString()).toBe("2026-10-14T21:00:00.000Z");
		expect(new Date(range.from).toISOString()).toBe("2026-09-14T21:00:00.000Z");
		expect(range.count).toBe(30);
	});

	it("keeps the fullest sample of every bar", () => {
		const { bucketDiskSamples, getDiskHistoryRange } = history;
		const range = getDiskHistoryRange("1d", START + 30 * MINUTE, 0);
		const sample = (at: number, usedBytes: number) => ({
			at,
			totalBytes: TOTAL,
			usedBytes,
		});

		const buckets = bucketDiskSamples(
			[
				sample(START - 2 * 24 * HOUR, 49 * GB),
				sample(START - HOUR + 5 * MINUTE, 20 * GB),
				sample(START - HOUR + 10 * MINUTE, 45 * GB),
				sample(START - HOUR + 15 * MINUTE, 21 * GB),
				sample(START + 5 * MINUTE, 22 * GB),
			],
			range,
		);

		expect(buckets).toHaveLength(24);
		expect(buckets.at(-2)?.sample?.usedBytes).toBe(45 * GB);
		expect(buckets.at(-1)).toMatchObject({
			from: START,
			sample: { usedBytes: 22 * GB },
		});
		expect(buckets.slice(0, -2).every((bucket) => bucket.sample === null)).toBe(
			true,
		);
	});

	it("lists what shrank after what grew, and what vanished as freed", () => {
		const { getDiskMovers } = history;

		expect(
			getDiskMovers(
				{ "image:old": 2 * GB, "volume:data": 1 * GB },
				{ "volume:data": 1.5 * GB, "containerLog:web": 3 * GB },
				[{ category: "other", bytes: 5 * GB, deltaBytes: -1 * GB }],
			),
		).toEqual([
			{ kind: "containerLog", name: "web", bytes: 3 * GB, deltaBytes: 3 * GB },
			{ kind: "volume", name: "data", bytes: 1.5 * GB, deltaBytes: 0.5 * GB },
			{ kind: "category", name: "other", bytes: 5 * GB, deltaBytes: -1 * GB },
			{ kind: "image", name: "old", bytes: 0, deltaBytes: -2 * GB },
		]);
	});
});

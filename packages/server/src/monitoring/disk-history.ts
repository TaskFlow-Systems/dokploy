import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { paths } from "../constants";
import {
	DISK_PARTS,
	type DiskCategory,
	type DiskItemKind,
	type DiskItems,
	type DiskPart,
	type DiskParts,
	type DiskStat,
	type DiskUsageProbe,
	getRootDiskStat,
	parseDiskItemKey,
	probeDockerUsage,
	probeSlowUsage,
} from "./disk-usage";

export const DISK_HISTORY_PERIODS = ["1d", "3d", "7d", "30d"] as const;
export type DiskHistoryPeriod = (typeof DISK_HISTORY_PERIODS)[number];

export const diskHistoryInputSchema = z.object({
	period: z.enum(DISK_HISTORY_PERIODS),
	/** Minutes east of UTC, so that day-long bars start at the viewer's midnight. */
	utcOffsetMinutes: z.number().int().min(-840).max(840).default(0),
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const PERIOD_BUCKETS: Record<
	DiskHistoryPeriod,
	{ bucketMs: number; count: number }
> = {
	"1d": { bucketMs: HOUR, count: 24 },
	"3d": { bucketMs: 2 * HOUR, count: 36 },
	"7d": { bucketMs: 4 * HOUR, count: 42 },
	"30d": { bucketMs: DAY, count: 30 },
};

const STAT_INTERVAL_MS = MINUTE;
const PROBE_INTERVAL_MS = 5 * MINUTE;
const SLOW_PROBE_INTERVAL_MS = HOUR;
const SLOW_PROBE_JUMP_GAP_MS = 10 * MINUTE;
// A probe may take at most 2% of the time, however slow the disk is.
const PROBE_COOLDOWN_FACTOR = 50;
const RETENTION_MS = 30 * DAY;
const PRUNE_INTERVAL_MS = 6 * HOUR;
const JUMP_MIN_BYTES = 256 * 1024 ** 2;
const JUMP_DISK_SHARE = 0.005;
const MOVER_MIN_BYTES = 10 * 1024 ** 2;
const MOVERS_LIMIT = 12;

export interface DiskSample extends DiskParts {
	at: number;
	totalBytes: number;
	usedBytes: number;
}

interface DiskItemsSnapshot {
	at: number;
	items: DiskItems;
}

export interface DiskUsageBreakdown {
	at: number;
	totalBytes: number;
	usedBytes: number;
	/** Null for a part that could not be measured; its bytes are in `other`. */
	parts: Record<DiskCategory, number | null>;
}

export interface DiskCategoryChange {
	category: DiskCategory;
	bytes: number | null;
	deltaBytes: number | null;
}

export interface DiskMover {
	kind: DiskItemKind | "category";
	/** Item name, or the category key when the category has no items. */
	name: string;
	bytes: number;
	deltaBytes: number;
}

export interface DiskUsageHistory {
	period: DiskHistoryPeriod;
	from: number;
	to: number;
	bucketMs: number;
	current: (DiskUsageBreakdown & { availableBytes: number }) | null;
	/** One entry per bar: the fullest sample of that interval, or null without data. */
	buckets: { from: number; sample: DiskUsageBreakdown | null }[];
	/** Time of the sample the changes are measured from. */
	changeSince: number | null;
	usedDeltaBytes: number | null;
	categories: DiskCategoryChange[];
	movers: DiskMover[];
}

/** Used space that changed this much since the last saved sample is worth a new one. */
export const isDiskUsageJump = (
	previousUsedBytes: number,
	usedBytes: number,
	totalBytes: number,
) =>
	Math.abs(usedBytes - previousUsedBytes) >=
	Math.max(JUMP_MIN_BYTES, totalBytes * JUMP_DISK_SHARE);

export const toDiskUsageBreakdown = (
	sample: DiskSample,
): DiskUsageBreakdown => {
	const parts = Object.fromEntries(
		DISK_PARTS.map((part) => [part, sample[part] ?? null]),
	) as Record<DiskPart, number | null>;
	const known = Object.values(parts).reduce<number>(
		(total, bytes) => total + (bytes ?? 0),
		0,
	);
	return {
		at: sample.at,
		totalBytes: sample.totalBytes,
		usedBytes: sample.usedBytes,
		// Docker's data may live on another disk; the rest cannot go below zero.
		parts: { ...parts, other: Math.max(sample.usedBytes - known, 0) },
	};
};

/** The bars of a period, aligned to the viewer's clock; the last one holds `now`. */
export const getDiskHistoryRange = (
	period: DiskHistoryPeriod,
	now: number,
	utcOffsetMinutes: number,
) => {
	const { bucketMs, count } = PERIOD_BUCKETS[period];
	const offsetMs = utcOffsetMinutes * MINUTE;
	const lastBucketFrom =
		Math.floor((now + offsetMs) / bucketMs) * bucketMs - offsetMs;
	return {
		from: lastBucketFrom - (count - 1) * bucketMs,
		to: lastBucketFrom + bucketMs,
		bucketMs,
		count,
	};
};

/** Keeps the fullest sample of each bar, so a short spike stays visible. */
export const bucketDiskSamples = (
	samples: DiskSample[],
	range: ReturnType<typeof getDiskHistoryRange>,
) => {
	const fullest: (DiskSample | null)[] = Array.from(
		{ length: range.count },
		() => null,
	);
	for (const sample of samples) {
		const index = Math.floor((sample.at - range.from) / range.bucketMs);
		if (index < 0 || index >= range.count) {
			continue;
		}
		const current = fullest[index];
		if (!current || sample.usedBytes >= current.usedBytes) {
			fullest[index] = sample;
		}
	}
	return fullest.map((sample, index) => ({
		from: range.from + index * range.bucketMs,
		sample: sample ? toDiskUsageBreakdown(sample) : null,
	}));
};

export const getDiskCategoryChanges = (
	start: DiskUsageBreakdown | null,
	end: DiskUsageBreakdown,
): DiskCategoryChange[] =>
	([...DISK_PARTS, "other"] as DiskCategory[]).map((category) => {
		const bytes = end.parts[category];
		const startBytes = start?.parts[category] ?? null;
		return {
			category,
			bytes,
			deltaBytes:
				bytes !== null && startBytes !== null ? bytes - startBytes : null,
		};
	});

// Parts without single items; each one is listed among the movers as a whole.
const WHOLE_CATEGORY_MOVERS: DiskCategory[] = ["buildCache", "swap", "other"];

/** What grew or shrank the most between two moments, biggest growth first. */
export const getDiskMovers = (
	startItems: DiskItems,
	endItems: DiskItems,
	categories: DiskCategoryChange[],
): DiskMover[] => {
	const movers: DiskMover[] = [];
	for (const key of new Set([
		...Object.keys(startItems),
		...Object.keys(endItems),
	])) {
		const bytes = endItems[key] ?? 0;
		movers.push({
			...parseDiskItemKey(key),
			bytes,
			deltaBytes: bytes - (startItems[key] ?? 0),
		});
	}
	for (const change of categories) {
		if (
			WHOLE_CATEGORY_MOVERS.includes(change.category) &&
			change.bytes !== null &&
			change.deltaBytes !== null
		) {
			movers.push({
				kind: "category",
				name: change.category,
				bytes: change.bytes,
				deltaBytes: change.deltaBytes,
			});
		}
	}
	return movers
		.filter((mover) => Math.abs(mover.deltaBytes) >= MOVER_MIN_BYTES)
		.sort((a, b) => b.deltaBytes - a.deltaBytes)
		.slice(0, MOVERS_LIMIT);
};

const getHistoryFiles = () => {
	const directory = path.join(paths().MONITORING_PATH, "disk-history");
	return {
		directory,
		samples: path.join(directory, "samples.jsonl"),
		items: path.join(directory, "items.jsonl"),
	};
};

const readJsonLines = async <T extends { at: number }>(
	file: string,
	since = 0,
): Promise<T[]> => {
	const content = await fs.readFile(file, "utf-8").catch(() => "");
	const rows: T[] = [];
	for (const line of content.split("\n")) {
		if (!line) {
			continue;
		}
		try {
			const row = JSON.parse(line) as T;
			if (row.at >= since) {
				rows.push(row);
			}
		} catch {
			// A line cut short by a restart or a full disk.
		}
	}
	return rows;
};

const appendJsonLine = async <T extends { at: number }>(
	file: string,
	row: T,
) => {
	await fs.mkdir(path.dirname(file), { recursive: true });
	// A full disk can cut the previous line short; the leading newline keeps
	// this row from being glued to it and lost with it.
	await fs.appendFile(file, `\n${JSON.stringify(row)}\n`);
};

const pruneJsonLines = async (file: string, since: number) => {
	const content = await fs.readFile(file, "utf-8").catch(() => null);
	if (content === null) {
		return;
	}
	const kept = content.split("\n").filter((line) => {
		const at = Number(line.match(/^\{"at":(\d+)/)?.[1]);
		return Number.isFinite(at) && at >= since;
	});
	// Written next to the file and renamed, so a crash cannot leave half of it.
	const temporary = `${file}.tmp`;
	await fs.writeFile(temporary, kept.length > 0 ? `${kept.join("\n")}\n` : "");
	await fs.rename(temporary, file);
};

interface ProbeRun {
	at: number;
	durationMs: number;
}

interface SamplerState {
	stat: (DiskStat & { at: number }) | null;
	parts: DiskParts;
	items: DiskItems;
	/** Last sample written to disk; jumps are measured against it. */
	savedSample: DiskSample | null;
	probe: ProbeRun | null;
	slowProbe: ProbeRun | null;
	prunedAt: number;
	running: Promise<void> | null;
	timer: ReturnType<typeof setInterval> | null;
}

// Like the Docker client: the module is evaluated once per bundled copy, and
// two samplers would write every sample twice.
const globalForDiskHistory = globalThis as unknown as {
	diskHistorySampler?: SamplerState;
};

if (!globalForDiskHistory.diskHistorySampler) {
	globalForDiskHistory.diskHistorySampler = {
		stat: null,
		parts: {},
		items: {},
		savedSample: null,
		probe: null,
		slowProbe: null,
		prunedAt: 0,
		running: null,
		timer: null,
	};
}

const state = globalForDiskHistory.diskHistorySampler;

const isProbeDue = (last: ProbeRun | null, now: number, intervalMs: number) => {
	if (!last) {
		return true;
	}
	// The timer fires a few milliseconds early or late; without the slack a
	// probe due on this tick would wait for the next one.
	const elapsed = now - last.at + STAT_INTERVAL_MS / 2;
	return (
		elapsed >= intervalMs && elapsed >= last.durationMs * PROBE_COOLDOWN_FACTOR
	);
};

const applyProbe = (probe: DiskUsageProbe) => {
	state.parts = { ...state.parts, ...probe.parts };
	const kept = Object.entries(state.items).filter(
		([key]) => !probe.itemKinds.includes(parseDiskItemKey(key).kind),
	);
	state.items = { ...Object.fromEntries(kept), ...probe.items };
};

const timeProbe = async (
	now: number,
	run: () => Promise<DiskUsageProbe>,
): Promise<ProbeRun> => {
	const startedAt = Date.now();
	applyProbe(await run());
	return { at: now, durationMs: Date.now() - startedAt };
};

const sampleDiskUsage = async (now: number, force: boolean) => {
	const stat = await getRootDiskStat();
	state.stat = { ...stat, at: now };

	const saved = state.savedSample;
	const jumped =
		!!saved &&
		isDiskUsageJump(saved.usedBytes, stat.usedBytes, stat.totalBytes);
	const probeDue =
		force ||
		isProbeDue(state.probe, now, jumped ? STAT_INTERVAL_MS : PROBE_INTERVAL_MS);
	if (!probeDue) {
		return;
	}
	const slowProbeDue = isProbeDue(
		state.slowProbe,
		now,
		jumped ? SLOW_PROBE_JUMP_GAP_MS : SLOW_PROBE_INTERVAL_MS,
	);

	state.probe = await timeProbe(now, probeDockerUsage);
	if (slowProbeDue) {
		state.slowProbe = await timeProbe(now, probeSlowUsage);
	}

	const files = getHistoryFiles();
	const sample: DiskSample = {
		at: now,
		totalBytes: stat.totalBytes,
		usedBytes: stat.usedBytes,
		...state.parts,
	};
	await appendJsonLine(files.samples, sample);
	state.savedSample = sample;
	if (slowProbeDue) {
		// Saved together with a sample, so both describe the same moment.
		await appendJsonLine(files.items, { at: now, items: state.items });
	}

	if (now - state.prunedAt >= PRUNE_INTERVAL_MS) {
		state.prunedAt = now;
		await pruneJsonLines(files.samples, now - RETENTION_MS);
		await pruneJsonLines(files.items, now - RETENTION_MS);
	}
};

/**
 * Reads the disk and, when it is time, Docker's usage, and saves a sample. With
 * `force` the Docker probe runs now, e.g. right after a cleanup.
 */
export const refreshDiskUsage = async ({ force = false } = {}) => {
	// A forced refresh must not settle for a run that started before the cleanup.
	if (state.running && force) {
		await state.running.catch(() => {});
	}
	state.running ??= sampleDiskUsage(Date.now(), force).finally(() => {
		state.running = null;
	});
	await state.running;
};

/** Samples the disk every minute for as long as the process lives. */
export const startDiskHistorySampler = () => {
	if (state.timer) {
		return;
	}
	const tick = () => {
		refreshDiskUsage().catch((error) => {
			console.error("Disk usage: sampling failed", error);
		});
	};
	state.timer = setInterval(tick, STAT_INTERVAL_MS);
	state.timer.unref();
	tick();
};

const getCurrentSample = async (now: number): Promise<DiskSample | null> => {
	// Without the sampler (development) a query is what keeps the numbers fresh.
	if (!state.stat || now - state.stat.at > 2 * STAT_INTERVAL_MS) {
		await refreshDiskUsage().catch((error) => {
			console.error("Disk usage: sampling failed", error);
		});
	}
	if (!state.stat) {
		return null;
	}
	return {
		at: state.stat.at,
		totalBytes: state.stat.totalBytes,
		usedBytes: state.stat.usedBytes,
		...state.parts,
	};
};

export const getDiskUsageHistory = async (
	period: DiskHistoryPeriod,
	utcOffsetMinutes = 0,
	now = Date.now(),
): Promise<DiskUsageHistory> => {
	const currentSample = await getCurrentSample(now);
	const files = getHistoryFiles();
	const range = getDiskHistoryRange(period, now, utcOffsetMinutes);
	const [samples, snapshots] = await Promise.all([
		readJsonLines<DiskSample>(files.samples, range.from),
		readJsonLines<DiskItemsSnapshot>(files.items, range.from),
	]);
	const buckets = bucketDiskSamples(
		currentSample ? [...samples, currentSample] : samples,
		range,
	);

	const current = currentSample ? toDiskUsageBreakdown(currentSample) : null;
	// Item sizes are saved less often than samples; starting from the first
	// saved set keeps the category changes and the movers on the same moment.
	const startItems = snapshots[0];
	const startSample =
		samples.find((sample) => sample.at === startItems?.at) ?? samples[0];
	const start =
		startSample && current && startSample.at < current.at
			? toDiskUsageBreakdown(startSample)
			: null;
	const categories = current ? getDiskCategoryChanges(start, current) : [];

	return {
		period,
		from: range.from,
		to: range.to,
		bucketMs: range.bucketMs,
		current:
			current && state.stat
				? { ...current, availableBytes: state.stat.availableBytes }
				: null,
		buckets,
		changeSince: start?.at ?? null,
		usedDeltaBytes:
			start && current ? current.usedBytes - start.usedBytes : null,
		categories,
		movers:
			start && startItems?.at === start.at
				? getDiskMovers(startItems.items, state.items, categories)
				: [],
	};
};

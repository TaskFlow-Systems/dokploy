import type {
	DiskCategory,
	DiskHistoryPeriod,
	DiskMover,
} from "@dokploy/server/index";
import { format } from "date-fns";

interface DiskCategoryMeta {
	label: string;
	description: string;
	color: string;
}

// The order is the stacking order, bottom to top. The colors were checked as
// neighbours in exactly this order, so a new category goes through the palette
// validator before it is inserted.
export const DISK_CATEGORIES: Record<DiskCategory, DiskCategoryMeta> = {
	images: {
		label: "Images",
		description: "Docker images of your apps, databases and Dokploy itself.",
		color: "var(--disk-images)",
	},
	buildCache: {
		label: "Build cache",
		description:
			"Layers kept to make the next builds faster, without those that images share. Safe to clear.",
		color: "var(--disk-build-cache)",
	},
	volumes: {
		label: "Volumes",
		description: "Data of databases and apps stored in Docker volumes.",
		color: "var(--disk-volumes)",
	},
	containerLogs: {
		label: "Container logs",
		description: "Output that Docker stores for every container.",
		color: "var(--disk-container-logs)",
	},
	containers: {
		label: "Container files",
		description: "Files written inside containers, outside of volumes.",
		color: "var(--disk-containers)",
	},
	dokployData: {
		label: "Dokploy data",
		description: "Deployment logs, source checkouts and backups of Dokploy.",
		color: "var(--disk-dokploy-data)",
	},
	swap: {
		label: "Swap files",
		description: "Disk space the system reserved to extend the memory.",
		color: "var(--disk-swap)",
	},
	other: {
		label: "System and other",
		description:
			"The operating system, system logs and everything Docker does not report.",
		color: "var(--disk-other)",
	},
};

export const DISK_CATEGORY_ORDER = Object.keys(
	DISK_CATEGORIES,
) as DiskCategory[];

export const DISK_PERIOD_LABELS: Record<DiskHistoryPeriod, string> = {
	"1d": "1 day",
	"3d": "3 days",
	"7d": "7 days",
	"30d": "30 days",
};

// Decimal units, the same Docker prints, so the numbers match `docker system df`.
export const formatDiskBytes = (bytes: number) => {
	const absolute = Math.abs(bytes);
	if (absolute >= 1e9) {
		return `${(bytes / 1e9).toFixed(absolute >= 1e10 ? 1 : 2)} GB`;
	}
	if (absolute >= 1e6) {
		return `${Math.round(bytes / 1e6)} MB`;
	}
	if (absolute >= 1e3) {
		return `${Math.round(bytes / 1e3)} KB`;
	}
	return `${bytes} B`;
};

export const formatDiskDelta = (bytes: number) => {
	// A change that rounds to zero reads as "no change", not as "+0 MB".
	if (Math.abs(bytes) < 5e5) {
		return "no change";
	}
	return `${bytes > 0 ? "+" : "−"}${formatDiskBytes(Math.abs(bytes))}`;
};

export const formatDiskBucket = (from: number, bucketMs: number) => {
	const start = new Date(from);
	if (bucketMs >= 24 * 60 * 60 * 1000) {
		return format(start, "d MMM");
	}
	return `${format(start, "d MMM")}, ${format(start, "HH:mm")}–${format(new Date(from + bucketMs), "HH:mm")}`;
};

export const describeDiskBucket = (bucketMs: number) => {
	const hours = bucketMs / (60 * 60 * 1000);
	if (hours >= 24) {
		return "a day";
	}
	return hours === 1 ? "an hour" : `${hours} hours`;
};

const MOVER_KIND_LABELS: Record<DiskMover["kind"], string | null> = {
	image: "Images",
	volume: "Volume",
	container: "Container files",
	containerLog: "Container logs",
	dokployData: "Dokploy data",
	category: null,
};

export const getDiskMoverLabel = (mover: DiskMover) => {
	if (mover.kind === "category") {
		return {
			kind: null,
			name: DISK_CATEGORIES[mover.name as DiskCategory]?.label ?? mover.name,
		};
	}
	return { kind: MOVER_KIND_LABELS[mover.kind], name: mover.name };
};

const MOVER_CATEGORIES: Record<
	Exclude<DiskMover["kind"], "category">,
	DiskCategory
> = {
	image: "images",
	volume: "volumes",
	container: "containers",
	containerLog: "containerLogs",
	dokployData: "dokployData",
};

export const getDiskMoverCategory = (mover: DiskMover): DiskCategory =>
	mover.kind === "category"
		? (mover.name as DiskCategory)
		: MOVER_CATEGORIES[mover.kind];

/** Round axis values (1, 2 or 5 times a power of ten) below the disk size. */
export const getDiskAxisTicks = (totalBytes: number) => {
	if (totalBytes <= 0) {
		return [0];
	}
	const rough = totalBytes / 4;
	const magnitude = 10 ** Math.floor(Math.log10(rough));
	const step =
		magnitude *
		([1, 2, 5, 10].find((factor) => factor * magnitude >= rough) ?? 10);
	const ticks: number[] = [];
	// A value right under the disk size would collide with the label of that line.
	for (let value = 0; value <= totalBytes * 0.92; value += step) {
		ticks.push(value);
	}
	return ticks;
};

const HOUR_MS = 60 * 60 * 1000;

/**
 * Bars that get a label under the axis: every third hour of a day, noon and
 * midnight of three days, midnight of a week. Day-long bars are left to the chart.
 */
export const getDiskTimeTicks = (bucketStarts: number[], bucketMs: number) => {
	const hours = bucketMs / HOUR_MS;
	if (hours >= 24) {
		return undefined;
	}
	const step = hours <= 1 ? 3 : hours <= 2 ? 12 : 24;
	return bucketStarts.filter((from) => new Date(from).getHours() % step === 0);
};

/** Midnight carries the date, so the days of a longer period can be told apart. */
export const formatDiskTimeTick = (from: number, bucketMs: number) => {
	const start = new Date(from);
	return bucketMs >= 24 * HOUR_MS || start.getHours() === 0
		? format(start, "d MMM")
		: format(start, "HH:mm");
};

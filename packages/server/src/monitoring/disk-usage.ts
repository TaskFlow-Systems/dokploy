import { promises as fs } from "node:fs";
import path from "node:path";
import { docker, paths } from "../constants";
import { quoteShellArg } from "../utils/filesystem/safe-path";
import { execAsync } from "../utils/process/execAsync";

/** What the disk usage is split into; the rest of the used space is "other". */
export const DISK_PARTS = [
	"images",
	"buildCache",
	"volumes",
	"containerLogs",
	"containers",
	"dokployData",
	"swap",
] as const;

export type DiskPart = (typeof DISK_PARTS)[number];
export type DiskCategory = DiskPart | "other";
export type DiskParts = Partial<Record<DiskPart, number>>;

export type DiskItemKind =
	| "image"
	| "volume"
	| "container"
	| "containerLog"
	| "dokployData";

/** Sizes of single images, volumes and so on, keyed by `<kind>:<name>`. */
export type DiskItems = Record<string, number>;

export interface DiskUsageProbe {
	parts: DiskParts;
	items: DiskItems;
	/** Kinds this probe measured; items of other kinds keep their last value. */
	itemKinds: DiskItemKind[];
}

export interface DiskStat {
	totalBytes: number;
	usedBytes: number;
	availableBytes: number;
}

const PROBE_TIMEOUT_MS = 60_000;
const ANONYMOUS_VOLUME_NAME = /^[a-f0-9]{64}$/;
const CONTAINER_LOGS_MOUNT = "/docker-containers";

export const diskItemKey = (kind: DiskItemKind, name: string) =>
	`${kind}:${name}`;

export const parseDiskItemKey = (key: string) => {
	const separator = key.indexOf(":");
	return {
		kind: key.slice(0, separator) as DiskItemKind,
		name: key.slice(separator + 1),
	};
};

// The same numbers `df /` prints. Dokploy's container root is an overlay on the
// host disk, so this is the host's disk even without /var/lib/docker mounted.
export const getRootDiskStat = async (): Promise<DiskStat> => {
	const stat = await fs.statfs("/");
	return {
		totalBytes: stat.blocks * stat.bsize,
		usedBytes: (stat.blocks - stat.bfree) * stat.bsize,
		availableBytes: stat.bavail * stat.bsize,
	};
};

interface DockerUsageSection<T> {
	TotalSize?: number;
	Items?: T[] | null;
}

interface DockerImageUsage {
	Id?: string;
	RepoTags?: string[] | null;
	RepoDigests?: string[] | null;
	Size?: number;
	SharedSize?: number;
}

interface DockerContainerUsage {
	Id?: string;
	Names?: string[] | null;
	Labels?: Record<string, string> | null;
	SizeRw?: number;
}

interface DockerVolumeUsage {
	Name?: string;
	UsageData?: { Size?: number } | null;
}

interface DockerBuildCacheUsage {
	Size?: number;
	Shared?: boolean;
}

// Docker 29 reports each section twice: the legacy top-level lists and the
// `*Usage` objects that replace them in later API versions.
export interface DockerDiskUsageResponse {
	LayersSize?: number;
	Images?: DockerImageUsage[] | null;
	Containers?: DockerContainerUsage[] | null;
	Volumes?: DockerVolumeUsage[] | null;
	BuildCache?: DockerBuildCacheUsage[] | null;
	ImageUsage?: DockerUsageSection<DockerImageUsage> | null;
	ContainerUsage?: DockerUsageSection<DockerContainerUsage> | null;
	VolumeUsage?: DockerUsageSection<DockerVolumeUsage> | null;
	BuildCacheUsage?: DockerUsageSection<DockerBuildCacheUsage> | null;
}

type DockerUsageType = "image" | "container" | "volume" | "build-cache";

const getImageRepository = (image: DockerImageUsage) => {
	const reference =
		image.RepoTags?.find((tag) => !tag.startsWith("<none>")) ??
		image.RepoDigests?.[0];
	if (!reference) {
		return "untagged";
	}
	const withoutDigest = reference.split("@")[0] ?? reference;
	const lastSlash = withoutDigest.lastIndexOf("/");
	const lastColon = withoutDigest.lastIndexOf(":");
	// A colon before the last slash is a registry port, not a tag.
	return lastColon > lastSlash
		? withoutDigest.slice(0, lastColon)
		: withoutDigest;
};

// Swarm gives every task its own container name, so a redeploy would look like
// one container vanishing and another one appearing.
const getContainerName = (container: DockerContainerUsage) =>
	container.Labels?.["com.docker.swarm.service.name"] ??
	container.Names?.[0]?.replace(/^\//, "") ??
	container.Id?.slice(0, 12) ??
	"unknown";

const addBytes = (items: DiskItems, key: string, bytes: number) => {
	items[key] = (items[key] ?? 0) + bytes;
};

const sum = (values: number[]) =>
	values.reduce((total, value) => total + value, 0);

/**
 * Turns a `GET /system/df` answer into part totals and per-item sizes. Only the
 * sections Docker was asked for are present, so the others stay out of the result.
 */
export const summarizeDockerDiskUsage = (
	usage: DockerDiskUsageResponse,
): DiskUsageProbe => {
	const parts: DiskParts = {};
	const items: DiskItems = {};
	const itemKinds: DiskItemKind[] = [];

	const images = usage.ImageUsage?.Items ?? usage.Images;
	if (images) {
		itemKinds.push("image");
		for (const image of images) {
			const size = image.Size ?? 0;
			const shared = image.SharedSize ?? -1;
			// Docker answers -1 when it did not work out the shared part.
			const unique = shared >= 0 ? Math.max(size - shared, 0) : size;
			addBytes(items, diskItemKey("image", getImageRepository(image)), unique);
		}
		parts.images =
			usage.ImageUsage?.TotalSize ??
			usage.LayersSize ??
			sum(images.map((image) => image.Size ?? 0));
	}

	const containers = usage.ContainerUsage?.Items ?? usage.Containers;
	if (containers) {
		itemKinds.push("container");
		for (const container of containers) {
			addBytes(
				items,
				diskItemKey("container", getContainerName(container)),
				container.SizeRw ?? 0,
			);
		}
		parts.containers =
			usage.ContainerUsage?.TotalSize ??
			sum(containers.map((container) => container.SizeRw ?? 0));
	}

	const volumes = usage.VolumeUsage?.Items ?? usage.Volumes;
	if (volumes) {
		itemKinds.push("volume");
		for (const volume of volumes) {
			const name = volume.Name ?? "unknown";
			addBytes(
				items,
				diskItemKey(
					"volume",
					ANONYMOUS_VOLUME_NAME.test(name) ? "anonymous volumes" : name,
				),
				Math.max(volume.UsageData?.Size ?? 0, 0),
			);
		}
		parts.volumes =
			usage.VolumeUsage?.TotalSize ??
			sum(volumes.map((volume) => Math.max(volume.UsageData?.Size ?? 0, 0)));
	}

	const buildCache = usage.BuildCacheUsage?.Items ?? usage.BuildCache;
	if (buildCache) {
		// Shared records are image layers, and the images part already counts them.
		parts.buildCache = sum(
			buildCache
				.filter((record) => !record.Shared)
				.map((record) => record.Size ?? 0),
		);
	}

	return { parts, items, itemKinds };
};

const requestDockerDiskUsage = (types: DockerUsageType[]) =>
	new Promise<DockerDiskUsageResponse>((resolve, reject) => {
		docker.modem.dial(
			{
				// The modem appends the query only to a path that ends with "?".
				path: "/system/df?",
				method: "GET",
				options: { type: types },
				statusCodes: { 200: true, 500: "server error" },
			},
			(error, data) => {
				if (error) {
					reject(error);
					return;
				}
				resolve((data ?? {}) as DockerDiskUsageResponse);
			},
		);
	});

/** Parses `du -k` output into bytes per path. */
export const parseDuOutput = (stdout: string) => {
	const sizes = new Map<string, number>();
	for (const line of stdout.split("\n")) {
		const match = line.match(/^(\d+)\s+(.+)$/);
		if (match) {
			sizes.set(match[2] as string, Number(match[1]) * 1024);
		}
	}
	return sizes;
};

/** Bytes of the swap files listed in /proc/swaps; swap partitions take no disk space. */
export const parseSwapFileBytes = (procSwaps: string) =>
	sum(
		procSwaps
			.split("\n")
			.slice(1)
			.map((line) => line.trim().split(/\s+/))
			// The file name may hold spaces, so the columns are read from the end.
			.filter((columns) => columns.at(-4) === "file")
			.map((columns) => Number(columns.at(-3)) * 1024)
			.filter((bytes) => Number.isFinite(bytes)),
	);

const mergeProbes = (probes: DiskUsageProbe[]): DiskUsageProbe => ({
	parts: Object.assign({}, ...probes.map((probe) => probe.parts)),
	items: Object.assign({}, ...probes.map((probe) => probe.items)),
	itemKinds: probes.flatMap((probe) => probe.itemKinds),
});

const emptyProbe = (): DiskUsageProbe => ({
	parts: {},
	items: {},
	itemKinds: [],
});

const logProbeFailure = (what: string) => (error: unknown) => {
	console.error(`Disk usage: could not read ${what}`, error);
	return emptyProbe();
};

// Docker keeps container logs under its root directory, which Dokploy's own
// container does not see, so a throwaway container measures them.
const probeContainerLogs = async (): Promise<DiskUsageProbe> => {
	const [{ DockerRootDir }, containers] = await Promise.all([
		docker.info() as Promise<{ DockerRootDir?: string }>,
		docker.listContainers({ all: true }),
	]);
	if (!DockerRootDir) {
		return emptyProbe();
	}
	const mount = `${DockerRootDir}/containers:${CONTAINER_LOGS_MOUNT}:ro`;
	const { stdout } = await execAsync(
		`docker run --rm --network none -v ${quoteShellArg(mount)} busybox du -k -d 1 ${CONTAINER_LOGS_MOUNT}`,
		{ timeoutMs: PROBE_TIMEOUT_MS },
	);

	const names = new Map(
		containers.map((container) => [container.Id, getContainerName(container)]),
	);
	const items: DiskItems = {};
	let total = 0;
	for (const [directory, bytes] of parseDuOutput(stdout)) {
		if (directory === CONTAINER_LOGS_MOUNT) {
			total = bytes;
			continue;
		}
		const id = path.basename(directory);
		addBytes(
			items,
			diskItemKey("containerLog", names.get(id) ?? id.slice(0, 12)),
			bytes,
		);
	}
	return {
		parts: { containerLogs: total },
		items,
		itemKinds: ["containerLog"],
	};
};

const probeDokployData = async (): Promise<DiskUsageProbe> => {
	const { BASE_PATH } = paths();
	// du exits non-zero for a single unreadable file but still prints the sizes.
	const { stdout } = await execAsync(
		`du -k -x -d 1 ${quoteShellArg(BASE_PATH)} 2>/dev/null || true`,
		{ timeoutMs: PROBE_TIMEOUT_MS },
	);
	const sizes = parseDuOutput(stdout);
	const total = sizes.get(BASE_PATH);
	if (total === undefined) {
		return emptyProbe();
	}
	const items: DiskItems = {};
	for (const [directory, bytes] of sizes) {
		if (directory !== BASE_PATH) {
			items[diskItemKey("dokployData", path.basename(directory))] = bytes;
		}
	}
	return {
		parts: { dokployData: total },
		items,
		itemKinds: ["dokployData"],
	};
};

const probeSwapFiles = async (): Promise<DiskUsageProbe> => {
	const procSwaps = await fs.readFile("/proc/swaps", "utf-8").catch(() => null);
	if (procSwaps === null) {
		return emptyProbe();
	}
	return {
		parts: { swap: parseSwapFileBytes(procSwaps) },
		items: {},
		itemKinds: [],
	};
};

/** Images, container layers and build cache: Docker answers from its metadata. */
export const probeDockerUsage = async (): Promise<DiskUsageProbe> =>
	requestDockerDiskUsage(["image", "container", "build-cache"])
		.then(summarizeDockerDiskUsage)
		.catch(logProbeFailure("Docker disk usage"));

/**
 * Everything that walks files on disk: volumes (Docker sizes each one with a
 * directory walk), container logs, Dokploy's own data and swap files.
 */
export const probeSlowUsage = async (): Promise<DiskUsageProbe> =>
	mergeProbes(
		await Promise.all([
			requestDockerDiskUsage(["volume"])
				.then(summarizeDockerDiskUsage)
				.catch(logProbeFailure("Docker volume sizes")),
			probeContainerLogs().catch(logProbeFailure("container log sizes")),
			probeDokployData().catch(logProbeFailure("Dokploy data size")),
			probeSwapFiles().catch(logProbeFailure("swap files")),
		]),
	);

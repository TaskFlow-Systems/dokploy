import { readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { quoteShellArg } from "@dokploy/server/utils/filesystem/safe-path";
import { ExecError } from "@dokploy/server/utils/process/ExecError";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { and, eq } from "drizzle-orm";

import semver from "semver";
import { db } from "../db";
import { compose } from "../db/schema";
import {
	buildTraefikTlsMigrationStep,
	ensureTraefikImage,
	initializeStandaloneTraefik,
	initializeTraefikService,
	restoreInterruptedTraefik,
	TRAEFIK_MAIN_CONFIG_PATH,
	TRAEFIK_VERSION,
	type TraefikOptions,
} from "../setup/traefik-setup";
import { UPDATE_IMAGE_PULLED_MARKER } from "./web-server-update";
export interface IUpdateData {
	latestVersion: string | null;
	updateAvailable: boolean;
	updateSource?: "official" | "agenthits";
	latestImage?: string | null;
	latestOfficialVersion?: string | null;
	currentDigest?: string | null;
	latestDigest?: string | null;
	latestPlatformDigest?: string | null;
}

export const DEFAULT_UPDATE_DATA: IUpdateData = {
	latestVersion: null,
	updateAvailable: false,
};

export interface IDokployVersionData {
	officialVersion: string;
	forkVersion: string;
	releaseTag: string;
	isFork: boolean;
}

/** Returns current Dokploy docker image tag or `latest` by default. */
export const getDokployImageTag = () => {
	return process.env.RELEASE_TAG || "latest";
};

export const getAgentHitsUpdateTag = () => {
	return process.env.DOKPLOY_AGENTHITS_UPDATE_TAG?.trim() || "agenthits-dev";
};

export const getAgentHitsUpdateImage = () => {
	const explicitImage = process.env.DOKPLOY_AGENTHITS_UPDATE_IMAGE?.trim();
	if (explicitImage) {
		return explicitImage;
	}

	return `ghcr.io/agenthits/dokploy:${getAgentHitsUpdateTag()}`;
};

export const getOfficialDokployVersion = (currentVersion: string) => {
	return process.env.DOKPLOY_OFFICIAL_VERSION?.trim() || currentVersion;
};

export const getForkDokployVersion = (currentVersion: string) => {
	const forkVersion = process.env.DOKPLOY_FORK_VERSION?.trim();
	if (forkVersion) {
		return forkVersion;
	}

	const releaseTag = getDokployImageTag();
	if (releaseTag === "latest") {
		return currentVersion;
	}

	return releaseTag;
};

export const getDokployVersionData = (
	currentVersion: string,
): IDokployVersionData => {
	const officialVersion = getOfficialDokployVersion(currentVersion);
	const forkVersion = getForkDokployVersion(currentVersion);

	return {
		officialVersion,
		forkVersion,
		releaseTag: getDokployImageTag(),
		isFork: forkVersion !== officialVersion,
	};
};

export const isAgentHitsUpdateChannel = (currentVersion: string) => {
	const updateSource = process.env.DOKPLOY_UPDATE_SOURCE?.trim().toLowerCase();
	if (updateSource === "official") {
		return false;
	}
	if (updateSource === "agenthits") {
		return true;
	}

	const versionData = getDokployVersionData(currentVersion);
	return (
		versionData.releaseTag.startsWith("agenthits") ||
		versionData.forkVersion.startsWith("off_") ||
		Boolean(process.env.DOKPLOY_FORK_VERSION?.trim())
	);
};

const getGhcrPullToken = async () => {
	const response = await fetch(
		"https://ghcr.io/token?service=ghcr.io&scope=repository:agenthits/dokploy:pull",
	);
	if (!response.ok) {
		throw new Error(`Could not request GHCR pull token: ${response.status}`);
	}

	const data = (await response.json()) as { token?: string };
	if (!data.token) {
		throw new Error("GHCR pull token response did not include a token");
	}

	return data.token;
};

const fetchGhcrJson = async <T>(
	token: string,
	path: string,
	accept: string,
): Promise<{ digest: string | null; data: T }> => {
	const response = await fetch(`https://ghcr.io/v2/agenthits/dokploy/${path}`, {
		headers: {
			Accept: accept,
			Authorization: `Bearer ${token}`,
		},
	});
	if (!response.ok) {
		throw new Error(`Could not fetch GHCR ${path}: ${response.status}`);
	}

	return {
		digest: response.headers.get("docker-content-digest"),
		data: (await response.json()) as T,
	};
};

type RegistryManifestList = {
	manifests?: {
		digest: string;
		mediaType?: string;
		platform?: {
			architecture?: string;
			os?: string;
		};
	}[];
};

type RegistryImageManifest = {
	config?: {
		digest: string;
		mediaType?: string;
	};
};

type RegistryImageConfig = {
	config?: {
		Env?: string[];
	};
};

const MANIFEST_LIST_ACCEPT = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const IMAGE_MANIFEST_ACCEPT = [
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const findEnvValue = (env: string[] | undefined, name: string) => {
	const prefix = `${name}=`;
	return env?.find((item) => item.startsWith(prefix))?.slice(prefix.length);
};

export const getAgentHitsLatestImageData = async () => {
	const token = await getGhcrPullToken();
	const tag = getAgentHitsUpdateTag();
	const indexResult = await fetchGhcrJson<
		RegistryManifestList & RegistryImageManifest
	>(token, `manifests/${tag}`, MANIFEST_LIST_ACCEPT);
	const latestDigest = indexResult.digest;

	// Images pushed with provenance/sbom disabled are a bare manifest, not an index.
	const isBareManifest = Boolean(indexResult.data.config?.digest);
	const imageManifestDigest = isBareManifest
		? latestDigest
		: (indexResult.data.manifests?.find(
				(manifest) =>
					manifest.platform?.os === "linux" &&
					manifest.platform.architecture === "amd64",
			)?.digest ?? indexResult.data.manifests?.[0]?.digest);

	if (!latestDigest || !imageManifestDigest) {
		throw new Error("Could not resolve AgentHits image manifest digest");
	}

	const imageManifestResult = isBareManifest
		? indexResult
		: await fetchGhcrJson<RegistryImageManifest>(
				token,
				`manifests/${imageManifestDigest}`,
				IMAGE_MANIFEST_ACCEPT,
			);
	const configDigest = imageManifestResult.data.config?.digest;
	if (!configDigest) {
		throw new Error("Could not resolve AgentHits image config digest");
	}

	const configResult = await fetchGhcrJson<RegistryImageConfig>(
		token,
		`blobs/${configDigest}`,
		"application/octet-stream",
	);
	const env = configResult.data.config?.Env;

	return {
		image: getAgentHitsUpdateImage(),
		latestDigest,
		latestPlatformDigest: imageManifestDigest,
		forkVersion: findEnvValue(env, "DOKPLOY_FORK_VERSION") || tag,
		officialVersion: findEnvValue(env, "DOKPLOY_OFFICIAL_VERSION") || "v0.29.8",
	};
};

export const getAgentHitsUpdateData = async (
	currentVersion: string,
): Promise<IUpdateData> => {
	const currentDigest = await getServiceImageDigest();
	const latestImageData = await getAgentHitsLatestImageData();
	const currentVersionData = getDokployVersionData(currentVersion);
	const metadataUpdateAvailable =
		currentVersionData.forkVersion !== latestImageData.forkVersion ||
		currentVersionData.officialVersion !== latestImageData.officialVersion;
	const digestUpdateAvailable =
		Boolean(currentDigest) &&
		currentDigest !== latestImageData.latestDigest &&
		currentDigest !== latestImageData.latestPlatformDigest;

	return {
		latestVersion: latestImageData.forkVersion,
		updateAvailable: digestUpdateAvailable || metadataUpdateAvailable,
		updateSource: "agenthits",
		latestImage: latestImageData.image,
		latestOfficialVersion: latestImageData.officialVersion,
		currentDigest,
		latestDigest: latestImageData.latestDigest,
		latestPlatformDigest: latestImageData.latestPlatformDigest,
	};
};

// Renamed from DOKPLOY_KEEP_IMAGES when the count stopped including the new
// and the previous build: an old "0" (off) must not read as "keep none".
export const DOKPLOY_KEEP_IMAGES_ENV = "DOKPLOY_KEEP_OLD_IMAGES";
export const DOKPLOY_PREVIOUS_IMAGE_ENV = "DOKPLOY_PREVIOUS_IMAGE";
export const DOKPLOY_KEEP_IMAGES_MIN = 0;
export const DOKPLOY_KEEP_IMAGES_MAX = 5;

/**
 * Returns how many older Dokploy images to keep besides the running and the
 * previous one, or null when the cleanup is off.
 */
export const getDokployImageKeepCount = () => {
	const raw = process.env[DOKPLOY_KEEP_IMAGES_ENV]?.trim() ?? "";
	if (!/^\d+$/.test(raw)) {
		return null;
	}
	const value = Number(raw);
	if (value < DOKPLOY_KEEP_IMAGES_MIN || value > DOKPLOY_KEEP_IMAGES_MAX) {
		return null;
	}
	return value;
};

/** `--env-add` argument that stores the cleanup choice on the dokploy service. */
export const getDokployKeepImagesEnvArg = (keepImages: number | null) =>
	`--env-add ${quoteShellArg(`${DOKPLOY_KEEP_IMAGES_ENV}=${keepImages ?? "off"}`)}`;

/** Image id of the build that ran before the last update, if it was recorded. */
export const getDokployPreviousImage = () => {
	const value = process.env[DOKPLOY_PREVIOUS_IMAGE_ENV]?.trim() ?? "";
	return /^sha256:[a-f0-9]{64}$/.test(value) ? value : null;
};

const DOKPLOY_RUNNING_TASKS =
	"docker ps -q --filter label=com.docker.swarm.service.name=dokploy --filter status=running";

// Captured before `docker service update` so the cleanup in the new container
// knows which build to keep for a rollback.
const RECORD_PREVIOUS_IMAGE = `previous_image=""
running_tasks=$(${DOKPLOY_RUNNING_TASKS})
if [ -n "$running_tasks" ]; then
	previous_image=$(docker inspect --format '{{.Image}}' $running_tasks 2>/dev/null | head -n 1)
fi`;

const PREVIOUS_IMAGE_ENV_ARG = `--env-add "${DOKPLOY_PREVIOUS_IMAGE_ENV}=$previous_image"`;

const getImageRepository = (image: string) => {
	const withoutDigest = image.split("@")[0] ?? image;
	const lastSlash = withoutDigest.lastIndexOf("/");
	const lastColon = withoutDigest.lastIndexOf(":");
	// A colon before the last slash is a registry port, not a tag.
	return lastColon > lastSlash
		? withoutDigest.slice(0, lastColon)
		: withoutDigest;
};

export const getDokployImageRepositories = () => [
	...new Set([
		getImageRepository(getAgentHitsUpdateImage()),
		"dokploy/dokploy",
	]),
];

/**
 * Removes Dokploy web server images except the running one, the previous one
 * and the `keep` newest of the rest. Swarm keeps exited task containers of the
 * dokploy service, and they pin old images, so those are removed first.
 * Images used by running containers are never forced. `-a` is needed because
 * images swarm pulls by digest have no tag, and `docker image ls` hides
 * untagged images without it.
 */
export const getDokployImageCleanupCommand = (
	keep: number,
	previousImage: string | null,
) => {
	const filters = getDokployImageRepositories()
		.map((repository) => `--filter ${quoteShellArg(`reference=${repository}`)}`)
		.join(" ");
	// Without a recorded previous build, the newest older image stands in for it.
	const skip = keep + (previousImage ? 0 : 1);

	return `
ids=$(docker image ls -a -q --no-trunc ${filters} | sort -u)
if [ -z "$ids" ]; then
	exit 0
fi
protected="${previousImage ?? ""}"
running_tasks=$(${DOKPLOY_RUNNING_TASKS})
if [ -n "$running_tasks" ]; then
	protected="$protected $(docker inspect --format '{{.Image}}' $running_tasks | tr '\n' ' ')"
fi
docker image inspect --format '{{.Created}} {{.Id}}' $ids | sort -r | awk '{print $2}' | while read -r id; do
	case " $protected " in
		*" $id "*) ;;
		*) echo "$id" ;;
	esac
done | tail -n +${skip + 1} | while read -r id; do
	containers=$(docker ps -aq --filter "ancestor=$id" --filter status=exited --filter status=created --filter label=com.docker.swarm.service.name=dokploy)
	if [ -n "$containers" ]; then
		docker rm $containers || true
	fi
	echo "Removing old Dokploy image $id"
	tags=$(docker image inspect --format '{{range .RepoTags}}{{.}} {{end}}' "$id")
	if [ -n "$tags" ]; then
		docker image rm $tags || true
	fi
	if docker image inspect "$id" >/dev/null 2>&1; then
		docker image rm "$id" || true
	fi
done
`;
};

export const cleanupOldDokployImages = async () => {
	const keep = getDokployImageKeepCount();
	if (keep === null) {
		return;
	}
	try {
		await execAsync(
			getDokployImageCleanupCommand(keep, getDokployPreviousImage()),
		);
	} catch (error) {
		console.error("Failed to clean up old Dokploy images", error);
	}
};

export interface DokployImageInfo {
	id: string;
	tags: string[];
	createdAt: string;
	sizeBytes: number;
	/** Bytes not shared with other images, i.e. what deleting it frees. */
	uniqueSizeBytes: number | null;
	forkVersion: string | null;
	officialVersion: string | null;
	isCurrent: boolean;
	/** Exited task containers of the dokploy service; the cleanup removes them. */
	dokployTaskContainers: number;
	/** Containers of anything else; they keep the image from being removed. */
	otherContainers: number;
}

// `docker system df` prints sizes with decimal units (go-units HumanSize).
const parseDockerHumanSize = (size: string | undefined) => {
	const match = size?.trim().match(/^([\d.]+)\s*([kKMGTP]?B)$/);
	if (!match) {
		return null;
	}
	const units: Record<string, number> = {
		B: 1,
		KB: 1e3,
		MB: 1e6,
		GB: 1e9,
		TB: 1e12,
		PB: 1e15,
	};
	return Math.round(
		Number.parseFloat(match[1] as string) *
			(units[(match[2] as string).toUpperCase()] ?? 0),
	);
};

const getDockerUniqueImageSizes = async () => {
	const sizes = new Map<string, number>();
	try {
		const { stdout } = await execAsync(
			"docker system df -v --format '{{json .}}'",
		);
		const data = JSON.parse(stdout) as {
			Images?: { ID?: string; UniqueSize?: string }[];
		};
		for (const image of data.Images ?? []) {
			const size = parseDockerHumanSize(image.UniqueSize);
			if (image.ID && size !== null) {
				sizes.set(image.ID, size);
			}
		}
	} catch (error) {
		console.error("Could not read Docker image unique sizes", error);
	}
	return sizes;
};

/** Lists Dokploy web server images on this host, newest first. */
export const getDokployImages = async (): Promise<DokployImageInfo[]> => {
	const filters = getDokployImageRepositories()
		.map((repository) => `--filter ${quoteShellArg(`reference=${repository}`)}`)
		.join(" ");
	const { stdout: idsOutput } = await execAsync(
		`docker image ls -a -q --no-trunc ${filters} | sort -u`,
	);
	const ids = idsOutput.split("\n").filter(Boolean);
	if (ids.length === 0) {
		return [];
	}

	const [{ stdout: imagesOutput }, { stdout: containersOutput }, uniqueSizes] =
		await Promise.all([
			execAsync(
				`docker image inspect --format '{"id":{{json .Id}},"createdAt":{{json .Created}},"size":{{json .Size}},"tags":{{json .RepoTags}},"config":{{json .Config}}}' ${ids.join(" ")}`,
			),
			execAsync(
				`ids=$(docker ps -aq); if [ -n "$ids" ]; then docker inspect --format '{"image":{{json .Image}},"running":{{json .State.Running}},"service":{{json (index .Config.Labels "com.docker.swarm.service.name")}}}' $ids; fi`,
			),
			getDockerUniqueImageSizes(),
		]);

	const containers = containersOutput
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const container = JSON.parse(line) as {
				image: string;
				running: boolean;
				service: string | null;
			};
			return {
				image: container.image,
				running: container.running,
				isDokployTask: container.service === "dokploy",
			};
		});

	return imagesOutput
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const { id, createdAt, size, tags, config } = JSON.parse(line) as {
				id: string;
				createdAt: string;
				size: number;
				tags: string[] | null;
				config: { Env?: string[] | null } | null;
			};
			const env = config?.Env ?? [];
			const imageContainers = containers.filter(
				(container) => container.image === id,
			);
			return {
				id,
				tags: tags ?? [],
				createdAt,
				sizeBytes: size,
				uniqueSizeBytes: uniqueSizes.get(id) ?? null,
				forkVersion: findEnvValue(env, "DOKPLOY_FORK_VERSION") ?? null,
				officialVersion: findEnvValue(env, "DOKPLOY_OFFICIAL_VERSION") ?? null,
				isCurrent: imageContainers.some(
					(container) => container.isDokployTask && container.running,
				),
				dokployTaskContainers: imageContainers.filter(
					(container) => container.isDokployTask && !container.running,
				).length,
				otherContainers: imageContainers.filter(
					(container) => !container.isDokployTask,
				).length,
			};
		})
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};

/**
 * Old Dokploy images that `removeOldDokployImages` deletes: all but the
 * running one and the previous one. Images that other containers use stay.
 */
export const getRemovableDokployImages = (
	images: DokployImageInfo[],
	previousImage: string | null,
) => {
	const older = images.filter(
		(image) => !image.isCurrent && image.id !== previousImage,
	);
	// Without a recorded previous build, the newest older image stands in for it.
	return (previousImage ? older : older.slice(1)).filter(
		(image) => image.otherContainers === 0,
	);
};

/** Removes every old Dokploy image except the running and the previous one. */
export const removeOldDokployImages = async () => {
	await execAsync(getDokployImageCleanupCommand(0, getDokployPreviousImage()));
};

export interface UpdateDiskSpace {
	availableBytes: number | null;
	totalBytes: number | null;
	/** Size of the running Dokploy image, about what an update downloads. */
	requiredBytes: number | null;
	oldImageCount: number;
	oldImageBytes: number;
	/** The old builds a cleanup removes, newest first. */
	oldImages: DokployImageInfo[];
	buildCacheBytes: number;
}

// Dokploy runs in a container without the host's /var/lib/docker mounted, but
// the container's root is an overlay on that disk, so `df /` reports it.
const getRootDiskSpace = async () => {
	try {
		const { stdout } = await execAsync("df -Pk /");
		const [, total, , available] =
			stdout.trim().split("\n").pop()?.split(/\s+/) ?? [];
		const totalKb = Number(total);
		const availableKb = Number(available);
		if (!Number.isFinite(totalKb) || !Number.isFinite(availableKb)) {
			return null;
		}
		return { totalBytes: totalKb * 1024, availableBytes: availableKb * 1024 };
	} catch (error) {
		console.error("Could not read free disk space", error);
		return null;
	}
};

const getReclaimableBuildCacheBytes = async () => {
	try {
		const { stdout } = await execAsync(
			"docker system df --format '{{json .}}'",
		);
		for (const line of stdout.split("\n").filter(Boolean)) {
			const row = JSON.parse(line) as { Type?: string; Reclaimable?: string };
			if (row.Type === "Build Cache") {
				// Images and volumes print "1.2GB (40%)"; drop the percentage.
				return parseDockerHumanSize(row.Reclaimable?.split(" ")[0]) ?? 0;
			}
		}
	} catch (error) {
		console.error("Could not read Docker build cache size", error);
	}
	return 0;
};

export const getUpdateDiskSpace = async (): Promise<UpdateDiskSpace> => {
	const [disk, images, buildCacheBytes] = await Promise.all([
		getRootDiskSpace(),
		getDokployImages().catch((error) => {
			console.error("Could not list Dokploy images", error);
			return [];
		}),
		getReclaimableBuildCacheBytes(),
	]);
	const removable = getRemovableDokployImages(
		images,
		getDokployPreviousImage(),
	);

	return {
		availableBytes: disk?.availableBytes ?? null,
		totalBytes: disk?.totalBytes ?? null,
		requiredBytes: images.find((image) => image.isCurrent)?.sizeBytes ?? null,
		oldImageCount: removable.length,
		oldImageBytes: removable.reduce(
			(sum, image) => sum + (image.uniqueSizeBytes ?? image.sizeBytes),
			0,
		),
		oldImages: removable,
		buildCacheBytes,
	};
};

// Swarm pulls a tag again whenever it starts a task, so a service that names a
// moving tag such as `agenthits-dev` or `canary` can come up on a newer build
// after a crash, a node reboot or a Docker restart. The update names the build
// it just pulled instead: by digest, which swarm does not pull while the image
// is present, or by image id when the pull left no digest for this repository.
const getPinPulledImageCommand = (image: string) => {
	const reference = image.split("@")[0] ?? image;
	return `pinned_image=""
for pulled_ref in $(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}{{.Id}}' ${quoteShellArg(image)} 2>/dev/null); do
	case "$pulled_ref" in
		${quoteShellArg(getImageRepository(image))}@sha256:*) pinned_image=${quoteShellArg(reference)}"@\${pulled_ref#*@}"; break ;;
		sha256:*) pinned_image="$pulled_ref" ;;
	esac
done
if [ -z "$pinned_image" ]; then
	echo "The pulled image could not be found, so the panel was not updated." >&2
	exit 1
fi`;
};

export const getAgentHitsUpdateCommand = (
	currentVersion: string,
	forkVersion?: string | null,
	officialVersion?: string | null,
	keepImages?: number | null,
) => {
	const image = getAgentHitsUpdateImage();
	const forkVersionArg = forkVersion?.trim()
		? `--env-add ${quoteShellArg(`DOKPLOY_FORK_VERSION=${forkVersion.trim()}`)}`
		: "$fork_version_env_arg";
	const officialVersionArg = officialVersion?.trim()
		? officialVersion.trim()
		: getOfficialDokployVersion(currentVersion);
	const keepImagesArg =
		keepImages === undefined ? "" : getDokployKeepImagesEnvArg(keepImages);

	// Pull while the old container still serves the panel: the update is
	// stop-first, so a pull inside it would happen with Dokploy down. Stop-first
	// also keeps two panel versions from running migrations at the same time.
	return `
docker pull ${quoteShellArg(image)} || exit 1
echo ${quoteShellArg(UPDATE_IMAGE_PULLED_MARKER)}
${RECORD_PREVIOUS_IMAGE}
${getPinPulledImageCommand(image)}
fork_version_env_arg=""
if docker service inspect dokploy --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' 2>/dev/null | grep -q '^DOKPLOY_FORK_VERSION='; then
	fork_version_env_arg="--env-rm DOKPLOY_FORK_VERSION"
fi
docker service update --force --no-resolve-image \\
	--image "$pinned_image" \\
	--env-add ${quoteShellArg(`RELEASE_TAG=${getAgentHitsUpdateTag()}`)} \\
	--env-add ${quoteShellArg(`DOKPLOY_OFFICIAL_VERSION=${officialVersionArg}`)} \\
	${forkVersionArg} \\
	${keepImagesArg} \\
	${PREVIOUS_IMAGE_ENV_ARG} \\
	--update-order stop-first \\
	--update-failure-action rollback \\
	dokploy
`;
};

// A service last updated by an older panel still names a moving tag, so a plain
// forced restart can come up on a newer build (see getPinPulledImageCommand).
// Reload pins the image the panel runs now: by digest, or by image id for a
// build that never came from a registry.
export const getAgentHitsReloadCommand = () => `
running_tasks=$(${DOKPLOY_RUNNING_TASKS})
running_image=""
if [ -n "$running_tasks" ]; then
	running_image=$(docker inspect --format '{{.Image}}' $running_tasks 2>/dev/null | head -n 1)
fi
if [ -z "$running_image" ]; then
	echo "The image of the running panel could not be found, so the panel was not restarted." >&2
	exit 1
fi
reload_image=$(docker image inspect --format '{{index .RepoDigests 0}}' "$running_image" 2>/dev/null || true)
docker service update --force --no-resolve-image \\
	--image "\${reload_image:-$running_image}" \\
	--update-order stop-first \\
	--update-failure-action rollback \\
	dokploy
`;

export const getOfficialUpdateImage = (version: string) =>
	`dokploy/dokploy:${version}`;

export const getOfficialUpdateCommand = (
	version: string,
	keepImages?: number | null,
) => {
	const image = getOfficialUpdateImage(version);
	const keepImagesArg =
		keepImages === undefined ? "" : getDokployKeepImagesEnvArg(keepImages);

	return `
docker pull ${quoteShellArg(image)} || exit 1
echo ${quoteShellArg(UPDATE_IMAGE_PULLED_MARKER)}
${RECORD_PREVIOUS_IMAGE}
${getPinPulledImageCommand(image)}
docker service update --force --no-resolve-image --image "$pinned_image" ${keepImagesArg} ${PREVIOUS_IMAGE_ENV_ARG} --update-order stop-first --update-failure-action rollback dokploy
`;
};

/** Returns Dokploy docker service image digest */
export const getServiceImageDigest = async () => {
	const { stdout } = await execAsync(
		"docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'",
	);

	const currentDigest = stdout.trim().split("@")[1];

	if (!currentDigest) {
		return null;
	}

	return currentDigest;
};

/** Returns latest version number and information whether server update is available by comparing current image's digest against digest for provided image tag via Docker hub API. */
export const getUpdateData = async (
	currentVersion: string,
): Promise<IUpdateData> => {
	try {
		if (isAgentHitsUpdateChannel(currentVersion)) {
			return await getAgentHitsUpdateData(currentVersion);
		}

		const baseUrl =
			"https://hub.docker.com/v2/repositories/dokploy/dokploy/tags";
		let url: string | null = `${baseUrl}?page_size=100`;
		let allResults: { digest: string; name: string }[] = [];

		// Fetch all tags from Docker Hub
		while (url) {
			const response = await fetch(url, {
				method: "GET",
				headers: { "Content-Type": "application/json" },
			});

			const data = (await response.json()) as {
				next: string | null;
				results: { digest: string; name: string }[];
			};

			allResults = allResults.concat(data.results);
			url = data?.next;
		}

		const currentImageTag = getDokployImageTag();

		// Special handling for canary and feature branches
		// For development versions (canary/feature), don't perform update checks
		// These are unstable versions that change frequently, and users on these
		// branches are expected to manually manage updates
		if (currentImageTag === "canary" || currentImageTag === "feature") {
			const currentDigest = await getServiceImageDigest();
			const latestDigest = allResults.find(
				(t) => t.name === currentImageTag,
			)?.digest;
			if (!latestDigest) {
				return DEFAULT_UPDATE_DATA;
			}
			if (currentDigest && currentDigest !== latestDigest) {
				return {
					latestVersion: currentImageTag,
					updateAvailable: true,
				};
			}
			return {
				latestVersion: currentImageTag,
				updateAvailable: false,
			};
		}

		// For stable versions, use semver comparison
		// Find the "latest" tag and get its digest
		const latestTag = allResults.find((t) => t.name === "latest");

		if (!latestTag) {
			return DEFAULT_UPDATE_DATA;
		}

		// Find the versioned tag (v0.x.x) that has the same digest as "latest"
		const latestVersionTag = allResults.find(
			(t) => t.digest === latestTag.digest && t.name.startsWith("v"),
		);

		if (!latestVersionTag) {
			return DEFAULT_UPDATE_DATA;
		}

		const latestVersion = latestVersionTag.name;

		// Use semver to compare versions for stable releases
		const cleanedCurrent = semver.clean(currentVersion);
		const cleanedLatest = semver.clean(latestVersion);

		if (!cleanedCurrent || !cleanedLatest) {
			return DEFAULT_UPDATE_DATA;
		}

		// Check if the latest version is greater than the current version
		const updateAvailable = semver.gt(cleanedLatest, cleanedCurrent);

		return {
			latestVersion,
			updateAvailable,
			updateSource: "official",
			latestImage: `dokploy/dokploy:${latestVersion}`,
		};
	} catch (error) {
		console.error("Error fetching update data:", error);
		return DEFAULT_UPDATE_DATA;
	}
};

interface TreeDataItem {
	id: string;
	name: string;
	type: "file" | "directory";
	children?: TreeDataItem[];
}

const buildTreeFromRemoteFindOutput = (
	dirPath: string,
	encodedOutput: string,
): TreeDataItem[] => {
	const output = encodedOutput.trim();
	if (!output) {
		return [];
	}

	const decoded = Buffer.from(output, "base64").toString("utf8");
	const entries = decoded
		.split("\0")
		.filter(Boolean)
		.map((entry) => {
			const separator = entry.lastIndexOf("\t");
			if (separator === -1) {
				return null;
			}

			return {
				relativePath: entry.slice(0, separator),
				type: entry.slice(separator + 1) === "d" ? "directory" : "file",
			} as const;
		})
		.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
		.sort(
			(a, b) =>
				a.relativePath.split("/").length - b.relativePath.split("/").length,
		);

	const result: TreeDataItem[] = [];
	const directoryChildren = new Map<string, TreeDataItem[]>();

	for (const entry of entries) {
		const name = posix.basename(entry.relativePath);
		const itemPath = posix.join(dirPath, entry.relativePath);
		const item: TreeDataItem = {
			id: itemPath,
			name,
			type: entry.type,
			...(entry.type === "directory" ? { children: [] } : {}),
		};

		const parentPath = posix.dirname(entry.relativePath);
		const target =
			parentPath === "." ? result : directoryChildren.get(parentPath);
		if (!target) {
			continue;
		}

		target.push(item);
		if (entry.type === "directory") {
			directoryChildren.set(
				entry.relativePath,
				item.children as TreeDataItem[],
			);
		}
	}

	return result;
};

export const readDirectory = async (
	dirPath: string,
	serverId?: string,
): Promise<TreeDataItem[]> => {
	if (serverId) {
		const quotedDirPath = quoteShellArg(dirPath);
		const { stdout } = await execAsyncRemote(
			serverId,
			`
set -e
root_dir=${quotedDirPath}
if [ ! -d "$root_dir" ]; then
	exit 0
fi
find "$root_dir" -mindepth 1 -printf '%P\t%y\0' | base64 -w 0
			`,
		);
		return buildTreeFromRemoteFindOutput(dirPath, stdout);
	}

	const stack = [dirPath];
	const result: TreeDataItem[] = [];
	const parentMap: Record<string, TreeDataItem[]> = {};

	while (stack.length > 0) {
		const currentPath = stack.pop();
		if (!currentPath) continue;

		const items = readdirSync(currentPath, { withFileTypes: true });
		const currentDirectoryResult: TreeDataItem[] = [];

		for (const item of items) {
			const fullPath = join(currentPath, item.name);
			if (item.isDirectory()) {
				stack.push(fullPath);
				const directoryItem: TreeDataItem = {
					id: fullPath,
					name: item.name,
					type: "directory",
					children: [],
				};
				currentDirectoryResult.push(directoryItem);
				parentMap[fullPath] = directoryItem.children as TreeDataItem[];
			} else {
				const fileItem: TreeDataItem = {
					id: fullPath,
					name: item.name,
					type: "file",
				};
				currentDirectoryResult.push(fileItem);
			}
		}

		if (parentMap[currentPath]) {
			parentMap[currentPath].push(...currentDirectoryResult);
		} else {
			result.push(...currentDirectoryResult);
		}
	}
	return result;
};

export const getDockerResourceType = async (
	resourceName: string,
	serverId?: string,
) => {
	try {
		let result = "";
		const command = `
RESOURCE_NAME="${resourceName}"
if docker service inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "service"
elif docker inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "standalone"
else
	echo "unknown"
fi`;

		if (serverId) {
			const { stdout } = await execAsyncRemote(serverId, command);
			result = stdout.trim();
		} else {
			const { stdout } = await execAsync(command);
			result = stdout.trim();
		}
		if (result === "service") {
			return "service";
		}
		if (result === "standalone") {
			return "standalone";
		}
		return "unknown";
	} catch (error) {
		console.error(error);
		return "unknown";
	}
};

export const reloadDockerResource = async (
	resourceName: string,
	serverId?: string,
	version?: string,
) => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		if (resourceName === "dokploy") {
			const currentImageTag = getDokployImageTag();
			let imageTag = version;
			if (currentImageTag === "canary" || currentImageTag === "feature") {
				imageTag = currentImageTag;
			}

			command = isAgentHitsUpdateChannel(version || "")
				? getAgentHitsReloadCommand()
				: `docker service update --force --image dokploy/dokploy:${imageTag} ${resourceName}`;
		} else {
			command = `docker service update --force ${resourceName}`;
		}
	} else if (resourceType === "standalone") {
		command = `docker restart ${resourceName}`;
	} else {
		throw new Error("Resource type not found");
	}
	if (serverId) {
		await execAsyncRemote(serverId, command);
	} else {
		await execAsync(command);
	}
};

export const readEnvironmentVariables = async (
	resourceName: string,
	serverId?: string,
) => (await readEnvironmentVariableList(resourceName, serverId)).join("\n");

export const readEnvironmentVariableList = async (
	resourceName: string,
	serverId?: string,
): Promise<string[]> => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		command = `docker service inspect ${resourceName} --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}'`;
	} else if (resourceType === "standalone") {
		command = `docker container inspect ${resourceName} --format '{{json .Config.Env}}'`;
	}
	let result = "";
	if (serverId) {
		const { stdout } = await execAsyncRemote(serverId, command);
		result = stdout.trim();
	} else {
		const { stdout } = await execAsync(command);
		result = stdout.trim();
	}
	if (result === "null") {
		return [];
	}
	return JSON.parse(result) ?? [];
};

export const readPorts = async (
	resourceName: string,
	serverId?: string,
): Promise<
	{ targetPort: number; publishedPort: number; protocol?: string }[]
> => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		command = `docker service inspect ${resourceName} --format '{{json .Spec.EndpointSpec.Ports}}'`;
	} else if (resourceType === "standalone") {
		command = `docker container inspect ${resourceName} --format '{{json .NetworkSettings.Ports}}'`;
	} else {
		throw new Error("Resource type not found");
	}
	let result = "";
	if (serverId) {
		const { stdout } = await execAsyncRemote(serverId, command);
		result = stdout.trim();
	} else {
		const { stdout } = await execAsync(command);
		result = stdout.trim();
	}

	if (result === "null") {
		return [];
	}

	const parsedResult = JSON.parse(result);

	if (resourceType === "service") {
		return parsedResult
			.map((port: any) => ({
				targetPort: port.TargetPort,
				publishedPort: port.PublishedPort,
				protocol: port.Protocol,
			}))
			.filter((port: any) => port.targetPort !== 80 && port.targetPort !== 443);
	}
	const ports: {
		targetPort: number;
		publishedPort: number;
		protocol?: string;
	}[] = [];
	const seenPorts = new Set<string>();
	for (const key in parsedResult) {
		if (Object.hasOwn(parsedResult, key)) {
			const containerPortMappings = parsedResult[key];
			const protocol = key.split("/")[1];
			const targetPort = Number.parseInt(key.split("/")[0] ?? "0", 10);

			// A port the image exposes but the container does not publish comes
			// back as null (Traefik exposes 80, which is never published here).
			// Take only the first mapping to avoid duplicates (IPv4 and IPv6)
			const firstMapping = containerPortMappings?.[0];
			if (firstMapping) {
				const publishedPort = Number.parseInt(firstMapping.HostPort, 10);
				const portKey = `${targetPort}-${publishedPort}-${protocol}`;
				if (!seenPorts.has(portKey)) {
					seenPorts.add(portKey);
					ports.push({
						targetPort: targetPort,
						publishedPort: publishedPort,
						protocol: protocol,
					});
				}
			}
		}
	}
	return ports.filter(
		(port: any) => port.targetPort !== 80 && port.targetPort !== 443,
	);
};

export const checkPortInUse = async (
	port: number,
	serverId?: string,
): Promise<{ isInUse: boolean; conflictingContainer?: string }> => {
	try {
		// Check if port is in use by a Docker container
		const dockerCommand = `docker ps -a --format '{{.Names}}' | grep -v '^dokploy-traefik$' | while read name; do docker port "$name" 2>/dev/null | grep -q ':${port}' && echo "$name" && break; done || true`;
		const { stdout: dockerOut } = serverId
			? await execAsyncRemote(serverId, dockerCommand)
			: await execAsync(dockerCommand);

		const container = dockerOut.trim();

		if (container) {
			return {
				isInUse: true,
				conflictingContainer: `container "${container}"`,
			};
		}

		// Check if port is in use by a host-level service (non-Docker)
		// Dokploy runs inside a container, so we spawn an ephemeral container
		// with --net=host to share the host's network stack and use nc -z to
		// check if something is listening on the port
		const hostCommand = `docker run --rm --net=host busybox sh -c 'nc -z 0.0.0.0 ${port} 2>/dev/null && echo in_use || echo free'`;
		const { stdout: hostOut } = serverId
			? await execAsyncRemote(serverId, hostCommand)
			: await execAsync(hostCommand);

		if (hostOut.includes("in_use")) {
			return {
				isInUse: true,
				conflictingContainer: "a host-level service",
			};
		}

		return { isInUse: false };
	} catch (error) {
		console.error("Error checking port availability:", error);
		return { isInUse: false };
	}
};

const convertTraefikConfigToTls = async (serverId?: string) => {
	// Loaded lazily: a static import would close a cycle through server-setup and monitoring-setup, which import this module.
	const { wrapComponentUpdateSteps } = await import(
		"../setup/server-components"
	);
	const script = wrapComponentUpdateSteps(buildTraefikTlsMigrationStep());
	try {
		if (serverId) {
			await execAsyncRemote(serverId, script);
		} else {
			await execAsync(script);
		}
	} catch (error) {
		const stderr =
			error instanceof ExecError ? error.stderr?.trim() : undefined;
		const detail =
			stderr || (error instanceof Error ? error.message : String(error));
		throw new Error(
			`Traefik config ${TRAEFIK_MAIN_CONFIG_PATH} could not be converted to tlsChallenge. ${detail}`,
		);
	}
};

export const writeTraefikSetup = async (input: TraefikOptions) => {
	await restoreInterruptedTraefik(input.serverId);
	const resourceType = await getDockerResourceType(
		"dokploy-traefik",
		input.serverId,
	);

	if (resourceType === "service") {
		await convertTraefikConfigToTls(input.serverId);
		await initializeTraefikService({
			env: input.env,
			additionalPorts: input.additionalPorts,
			serverId: input.serverId,
		});
		await reconnectServicesToTraefik(input.serverId);
	} else if (resourceType === "standalone") {
		await convertTraefikConfigToTls(input.serverId);
		await initializeStandaloneTraefik({
			env: input.env,
			additionalPorts: input.additionalPorts,
			serverId: input.serverId,
		});

		await reconnectServicesToTraefik(input.serverId);
	} else {
		throw new Error("Traefik resource type not found");
	}
};

const splitImageReference = (image: string) => {
	// Swarm service images carry a @sha256 digest.
	const reference = image.split("@")[0] ?? "";
	const tagStart = reference.lastIndexOf(":");
	// A colon followed by a slash is a registry port, not a tag.
	if (tagStart === -1 || reference.slice(tagStart).includes("/")) {
		return { repository: reference, tag: null };
	}
	return {
		repository: reference.slice(0, tagStart),
		tag: reference.slice(tagStart + 1),
	};
};

export const parseTraefikImageVersion = (image: string) => {
	const { tag } = splitImageReference(image);
	return tag ? (semver.coerce(tag)?.version ?? null) : null;
};

// The exec helpers have no timeout of their own.
const rejectAfter = <T>(promise: Promise<T>, ms: number, message: string) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

const OFFICIAL_TRAEFIK_REPOSITORIES = [
	"traefik",
	"library/traefik",
	"docker.io/traefik",
	"docker.io/library/traefik",
];

type TraefikVersionStatus =
	| "not-found"
	| "custom"
	| "unknown"
	| "outdated"
	| "up-to-date"
	| "newer";

export const getTraefikOverview = async (serverId?: string) => {
	const recommendedVersion = TRAEFIK_VERSION;

	// Unlike getDockerResourceType, an unreachable server throws instead of
	// being reported as a missing Traefik.
	const command = `
if ! docker info >/dev/null 2>&1; then
	echo "docker-unavailable"
elif docker service inspect dokploy-traefik >/dev/null 2>&1; then
	task=$(docker service ps dokploy-traefik --filter desired-state=running --no-trunc -q | head -n 1)
	[ -z "$task" ] && task=$(docker service ps dokploy-traefik --no-trunc -q | head -n 1)
	if [ -n "$task" ]; then
		docker inspect "$task" --format '{{.Spec.ContainerSpec.Image}}|{{.Status.State}}|{{.Status.Timestamp}}'
	else
		echo "$(docker service inspect dokploy-traefik --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}')|stopped|"
	fi
elif docker container inspect dokploy-traefik >/dev/null 2>&1; then
	docker container inspect dokploy-traefik --format '{{.Config.Image}}|{{.State.Status}}|{{.State.StartedAt}}'
else
	echo "missing"
fi`;
	const { stdout } = await rejectAfter(
		serverId ? execAsyncRemote(serverId, command) : execAsync(command),
		30_000,
		"Timed out reading the Traefik status from this server after 30 seconds.",
	);
	const output = stdout.trim();

	if (output === "docker-unavailable") {
		throw new Error(
			"Docker is not reachable on this server. Check that it is installed and running.",
		);
	}
	if (output === "missing") {
		return {
			state: null,
			startedAt: null,
			image: null,
			currentVersion: null,
			recommendedVersion,
			versionStatus: "not-found" as const,
		};
	}

	const [image = "", state = "", startedAt = ""] = output.split("|");
	const currentVersion = parseTraefikImageVersion(image);
	const target = semver.coerce(recommendedVersion)?.version;

	let versionStatus: TraefikVersionStatus = "up-to-date";
	if (
		!OFFICIAL_TRAEFIK_REPOSITORIES.includes(
			splitImageReference(image).repository,
		)
	) {
		versionStatus = "custom";
	} else if (!currentVersion || !target) {
		versionStatus = "unknown";
	} else if (semver.lt(currentVersion, target)) {
		versionStatus = "outdated";
	} else if (semver.gt(currentVersion, target)) {
		versionStatus = "newer";
	}

	return {
		state: state || null,
		startedAt: state === "running" && startedAt ? startedAt : null,
		image,
		currentVersion,
		recommendedVersion,
		versionStatus,
	};
};

// Stays under proxy timeouts (~100s); the download continues in the background.
export const pullTraefikImage = (serverId?: string) =>
	rejectAfter(
		ensureTraefikImage(serverId),
		90_000,
		"the download took longer than 90 seconds. It continues in the background, so try again in a minute.",
	);

export const reconnectServicesToTraefik = async (serverId?: string) => {
	const composeResult = await db.query.compose.findMany({
		where: and(
			...(serverId ? [eq(compose.serverId, serverId)] : []),
			eq(compose.isolatedDeployment, true),
		),
	});

	if (composeResult.length === 0) {
		return;
	}
	let commands = "";

	for (const compose of composeResult) {
		commands += `docker network connect ${compose.appName} $(docker ps --filter "name=dokploy-traefik" -q) >/dev/null 2>&1\n`;
	}

	if (serverId) {
		await execAsyncRemote(serverId, commands);
	} else {
		await execAsync(commands);
	}
};

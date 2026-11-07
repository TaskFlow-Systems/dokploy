import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { docker, paths } from "@dokploy/server/constants";
import { isEncrypted } from "@dokploy/server/lib/encryption";
import type { Compose } from "@dokploy/server/services/compose";
import type { ContainerInfo, ResourceRequirements } from "dockerode";
import { parse } from "dotenv";
import { quote } from "shell-quote";
import { z } from "zod";
import type { ApplicationNested } from "../builders";
import type { LibsqlNested } from "../databases/libsql";
import type { MariadbNested } from "../databases/mariadb";
import type { MongoNested } from "../databases/mongo";
import type { MysqlNested } from "../databases/mysql";
import type { PostgresNested } from "../databases/postgres";
import type { RedisNested } from "../databases/redis";
import {
	type BindMountServiceContext,
	normalizeBindMountHostPath,
} from "../filesystem/bind-mount-path";
import {
	assertNoSymlinkEscapeInsideDirectory,
	getNoSymlinkFilePathGuardCommand,
	quoteShellArg,
	resolveFilePathInsideDirectory,
} from "../filesystem/safe-path";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import { spawnAsync } from "../process/spawnAsync";
import { getRemoteDocker } from "../servers/remote-docker";

interface RegistryAuth {
	username: string;
	password: string;
	registryUrl: string;
}

export const pullImage = async (
	dockerImage: string,
	onData?: (data: any) => void,
	authConfig?: Partial<RegistryAuth>,
): Promise<void> => {
	try {
		if (!dockerImage) {
			throw new Error("Docker image not found");
		}

		if (authConfig?.username && authConfig?.password) {
			await spawnAsync(
				"docker",
				[
					"login",
					authConfig.registryUrl || "",
					"--username",
					authConfig.username,
					"--password-stdin",
				],
				onData,
				{ input: authConfig.password },
			);
		}
		await spawnAsync("docker", ["pull", dockerImage], onData);
	} catch (error) {
		throw error;
	}
};

export const pullRemoteImage = async (
	dockerImage: string,
	serverId: string,
	onData?: (data: any) => void,
	authConfig?: Partial<RegistryAuth>,
): Promise<void> => {
	try {
		if (!dockerImage) {
			throw new Error("Docker image not found");
		}

		const remoteDocker = await getRemoteDocker(serverId);

		await new Promise((resolve, reject) => {
			remoteDocker.pull(
				dockerImage,
				{ authconfig: authConfig },
				(err, stream) => {
					if (err) {
						reject(err);
						return;
					}

					remoteDocker.modem.followProgress(
						stream as Readable,
						(err: Error | null, res) => {
							if (!err) {
								resolve(res);
							}
							if (err) {
								reject(err);
							}
						},
						(event) => {
							onData?.(event);
						},
					);
				},
			);
		});
	} catch (error) {
		throw error;
	}
};

export const containerExists = async (containerName: string) => {
	const container = docker.getContainer(containerName);
	try {
		await container.inspect();
		return true;
	} catch {
		return false;
	}
};

export const stopService = async (appName: string) => {
	try {
		await execAsync(`docker service scale ${quoteShellArg(appName)}=0 `);
	} catch (error) {
		console.error(error);
		return error;
	}
};

export const stopServiceRemote = async (serverId: string, appName: string) => {
	try {
		await execAsyncRemote(
			serverId,
			`docker service scale ${quoteShellArg(appName)}=0 `,
		);
	} catch (error) {
		console.error(error);
		return error;
	}
};

export const getContainerByName = (name: string): Promise<ContainerInfo> => {
	const opts = {
		limit: 1,
		filters: {
			name: [name],
		},
	};
	return new Promise((resolve, reject) => {
		docker.listContainers(opts, (err, containers) => {
			if (err) {
				reject(err);
			} else if (containers?.length === 0) {
				reject(new Error(`No container found with name: ${name}`));
			} else if (containers && containers?.length > 0 && containers[0]) {
				resolve(containers[0]);
			}
		});
	});
};

/**
 * Docker commands sent using this method are held in a hold when Docker is busy.
 *
 * https://github.com/Dokploy/dokploy/pull/3064
 */
export const dockerSafeExec = (exec: string) => `
CHECK_INTERVAL=10
MAX_WAIT=300
WAITED=0

echo "Preparing for execution..."

while true; do
    PROCESSES=$(ps -eo args | awk '$1 ~ /(^|\\/)docker$/')
    # Swarm pulls don't show up in ps (moby/moby#53321)
    PULLING=$(docker node ps self --filter desired-state=running --filter desired-state=ready --format '{{.CurrentState}}' 2>/dev/null | grep '^Preparing')

    if [ -z "$PROCESSES" ] && [ -z "$PULLING" ]; then
        echo "Docker is idle. Starting execution..."
        break
    fi

    if [ "$WAITED" -ge "$MAX_WAIT" ]; then
        echo "Docker still busy after \${MAX_WAIT}s, proceeding anyway." >&2
        break
    fi

    echo "Docker is busy. Will check again in $CHECK_INTERVAL seconds..."
    sleep $CHECK_INTERVAL
    WAITED=$((WAITED + CHECK_INTERVAL))
done

${exec}

echo "Execution completed."
`;

// A stopped Traefik must stay startable; keeping its container also keeps its image from `image prune --all`.
const skipIfTraefikStopped = (command: string) => `
if docker container inspect --format '{{.State.Running}}' dokploy-traefik dokploy-traefik-previous 2>/dev/null | grep -q false; then
    echo "Skipping '${command}': dokploy-traefik is stopped"
else
    ${command}
fi
`;

const cleanupCommands = {
	containers: skipIfTraefikStopped("docker container prune --force"),
	images: "docker image prune --all --force",
	volumes: "docker volume prune --all --force",
	builders: "docker builder prune --all --force",
	system: skipIfTraefikStopped("docker system prune --all --force"),
};

export const cleanupContainers = async (serverId?: string) => {
	try {
		const command = cleanupCommands.containers;

		if (serverId) {
			await execAsyncRemote(serverId, dockerSafeExec(command));
		} else {
			await execAsync(dockerSafeExec(command));
		}
	} catch (error) {
		console.error(error);

		throw error;
	}
};

export const cleanupImages = async (serverId?: string) => {
	try {
		const command = cleanupCommands.images;

		if (serverId) {
			await execAsyncRemote(serverId, dockerSafeExec(command));
		} else await execAsync(dockerSafeExec(command));
	} catch (error) {
		console.error(error);

		throw error;
	}
};

export const cleanupVolumes = async (serverId?: string) => {
	try {
		const command = cleanupCommands.volumes;

		if (serverId) {
			await execAsyncRemote(serverId, dockerSafeExec(command));
		} else {
			await execAsync(dockerSafeExec(command));
		}
	} catch (error) {
		console.error(error);

		throw error;
	}
};

export const cleanupBuilders = async (serverId?: string) => {
	try {
		const command = cleanupCommands.builders;

		if (serverId) {
			await execAsyncRemote(serverId, dockerSafeExec(command));
		} else {
			await execAsync(dockerSafeExec(command));
		}
	} catch (error) {
		console.error(error);

		throw error;
	}
};

export const cleanupSystem = async (serverId?: string) => {
	try {
		const command = cleanupCommands.system;

		if (serverId) {
			await execAsyncRemote(serverId, dockerSafeExec(command));
		} else {
			await execAsync(dockerSafeExec(command));
		}
	} catch (error) {
		console.error(error);

		throw error;
	}
};

export interface DockerDiskUsageItem {
	type: string;
	totalCount: number;
	active: number;
	size: string;
	reclaimable: string;
	sizeBytes: number;
	details?: DockerDiskUsageDetailItem[];
}

export interface DockerDiskUsageDetailItem {
	id: string;
	name: string;
	size: string;
	sizeBytes: number;
	subtitle?: string;
	meta: {
		label: string;
		value: string;
	}[];
}

export interface DockerDiskUsageVerboseDetails {
	images: DockerDiskUsageDetailItem[];
	containers: DockerDiskUsageDetailItem[];
	volumes: DockerDiskUsageDetailItem[];
	buildCache: DockerDiskUsageDetailItem[];
}

export type DockerDiskUsageDetailLimit = 5 | 10 | 15 | null;

// The OpenAPI generator rejects numeric literals in query inputs, which takes
// down the whole /swagger document; a coerced number piped into the literals
// passes its check and also accepts "?detailLimit=5" from REST callers.
export const dockerDiskUsageDetailLimitSchema = z.coerce
	.number()
	.pipe(z.union([z.literal(5), z.literal(10), z.literal(15)]))
	.nullable()
	.optional();

export const resolveDockerDiskUsageDetailLimit = (
	detailLimit?: DockerDiskUsageDetailLimit,
): DockerDiskUsageDetailLimit => (detailLimit === undefined ? 10 : detailLimit);

const parseSizeToBytes = (size: string): number => {
	const match = size.match(/^([\d.]+)\s*([KMGT]?B)$/i);
	if (!match) return 0;
	const value = Number.parseFloat(match[1] as string);
	const unit = (match[2] as string).toUpperCase();
	const multipliers: Record<string, number> = {
		B: 1,
		KB: 1024,
		MB: 1024 ** 2,
		GB: 1024 ** 3,
		TB: 1024 ** 4,
	};
	return value * (multipliers[unit] || 0);
};

const dockerDiskUsageTypeToDetailsKey: Record<
	string,
	keyof DockerDiskUsageVerboseDetails
> = {
	"Build Cache": "buildCache",
	Containers: "containers",
	Images: "images",
	"Local Volumes": "volumes",
};
const splitDockerTableRow = (line: string) =>
	line
		.trim()
		.split(/\s{2,}/)
		.map((item) => item.trim());

const sortDiskUsageDetails = (items: DockerDiskUsageDetailItem[]) =>
	items.sort((a, b) => b.sizeBytes - a.sizeBytes);

interface DockerDiskUsageContainerReference {
	id: string;
	image: string;
	imageId: string;
	name: string;
	state?: string;
}

interface DockerImageInspect {
	Id?: string;
	RepoDigests?: string[];
	RepoTags?: string[];
	GraphDriver?: {
		Data?: Record<string, string>;
	};
}

interface DockerVolumeInspect {
	Driver?: string;
	Mountpoint?: string;
	Name?: string;
}

interface DockerDiskUsageEnrichment {
	containers?: DockerDiskUsageContainerReference[];
	imageInspects?: Map<string, DockerImageInspect>;
	volumeInspects?: Map<string, DockerVolumeInspect>;
}

const parseJsonLines = <T>(stdout: string): T[] =>
	stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as T];
			} catch {
				return [];
			}
		});

const parseJsonArray = <T>(stdout: string): T[] => {
	try {
		const parsed = JSON.parse(stdout);
		return Array.isArray(parsed) ? (parsed as T[]) : [];
	} catch {
		return [];
	}
};

const isDanglingImageName = (name: string) => name === "<none>:<none>";

const isImageIdReference = (reference: string) =>
	/^(sha256:)?[a-f0-9]{12,64}$/.test(reference);

const splitImageReference = (reference: string) => {
	const [repositoryAndTag = reference, digest] = reference.split("@");
	const lastPathSegment = repositoryAndTag.slice(
		repositoryAndTag.lastIndexOf("/") + 1,
	);
	return {
		digest,
		hasTag: lastPathSegment.includes(":"),
		repositoryAndTag,
	};
};

const getImageReferenceName = (reference: string) => {
	const { digest, hasTag, repositoryAndTag } = splitImageReference(reference);
	if (hasTag || !digest) {
		return repositoryAndTag;
	}
	return `${repositoryAndTag}@${digest.slice(0, "sha256:".length + 12)}`;
};

// Docker drops the tag from an image once the tag moves to a newer pull or
// build, and never stores one for an image pulled by digest; the reference a
// container was created from still says what the image is.
const describeUntaggedImage = (references: string[], usedBy: string[]) => {
	const hasMovedTag = references.some((reference) => {
		const { digest, hasTag } = splitImageReference(reference);
		return hasTag && !digest;
	});
	if (hasMovedTag) {
		return "Previous version: the tag now points to another image";
	}
	if (references.length > 0) {
		return "Pulled by digest, no local tag";
	}
	return usedBy.length > 0 ? "Untagged local image" : "Dangling local image";
};

const isContainerOfImage = (
	container: DockerDiskUsageContainerReference,
	detail: DockerDiskUsageDetailItem,
	inspect?: DockerImageInspect,
) =>
	container.imageId === inspect?.Id ||
	container.imageId.startsWith(`sha256:${detail.id}`);

const formatContainerName = (container: DockerDiskUsageContainerReference) =>
	container.state && container.state !== "running"
		? `${container.name} (${container.state})`
		: container.name;

const formatListValue = (items: string[], emptyValue = "--") =>
	items.length > 0 ? items.join(", ") : emptyValue;

const getImagePathFromInspect = (inspect?: DockerImageInspect) => {
	const data = inspect?.GraphDriver?.Data;
	return data?.MergedDir ?? data?.UpperDir ?? data?.WorkDir;
};

export const enrichDockerDiskUsageDetails = (
	details: DockerDiskUsageVerboseDetails,
	enrichment: DockerDiskUsageEnrichment,
): DockerDiskUsageVerboseDetails => {
	const containers = enrichment.containers ?? [];
	const imageInspects = enrichment.imageInspects ?? new Map();
	const volumeInspects = enrichment.volumeInspects ?? new Map();

	return {
		...details,
		images: details.images.map((detail) => {
			const inspect = imageInspects.get(detail.id);
			const fullId = inspect?.Id ?? detail.id;
			const repoTags =
				inspect?.RepoTags?.filter((tag: string) => tag !== "<none>:<none>") ??
				[];
			const repoDigests = inspect?.RepoDigests ?? [];
			const imageContainers = containers
				.filter((container) => isContainerOfImage(container, detail, inspect))
				.sort(
					(a, b) =>
						Number(b.state === "running") - Number(a.state === "running"),
				);
			const usedBy = imageContainers.map(formatContainerName);
			const isUntagged = isDanglingImageName(detail.name);
			const references = [
				...new Set(
					imageContainers
						.map((container) => container.image)
						.filter((reference) => !isImageIdReference(reference)),
				),
			];
			const nameReference = references[0] ?? repoDigests[0];
			const imagePath = getImagePathFromInspect(inspect);
			const extraMeta = [
				{ label: "Full image id", value: fullId },
				{
					label: "Source",
					value: isUntagged
						? formatListValue(references, "dangling local image")
						: detail.name,
				},
				...(repoTags.length > 0
					? [{ label: "Tags", value: formatListValue(repoTags) }]
					: []),
				...(repoDigests.length > 0
					? [{ label: "Digests", value: formatListValue(repoDigests) }]
					: []),
				...(imagePath ? [{ label: "Docker path", value: imagePath }] : []),
				{
					label: "Used by",
					value: formatListValue(usedBy, "no containers reported"),
				},
			];

			return {
				...detail,
				meta: [
					...extraMeta,
					...detail.meta.filter(
						(meta) => meta.label !== "Containers" || usedBy.length === 0,
					),
				],
				name:
					isUntagged && nameReference
						? getImageReferenceName(nameReference)
						: detail.name,
				subtitle: isUntagged
					? describeUntaggedImage(references, usedBy)
					: detail.subtitle,
			};
		}),
		volumes: details.volumes.map((detail) => {
			const inspect = volumeInspects.get(detail.id);
			return {
				...detail,
				meta: [
					...(inspect?.Mountpoint
						? [{ label: "Mountpoint", value: inspect.Mountpoint }]
						: []),
					...(inspect?.Driver
						? [{ label: "Driver", value: inspect.Driver }]
						: []),
					...detail.meta,
				],
			};
		}),
	};
};

export const parseDockerDiskUsageSummary = (
	stdout: string,
): DockerDiskUsageItem[] => {
	const lines = stdout.trim().split("\n").filter(Boolean);
	return lines.map((line) => {
		const data = JSON.parse(line);
		return {
			type: data.Type,
			totalCount: Number.parseInt(data.TotalCount, 10) || 0,
			active: Number.parseInt(data.Active, 10) || 0,
			size: data.Size,
			reclaimable: data.Reclaimable,
			sizeBytes: parseSizeToBytes(data.Size),
		};
	});
};

export const parseDockerDiskUsageVerbose = (
	stdout: string,
): DockerDiskUsageVerboseDetails => {
	const rows: Record<keyof DockerDiskUsageVerboseDetails, string[]> = {
		buildCache: [],
		containers: [],
		images: [],
		volumes: [],
	};
	let currentSection: keyof DockerDiskUsageVerboseDetails | null = null;
	let hasHeader = false;

	for (const line of stdout.split("\n")) {
		const trimmedLine = line.trim();
		if (!trimmedLine) {
			continue;
		}

		if (trimmedLine === "Images space usage:") {
			currentSection = "images";
			hasHeader = false;
			continue;
		}
		if (trimmedLine === "Containers space usage:") {
			currentSection = "containers";
			hasHeader = false;
			continue;
		}
		if (trimmedLine === "Local Volumes space usage:") {
			currentSection = "volumes";
			hasHeader = false;
			continue;
		}
		if (trimmedLine.startsWith("Build cache usage:")) {
			currentSection = "buildCache";
			hasHeader = false;
			continue;
		}

		if (!currentSection) {
			continue;
		}

		if (!hasHeader) {
			hasHeader = true;
			continue;
		}

		rows[currentSection].push(trimmedLine);
	}

	return {
		buildCache: sortDiskUsageDetails(
			rows.buildCache.flatMap((row) => {
				const [id, cacheType, size, created, lastUsed, usage, shared] =
					splitDockerTableRow(row);
				if (!id || !cacheType || !size) {
					return [];
				}

				return {
					id,
					meta: [
						{ label: "Created", value: created ?? "--" },
						{ label: "Last used", value: lastUsed ?? "--" },
						{ label: "Usage", value: usage ?? "--" },
						{ label: "Shared", value: shared ?? "--" },
					],
					name: cacheType,
					size,
					sizeBytes: parseSizeToBytes(size),
				};
			}),
		),
		containers: sortDiskUsageDetails(
			rows.containers.flatMap((row) => {
				const [id, image, command, localVolumes, size, created, status, name] =
					splitDockerTableRow(row);
				if (!id || !image || !size || !name) {
					return [];
				}

				return {
					id,
					meta: [
						{ label: "Image", value: image },
						{ label: "Command", value: command ?? "--" },
						{ label: "Volumes", value: localVolumes ?? "0" },
						{ label: "Created", value: created ?? "--" },
						{ label: "Status", value: status ?? "--" },
					],
					name,
					size,
					sizeBytes: parseSizeToBytes(size),
				};
			}),
		),
		images: sortDiskUsageDetails(
			rows.images.flatMap((row) => {
				const [
					repository,
					tag,
					id,
					created,
					size,
					sharedSize,
					uniqueSize,
					containers,
				] = splitDockerTableRow(row);
				if (!repository || !tag || !id || !size) {
					return [];
				}

				return {
					id,
					meta: [
						{ label: "Created", value: created ?? "--" },
						{ label: "Shared", value: sharedSize ?? "--" },
						{ label: "Unique", value: uniqueSize ?? "--" },
						{ label: "Containers", value: containers ?? "0" },
					],
					name: `${repository}:${tag}`,
					size,
					sizeBytes: parseSizeToBytes(size),
				};
			}),
		),
		volumes: sortDiskUsageDetails(
			rows.volumes.flatMap((row) => {
				const [name, links, size] = splitDockerTableRow(row);
				if (!name || !size) {
					return [];
				}

				return {
					id: name,
					meta: [{ label: "Links", value: links ?? "0" }],
					name,
					size,
					sizeBytes: parseSizeToBytes(size),
				};
			}),
		),
	};
};

const limitDiskUsageDetailItems = (
	items: DockerDiskUsageDetailItem[],
	detailLimit: DockerDiskUsageDetailLimit,
) => (typeof detailLimit === "number" ? items.slice(0, detailLimit) : items);

export const limitDockerDiskUsageDetails = (
	details: DockerDiskUsageVerboseDetails,
	detailLimit: DockerDiskUsageDetailLimit = 10,
): DockerDiskUsageVerboseDetails => ({
	buildCache: limitDiskUsageDetailItems(details.buildCache, detailLimit),
	containers: limitDiskUsageDetailItems(details.containers, detailLimit),
	images: limitDiskUsageDetailItems(details.images, detailLimit),
	volumes: limitDiskUsageDetailItems(details.volumes, detailLimit),
});

// docker ps has no image id and prints a bare id instead of the reference once
// the tag has moved on, so only inspect ties a container to an untagged image.
const dockerContainerReferenceFormat =
	'{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"state":{{json .State.Status}}}';

const getDockerDiskUsageContainerReferences = async (): Promise<
	DockerDiskUsageContainerReference[]
> => {
	const { stdout: idsStdout } = await execAsync("docker ps -aq --no-trunc");
	const containerIds = idsStdout
		.split("\n")
		.map((containerId) => containerId.trim())
		.filter(Boolean);
	if (containerIds.length === 0) {
		return [];
	}

	const { stdout } = await execAsync(
		`docker container inspect --format ${quoteShellArg(
			dockerContainerReferenceFormat,
		)} ${containerIds.map((containerId) => quoteShellArg(containerId)).join(" ")}`,
	);

	return parseJsonLines<{
		id?: string;
		image?: string;
		imageId?: string;
		name?: string;
		state?: string;
	}>(stdout).flatMap((container) => {
		if (
			!container.id ||
			!container.image ||
			!container.imageId ||
			!container.name
		) {
			return [];
		}

		return {
			id: container.id,
			image: container.image,
			imageId: container.imageId,
			name: container.name.replace(/^\//, ""),
			state: container.state,
		};
	});
};

const inspectDockerImages = async (
	images: DockerDiskUsageDetailItem[],
): Promise<Map<string, DockerImageInspect>> => {
	const imageIds = images.map((image) => image.id).filter(Boolean);
	if (imageIds.length === 0) {
		return new Map();
	}

	const command = `docker image inspect ${imageIds
		.map((imageId) => quoteShellArg(imageId))
		.join(" ")}`;
	const { stdout } = await execAsync(command);
	const inspectedImages = parseJsonArray<DockerImageInspect>(stdout);

	return new Map(
		inspectedImages.flatMap((image) => {
			const matchingId = imageIds.find(
				(imageId) =>
					image.Id === imageId ||
					Boolean(image.Id?.startsWith(`sha256:${imageId}`)),
			);

			return matchingId ? [[matchingId, image] as const] : [];
		}),
	);
};

const inspectDockerVolumes = async (
	volumes: DockerDiskUsageDetailItem[],
): Promise<Map<string, DockerVolumeInspect>> => {
	const volumeNames = volumes.map((volume) => volume.id).filter(Boolean);
	if (volumeNames.length === 0) {
		return new Map();
	}

	const command = `docker volume inspect ${volumeNames
		.map((volumeName) => quoteShellArg(volumeName))
		.join(" ")}`;
	const { stdout } = await execAsync(command);
	const inspectedVolumes = parseJsonArray<DockerVolumeInspect>(stdout);

	return new Map(
		inspectedVolumes.flatMap((volume) => {
			const name = volume.Name;
			return name ? [[name, volume] as const] : [];
		}),
	);
};

export const getDockerDiskUsage = async (
	detailLimit: DockerDiskUsageDetailLimit = 10,
	serverId?: string,
): Promise<DockerDiskUsageItem[]> => {
	const summaryCommand = "docker system df --format '{{json .}}'";
	const verboseCommand = "docker system df -v";
	const runCommand = (command: string) =>
		serverId ? execAsyncRemote(serverId, command) : execAsync(command);
	const [summaryResult, verboseResult] = await Promise.all([
		runCommand(summaryCommand),
		runCommand(verboseCommand).catch(() => ({ stdout: "" })),
	]);

	const parsedDetails = parseDockerDiskUsageVerbose(verboseResult.stdout);
	const limitedDetails = limitDockerDiskUsageDetails(
		parsedDetails,
		detailLimit,
	);
	if (serverId) {
		return parseDockerDiskUsageSummary(summaryResult.stdout).map((item) => ({
			...item,
			details: [],
		}));
	}
	const [containers, imageInspects, volumeInspects] = await Promise.all([
		getDockerDiskUsageContainerReferences().catch(() => []),
		inspectDockerImages(limitedDetails.images).catch(() => new Map()),
		inspectDockerVolumes(limitedDetails.volumes).catch(() => new Map()),
	]);
	const details = enrichDockerDiskUsageDetails(limitedDetails, {
		containers,
		imageInspects,
		volumeInspects,
	});

	return parseDockerDiskUsageSummary(summaryResult.stdout).map((item) => {
		const detailsKey = dockerDiskUsageTypeToDetailsKey[item.type];
		return {
			...item,
			details: detailsKey ? details[detailsKey] : [],
		};
	});
};
export interface DockerBuildCacheItem {
	id: string;
	type: string;
	description: string;
	size: string;
	sizeBytes: number;
	createdSince: string;
	lastUsedSince: string;
	usageCount: number;
	shared: boolean;
	inUse: boolean;
}

export const getBuildCache = async (
	serverId?: string,
): Promise<DockerBuildCacheItem[]> => {
	try {
		const command = "docker system df -v --format '{{json .}}'";
		const { stdout } = serverId
			? await execAsyncRemote(serverId, command)
			: await execAsync(command);

		const diskUsage = JSON.parse(stdout.trim());
		return ((diskUsage?.BuildCache ?? []) as Record<string, string>[]).map(
			(entry) => ({
				id: entry.ID ?? "",
				type: entry.CacheType ?? "",
				description: entry.Description ?? "",
				size: entry.Size ?? "",
				sizeBytes: parseSizeToBytes(entry.Size ?? ""),
				createdSince: entry.CreatedSince ?? "",
				lastUsedSince: entry.LastUsedSince ?? "",
				usageCount: Number.parseInt(entry.UsageCount ?? "0", 10) || 0,
				shared: entry.Shared === "true",
				inUse: entry.InUse === "true",
			}),
		);
	} catch (error) {
		console.error(error);
		return [];
	}
};

/**
 * Volume cleanup should always be performed manually by the user. The reason is that during automatic cleanup, a volume may be deleted due to a stopped container, which is a dangerous situation.
 *
 * https://github.com/Dokploy/dokploy/pull/3267
 */
const excludedCleanupAllCommands: (keyof typeof cleanupCommands)[] = [
	"volumes",
];

export const cleanupAll = async (serverId?: string) => {
	for (const [key, command] of Object.entries(cleanupCommands) as [
		keyof typeof cleanupCommands,
		string,
	][]) {
		if (excludedCleanupAllCommands.includes(key)) continue;

		try {
			if (serverId) {
				await execAsyncRemote(serverId, dockerSafeExec(command));
			} else {
				await execAsync(dockerSafeExec(command));
			}
		} catch (error) {
			console.error(
				`Docker cleanup: "${key}" failed${serverId ? ` on server ${serverId}` : ""}`,
				error,
			);
		}
	}
};

export const cleanupAllBackground = async (serverId?: string) => {
	Promise.allSettled(
		(
			Object.entries(cleanupCommands) as [
				keyof typeof cleanupCommands,
				string,
			][]
		)
			.filter(([key]) => !excludedCleanupAllCommands.includes(key))
			.map(async ([, command]) => {
				if (serverId) {
					await execAsyncRemote(serverId, dockerSafeExec(command));
				} else {
					await execAsync(dockerSafeExec(command));
				}
			}),
	)
		.then((results) => {
			const failed = results.filter((r) => r.status === "rejected");
			if (failed.length > 0) {
				console.error(`Docker cleanup: ${failed.length} operations failed`);
			} else {
				console.log("Docker cleanup completed successfully");
			}
		})
		.catch((error) => console.error("Error in cleanup:", error));

	return {
		status: "scheduled",
		message: "Docker cleanup has been initiated in the background",
	};
};

export const startService = async (appName: string) => {
	try {
		await execAsync(`docker service scale ${quoteShellArg(appName)}=1 `);
	} catch (error) {
		console.error(error);
		throw error;
	}
};

export const startServiceRemote = async (serverId: string, appName: string) => {
	try {
		await execAsyncRemote(
			serverId,
			`docker service scale ${quoteShellArg(appName)}=1 `,
		);
	} catch (error) {
		console.error(error);
		throw error;
	}
};

export const removeService = async (
	appName: string,
	serverId?: string | null,
	_deleteVolumes = false,
) => {
	try {
		const command = `docker service rm ${quoteShellArg(appName)}`;

		if (serverId) {
			await execAsyncRemote(serverId, command);
		} else {
			await execAsync(command);
		}
	} catch (error) {
		return error;
	}
};

export const prepareEnvironmentVariables = (
	serviceEnv: string | null,
	projectEnv?: string | null,
	environmentEnv?: string | null,
) => {
	for (const source of [serviceEnv, projectEnv, environmentEnv]) {
		if (source?.includes("${{vault.")) {
			throw new Error(
				"Unresolved vault reference: call withResolvedVaultRefs() on the entity before preparing environment variables",
			);
		}
		// Undecryptable columns arrive as ciphertext that dotenv drops; compose prepends lines, so check each.
		if (source?.split("\n").some((line) => isEncrypted(line.trim()))) {
			throw new Error(
				"Environment variables could not be decrypted. BETTER_AUTH_SECRET or ENCRYPTION_KEY changed after they were saved; restore the previous secret or re-enter the variables.",
			);
		}
	}
	const projectVars = parse(projectEnv ?? "");
	const environmentVars = parse(environmentEnv ?? "");
	const serviceVars = parse(serviceEnv ?? "");

	const resolvedVars = Object.entries(serviceVars).map(([key, value]) => {
		let resolvedValue = value;

		// Replace project variables
		if (projectVars) {
			resolvedValue = resolvedValue.replace(
				/\$\{\{project\.(.*?)\}\}/g,
				(_, ref) => {
					if (projectVars[ref] !== undefined) {
						return projectVars[ref];
					}
					throw new Error(
						`Invalid project environment variable: project.${ref}`,
					);
				},
			);
		}

		// Replace environment variables
		if (environmentVars) {
			resolvedValue = resolvedValue.replace(
				/\$\{\{environment\.(.*?)\}\}/g,
				(_, ref) => {
					if (environmentVars[ref] !== undefined) {
						return environmentVars[ref];
					}
					throw new Error(`Invalid environment variable: environment.${ref}`);
				},
			);
		}

		// Replace self-references (service variables)
		resolvedValue = resolvedValue.replace(/\$\{\{(.*?)\}\}/g, (_, ref) => {
			if (serviceVars[ref] !== undefined) {
				return serviceVars[ref];
			}
			throw new Error(`Invalid service environment variable: ${ref}`);
		});

		return `${key}=${resolvedValue}`;
	});

	return resolvedVars;
};

export const prepareEnvironmentVariablesForShell = (
	serviceEnv: string | null,
	projectEnv?: string | null,
	environmentEnv?: string | null,
): string[] => {
	const envVars = prepareEnvironmentVariables(
		serviceEnv,
		projectEnv,
		environmentEnv,
	);
	// Using shell-quote library to properly escape shell arguments
	// This is the standard way to handle special characters in shell commands
	return envVars.map((env) => quote([env]));
};

export const prepareEnvironmentVariablesForFile = (
	serviceEnv: string | null,
	projectEnv?: string | null,
	environmentEnv?: string | null,
): string[] => {
	const envVars = prepareEnvironmentVariables(
		serviceEnv,
		projectEnv,
		environmentEnv,
	);

	return envVars.map((pair) => {
		const [key, value] = parseEnvironmentKeyValuePair(pair);
		const escapedValue = value
			.replace(/\\/g, "\\\\")
			.replace(/"/g, '\\"')
			.replace(/\$(?!\{[A-Za-z_][A-Za-z0-9_]*(?::?[-+?][^{}]*)?\})/g, "\\$");
		return `${key}="${escapedValue}"`;
	});
};

export const parseEnvironmentKeyValuePair = (
	pair: string,
): [string, string] => {
	const [key, ...valueParts] = pair.split("=");
	if (!key || !valueParts.length) {
		throw new Error(`Invalid environment variable pair: ${pair}`);
	}

	return [key, valueParts.join("=")];
};

export const getEnvironmentVariablesObject = (
	input: string | null,
	projectEnv?: string | null,
	environmentEnv?: string | null,
) => {
	const envs = prepareEnvironmentVariables(input, projectEnv, environmentEnv);

	const jsonObject: Record<string, string> = {};

	for (const pair of envs) {
		const [key, value] = parseEnvironmentKeyValuePair(pair);
		if (key && value) {
			jsonObject[key] = value;
		}
	}

	return jsonObject;
};

export const generateVolumeMounts = (mounts: ApplicationNested["mounts"]) => {
	if (!mounts || mounts.length === 0) {
		return [];
	}

	return mounts
		.filter((mount) => mount.type === "volume")
		.map((mount) => ({
			Type: "volume" as const,
			Source: mount.volumeName || "",
			Target: mount.mountPath,
		}));
};

type Resources = {
	memoryLimit: string | null;
	memoryReservation: string | null;
	cpuLimit: string | null;
	cpuReservation: string | null;
};
export const calculateResources = ({
	memoryLimit,
	memoryReservation,
	cpuLimit,
	cpuReservation,
}: Resources): ResourceRequirements => {
	return {
		Limits: {
			MemoryBytes: memoryLimit ? Number.parseInt(memoryLimit, 10) : undefined,
			NanoCPUs: cpuLimit ? Number.parseInt(cpuLimit, 10) : undefined,
		},
		Reservations: {
			MemoryBytes: memoryReservation
				? Number.parseInt(memoryReservation, 10)
				: undefined,
			NanoCPUs: cpuReservation
				? Number.parseInt(cpuReservation, 10)
				: undefined,
		},
	};
};

export const generateConfigContainer = (
	application: Partial<ApplicationNested>,
) => {
	const {
		healthCheckSwarm,
		restartPolicySwarm,
		placementSwarm,
		updateConfigSwarm,
		rollbackConfigSwarm,
		modeSwarm,
		labelsSwarm,
		replicas,
		mounts,
		stopGracePeriodSwarm,
		endpointSpecSwarm,
		ulimitsSwarm,
	} = application;

	const haveMounts = mounts && mounts.length > 0;

	return {
		...(healthCheckSwarm && {
			HealthCheck: healthCheckSwarm,
		}),
		...(restartPolicySwarm && {
			RestartPolicy: restartPolicySwarm,
		}),
		...(placementSwarm
			? {
					Placement: placementSwarm,
				}
			: {
					// if app have mounts keep manager as constraint
					Placement: {
						Constraints: haveMounts ? ["node.role==manager"] : [],
					},
				}),
		...(labelsSwarm && {
			Labels: labelsSwarm,
		}),
		...(modeSwarm
			? {
					Mode: modeSwarm,
				}
			: {
					// use replicas value if no modeSwarm provided
					Mode: {
						Replicated: {
							Replicas: replicas,
						},
					},
				}),
		...(rollbackConfigSwarm
			? { RollbackConfig: rollbackConfigSwarm }
			: {
					// default rollback config to match update config
					RollbackConfig: {
						Parallelism: 1,
						Order: "start-first",
					},
				}),
		...(updateConfigSwarm
			? { UpdateConfig: updateConfigSwarm }
			: {
					// default config if no updateConfigSwarm provided
					UpdateConfig: {
						Parallelism: 1,
						Order: "start-first",
						FailureAction: "rollback",
					},
				}),
		...(stopGracePeriodSwarm !== null &&
			stopGracePeriodSwarm !== undefined && {
				StopGracePeriod: stopGracePeriodSwarm,
			}),
		...(endpointSpecSwarm && {
			EndpointSpec: {
				...(endpointSpecSwarm.Mode && { Mode: endpointSpecSwarm.Mode }),
				Ports:
					endpointSpecSwarm.Ports?.map((port) => ({
						Protocol: (port.Protocol || "tcp") as "tcp" | "udp" | "sctp",
						TargetPort: port.TargetPort || 0,
						PublishedPort: port.PublishedPort || 0,
						PublishMode: (port.PublishMode || "host") as "ingress" | "host",
					})) || [],
			},
		}),
		...(ulimitsSwarm &&
			ulimitsSwarm.length > 0 && {
				Ulimits: ulimitsSwarm,
			}),
	};
};

export const generateBindMounts = (
	mounts: ApplicationNested["mounts"],
	serviceContext: BindMountServiceContext,
) => {
	if (!mounts || mounts.length === 0) {
		return [];
	}

	return mounts
		.filter((mount) => mount.type === "bind")
		.map((mount) => ({
			Type: "bind" as const,
			Source: normalizeBindMountHostPath(mount.hostPath, serviceContext),
			Target: mount.mountPath,
		}));
};

export const generateFileMounts = (
	appName: string,
	service:
		| ApplicationNested
		| LibsqlNested
		| MongoNested
		| MariadbNested
		| MysqlNested
		| PostgresNested
		| RedisNested,
) => {
	const { mounts } = service;
	const { APPLICATIONS_PATH } = paths(!!service.serverId);
	if (!mounts || mounts.length === 0) {
		return [];
	}

	return mounts
		.filter((mount) => mount.type === "file")
		.map((mount) => {
			const absoluteBasePath = path.resolve(APPLICATIONS_PATH);
			const directory = path.join(absoluteBasePath, appName, "files");
			const { fullPath: sourcePath } = assertNoSymlinkEscapeInsideDirectory(
				directory,
				mount.filePath || "",
			);
			return {
				Type: "bind" as const,
				Source: sourcePath,
				Target: mount.mountPath,
			};
		});
};

export const isValidMountFilePath = (filePath: string) => {
	const relative = path.relative("/base", path.join("/base", filePath));
	return (
		!!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`)
	);
};

export const createFile = async (
	outputPath: string,
	filePath: string,
	content: string,
) => {
	try {
		const { fullPath, isDirectory } = assertNoSymlinkEscapeInsideDirectory(
			outputPath,
			filePath,
		);
		if (isDirectory) {
			fs.mkdirSync(fullPath, { recursive: true });
			return;
		}

		const directory = path.dirname(fullPath);
		fs.mkdirSync(directory, { recursive: true });
		// Docker creates missing bind sources as empty directories if the stack was deployed before the mount existed
		if (fs.lstatSync(fullPath, { throwIfNoEntry: false })?.isDirectory()) {
			fs.rmdirSync(fullPath);
		}
		const fd = fs.openSync(
			fullPath,
			fs.constants.O_WRONLY |
				fs.constants.O_CREAT |
				fs.constants.O_TRUNC |
				(fs.constants.O_NOFOLLOW ?? 0),
			0o666,
		);
		try {
			fs.writeFileSync(fd, content || "");
		} finally {
			fs.closeSync(fd);
		}
	} catch (error) {
		throw error;
	}
};
export const encodeBase64 = (content: string) =>
	Buffer.from(content, "utf-8").toString("base64");

export const getCreateFileCommand = (
	outputPath: string,
	filePath: string,
	content: string,
) => {
	const { fullPath, isDirectory } = resolveFilePathInsideDirectory(
		outputPath,
		filePath,
	);
	const quotedFullPath = quoteShellArg(fullPath);
	const symlinkGuard = getNoSymlinkFilePathGuardCommand(outputPath, fullPath);
	if (isDirectory) {
		return `
		${symlinkGuard}
		mkdir -p ${quotedFullPath};
		`;
	}

	const encodedContent = encodeBase64(content);
	return `
		${symlinkGuard}
		dir="$(dirname "$file")";
		mkdir -p "$dir";
		tmp="$(mktemp "$dir/.dokploy-write.XXXXXX")";
		echo "${encodedContent}" | base64 -d > "$tmp";
		if [ -d "$file" ] && [ ! -L "$file" ]; then rmdir "$file" || { rm -f "$tmp"; exit 1; }; fi;
		mv -f "$tmp" "$file";
		`;
};

export const getServiceContainer = async (
	appName: string,
	serverId?: string | null,
) => {
	try {
		const filter = {
			status: ["running"],
			label: [`com.docker.swarm.service.name=${appName}`],
		};
		const remoteDocker = await getRemoteDocker(serverId);
		const containers = await remoteDocker.listContainers({
			filters: JSON.stringify(filter),
		});

		if (containers.length === 0 || !containers[0]) {
			return null;
		}

		const container = containers[0];

		return container;
	} catch (error) {
		throw error;
	}
};

export const getComposeContainer = async (
	compose: Compose,
	serviceName: string,
) => {
	try {
		const { appName, composeType, serverId } = compose;
		// 1. Determine the correct labels based on composeType
		const labels: string[] = [];
		if (composeType === "stack") {
			// Labels for Docker Swarm stack services
			labels.push(`com.docker.stack.namespace=${appName}`);
			labels.push(`com.docker.swarm.service.name=${appName}_${serviceName}`);
		} else {
			// Labels for Docker Compose projects (default)
			labels.push(`com.docker.compose.project=${appName}`);
			labels.push(`com.docker.compose.service=${serviceName}`);
		}
		const filter = {
			status: ["running"],
			label: labels,
		};

		const remoteDocker = await getRemoteDocker(serverId);
		const containers = await remoteDocker.listContainers({
			filters: JSON.stringify(filter),
			limit: 1,
		});

		if (containers.length === 0 || !containers[0]) {
			return null;
		}

		const container = containers[0];
		return container;
	} catch (error) {
		throw error;
	}
};

type ServiceHealthStatus = {
	status: "healthy" | "unhealthy";
	message?: string;
};

const checkSwarmServiceRunning = async (
	serviceName: string,
): Promise<ServiceHealthStatus> => {
	try {
		const service = docker.getService(serviceName);
		const info = await service.inspect();
		const replicas = info.Spec?.Mode?.Replicated?.Replicas ?? 0;
		if (replicas === 0) {
			return {
				status: "unhealthy",
				message: "Service has 0 replicas configured",
			};
		}

		// Check that at least one task is actually running
		const tasks = await docker.listTasks({
			filters: JSON.stringify({
				service: [serviceName],
				"desired-state": ["running"],
			}),
		});

		const runningTask = tasks.find((t) => t.Status?.State === "running");

		if (!runningTask) {
			const latestTask = tasks[0];
			const taskState = latestTask?.Status?.State ?? "unknown";
			return {
				status: "unhealthy",
				message: `No running tasks (current state: ${taskState})`,
			};
		}

		return { status: "healthy" };
	} catch (error) {
		return {
			status: "unhealthy",
			message: error instanceof Error ? error.message : "Service not found",
		};
	}
};

const getSwarmServiceContainerId = async (
	serviceName: string,
): Promise<string | null> => {
	try {
		const tasks = await docker.listTasks({
			filters: JSON.stringify({
				service: [serviceName],
				"desired-state": ["running"],
			}),
		});

		const runningTask = tasks.find((t) => t.Status?.State === "running");

		return runningTask?.Status?.ContainerStatus?.ContainerID ?? null;
	} catch {
		return null;
	}
};

export class ServiceConvergenceError extends Error {}

const SWARM_UPDATE_START_GRACE_MS = 2_000;
const TASK_START_ALLOWANCE_NS = 30e9;
const DOCKER_DEFAULT_STOP_GRACE_NS = 10e9;
const DOCKER_DEFAULT_MONITOR_NS = 5e9;
const DOCKER_DEFAULT_HEALTH_STEP_NS = 30e9;
const DOCKER_DEFAULT_HEALTH_RETRIES = 3;

type SwarmServiceSpec = {
	Mode?: { Replicated?: { Replicas?: number } };
	UpdateConfig?: { Parallelism?: number; Monitor?: number; Delay?: number };
	TaskTemplate?: {
		RestartPolicy?: { Condition?: string };
		ContainerSpec?: {
			StopGracePeriod?: number;
			Healthcheck?: {
				Test?: string[];
				Interval?: number;
				Timeout?: number;
				Retries?: number;
				StartPeriod?: number;
			};
		};
	};
};

type SwarmTask = {
	CreatedAt?: string;
	DesiredState?: string;
	ID?: string;
	NodeID?: string;
	Slot?: number;
	Version?: { Index?: number };
	Status?: { Err?: string; State?: string; Timestamp?: string };
};

type SwarmServiceState = {
	UpdatedAt?: string;
	Version?: { Index?: number };
};

const REVERTED_OUTCOME =
	"The service returns to its previous configuration, so the changes of this deployment are not running.";

const FAILED_UPDATE_STATES: Record<
	string,
	{ action: string; outcome: string }
> = {
	rollback_started: { action: "is rolling back", outcome: REVERTED_OUTCOME },
	rollback_completed: { action: "rolled back", outcome: REVERTED_OUTCOME },
	rollback_paused: {
		action: "could not finish rolling back",
		outcome: "Some tasks may still run the failed configuration.",
	},
	paused: {
		action: "paused",
		outcome: "It stays paused until the next deployment.",
	},
};

const swarmUpdateBatches = (spec?: SwarmServiceSpec) => {
	const replicas = spec?.Mode?.Replicated?.Replicas ?? 1;
	return Math.max(
		1,
		Math.ceil(replicas / (spec?.UpdateConfig?.Parallelism || replicas || 1)),
	);
};

// Swarm sets no limit of its own: a task waiting for a node keeps an update in
// `updating` forever. Replicas go batch by batch, so a fixed limit would fail
// a healthy update of three replicas that stop slowly. The default spec comes to 45 s.
export const getSwarmConvergenceTimeoutMs = (spec?: SwarmServiceSpec) => {
	const update = spec?.UpdateConfig;
	const container = spec?.TaskTemplate?.ContainerSpec;
	const health = container?.Healthcheck;
	const healthNs =
		health?.Test && health.Test[0] !== "NONE"
			? (health.StartPeriod ?? 0) +
				(health.Retries || DOCKER_DEFAULT_HEALTH_RETRIES) *
					((health.Interval || DOCKER_DEFAULT_HEALTH_STEP_NS) +
						(health.Timeout || DOCKER_DEFAULT_HEALTH_STEP_NS))
			: 0;
	const batchNs =
		(container?.StopGracePeriod ?? DOCKER_DEFAULT_STOP_GRACE_NS) +
		TASK_START_ALLOWANCE_NS +
		healthNs +
		(update?.Monitor ?? DOCKER_DEFAULT_MONITOR_NS) +
		(update?.Delay ?? 0);
	return (swarmUpdateBatches(spec) * batchNs) / 1e6;
};

// The earliest error is the cause. Later ones are its consequences: a replacement
// that the rollback cancels ends with "context canceled". A service also keeps its
// last few tasks, so an error from before this update belongs to an earlier deployment.
const firstTaskError = (tasks: SwarmTask[], updateStartedAt?: string) => {
	const since = updateStartedAt ? Date.parse(updateStartedAt) : 0;
	return tasks
		.filter(
			(task) =>
				task.Status?.Err &&
				!task.Status.Err.includes("context canceled") &&
				Date.parse(task.CreatedAt ?? "") >= since,
		)
		.sort(
			(a, b) =>
				Date.parse(a.Status?.Timestamp ?? "") -
				Date.parse(b.Status?.Timestamp ?? ""),
		)[0]?.Status?.Err;
};

// How long a task had been running when its service last changed, by the cluster's
// own clocks, so the panel's clock plays no part. This is what spares a redeploy that
// changes nothing from watching a task that has been up for days, and a task that
// passed Swarm's watch from being watched again. The timestamp comes from the task's
// node and UpdatedAt from a manager, so a node with a slow clock could make a new task
// look old. The raft indexes order the two changes without any clock and rule that out.
const runningBeforeServiceChangeMs = (
	task: SwarmTask,
	service: SwarmServiceState,
) => {
	const taskChangedSince =
		(task.Version?.Index ?? 0) >= (service.Version?.Index ?? 0);
	if (taskChangedSince) {
		return 0;
	}
	return Math.max(
		0,
		Date.parse(service.UpdatedAt ?? "") -
			Date.parse(task.Status?.Timestamp ?? ""),
	);
};

// With a restart condition other than `any`, a task may end for good: migrations in a
// stack are often written this way. Swarm then sets its DesiredState to `shutdown`, so
// no running task stays behind, and its last run is what tells how the service did. A
// replacement after a failure exists from the moment of the failure, so it is the newest.
const endedRuns = (spec: SwarmServiceSpec | undefined, tasks: SwarmTask[]) => {
	if ((spec?.TaskTemplate?.RestartPolicy?.Condition ?? "any") === "any") {
		return [];
	}
	const newestOfSlot = new Map<string, SwarmTask>();
	for (const task of tasks) {
		const slot = String(task.Slot ?? task.NodeID);
		const newest = newestOfSlot.get(slot);
		if (
			!newest ||
			Date.parse(task.CreatedAt ?? "") > Date.parse(newest.CreatedAt ?? "")
		) {
			newestOfSlot.set(slot, task);
		}
	}
	return [...newestOfSlot.values()].filter(
		(task) => task.DesiredState !== "running",
	);
};

// A pull on the node that runs the task and a HEALTHCHECK of the image itself
// take as long as they take, and a false failure costs more than a late one.
export const QUIET_START_ALLOWANCE_MS = 10 * 60_000;

type SwarmConvergenceOptions = {
	timeoutMs?: number;
	intervalMs?: number;
	// Added per batch to the limit for as long as no task reports an error. A pull
	// and a HEALTHCHECK of the image itself show in no spec, so the limit cannot
	// count them. A crash or "no suitable node" still ends the wait after `timeoutMs`.
	quietStartAllowanceMs?: number;
	readTimeoutMs?: number;
};

// A healthy daemon answers these reads in milliseconds, and a read that times out is
// tried again until the wait's own limit, so this does not have to be generous.
export const SWARM_READ_TIMEOUT_MS = 30_000;

export const waitForSwarmServiceConvergence = async (
	appName: string,
	serverId?: string | null,
	options?: SwarmConvergenceOptions,
): Promise<void> => {
	const intervalMs = options?.intervalMs ?? 2_000;
	const remoteDocker = await getRemoteDocker(serverId);
	const service = remoteDocker.getService(appName);
	const startedAt = Date.now();
	const firstSeenRunningAt = new Map<string, number>();
	// Tasks whose container was found down while Swarm still showed them running.
	const downTasks = new Set<string>();
	let timeoutMs = options?.timeoutMs;
	let quietLimitMs: number | undefined;
	let taskErrorSeenAt: number | undefined;

	const readService = async () => {
		// The limits of this wait run only between reads, and SSH_KEEPALIVE sees a dead
		// network, not a daemon that took the request and stays silent. Without this such
		// a read never ends and the deployment keeps its slot in the queue for good.
		const readTimeoutMs = options?.readTimeoutMs ?? SWARM_READ_TIMEOUT_MS;
		const abortSignal = AbortSignal.timeout(readTimeoutMs);
		try {
			return {
				info: await service.inspect({ abortSignal }),
				tasks: await remoteDocker.listTasks({
					abortSignal,
					filters: JSON.stringify({ service: [appName] }),
				}),
			};
		} catch (error) {
			if (abortSignal.aborted) {
				throw new Error(`no answer within ${readTimeoutMs}ms`);
			}
			throw error;
		}
	};
	const pause = () => new Promise((resolve) => setTimeout(resolve, intervalMs));

	// Under load a node reports a container's exit to Swarm late: with the disks
	// and CPUs of a host busy, a task that crashed after 3 s stayed `running` for
	// 33 s, and this wait took a crashing database for a settled one. The engine
	// of the node knows at once, but the panel reaches only the node it connects
	// to, so tasks elsewhere still go by what Swarm says. Anything that cannot be
	// read here leaves the decision to Swarm, as before.
	let localNodeId: Promise<string | undefined> | undefined;
	const isContainerDown = async (task: {
		NodeID?: string;
		Status?: { ContainerStatus?: { ContainerID?: string } };
	}) => {
		const containerId = task.Status?.ContainerStatus?.ContainerID;
		if (!containerId) return false;
		// dockerode passes abortSignal on, but its types leave it out.
		const readInfo = remoteDocker.info as unknown as (options: {
			abortSignal: AbortSignal;
		}) => Promise<{ Swarm?: { NodeID?: string } } | undefined>;
		localNodeId ??= Promise.resolve()
			.then(() =>
				readInfo.call(remoteDocker, {
					abortSignal: AbortSignal.timeout(
						options?.readTimeoutMs ?? SWARM_READ_TIMEOUT_MS,
					),
				}),
			)
			.then(
				(info) => info?.Swarm?.NodeID || undefined,
				() => undefined,
			);
		const nodeId = await localNodeId;
		if (!nodeId || task.NodeID !== nodeId) return false;
		try {
			const container = await remoteDocker.getContainer(containerId).inspect({
				abortSignal: AbortSignal.timeout(
					options?.readTimeoutMs ?? SWARM_READ_TIMEOUT_MS,
				),
			});
			return container?.State?.Running === false;
		} catch (error) {
			return (error as { statusCode?: number }).statusCode === 404;
		}
	};

	while (true) {
		let state: Awaited<ReturnType<typeof readService>>;
		try {
			state = await readService();
		} catch (error) {
			if ((error as { statusCode?: number }).statusCode === 404) {
				throw error;
			}
			// The update goes on without the panel, so a lost connection says nothing
			// about it.
			const limitMs =
				quietLimitMs ?? options?.timeoutMs ?? getSwarmConvergenceTimeoutMs();
			if (Date.now() - startedAt >= limitMs) {
				throw new ServiceConvergenceError(
					`Could not read the state of service ${appName} within ${limitMs}ms: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			await pause();
			continue;
		}
		const { info, tasks } = state;
		timeoutMs ??= getSwarmConvergenceTimeoutMs(info.Spec);
		quietLimitMs ??=
			timeoutMs +
			swarmUpdateBatches(info.Spec) * (options?.quietStartAllowanceMs ?? 0);
		const desiredTasksCount = info.Spec?.Mode?.Replicated?.Replicas ?? 1;
		const monitorMs =
			(info.Spec?.UpdateConfig?.Monitor ?? DOCKER_DEFAULT_MONITOR_NS) / 1e6;

		const now = Date.now();
		const currentTasks = tasks.filter(
			(task) => task.DesiredState === "running",
		);
		// Swarm watches a task for `Monitor` only during an update, so nothing watches
		// a new service or a new replica, and a restart loop can show a running task on
		// any poll. A restart always makes a new task, so the same ID staying up that
		// long is the check Swarm would have made.
		const settledTasks = currentTasks.filter((task) => {
			if (task.Status?.State !== "running" || downTasks.has(task.ID)) {
				return false;
			}
			const firstSeenAt = firstSeenRunningAt.get(task.ID) ?? now;
			firstSeenRunningAt.set(task.ID, firstSeenAt);
			return (
				now - firstSeenAt + runningBeforeServiceChangeMs(task, info) >=
				monitorMs
			);
		});
		const settledTasksCount = settledTasks.length;
		const updateState: string | undefined = info.UpdateStatus?.State;
		// Until Swarm sets `updating` there is no StartedAt, and the failed tasks a
		// service keeps from an earlier deployment are not this update's.
		const taskError = firstTaskError(
			tasks,
			info.UpdateStatus?.StartedAt ?? info.UpdatedAt,
		);

		const ended = endedRuns(info.Spec, tasks);
		// Swarm counts any task that ends during Monitor against the update, exit 0
		// included, so a short task of this update that did its work ends in `paused`.
		const pausedByCleanEnd =
			updateState === "paused" &&
			ended.length >= desiredTasksCount &&
			ended.every(
				(task) =>
					task.Status?.State === "complete" &&
					Date.parse(task.CreatedAt ?? "") >=
						Date.parse(info.UpdateStatus?.StartedAt ?? ""),
			);

		// The first sight decides: Swarm can replace `rollback_completed` with
		// `completed` seconds later (seen with two replicas), and it reports
		// `rollback_completed` before the old task is up, so the message says
		// nothing about what runs.
		const failure = updateState && FAILED_UPDATE_STATES[updateState];
		if (failure && !pausedByCleanEnd) {
			throw new ServiceConvergenceError(
				`Swarm ${failure.action} the update of service ${appName}: ${taskError ?? "a new task stopped or failed its health check"}. ${failure.outcome}`,
			);
		}

		const elapsedMs = now - startedAt;
		// `service.update` clears UpdateStatus, and Swarm sets `updating` about
		// 50 ms later only if a task has to change: a fresh service, an update
		// with nothing to roll out and a scale change never get a state. Until
		// then the running task is the old one. A task with another ForceUpdate
		// always gets replaced, so for it the wait does not depend on that time.
		const noRolloutPending =
			elapsedMs >= SWARM_UPDATE_START_GRACE_MS &&
			currentTasks.every(
				(task) =>
					task.Spec?.ForceUpdate === info.Spec?.TaskTemplate?.ForceUpdate,
			);
		const rolloutFinished =
			updateState === "completed" ||
			pausedByCleanEnd ||
			(updateState === undefined && noRolloutPending);

		if (rolloutFinished) {
			const failedRun = ended.find(
				(task) =>
					task.Status?.State === "failed" || task.Status?.State === "rejected",
			);
			if (failedRun) {
				throw new ServiceConvergenceError(
					`Service ${appName} ended with an error, and its restart policy does not run it again: ${failedRun.Status?.Err ?? `last state: ${failedRun.Status?.State}`}`,
				);
			}
			const completedRunsCount = ended.filter(
				(task) => task.Status?.State === "complete",
			).length;
			if (settledTasksCount + completedRunsCount >= desiredTasksCount) {
				const down: string[] = [];
				for (const task of settledTasks) {
					if (await isContainerDown(task)) down.push(task.ID);
				}
				if (down.length === 0) {
					return;
				}
				for (const id of down) downTasks.add(id);
			}
		}

		const containerError =
			downTasks.size > 0
				? "a task's container had stopped while Swarm still reported it running"
				: undefined;
		if (taskError || containerError) {
			taskErrorSeenAt ??= now;
		}
		if (
			elapsedMs >= quietLimitMs ||
			(taskErrorSeenAt !== undefined && now - taskErrorSeenAt >= timeoutMs)
		) {
			const lastState = currentTasks[0]?.Status?.State ?? "unknown";
			throw new ServiceConvergenceError(
				`Service ${appName} did not converge within ${Math.min(elapsedMs, quietLimitMs)}ms: ${settledTasksCount}/${desiredTasksCount} tasks stayed running for ${monitorMs / 1000} s${updateState === "updating" ? ", Swarm is still updating it" : ""} (last state: ${lastState}${taskError ? `, task error: ${taskError}` : ""}${containerError ? `, ${containerError}` : ""})`,
			);
		}

		await pause();
	}
};

export const checkPostgresHealth = async (): Promise<ServiceHealthStatus> => {
	const serviceCheck = await checkSwarmServiceRunning("dokploy-postgres");
	if (serviceCheck.status === "unhealthy") {
		return serviceCheck;
	}

	// Verify PostgreSQL actually accepts connections
	const containerId = await getSwarmServiceContainerId("dokploy-postgres");
	if (!containerId) {
		return { status: "unhealthy", message: "Could not find running container" };
	}

	try {
		const exec = await docker.getContainer(containerId).exec({
			Cmd: ["pg_isready", "-U", "dokploy"],
			AttachStdout: true,
			AttachStderr: true,
		});
		const stream = await exec.start({});

		const output = await new Promise<string>((resolve) => {
			let data = "";
			stream.on("data", (chunk: Buffer) => {
				data += chunk.toString();
			});
			stream.on("end", () => resolve(data));
		});

		const inspectResult = await exec.inspect();
		if (inspectResult.ExitCode !== 0) {
			return {
				status: "unhealthy",
				message: `PostgreSQL not ready: ${output.trim()}`,
			};
		}

		return { status: "healthy" };
	} catch (error) {
		return {
			status: "unhealthy",
			message:
				error instanceof Error ? error.message : "Failed to check PostgreSQL",
		};
	}
};

export const checkTraefikHealth = async (): Promise<ServiceHealthStatus> => {
	// Traefik can run as a standalone container or a swarm service
	try {
		const container = docker.getContainer("dokploy-traefik");
		const info = await container.inspect();
		if (!info.State.Running) {
			return {
				status: "unhealthy",
				message: "Container is not running",
			};
		}
		return { status: "healthy" };
	} catch {
		// Not a standalone container, check as swarm service
		return checkSwarmServiceRunning("dokploy-traefik");
	}
};

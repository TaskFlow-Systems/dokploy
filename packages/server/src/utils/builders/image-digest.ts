import type Dockerode from "dockerode";

const SHA256_DIGEST_RE = /@(sha256:[0-9a-f]{64})$/i;
const DOCKER_HUB_PREFIX_RE = /^(?:index\.)?docker\.io\//;

/**
 * Strips `@digest` and an explicit `:tag` while keeping any registry host port
 * (e.g. `registry.example.com:5000/ns/app:latest` -> `registry.example.com:5000/ns/app`).
 */
export const stripImageTag = (imageRef: string): string => {
	const atIndex = imageRef.indexOf("@");
	const withoutDigest = atIndex === -1 ? imageRef : imageRef.slice(0, atIndex);
	const lastSlash = withoutDigest.lastIndexOf("/");
	const lastColon = withoutDigest.lastIndexOf(":");
	return lastColon > lastSlash
		? withoutDigest.slice(0, lastColon)
		: withoutDigest;
};

const normalizeRegistryRepo = (repo: string): string => {
	const stripped = repo.replace(DOCKER_HUB_PREFIX_RE, "");
	if (stripped !== repo) {
		return stripped;
	}
	return repo;
};

const isDockerHubShortRef = (repo: string): boolean => {
	const slashIndex = repo.indexOf("/");
	if (slashIndex === -1) return true;
	const firstSegment = repo.slice(0, slashIndex);
	return (
		firstSegment !== "localhost" &&
		!firstSegment.includes(".") &&
		!firstSegment.includes(":")
	);
};

export const pickPushedImageDigest = (
	imageRef: string,
	repoDigests: readonly string[] | null | undefined,
): string | null => {
	if (SHA256_DIGEST_RE.test(imageRef)) {
		return imageRef;
	}
	if (!repoDigests?.length) {
		return null;
	}

	const targetRepo = stripImageTag(imageRef);
	const allowDockerHubAlias =
		isDockerHubShortRef(targetRepo) || DOCKER_HUB_PREFIX_RE.test(targetRepo);
	const normalizedTarget = normalizeRegistryRepo(targetRepo);

	for (const entry of repoDigests) {
		const match = SHA256_DIGEST_RE.exec(entry);
		if (!match?.[1]) continue;
		const candidateRepo = entry.slice(0, match.index);
		const exactMatch = candidateRepo === targetRepo;
		const hubMatch =
			allowDockerHubAlias &&
			(normalizeRegistryRepo(candidateRepo) === normalizedTarget ||
				(!targetRepo.includes("/") &&
					normalizeRegistryRepo(candidateRepo) ===
						`library/${normalizedTarget}`));
		if (exactMatch || hubMatch) {
			return `${targetRepo}@${match[1].toLowerCase()}`;
		}
	}

	return null;
};

const inspectImageWithTimeout = (
	docker: Dockerode,
	imageRef: string,
	timeoutMs: number,
): Promise<{ RepoDigests?: string[] }> => {
	const abortSignal = AbortSignal.timeout(timeoutMs);
	return new Promise((resolve, reject) => {
		docker.modem.dial(
			{
				path: `/images/${imageRef}/json`,
				method: "GET",
				abortSignal,
				statusCodes: {
					200: true,
					404: "no such image",
					500: "server error",
				},
			},
			(err: Error | null, data?: unknown) => {
				if (err) {
					reject(err);
					return;
				}
				const info =
					data && typeof data === "object" && "RepoDigests" in data
						? (data as { RepoDigests?: string[] })
						: {};
				resolve(info);
			},
		);
	});
};

export const resolvePushedImageRef = async ({
	docker,
	imageRef,
	timeoutMs = 15_000,
}: {
	docker: Dockerode;
	imageRef: string;
	timeoutMs?: number;
}): Promise<string | null> => {
	if (SHA256_DIGEST_RE.test(imageRef)) {
		return imageRef;
	}

	const info = await inspectImageWithTimeout(docker, imageRef, timeoutMs);

	return pickPushedImageDigest(imageRef, info?.RepoDigests);
};

export const preservePinnedDigestOnReload = (
	desiredImage: string,
	currentImage?: string | null,
): string | undefined => {
	if (!currentImage || SHA256_DIGEST_RE.test(desiredImage)) {
		return undefined;
	}
	const match = SHA256_DIGEST_RE.exec(currentImage);
	if (!match?.[1]) {
		return undefined;
	}
	const currentRepo = stripImageTag(currentImage.slice(0, match.index));
	const desiredRepo = stripImageTag(desiredImage);
	if (currentRepo !== desiredRepo) {
		return undefined;
	}
	return `${desiredRepo}@${match[1].toLowerCase()}`;
};

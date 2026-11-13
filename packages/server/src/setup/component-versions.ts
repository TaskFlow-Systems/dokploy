// Every component version the fork installs. install-agenthits.sh, the
// Dockerfile, the CI workflow and the Railpack picker in the UI repeat these
// values; apps/dokploy/__test__/server/component-versions-sync.test.ts fails
// when they drift from this object.
export const PINNED_VERSIONS = {
	node: "26.13.1",
	docker: "29.9.3",
	traefik: "3.7.18",
	postgres: "18.7",
	redis: "8.10.3",
	nixpacks: "1.41.0",
	railpack: "0.43.0",
	buildpacks: "0.40.11",
	rclone: "1.76.0",
} as const;

// The panel's Redis runs the Alpine variant: on 2026-11-13 the Debian tags of
// redis 8.x had not been rebuilt for a week and still shipped zlib1g with two
// fixed high CVEs, while redis:8.10.3-alpine scanned clean.
export const REDIS_IMAGE = `redis:${PINNED_VERSIONS.redis}-alpine`;

export const NIXPACKS_VERSION = PINNED_VERSIONS.nixpacks;
export const RAILPACK_VERSION = PINNED_VERSIONS.railpack;
export const BUILDPACKS_VERSION = PINNED_VERSIONS.buildpacks;

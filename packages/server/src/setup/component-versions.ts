// Every component version the fork installs. install-agenthits.sh, the
// Dockerfile, the CI workflow and the Railpack picker in the UI repeat these
// values; apps/dokploy/__test__/server/component-versions-sync.test.ts fails
// when they drift from this object.
export const PINNED_VERSIONS = {
	node: "26.12.1",
	docker: "29.8.2",
	traefik: "3.7.14",
	postgres: "18.6",
	redis: "8.10.2",
	nixpacks: "1.41.0",
	railpack: "0.40.1",
	buildpacks: "0.40.9",
	rclone: "1.75.1",
} as const;

export const NIXPACKS_VERSION = PINNED_VERSIONS.nixpacks;
export const RAILPACK_VERSION = PINNED_VERSIONS.railpack;
export const BUILDPACKS_VERSION = PINNED_VERSIONS.buildpacks;

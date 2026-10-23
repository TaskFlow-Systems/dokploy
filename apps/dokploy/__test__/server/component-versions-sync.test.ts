import { readFileSync } from "node:fs";
import path from "node:path";
import { PINNED_VERSIONS } from "@dokploy/server/setup/component-versions";
import { TRAEFIK_VERSION } from "@dokploy/server/setup/traefik-setup";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(process.cwd(), "../..");
const read = (file: string) => readFileSync(path.join(repoRoot, file), "utf8");

const pinIn = (text: string, pattern: RegExp) => {
	const match = text.match(pattern);
	if (!match?.[1]) {
		throw new Error(`pin not found: ${pattern}`);
	}
	return match[1];
};

describe("install-agenthits.sh defaults", () => {
	const installer = read("install-agenthits.sh");

	it("pins Docker", () => {
		expect(
			pinIn(installer, /DOCKER_VERSION="\$\{DOCKER_VERSION:-([^}]+)\}"/),
		).toBe(PINNED_VERSIONS.docker);
	});
	it("pins Traefik", () => {
		expect(
			pinIn(installer, /TRAEFIK_IMAGE="\$\{TRAEFIK_IMAGE:-traefik:v([^}]+)\}"/),
		).toBe(PINNED_VERSIONS.traefik);
	});
	it("pins Postgres", () => {
		expect(
			pinIn(
				installer,
				/POSTGRES_IMAGE="\$\{POSTGRES_IMAGE:-postgres:([^}]+)\}"/,
			),
		).toBe(PINNED_VERSIONS.postgres);
	});
	it("pins Redis", () => {
		expect(
			pinIn(installer, /REDIS_IMAGE="\$\{REDIS_IMAGE:-redis:([^}]+)\}"/),
		).toBe(PINNED_VERSIONS.redis);
	});
	it("pins Nixpacks", () => {
		expect(
			pinIn(installer, /NIXPACKS_VERSION="\$\{NIXPACKS_VERSION:-([^}]+)\}"/),
		).toBe(PINNED_VERSIONS.nixpacks);
	});
	it("pins Railpack", () => {
		expect(
			pinIn(installer, /RAILPACK_VERSION="\$\{RAILPACK_VERSION:-([^}]+)\}"/),
		).toBe(PINNED_VERSIONS.railpack);
	});
	it("pins Buildpacks", () => {
		expect(
			pinIn(
				installer,
				/BUILDPACKS_VERSION="\$\{BUILDPACKS_VERSION:-([^}]+)\}"/,
			),
		).toBe(PINNED_VERSIONS.buildpacks);
	});
	it("pins RClone", () => {
		expect(
			pinIn(installer, /RCLONE_VERSION="\$\{RCLONE_VERSION:-([^}]+)\}"/),
		).toBe(PINNED_VERSIONS.rclone);
	});
});

describe("update.sh defaults", () => {
	const updateScript = read("update.sh");

	it("pins Docker", () => {
		expect(
			pinIn(updateScript, /DOCKER_VERSION="\$\{DOCKER_VERSION:-([^}]+)\}"/),
		).toBe(PINNED_VERSIONS.docker);
	});
});

describe("Dockerfile", () => {
	const dockerfile = read("Dockerfile");

	it("pins Docker", () => {
		expect(pinIn(dockerfile, /ARG DOCKER_VERSION=(\S+)/)).toBe(
			PINNED_VERSIONS.docker,
		);
	});
	it("pins RClone", () => {
		expect(pinIn(dockerfile, /ARG RCLONE_VERSION=(\S+)/)).toBe(
			PINNED_VERSIONS.rclone,
		);
	});
	it("pins Nixpacks", () => {
		expect(pinIn(dockerfile, /ARG NIXPACKS_VERSION=(\S+)/)).toBe(
			PINNED_VERSIONS.nixpacks,
		);
	});
	it("pins Railpack", () => {
		expect(pinIn(dockerfile, /ARG RAILPACK_VERSION=(\S+)/)).toBe(
			PINNED_VERSIONS.railpack,
		);
	});
	it("pins pack", () => {
		expect(pinIn(dockerfile, /buildpacksio\/pack:(\S+) /)).toBe(
			PINNED_VERSIONS.buildpacks,
		);
	});
});

describe("CI workflow", () => {
	const ci = read(".github/workflows/pull-request.yml");

	it("pins Nixpacks", () => {
		expect(pinIn(ci, /export NIXPACKS_VERSION=(\S+)/)).toBe(
			PINNED_VERSIONS.nixpacks,
		);
	});
	it("pins Railpack", () => {
		expect(pinIn(ci, /export RAILPACK_VERSION=(\S+)/)).toBe(
			PINNED_VERSIONS.railpack,
		);
	});
});

describe("application Railpack picker", () => {
	const picker = read(
		"apps/dokploy/components/dashboard/application/build/show.tsx",
	);

	it("defaults new applications to the pinned Railpack", () => {
		expect(
			pinIn(
				picker,
				/railpackVersion: z\.string\(\)\.nullable\(\)\.default\("([^"]+)"\)/,
			),
		).toBe(PINNED_VERSIONS.railpack);
	});
	it("offers the pinned Railpack in the version list", () => {
		expect(picker).toContain(`\t"${PINNED_VERSIONS.railpack}",`);
	});
});

describe("panel Traefik default", () => {
	it("matches the pin", () => {
		expect(TRAEFIK_VERSION).toBe(PINNED_VERSIONS.traefik);
	});
});

describe("Node.js image and CI version", () => {
	const dockerfiles = [
		"Dockerfile",
		"Dockerfile.cloud",
		"Dockerfile.schedule",
		"Dockerfile.server",
	];

	it.each(dockerfiles)("%s builds on the pinned Node image", (file) => {
		expect(pinIn(read(file), /FROM node:([\d.]+)-bookworm-slim AS base/)).toBe(
			PINNED_VERSIONS.node,
		);
	});

	it.each([
		".github/workflows/dokploy.yml",
		".github/workflows/pull-request.yml",
		".github/workflows/sync-openapi-docs.yml",
	])("%s runs on the pinned Node version", (file) => {
		const versions = [...read(file).matchAll(/node-version: (\S+)/g)].map(
			(match) => match[1],
		);
		expect(versions.length).toBeGreaterThan(0);
		expect(versions.every((version) => version === PINNED_VERSIONS.node)).toBe(
			true,
		);
	});
});

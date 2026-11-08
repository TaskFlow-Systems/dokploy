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

// The daily pins update pushes with the workflow token, which may not change
// files under .github/workflows, so workflows read each version from a file
// the update rewrites.
describe("workflows hold no pinned version", () => {
	const workflows = [
		"pull-request.yml",
		"dependency-audit.yml",
		"deps-auto-update.yml",
		"sync-openapi-docs.yml",
		"dokploy.yml",
		"image-audit.yml",
	].map((file) => [file, read(`.github/workflows/${file}`)] as const);

	it.each(workflows)("%s sets up Bun and Node from files", (_, text) => {
		expect(text).not.toMatch(/bun-version:/);
		expect(text).not.toMatch(/node-version:/);
		for (const match of text.matchAll(/oven-sh\/setup-bun@\S+\n\s+with:\n\s+(\S+)/g)) {
			expect(match[1]).toBe("bun-version-file:");
		}
	});

	it.each(workflows)("%s names no pinned version", (_, text) => {
		for (const version of Object.values(PINNED_VERSIONS)) {
			expect(text).not.toMatch(
				new RegExp(`[:=v]${version.replaceAll(".", "\\.")}(?![\\w.])`),
			);
		}
	});

	it("pull-request.yml installs the Dockerfile's Nixpacks, Railpack and mise", () => {
		const ci = read(".github/workflows/pull-request.yml");
		for (const name of ["NIXPACKS", "RAILPACK", "MISE"]) {
			expect(ci).toContain(
				`${name}_VERSION="$(sed -n "s/^ARG ${name}_VERSION=//p" Dockerfile)"`,
			);
		}
	});
});

describe("version files", () => {
	it("Bun in packageManager matches the Dockerfiles", () => {
		const bun = pinIn(read("Dockerfile"), /bun-v([\d.]+)/);
		for (const file of [
			"package.json",
			"apps/api/package.json",
			"apps/dokploy/package.json",
			"apps/schedules/package.json",
			"packages/server/package.json",
		]) {
			expect(JSON.parse(read(file)).packageManager).toBe(`bun@${bun}`);
		}
		for (const file of [
			"Dockerfile.cloud",
			"Dockerfile.schedule",
			"Dockerfile.server",
			".devcontainer/Dockerfile",
		]) {
			expect(pinIn(read(file), /bun-v([\d.]+)/)).toBe(bun);
		}
	});
	it(".nvmrc holds the pinned Node", () => {
		expect(read(".nvmrc").trim()).toBe(PINNED_VERSIONS.node);
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

describe("Node.js image", () => {
	const dockerfiles = [
		"Dockerfile",
		"Dockerfile.cloud",
		"Dockerfile.schedule",
		"Dockerfile.server",
	];

	const nodeImage =
		/FROM node:([\d.]+)-trixie-slim@(sha256:[0-9a-f]{64}) AS base/;

	it.each(dockerfiles)("%s builds on the pinned Node image", (file) => {
		expect(pinIn(read(file), nodeImage)).toBe(PINNED_VERSIONS.node);
	});

	it("pins the same Node image digest in every Dockerfile", () => {
		const digests = dockerfiles.map((file) => read(file).match(nodeImage)?.[2]);
		expect(new Set(digests).size).toBe(1);
	});

	it("dev container builds on the same image", () => {
		const image = read("Dockerfile").match(nodeImage)?.slice(1, 3).join("-trixie-slim@");
		expect(read(".devcontainer/Dockerfile")).toContain(`FROM node:${image}`);
	});
});

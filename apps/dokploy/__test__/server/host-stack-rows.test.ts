import { PINNED_VERSIONS } from "@dokploy/server/setup/component-versions";
import {
	buildHostStackRows,
	HOST_STACK_COMPONENTS,
	type HostStackReadings,
	type HostStackRow,
	hostStackRefusals,
	isHostStackUiComponent,
} from "@dokploy/server/setup/host-stack-rows";
import { TRAEFIK_VERSION } from "@dokploy/server/setup/traefik-setup";
import { describe, expect, it } from "vitest";

const pinnedPostgresMajor = PINNED_VERSIONS.postgres.split(".")[0];

const upToDate: HostStackReadings = {
	docker: PINNED_VERSIONS.docker,
	traefikImage: `traefik:v${TRAEFIK_VERSION}`,
	postgresImage: `postgres:${PINNED_VERSIONS.postgres}`,
	redisImage: `redis:${PINNED_VERSIONS.redis}`,
	panel: {
		installed: "agenthits-dev",
		latest: "agenthits-dev",
		updateAvailable: false,
	},
};

const rowsFor = (overrides: Partial<HostStackReadings>) =>
	buildHostStackRows({ ...upToDate, ...overrides });

const rowNamed = (rows: HostStackRow[], name: HostStackRow["name"]) => {
	const row = rows.find((candidate) => candidate.name === name);
	if (!row) {
		throw new Error(`no row named ${name}`);
	}
	return row;
};

describe("buildHostStackRows", () => {
	it("lists the panel host components in stack order", () => {
		expect(rowsFor({}).map((row) => row.name)).toEqual([
			"panel",
			"docker",
			"traefik",
			"postgres",
			"redis",
		]);
	});

	it("reports every component as current when the installed versions match the pins", () => {
		for (const row of rowsFor({})) {
			expect(row.status, row.name).toBe("current");
			expect(row.outdated, row.name).toBe(false);
		}
	});

	it("keeps the downtime and maintenance-window reasons even when the rows are current", () => {
		const rows = rowsFor({});

		expect(rowNamed(rows, "docker")).toMatchObject({
			action: "docker",
			command: "DOCKER_ENGINE_UPGRADE=1 bash install-agenthits.sh update",
		});
		expect(rowNamed(rows, "docker").reason).toContain("restarts Docker");
		expect(rowNamed(rows, "postgres")).toMatchObject({
			action: "manual",
			command: null,
		});
		expect(rowNamed(rows, "postgres").reason).toContain("maintenance window");
	});

	it("gives Traefik and Redis no reason or command, since the panel runs them", () => {
		const rows = rowsFor({
			traefikImage: "traefik:v3.6.1",
			redisImage: "redis:7",
		});

		for (const name of ["traefik", "redis"] as const) {
			expect(rowNamed(rows, name)).toMatchObject({
				action: "ui",
				reason: null,
				command: null,
			});
		}
	});

	it("offers the panel's own upgrade for Docker Engine behind its pin and keeps the manual command", () => {
		const docker = rowNamed(rowsFor({ docker: "29.4.1" }), "docker");

		expect(docker).toMatchObject({
			installed: "29.4.1",
			target: PINNED_VERSIONS.docker,
			outdated: true,
			action: "docker",
			command: "DOCKER_ENGINE_UPGRADE=1 bash install-agenthits.sh update",
		});
		expect(docker.reason).toContain("rolls Docker back");
	});

	it("compares Docker Engine versions numerically", () => {
		expect(rowNamed(rowsFor({ docker: "29.10.0" }), "docker").outdated).toBe(
			false,
		);
		expect(rowNamed(rowsFor({ docker: "29.8.1" }), "docker").outdated).toBe(
			true,
		);
	});

	it("reads the Traefik version from its image tag and marks it updatable from the panel", () => {
		const traefik = rowNamed(
			rowsFor({ traefikImage: "traefik:v3.6.1" }),
			"traefik",
		);

		expect(traefik).toMatchObject({
			installed: "3.6.1",
			target: TRAEFIK_VERSION,
			outdated: true,
			action: "ui",
			reason: null,
			command: null,
		});
	});

	it("treats Traefik at the pinned version as current", () => {
		expect(
			rowNamed(
				rowsFor({ traefikImage: `traefik:v${TRAEFIK_VERSION}` }),
				"traefik",
			).outdated,
		).toBe(false);
	});

	it("compares Postgres by major version and reports a major change as manual", () => {
		const postgres = rowNamed(
			rowsFor({ postgresImage: "postgres:16" }),
			"postgres",
		);

		expect(postgres).toMatchObject({
			installed: "16",
			target: PINNED_VERSIONS.postgres,
			outdated: true,
			action: "manual",
			command: "POSTGRES_IMAGE=postgres:16 bash install-agenthits.sh update",
		});
		expect(postgres.reason).toBe(
			`Major version change (16 to ${pinnedPostgresMajor}) needs a migration. The panel never changes the Postgres major version.`,
		);
	});

	it("compares the full Postgres version within the pinned major", () => {
		const current = rowNamed(
			rowsFor({ postgresImage: `postgres:${PINNED_VERSIONS.postgres}-alpine` }),
			"postgres",
		);

		expect(current).toMatchObject({
			installed: PINNED_VERSIONS.postgres,
			status: "current",
			outdated: false,
			command: null,
		});

		const minorBehind = rowNamed(
			rowsFor({ postgresImage: `postgres:${pinnedPostgresMajor}` }),
			"postgres",
		);

		expect(minorBehind).toMatchObject({
			installed: pinnedPostgresMajor,
			target: PINNED_VERSIONS.postgres,
			status: "outdated",
			outdated: true,
			action: "manual",
			command: null,
		});
		expect(minorBehind.reason).toContain("maintenance window");
	});

	it("compares Postgres minor versions numerically", () => {
		expect(
			rowNamed(
				rowsFor({ postgresImage: `postgres:${pinnedPostgresMajor}.10` }),
				"postgres",
			).outdated,
		).toBe(false);
	});

	it("keeps the image digest out of the Postgres command", () => {
		const postgres = rowNamed(
			rowsFor({ postgresImage: "postgres:16@sha256:abcdef0123" }),
			"postgres",
		);

		expect(postgres.command).toBe(
			"POSTGRES_IMAGE=postgres:16 bash install-agenthits.sh update",
		);
	});

	it("marks Redis behind its pin as updatable from the panel, comparing versions numerically", () => {
		expect(rowNamed(rowsFor({ redisImage: "redis:7" }), "redis")).toMatchObject(
			{
				installed: "7",
				target: PINNED_VERSIONS.redis,
				outdated: true,
				action: "ui",
			},
		);
		expect(
			rowNamed(rowsFor({ redisImage: "redis:8.9.9" }), "redis").outdated,
		).toBe(true);
		expect(
			rowNamed(rowsFor({ redisImage: "redis:8.10.2" }), "redis").outdated,
		).toBe(false);
	});

	it("reports components whose version cannot be read as unknown rather than outdated", () => {
		const rows = rowsFor({
			docker: null,
			traefikImage: null,
			postgresImage: "postgres:latest",
			redisImage: "redis:latest",
		});

		for (const name of ["docker", "traefik", "postgres", "redis"] as const) {
			const row = rowNamed(rows, name);
			expect(row.status, name).toBe("unknown");
			expect(row.outdated, name).toBe(false);
			expect(row.installed, name).toBeNull();
			expect(row.command, name).toBe(
				name === "docker"
					? "DOCKER_ENGINE_UPGRADE=1 bash install-agenthits.sh update"
					: null,
			);
			expect(row.reason, name).not.toBeNull();
		}
	});

	it("marks the panel outdated when its update check reports a newer build", () => {
		expect(
			rowNamed(
				rowsFor({
					panel: {
						installed: "agenthits-dev",
						latest: "agenthits-dev-2",
						updateAvailable: true,
					},
				}),
				"panel",
			),
		).toMatchObject({
			installed: "agenthits-dev",
			target: "agenthits-dev-2",
			status: "outdated",
			outdated: true,
			action: "panel",
		});
	});

	it("reports the panel as unknown when the update check did not return a version", () => {
		expect(
			rowNamed(
				rowsFor({
					panel: {
						installed: "agenthits-dev",
						latest: null,
						updateAvailable: null,
					},
				}),
				"panel",
			),
		).toMatchObject({
			status: "unknown",
			outdated: false,
			action: "panel",
			target: null,
		});
	});
});

describe("host stack update rules", () => {
	it("allows the panel to update only Traefik and Redis", () => {
		expect(HOST_STACK_COMPONENTS.filter(isHostStackUiComponent)).toEqual([
			"traefik",
			"redis",
		]);
	});

	it("refuses docker, postgres and panel with a message that names the next step", () => {
		const refusals = hostStackRefusals([
			"traefik",
			"docker",
			"postgres",
			"panel",
		]);

		expect(refusals).toHaveLength(3);
		expect(refusals[0]).toContain("its own button");
		expect(refusals[1]).toContain("POSTGRES_IMAGE");
		expect(refusals[2]).toContain("Web Server Update");
		expect(hostStackRefusals(["traefik", "redis"])).toEqual([]);
	});
});

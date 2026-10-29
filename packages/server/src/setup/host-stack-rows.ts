import { PINNED_VERSIONS } from "./component-versions";
import { TRAEFIK_VERSION } from "./traefik-setup";

export const HOST_STACK_COMPONENTS = [
	"panel",
	"docker",
	"traefik",
	"postgres",
	"redis",
] as const;

export type HostStackComponent = (typeof HOST_STACK_COMPONENTS)[number];

export const HOST_STACK_UI_COMPONENTS = ["traefik", "redis"] as const;

export type HostStackUiComponent = (typeof HOST_STACK_UI_COMPONENTS)[number];

export type HostStackAction = "panel" | "ui" | "docker" | "manual";

export type HostStackStatus = "current" | "outdated" | "unknown";

export type HostStackRow = {
	name: HostStackComponent;
	installed: string | null;
	target: string | null;
	status: HostStackStatus;
	outdated: boolean;
	action: HostStackAction;
	reason: string | null;
	command: string | null;
};

export type HostStackReadings = {
	docker: string | null;
	traefikImage: string | null;
	postgresImage: string | null;
	redisImage: string | null;
	panel: {
		installed: string | null;
		latest: string | null;
		updateAvailable: boolean | null;
	};
};

export const isHostStackUiComponent = (
	name: HostStackComponent,
): name is HostStackUiComponent =>
	(HOST_STACK_UI_COMPONENTS as readonly string[]).includes(name);

const INSTALLER_UPDATE = "bash install-agenthits.sh update";
const DOCKER_UPGRADE_COMMAND = `DOCKER_ENGINE_UPGRADE=1 ${INSTALLER_UPDATE}`;
const UNKNOWN_REASON =
	"The installed version could not be read on the panel host.";
const PANEL_UNKNOWN_REASON =
	"The update check did not return a version for this panel.";
const DOCKER_REASON =
	"Upgrading restarts Docker: every site on this server and this panel stop for a minute or two. The upgrade runs on the host and rolls Docker back by itself if the services do not come back healthy.";
const POSTGRES_REASON =
	"Postgres changes only in the maintenance window, and keeps its major version.";

const HOST_STACK_REFUSALS: Record<
	Exclude<HostStackComponent, HostStackUiComponent>,
	string
> = {
	panel: "The panel is updated from the Web Server Update dialog.",
	docker:
		"Docker Engine is upgraded with its own button in the Panel host components list, because the daemon restart stops this panel.",
	postgres:
		"Postgres is not updated from the panel, and its major version never changes here. In the maintenance window run the host update with POSTGRES_IMAGE set to the image Postgres runs now (see the Panel host components list).",
};

const withoutDigest = (image: string) => image.split("@")[0] ?? image;

const imageTag = (image: string) => {
	const name = withoutDigest(image);
	const slash = name.lastIndexOf("/");
	const colon = name.lastIndexOf(":");
	return colon > slash ? name.slice(colon + 1) : null;
};

const VERSION_PATTERN = /\d+(?:\.\d+)*/;

const versionOf = (value: string | null) =>
	value?.match(VERSION_PATTERN)?.[0] ?? null;

const imageVersion = (image: string | null) =>
	versionOf(image ? imageTag(image) : null);

const postgresVersion = (image: string | null) =>
	(image ? imageTag(image) : null)?.match(/^\d+(?:\.\d+)*/)?.[0] ?? null;

const compareVersions = (left: string, right: string) => {
	const leftParts = left.split(".").map(Number);
	const rightParts = right.split(".").map(Number);
	const length = Math.max(leftParts.length, rightParts.length);
	for (let index = 0; index < length; index += 1) {
		const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (difference !== 0) {
			return difference;
		}
	}
	return 0;
};

const unknownRow = (
	name: HostStackComponent,
	target: string | null,
	action: HostStackAction,
): HostStackRow => ({
	name,
	installed: null,
	target,
	status: "unknown",
	outdated: false,
	action,
	reason: UNKNOWN_REASON,
	command: null,
});

const panelRow = ({
	installed,
	latest,
	updateAvailable,
}: HostStackReadings["panel"]): HostStackRow => {
	if (updateAvailable === null) {
		return {
			name: "panel",
			installed,
			target: latest,
			status: "unknown",
			outdated: false,
			action: "panel",
			reason: PANEL_UNKNOWN_REASON,
			command: null,
		};
	}
	return {
		name: "panel",
		installed,
		target: latest,
		status: updateAvailable ? "outdated" : "current",
		outdated: updateAvailable,
		action: "panel",
		reason: null,
		command: null,
	};
};

export const dockerRow = (readout: string | null): HostStackRow => {
	const target = PINNED_VERSIONS.docker;
	const installed = versionOf(readout);
	if (installed === null) {
		return {
			...unknownRow("docker", target, "docker"),
			command: DOCKER_UPGRADE_COMMAND,
		};
	}
	const outdated = compareVersions(installed, target) < 0;
	return {
		name: "docker",
		installed,
		target,
		status: outdated ? "outdated" : "current",
		outdated,
		action: "docker",
		reason: DOCKER_REASON,
		command: DOCKER_UPGRADE_COMMAND,
	};
};

const traefikRow = (image: string | null): HostStackRow => {
	const target = TRAEFIK_VERSION;
	const installed = imageVersion(image);
	if (installed === null) {
		return unknownRow("traefik", target, "ui");
	}
	const outdated = compareVersions(installed, target) < 0;
	return {
		name: "traefik",
		installed,
		target,
		status: outdated ? "outdated" : "current",
		outdated,
		action: "ui",
		reason: null,
		command: null,
	};
};

const postgresRow = (image: string | null): HostStackRow => {
	const target = PINNED_VERSIONS.postgres;
	const targetMajor = Number(target.split(".")[0]);
	const installed = postgresVersion(image);
	if (image === null || installed === null) {
		return unknownRow("postgres", target, "manual");
	}
	const installedMajor = Number(installed.split(".")[0]);
	const majorChanged = installedMajor !== targetMajor;
	const outdated = majorChanged
		? installedMajor < targetMajor
		: compareVersions(installed, target) < 0;
	return {
		name: "postgres",
		installed,
		target,
		status: outdated ? "outdated" : "current",
		outdated,
		action: "manual",
		reason:
			majorChanged && outdated
				? `Major version change (${installedMajor} to ${targetMajor}) needs a migration. The panel never changes the Postgres major version.`
				: POSTGRES_REASON,
		command: majorChanged
			? `POSTGRES_IMAGE=${withoutDigest(image)} ${INSTALLER_UPDATE}`
			: null,
	};
};

const redisRow = (image: string | null): HostStackRow => {
	const target = PINNED_VERSIONS.redis;
	const installed = imageVersion(image);
	if (installed === null) {
		return unknownRow("redis", target, "ui");
	}
	const outdated = compareVersions(installed, target) < 0;
	return {
		name: "redis",
		installed,
		target,
		status: outdated ? "outdated" : "current",
		outdated,
		action: "ui",
		reason: null,
		command: null,
	};
};

export const buildHostStackRows = (
	readings: HostStackReadings,
): HostStackRow[] => [
	panelRow(readings.panel),
	dockerRow(readings.docker),
	traefikRow(readings.traefikImage),
	postgresRow(readings.postgresImage),
	redisRow(readings.redisImage),
];

export const hostStackRefusals = (components: HostStackComponent[]) =>
	components.flatMap((component) =>
		isHostStackUiComponent(component) ? [] : [HOST_STACK_REFUSALS[component]],
	);

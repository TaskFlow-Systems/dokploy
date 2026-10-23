import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {},
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

const { readPorts } = await import("@dokploy/server/services/settings");

// `docker container inspect --format '{{json .NetworkSettings.Ports}}'` of a
// Traefik container that publishes only 443: the image still exposes 80.
const traefikPorts = {
	"80/tcp": null,
	"443/tcp": [
		{ HostIp: "0.0.0.0", HostPort: "443" },
		{ HostIp: "::", HostPort: "443" },
	],
	"443/udp": [
		{ HostIp: "0.0.0.0", HostPort: "443" },
		{ HostIp: "::", HostPort: "443" },
	],
};

const standaloneWith = (ports: Record<string, unknown>) => (command: string) =>
	Promise.resolve({
		stdout: command.includes("RESOURCE_NAME=")
			? "standalone\n"
			: `${JSON.stringify(ports)}\n`,
		stderr: "",
	});

describe("readPorts for a standalone Traefik container", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("skips exposed ports that have no host binding", async () => {
		mocks.execAsync.mockImplementation(standaloneWith(traefikPorts));

		await expect(readPorts("dokploy-traefik")).resolves.toEqual([]);
	});

	it("still lists additional published ports next to an unpublished one", async () => {
		mocks.execAsync.mockImplementation(
			standaloneWith({
				...traefikPorts,
				"8080/tcp": null,
				"5432/tcp": [
					{ HostIp: "0.0.0.0", HostPort: "5433" },
					{ HostIp: "::", HostPort: "5433" },
				],
			}),
		);

		await expect(readPorts("dokploy-traefik")).resolves.toEqual([
			{ targetPort: 5432, publishedPort: 5433, protocol: "tcp" },
		]);
	});

	it("reads the ports of a remote server's Traefik the same way", async () => {
		mocks.execAsyncRemote.mockImplementation(
			(_serverId: string, command: string) =>
				standaloneWith(traefikPorts)(command),
		);

		await expect(readPorts("dokploy-traefik", "server-1")).resolves.toEqual([]);
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});
});

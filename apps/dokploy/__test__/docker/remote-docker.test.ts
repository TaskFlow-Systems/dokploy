import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientKey, startDockerOverSsh } from "./fixtures/docker-over-ssh";

const mocks = vi.hoisted(() => ({
	server: {} as Record<string, unknown>,
	host: "127.0.0.1",
}));

vi.mock("@dokploy/server/constants", () => ({ docker: {} }));
vi.mock("@dokploy/server/services/server", () => ({
	findServerById: vi.fn(async () => mocks.server),
}));
vi.mock("@dokploy/server/utils/servers/destination", () => ({
	resolveServerDestinationHost: vi.fn(async () => mocks.host),
}));

const { getRemoteDocker } = await import(
	"@dokploy/server/utils/servers/remote-docker"
);

// The suite runs on Node, where docker-modem's own ssh address ("ssh:<host>:
// <port><host>") is rejected with "Invalid port in url"; `REMOTE_DOCKER_SSH_*`
// points the same calls at a real host.
const real = process.env.REMOTE_DOCKER_SSH_HOST
	? {
			host: process.env.REMOTE_DOCKER_SSH_HOST,
			port: Number(process.env.REMOTE_DOCKER_SSH_PORT ?? 22),
			privateKey: `${(process.env.REMOTE_DOCKER_SSH_KEY ?? "").trim()}\n`,
		}
	: undefined;

describe("getRemoteDocker", () => {
	let remote: Awaited<ReturnType<typeof startDockerOverSsh>>;

	beforeEach(async () => {
		remote = await startDockerOverSsh();
		mocks.host = real?.host ?? "127.0.0.1";
		mocks.server = {
			serverId: "remote-1",
			sshKeyId: "key",
			port: real?.port ?? remote.sshPort,
			username: "root",
			sshKey: { privateKey: real?.privateKey ?? clientKey },
		};
	});

	afterEach(async () => {
		await remote.close();
	});

	it("lists containers through docker system dial-stdio", async () => {
		const docker = await getRemoteDocker("remote-1");

		const containers = await docker.listContainers();

		expect(Array.isArray(containers)).toBe(true);
		if (!real) {
			expect(containers).toMatchObject([{ Id: "abc", State: "running" }]);
			expect(remote.commands).toEqual(["docker system dial-stdio"]);
		}
	});

	it("answers several calls, each over its own connection", async () => {
		const docker = await getRemoteDocker("remote-1");

		const version = await docker.version();
		const again = await docker.listContainers({ all: true });

		expect(version).toHaveProperty("Version");
		expect(Array.isArray(again)).toBe(true);
		if (!real) {
			expect(remote.requests).toEqual([
				"GET /version",
				"GET /containers/json?all=true",
			]);
		}
	});

	it("passes an error from the daemon on", async () => {
		const docker = await getRemoteDocker("remote-1");

		await expect(docker.getContainer("missing").inspect()).rejects.toThrow(
			/404/,
		);
	});
});

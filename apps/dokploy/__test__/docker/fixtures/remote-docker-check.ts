import { clientKey, startDockerOverSsh } from "./docker-over-ssh";

type BunBuild = {
	module: (
		name: string,
		factory: () => { exports: object; loader: "object" },
	) => void;
};

declare const Bun:
	| {
			plugin: (plugin: {
				name: string;
				setup: (build: BunBuild) => void;
			}) => void;
	  }
	| undefined;

// Bun has no vi.mock: the modules that reach the database are replaced before
// getRemoteDocker is imported. REMOTE_DOCKER_SSH_* points it at a real host.
const realHost = process.env.REMOTE_DOCKER_SSH_HOST;
const remote = realHost ? undefined : await startDockerOverSsh();
const server = {
	serverId: "remote-1",
	sshKeyId: "key",
	port: remote
		? remote.sshPort
		: Number(process.env.REMOTE_DOCKER_SSH_PORT ?? 22),
	username: "root",
	ipAddress: realHost ?? "127.0.0.1",
	sshKey: {
		privateKey: remote
			? clientKey
			: `${(process.env.REMOTE_DOCKER_SSH_KEY ?? "").trim()}\n`,
	},
};

Bun?.plugin({
	name: "remote-docker-stubs",
	setup(build) {
		build.module("@dokploy/server/constants", () => ({
			exports: { docker: {} },
			loader: "object",
		}));
		build.module("@dokploy/server/services/server", () => ({
			exports: { findServerById: async () => server },
			loader: "object",
		}));
	},
});

const { getRemoteDocker } = await import(
	"@dokploy/server/utils/servers/remote-docker"
);

const docker = await getRemoteDocker("remote-1");
const version = await docker.version();
const containers = await docker.listContainers({ all: true });
let missing = "";
try {
	await docker.getContainer("missing").inspect();
} catch (error) {
	missing = (error as Error).message;
}

console.log(
	JSON.stringify({
		runtime: typeof Bun === "undefined" ? "node" : "bun",
		version: typeof version.Version,
		containers: Array.isArray(containers),
		missing: missing.includes("404"),
	}),
);
process.exit(0);

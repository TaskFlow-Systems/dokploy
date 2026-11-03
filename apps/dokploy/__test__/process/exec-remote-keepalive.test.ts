import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serverRow = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: vi.fn(async () => serverRow.value),
}));
vi.mock("@dokploy/server/utils/servers/destination", () => ({
	resolveServerDestinationHost: vi.fn(async () => "127.0.0.1"),
}));

import type { ExecError } from "@dokploy/server/utils/process/ExecError";
import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";
import { type ServerChannel, Server as SshServer, utils } from "ssh2";

const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_TICKS_UNTIL_LOSS = 5;

const clientKey = utils.generateKeyPairSync("ed25519").private;
const hostKey = utils.generateKeyPairSync("ed25519").private;

const waitUntil = async (condition: () => boolean) => {
	while (!condition()) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};

const flushIo = () => new Promise((resolve) => setTimeout(resolve, 100));

/**
 * A real ssh2 server behind a proxy. `blackhole` models a dead network: bytes
 * stop flowing and neither side sees a FIN or an RST.
 */
const startSshServer = async () => {
	const channels: ServerChannel[] = [];
	const sshServer = new SshServer({ hostKeys: [hostKey] }, (client) => {
		client.on("error", () => {});
		client.on("authentication", (ctx) => ctx.accept());
		client.on("ready", () => {
			client.on("session", (accept) => {
				accept().on("exec", (acceptExec) => {
					channels.push(acceptExec());
				});
			});
		});
	});
	await new Promise<void>((resolve) =>
		sshServer.listen(0, "127.0.0.1", () => resolve()),
	);

	const sockets: net.Socket[] = [];
	const proxyState = { blackhole: false };
	const proxy = net.createServer((clientSide) => {
		const serverSide = net.connect(
			(sshServer.address() as net.AddressInfo).port,
			"127.0.0.1",
		);
		sockets.push(clientSide, serverSide);
		for (const [from, to] of [
			[clientSide, serverSide],
			[serverSide, clientSide],
		] as const) {
			from.on("error", () => {});
			from.on("data", (chunk) => {
				if (!proxyState.blackhole) {
					to.write(chunk);
				}
			});
			from.on("close", () => {
				if (!proxyState.blackhole) {
					to.destroy();
				}
			});
		}
	});
	await new Promise<void>((resolve) =>
		proxy.listen(0, "127.0.0.1", () => resolve()),
	);

	return {
		channels,
		proxyState,
		sockets,
		port: (proxy.address() as net.AddressInfo).port,
		close: async () => {
			for (const socket of sockets) {
				socket.destroy();
			}
			await new Promise((resolve) => proxy.close(resolve));
			await new Promise((resolve) => sshServer.close(() => resolve(null)));
		},
	};
};

const advanceKeepalive = async (ticks: number) => {
	for (let tick = 0; tick < ticks; tick++) {
		vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS);
		await flushIo();
	}
};

describe("execAsyncRemote over a lost connection", () => {
	let ssh: Awaited<ReturnType<typeof startSshServer>>;

	beforeEach(async () => {
		ssh = await startSshServer();
		serverRow.value = {
			serverId: "build-server",
			sshKeyId: "key",
			port: ssh.port,
			username: "dokploy",
			sshKey: { privateKey: clientKey },
		};
		// Only the keepalive timer is fake; sockets and setTimeout stay real.
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	});

	afterEach(async () => {
		vi.useRealTimers();
		await ssh.close();
	});

	// The reply to exec may already be past the proxy. ssh2 restarts its keepalive
	// count when it reads that reply, so the first tick has to come after it.
	const loseNetwork = async () => {
		ssh.proxyState.blackhole = true;
		await flushIo();
	};

	it("rejects when the network dies, so the queue job ends", async () => {
		const running = execAsyncRemote("build-server", "bun install");
		const outcome = running.then(
			() => "resolved",
			(error: Error) => error.message,
		);
		await waitUntil(() => ssh.channels.length === 1);

		await loseNetwork();
		await advanceKeepalive(KEEPALIVE_TICKS_UNTIL_LOSS);

		expect(await outcome).toBe("SSH connection error: Keepalive timeout");
	});

	it("does not give up before the fifth missed reply", async () => {
		const settled = vi.fn();
		execAsyncRemote("build-server", "bun install").then(settled, settled);
		await waitUntil(() => ssh.channels.length === 1);

		await loseNetwork();
		await advanceKeepalive(KEEPALIVE_TICKS_UNTIL_LOSS - 1);

		expect(settled).not.toHaveBeenCalled();

		await advanceKeepalive(1);
		await waitUntil(() => settled.mock.calls.length === 1);
	});

	it("keeps a long build alive while the server answers", async () => {
		const running = execAsyncRemote("build-server", "docker build .");
		await waitUntil(() => ssh.channels.length === 1);

		await advanceKeepalive(KEEPALIVE_TICKS_UNTIL_LOSS * 2);

		const channel = ssh.channels[0] as ServerChannel;
		channel.write("done");
		channel.exit(0);
		channel.close();

		await expect(running).resolves.toMatchObject({ stdout: "done" });
	});

	it("rejects when the connection is closed in the middle of a command", async () => {
		const running = execAsyncRemote("build-server", "bun install");
		const outcome = running.then(
			() => "resolved",
			() => "rejected",
		);
		await waitUntil(() => ssh.channels.length === 1);

		for (const socket of ssh.sockets) {
			socket.destroy();
		}

		expect(await outcome).toBe("rejected");
	});

	const failureOf = (running: Promise<unknown>) =>
		running.then(
			() => {
				throw new Error("The command should have failed");
			},
			(error: ExecError) => error,
		);

	it("reports that the command did not finish when the network dies", async () => {
		const failure = failureOf(execAsyncRemote("build-server", "bun install"));
		await waitUntil(() => ssh.channels.length === 1);

		await loseNetwork();
		await advanceKeepalive(KEEPALIVE_TICKS_UNTIL_LOSS);

		expect((await failure).didCommandFinish()).toBe(false);
	});

	it("reports that the command did not finish when the connection closes", async () => {
		const failure = failureOf(execAsyncRemote("build-server", "bun install"));
		await waitUntil(() => ssh.channels.length === 1);

		for (const socket of ssh.sockets) {
			socket.destroy();
		}

		const error = await failure;
		expect(error.didCommandFinish()).toBe(false);
		expect(error.message).not.toContain("undefined");
	});

	it("reports that the command finished when it exits with an error", async () => {
		const failure = failureOf(
			execAsyncRemote("build-server", "docker build ."),
		);
		await waitUntil(() => ssh.channels.length === 1);

		const channel = ssh.channels[0] as ServerChannel;
		channel.exit(1);
		channel.close();

		const error = await failure;
		expect(error.didCommandFinish()).toBe(true);
		expect(error.exitCode).toBe(1);
	});
});

describe("getRemoteDocker", () => {
	it("notices a dead network on the docker API over ssh", async () => {
		serverRow.value = {
			serverId: "deploy-server",
			sshKeyId: "key",
			port: 22,
			username: "dokploy",
			sshKey: { privateKey: clientKey },
		};

		const docker = await getRemoteDocker("deploy-server");

		expect((docker.modem as { sshOptions?: object }).sshOptions).toMatchObject({
			keepaliveInterval: KEEPALIVE_INTERVAL_MS,
			keepaliveCountMax: KEEPALIVE_TICKS_UNTIL_LOSS - 1,
		});
	});
});

import type { AddressInfo } from "node:net";
import { Server } from "ssh2";
import { generateSshTestKey } from "../../helpers/ssh-test-key";

export const clientKey = generateSshTestKey();
const hostKey = generateSshTestKey();

// A real ssh2 server whose shell echoes what it gets. `live` is the number of
// client connections it still holds, which is what a leak keeps above zero.
export const startShellServer = async ({
	authDelayMs = 0,
}: {
	authDelayMs?: number;
} = {}) => {
	const live = new Set<object>();
	let total = 0;
	let shells = 0;
	const server = new Server({ hostKeys: [hostKey] }, (client) => {
		total++;
		live.add(client);
		client.on("error", () => {});
		client.on("close", () => live.delete(client));
		client.on("authentication", (ctx) => {
			setTimeout(() => ctx.accept(), authDelayMs);
		});
		client.on("ready", () => {
			client.on("session", (accept) => {
				const session = accept();
				session.on("pty", (acceptPty) => acceptPty());
				session.on("window-change", (acceptResize) => acceptResize?.());
				session.on("shell", (acceptShell) => {
					shells++;
					const stream = acceptShell();
					stream.write("ready$ ");
					stream.on("data", (data: Buffer) => stream.write(data));
				});
			});
		});
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);

	return {
		port: (server.address() as AddressInfo).port,
		get live() {
			return live.size;
		},
		get total() {
			return total;
		},
		get shells() {
			return shells;
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
};

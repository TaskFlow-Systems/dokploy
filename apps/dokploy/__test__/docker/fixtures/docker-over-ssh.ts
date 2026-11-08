import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { Server, utils } from "ssh2";

export const clientKey = utils.generateKeyPairSync("ed25519").private;
const hostKey = utils.generateKeyPairSync("ed25519").private;

// A Docker API that answers three calls, behind an ssh2 server that serves
// `docker system dial-stdio` the way a real host does: the channel is a raw
// connection to the daemon.
export const startDockerOverSsh = async () => {
	const requests: string[] = [];
	const api = http.createServer((req, res) => {
		requests.push(`${req.method} ${req.url}`);
		res.setHeader("Content-Type", "application/json");
		if (req.url?.startsWith("/containers/json")) {
			res.end(
				JSON.stringify([{ Id: "abc", Names: ["/web"], State: "running" }]),
			);
			return;
		}
		if (req.url?.endsWith("/version")) {
			res.end(JSON.stringify({ Version: "29.9.3", ApiVersion: "1.54" }));
			return;
		}
		res.statusCode = 404;
		res.end(JSON.stringify({ message: "page not found" }));
	});
	await new Promise<void>((resolve) =>
		api.listen(0, "127.0.0.1", () => resolve()),
	);
	const apiPort = (api.address() as AddressInfo).port;

	const commands: string[] = [];
	const ssh = new Server({ hostKeys: [hostKey] }, (client) => {
		client.on("error", () => {});
		client.on("authentication", (ctx) => ctx.accept());
		client.on("ready", () => {
			client.on("session", (accept) => {
				accept().on("exec", (acceptExec, _reject, info) => {
					commands.push(info.command);
					const channel = acceptExec();
					const daemon = net.connect(apiPort, "127.0.0.1");
					channel.pipe(daemon);
					daemon.pipe(channel);
					daemon.on("error", () => channel.close());
					channel.on("close", () => daemon.destroy());
				});
			});
		});
	});
	await new Promise<void>((resolve) =>
		ssh.listen(0, "127.0.0.1", () => resolve()),
	);

	return {
		commands,
		requests,
		sshPort: (ssh.address() as AddressInfo).port,
		close: async () => {
			await new Promise((resolve) => ssh.close(() => resolve(null)));
			api.closeAllConnections();
			await new Promise((resolve) => api.close(() => resolve(null)));
		},
	};
};

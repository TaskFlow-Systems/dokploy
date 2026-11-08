import http from "node:http";
import type { Duplex } from "node:stream";
import { Client, type ConnectConfig } from "ssh2";

// docker-modem's own `protocol: "ssh"` builds the request address from the
// bare host and gets `ssh:<host>:<port><host>`, which Node 26 refuses with
// "Invalid port in url" (Bun only warns). With a plain http address the agent
// is the only thing that has to know about ssh: every request gets its own
// connection that runs `docker system dial-stdio`, like modem's agent does.
export const createDockerSshAgent = (sshOptions: ConnectConfig) => {
	const agent = new http.Agent();

	agent.createConnection = (_options, callback) => {
		const conn = new Client();
		let channel: Duplex | undefined;

		const fail = (error: Error) => {
			conn.end();
			if (channel) {
				channel.destroy(error);
			} else {
				callback?.(error, undefined as unknown as Duplex);
			}
		};

		conn
			.once("ready", () => {
				conn.exec("docker system dial-stdio", (error, stream) => {
					if (error) {
						fail(error);
						return;
					}
					channel = stream;
					stream.once("close", () => conn.end());
					callback?.(null, stream);
				});
			})
			.on("error", fail)
			.once("close", () => channel?.destroy())
			.connect(sshOptions);

		return undefined;
	};

	return agent;
};

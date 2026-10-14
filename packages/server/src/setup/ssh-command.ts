import { Client } from "ssh2";
import { findServerById } from "../services/server";
import {
	assertServerDestinationAllowed,
	resolveServerDestinationHost,
} from "../utils/servers/destination";

export const runSshCommand = async (
	serverId: string,
	command: string,
	onData?: (data: string) => void,
) => {
	const server = await findServerById(serverId);
	if (!server.sshKeyId) {
		throw new Error("No SSH Key found");
	}
	await assertServerDestinationAllowed(server);
	const host = await resolveServerDestinationHost(server);
	const client = new Client();

	return new Promise<{ stdout: string; exitCode: number | null }>(
		(resolve, reject) => {
			client
				.once("ready", () => {
					client.exec(command, (err, stream) => {
						if (err) {
							client.end();
							reject(err);
							return;
						}
						let stdout = "";
						stream
							.on("close", (exitCode: number | null) => {
								client.end();
								resolve({ stdout, exitCode });
							})
							.on("data", (data: Buffer) => {
								const text = data.toString();
								stdout += text;
								onData?.(text);
							})
							.stderr.on("data", (data: Buffer) => {
								onData?.(data.toString());
							});
					});
				})
				.on("error", (err) => {
					client.end();
					reject(new Error(`SSH connection error: ${err.message}`));
				})
				.connect({
					host,
					port: server.port,
					username: server.username,
					privateKey: server.sshKey?.privateKey,
				});
		},
	);
};

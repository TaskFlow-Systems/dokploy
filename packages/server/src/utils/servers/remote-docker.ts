import { docker } from "@dokploy/server/constants";
import { findServerById } from "@dokploy/server/services/server";
import Dockerode from "dockerode";
import { SSH_KEEPALIVE } from "../process/ssh-keepalive";
import { resolveServerDestinationHost } from "./destination";

type DockerSshOptions = Dockerode.DockerOptions & {
	sshOptions?: {
		privateKey?: string | Buffer;
		keepaliveInterval?: number;
		keepaliveCountMax?: number;
	};
};

export const getRemoteDocker = async (serverId?: string | null) => {
	if (!serverId) return docker;
	const server = await findServerById(serverId);
	if (!server.sshKeyId) return docker;
	const host = await resolveServerDestinationHost(server);
	const dockerOptions: DockerSshOptions = {
		host,
		port: server.port,
		username: server.username,
		protocol: "ssh",
		sshOptions: {
			privateKey: server.sshKey?.privateKey ?? undefined,
			...SSH_KEEPALIVE,
		},
	};
	const dockerode = new Dockerode(dockerOptions);

	return dockerode;
};

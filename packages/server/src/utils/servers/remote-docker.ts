import type http from "node:http";
import { docker } from "@dokploy/server/constants";
import { findServerById } from "@dokploy/server/services/server";
import Dockerode from "dockerode";
import { SSH_KEEPALIVE } from "../process/ssh-keepalive";
import { resolveServerDestinationHost } from "./destination";
import { createDockerSshAgent } from "./docker-ssh-agent";

export const getRemoteDocker = async (serverId?: string | null) => {
	if (!serverId) return docker;
	const server = await findServerById(serverId);
	if (!server.sshKeyId) return docker;
	const host = await resolveServerDestinationHost(server);
	const dockerOptions: Dockerode.DockerOptions & { agent: http.Agent } = {
		host,
		port: server.port,
		protocol: "http",
		agent: createDockerSshAgent({
			host,
			port: server.port,
			username: server.username,
			privateKey: server.sshKey?.privateKey ?? undefined,
			...SSH_KEEPALIVE,
		}),
	};
	const dockerode = new Dockerode(dockerOptions);

	return dockerode;
};

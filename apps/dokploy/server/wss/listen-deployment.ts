import { spawn } from "node:child_process";
import type http from "node:http";
import {
	findDeploymentById,
	findServerById,
	IS_CLOUD,
	validateRequest,
} from "@dokploy/server";
import { checkDeploymentLogOwnerAccess } from "@dokploy/server/services/deployment-log-access";
import { checkPermission } from "@dokploy/server/services/permission";
import { encodeBase64 } from "@dokploy/server/utils/docker/utils";
import { resolveServerDestinationHost } from "@dokploy/server/utils/servers/destination";
import {
	type DeploymentLogPathRoot,
	readValidDeploymentLogPath,
} from "@dokploy/server/wss/utils";
import { Client } from "ssh2";
import { WebSocketServer } from "ws";
import { getDeploymentLogServerId } from "../utils/deployment-log-server";
import { rejectApiKeySession } from "./api-key";
import { verifyWebSocketOrigin } from "./origin";

const getDeploymentLogPathRoot = (
	deployment: Awaited<ReturnType<typeof findDeploymentById>>,
): DeploymentLogPathRoot => {
	if (deployment.scheduleId) {
		return "schedules";
	}

	if (deployment.volumeBackupId) {
		return "volumeBackups";
	}

	return "logs";
};

type DeploymentLogAccessCtx = {
	user: { id: string };
	session: { activeOrganizationId: string | null | undefined };
};

const assertServerDeploymentLogAccess = async (
	ctx: DeploymentLogAccessCtx,
	serverId: string,
) => {
	if (!ctx.session.activeOrganizationId) {
		throw new Error("Unauthorized deployment log organization");
	}
	const permissionCtx = {
		user: ctx.user,
		session: { activeOrganizationId: ctx.session.activeOrganizationId },
	};
	await checkPermission(permissionCtx, { deployment: ["read"] });
	const server = await findServerById(serverId);
	if (server.organizationId !== ctx.session.activeOrganizationId) {
		throw new Error("Unauthorized deployment log server");
	}
};

const assertDeploymentLogAccess = async (
	ctx: DeploymentLogAccessCtx,
	deployment: Awaited<ReturnType<typeof findDeploymentById>>,
) => {
	if (!ctx.session.activeOrganizationId) {
		throw new Error("Unauthorized deployment log organization");
	}
	const permissionCtx = {
		user: ctx.user,
		session: { activeOrganizationId: ctx.session.activeOrganizationId },
	};
	if (await checkDeploymentLogOwnerAccess(permissionCtx, deployment)) {
		return;
	}

	const serverId = deployment.serverId || deployment.schedule?.serverId;
	if (serverId) {
		await assertServerDeploymentLogAccess(ctx, serverId);
		return;
	}

	throw new Error("Deployment log has no supported owner");
};

export const setupDeploymentLogsWebSocketServer = (
	server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>,
) => {
	const wssTerm = new WebSocketServer({
		noServer: true,
		verifyClient: verifyWebSocketOrigin,
		path: "/listen-deployment",
	});

	server.on("upgrade", (req, socket, head) => {
		const { pathname } = new URL(req.url || "", `http://${req.headers.host}`);

		if (pathname === "/_next/webpack-hmr") {
			return;
		}
		if (pathname === "/listen-deployment") {
			wssTerm.handleUpgrade(req, socket, head, function done(ws) {
				wssTerm.emit("connection", ws, req);
			});
		}
	});

	wssTerm.on("connection", async (ws, req) => {
		const url = new URL(req.url || "", `http://${req.headers.host}`);
		const logPath = url.searchParams.get("logPath");
		const deploymentId = url.searchParams.get("deploymentId");
		const { user, session } = await validateRequest(req);

		// Client may have disconnected during the await; a later close handler would never fire.
		if (ws.readyState !== ws.OPEN) {
			return;
		}

		// Generate unique connection ID for tracking
		const connectionId = `deployment-logs-${Date.now()}-${Math.random().toString(36).substring(7)}`;
		if (!logPath && !deploymentId) {
			console.log(`[${connectionId}] logPath no provided`);
			ws.close(4000, "logPath no provided");
			return;
		}

		if (!user || !session || !session.activeOrganizationId) {
			ws.close();
			return;
		}
		if (rejectApiKeySession(ws, session)) {
			return;
		}

		if (!deploymentId) {
			ws.close(4000, "deploymentId required");
			return;
		}

		let effectiveLogPath = logPath || "";
		let effectiveServerId: string | undefined;
		let effectiveLogPathRoot: DeploymentLogPathRoot = "logs";

		try {
			const deployment = await findDeploymentById(deploymentId);
			const ctx = {
				user: { id: user.id },
				session: { activeOrganizationId: session.activeOrganizationId },
			};

			await assertDeploymentLogAccess(ctx, deployment);

			effectiveLogPath = deployment.logPath;
			effectiveLogPathRoot = getDeploymentLogPathRoot(deployment);
			effectiveServerId = getDeploymentLogServerId(deployment) || undefined;
		} catch {
			ws.close();
			return;
		}

		if (
			!readValidDeploymentLogPath(
				effectiveLogPath,
				effectiveServerId,
				effectiveLogPathRoot,
			)
		) {
			ws.close(4000, "Invalid log path");
			return;
		}

		let tailProcess: ReturnType<typeof spawn> | null = null;
		let sshClient: Client | null = null;

		// `killed` is set once a signal is sent, not when the process exits.
		const isTailRunning = () =>
			tailProcess !== null &&
			tailProcess.exitCode === null &&
			tailProcess.signalCode === null;

		const stopTailProcess = () => {
			if (!isTailRunning()) {
				return;
			}
			tailProcess!.kill("SIGTERM");
			// Force kill after a timeout if it doesn't terminate
			setTimeout(() => {
				if (isTailRunning()) {
					tailProcess!.kill("SIGKILL");
				}
			}, 1000);
		};

		try {
			if (effectiveServerId) {
				const server = await findServerById(effectiveServerId);

				if (ws.readyState !== ws.OPEN) {
					return;
				}

				if (server.organizationId !== session.activeOrganizationId) {
					ws.close();
					return;
				}

				if (!server.sshKeyId) {
					ws.close();
					return;
				}

				const host = await resolveServerDestinationHost(server);
				sshClient = new Client();
				sshClient
					.on("ready", () => {
						const encodedPath = encodeBase64(effectiveLogPath);
						const command = `tail -n +1 -f "$(echo '${encodedPath}' | base64 -d)"`;

						sshClient!.exec(command, (err, stream) => {
							if (err) {
								sshClient!.end();
								ws.close();
								return;
							}
							stream
								.on("close", () => {
									sshClient!.end();
									ws.close();
								})
								.on("data", (data: string) => {
									if (ws.readyState === ws.OPEN) {
										ws.send(data.toString());
									}
								})
								.stderr.on("data", (data) => {
									if (ws.readyState === ws.OPEN) {
										ws.send(data.toString());
									}
								});
						});
					})
					.on("error", (err) => {
						if (ws.readyState === ws.OPEN) {
							ws.send(`SSH error: ${err.message}`);
							ws.close();
						}
						if (sshClient) {
							sshClient.end();
						}
					})
					.connect({
						host,
						port: server.port,
						username: server.username,
						privateKey: server.sshKey?.privateKey,
					});

				ws.on("close", () => {
					if (sshClient) {
						sshClient.end();
					}
				});
			} else {
				if (IS_CLOUD) {
					ws.send("This feature is not available in the cloud version.");
					ws.close();
					return;
				}
				tailProcess = spawn("tail", ["-n", "+1", "-f", effectiveLogPath]);

				const stdout = tailProcess.stdout;
				const stderr = tailProcess.stderr;

				if (stdout) {
					stdout.on("data", (data) => {
						if (ws.readyState === ws.OPEN) {
							ws.send(data.toString());
						}
					});
				}

				if (stderr) {
					stderr.on("data", (data) => {
						if (ws.readyState === ws.OPEN) {
							ws.send(new Error(`tail error: ${data.toString()}`).message);
						}
					});
				}

				tailProcess.on("close", () => {
					ws.close();
				});

				tailProcess.on("error", () => {
					if (ws.readyState === ws.OPEN) {
						ws.close();
					}
				});

				ws.on("close", stopTailProcess);
			}
		} catch (error) {
			// Clean up resources on error
			stopTailProcess();
			if (sshClient) {
				sshClient.end();
			}
			if (ws.readyState === ws.OPEN) {
				// @ts-expect-error
				const errorMessage = error?.message as unknown as string;
				ws.send(errorMessage || "An error occurred");
				ws.close();
			}
		}
	});
};

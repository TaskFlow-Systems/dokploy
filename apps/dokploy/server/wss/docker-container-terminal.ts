import { execFile } from "node:child_process";
import type http from "node:http";
import { findServerById, IS_CLOUD, validateRequest } from "@dokploy/server";
import { resolveServerDestinationHost } from "@dokploy/server/utils/servers/destination";
import { quoteShellArgs } from "@dokploy/server/utils/shell";
import { spawn } from "node-pty";
import { Client } from "ssh2";
import { WebSocketServer } from "ws";
import { rejectApiKeySession } from "./api-key";
import { canAccessDockerOverWss } from "./authorize";
import { containerBelongsToService } from "./container-ownership";
import { canAccessDockerTerminalWebSocket } from "./docker-permission";
import { verifyWebSocketOrigin } from "./origin";
import { rejectTerminalWithoutSuperSession } from "./super-session";
import {
	getTerminalHangupArgs,
	isValidContainerId,
	isValidShell,
	newTerminalSessionMarker,
	parseResizeMessage,
	parseTerminalSize,
} from "./utils";

export const setupDockerContainerTerminalWebSocketServer = (
	server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>,
) => {
	const wssTerm = new WebSocketServer({
		noServer: true,
		verifyClient: verifyWebSocketOrigin,
		path: "/docker-container-terminal",
	});

	server.on("upgrade", (req, socket, head) => {
		const { pathname } = new URL(req.url || "", `http://${req.headers.host}`);

		if (pathname === "/_next/webpack-hmr") {
			return;
		}
		if (pathname === "/docker-container-terminal") {
			wssTerm.handleUpgrade(req, socket, head, function done(ws) {
				wssTerm.emit("connection", ws, req);
			});
		}
	});

	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	wssTerm.on("connection", async (ws, req) => {
		const url = new URL(req.url || "", `http://${req.headers.host}`);
		const containerId = url.searchParams.get("containerId");
		const activeWay = url.searchParams.get("activeWay");
		const serverId = url.searchParams.get("serverId");
		const serviceId = url.searchParams.get("serviceId");
		const { cols, rows } = parseTerminalSize(
			url.searchParams.get("cols"),
			url.searchParams.get("rows"),
		);
		const { user, session } = await validateRequest(req);

		if (!user || !session || !session.activeOrganizationId) {
			ws.close();
			return;
		}

		if (!containerId) {
			ws.close(4000, "containerId not provided");
			return;
		}

		// Security: Validate containerId to prevent command injection
		if (!isValidContainerId(containerId)) {
			ws.close(4000, "Invalid container ID format");
			return;
		}

		// Security: Validate shell to prevent command injection
		if (activeWay && !isValidShell(activeWay)) {
			ws.close(4000, "Invalid shell specified");
			return;
		}

		// Default to 'sh' if no shell specified
		const shell = activeWay || "sh";
		const sessionMarker = newTerminalSessionMarker();
		const hangupArgs = getTerminalHangupArgs(containerId, shell, sessionMarker);

		if (
			!(await canAccessDockerTerminalWebSocket({
				user,
				session,
				serverId,
				containerId,
			}))
		) {
			ws.close();
			return;
		}

		if (!(await canAccessDockerOverWss(user, session, serverId, serviceId))) {
			ws.close(4003, "Not authorized");
			return;
		}
		if (
			serviceId &&
			!(await containerBelongsToService(serviceId, containerId, serverId))
		) {
			ws.close(4003, "Not authorized");
			return;
		}

		if (await rejectTerminalWithoutSuperSession(ws, user, session)) {
			return;
		}
		if (rejectApiKeySession(ws, session)) {
			return;
		}
		try {
			if (serverId) {
				const server = await findServerById(serverId);

				if (server.organizationId !== session.activeOrganizationId) {
					ws.close();
					return;
				}

				if (!server.sshKeyId)
					throw new Error("No SSH key available for this server");

				const host = await resolveServerDestinationHost(server);
				const conn = new Client();
				let _stdout = "";
				let _stderr = "";
				conn
					.once("ready", () => {
						// Use array-style arguments to prevent shell injection
						const dockerCommand = [
							"docker",
							"exec",
							"-it",
							"-e",
							sessionMarker,
							"-w",
							"/",
							containerId,
							shell,
						].join(" ");
						conn.exec(dockerCommand, { pty: { cols, rows } }, (err, stream) => {
							if (err) {
								console.error("SSH exec error:", err);
								ws.close();
								conn.end();
								return;
							}

							let hangingUp = false;
							stream
								.on("close", (code: number, _signal: string) => {
									ws.send(`\nContainer closed with code: ${code}\n`);
									if (!hangingUp) {
										conn.end();
									}
								})
								.on("data", (data: string) => {
									_stdout += data.toString();
									ws.send(data.toString());
								})
								.stderr.on("data", (data) => {
									_stderr += data.toString();
									ws.send(data.toString());
									console.error("Error: ", data.toString());
								});

							ws.on("message", (message) => {
								try {
									let command: string | Buffer[] | Buffer | ArrayBuffer;
									if (Buffer.isBuffer(message)) {
										command = message.toString("utf8");
									} else {
										command = message;
									}
									const text = command.toString();
									const resize = parseResizeMessage(text);
									if (resize) {
										stream.setWindow(resize.rows, resize.cols, 0, 0);
										return;
									}
									stream.write(text);
								} catch (error) {
									// @ts-expect-error
									const errorMessage = error?.message as unknown as string;
									ws.send(errorMessage);
								}
							});

							ws.on("close", () => {
								hangingUp = true;
								const endConnection = () => {
									stream.end();
									conn.end();
								};
								// Ending the connection first would kill the hangup with it.
								const fallback = setTimeout(endConnection, 10_000);
								conn.exec(
									quoteShellArgs(["docker", ...hangupArgs]),
									(hangupError, hangup) => {
										if (hangupError) {
											clearTimeout(fallback);
											endConnection();
											return;
										}
										hangup.on("close", () => {
											clearTimeout(fallback);
											endConnection();
										});
										hangup.resume();
										hangup.stderr.resume();
									},
								);
							});
						});
					})
					.on("error", (err) => {
						console.error("SSH connection error:", err);
						if (ws.readyState === ws.OPEN) {
							ws.send(`SSH error: ${err.message}`);
							ws.close();
						}
						conn.end();
					})
					.connect({
						host,
						port: server.port,
						username: server.username,
						privateKey: server.sshKey?.privateKey,
					});
			} else {
				if (IS_CLOUD) {
					ws.send("This feature is not available in the cloud version.");
					ws.close();
					return;
				}
				const ptyProcess = spawn(
					"docker",
					["exec", "-it", "-e", sessionMarker, "-w", "/", containerId, shell],
					{ cols, rows },
				);

				ptyProcess.onData((data) => {
					ws.send(data);
				});
				ptyProcess.onExit(({ exitCode }) => {
					ws.send(`\nContainer closed with code: ${exitCode}\n`);
					ws.close();
				});
				ws.on("close", () => {
					ptyProcess.kill();
					execFile("docker", hangupArgs, () => {});
				});
				ws.on("message", (message) => {
					try {
						let command: string | Buffer[] | Buffer | ArrayBuffer;
						if (Buffer.isBuffer(message)) {
							command = message.toString("utf8");
						} else {
							command = message;
						}
						const text = command.toString();
						const resize = parseResizeMessage(text);
						if (resize) {
							ptyProcess.resize(resize.cols, resize.rows);
							return;
						}
						ptyProcess.write(text);
					} catch (error) {
						// @ts-expect-error
						const errorMessage = error?.message as unknown as string;
						ws.send(errorMessage);
					}
				});
			}
		} catch (error) {
			// @ts-expect-error
			const errorMessage = error?.message as unknown as string;

			ws.send(errorMessage);
		}
	});
};

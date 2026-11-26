import { execFile } from "node:child_process";
import type http from "node:http";
import { findServerById, IS_CLOUD, validateRequest } from "@dokploy/server";
import { SSH_KEEPALIVE } from "@dokploy/server/utils/process/ssh-keepalive";
import { resolveServerDestinationHost } from "@dokploy/server/utils/servers/destination";
import { quoteShellArgs } from "@dokploy/server/utils/shell";
import { Client, type ClientChannel } from "ssh2";
import { WebSocketServer } from "ws";
import { rejectApiKeySession } from "./api-key";
import { canAccessDockerOverWss } from "./authorize";
import {
	createSshCloser,
	onWebSocketConnection,
	readUpgradePathname,
	stopWhenClientIsSilent,
} from "./connection";
import { containerBelongsToService } from "./container-ownership";
import { canAccessDockerTerminalWebSocket } from "./docker-permission";
import { runHangupScans } from "./hangup-scans";
import { verifyWebSocketOrigin } from "./origin";
import { spawnPty } from "./pty";
import {
	getTerminalHangupArgs,
	isValidContainerId,
	isValidShell,
	newTerminalSessionMarker,
	parseResizeMessage,
	parseTerminalSize,
} from "./utils";

const EXEC_PENDING_FALLBACK_MS = 30_000;
const HANGUP_SCAN_TIMEOUT_MS = 10_000;
const HANGUP_FALLBACK_MS = 30_000;

type RemotePhase =
	| "connecting"
	| "opening-exec"
	| "closing-while-opening"
	| "open"
	| "hanging-up"
	| "closed";

export const setupDockerContainerTerminalWebSocketServer = (
	server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>,
) => {
	const wssTerm = new WebSocketServer({
		noServer: true,
		verifyClient: verifyWebSocketOrigin,
		path: "/docker-container-terminal",
	});

	server.on("upgrade", (req, socket, head) => {
		const pathname = readUpgradePathname(req, socket);

		if (pathname === "/_next/webpack-hmr") {
			return;
		}
		if (pathname === "/docker-container-terminal") {
			wssTerm.handleUpgrade(req, socket, head, function done(ws) {
				wssTerm.emit("connection", ws, req);
			});
		}
	});

	onWebSocketConnection(wssTerm, async (ws, req) => {
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

		if (!user || !session?.activeOrganizationId) {
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

				// Client may have disconnected during the awaits; a later close handler would never fire.
				if (ws.readyState !== ws.OPEN) {
					return;
				}

				const conn = new Client();
				const closeSsh = createSshCloser(conn);
				const state: {
					phase: RemotePhase;
					stream?: ClientChannel;
					scans?: ReturnType<typeof runHangupScans>;
					execPendingFallback?: ReturnType<typeof setTimeout>;
				} = { phase: "connecting" };
				const clearExecPendingFallback = () => {
					if (state.execPendingFallback) {
						clearTimeout(state.execPendingFallback);
						state.execPendingFallback = undefined;
					}
				};
				conn.once("close", clearExecPendingFallback);

				let _stdout = "";
				let _stderr = "";

				const hangUp = (stream: ClientChannel) => {
					if (state.phase === "hanging-up" || state.phase === "closed") {
						return;
					}
					state.phase = "hanging-up";
					state.stream = stream;
					// Ending the connection first would kill the hangup with it. The
					// connection stays up for the repeated scans, and goes at the latest
					// when the fallback fires.
					const scan = () =>
						new Promise<boolean>((resolve) => {
							const limit = setTimeout(
								() => resolve(true),
								HANGUP_SCAN_TIMEOUT_MS,
							);
							limit.unref?.();
							const settle = (usable = true) => {
								clearTimeout(limit);
								resolve(usable);
							};
							try {
								conn.exec(
									quoteShellArgs(["docker", ...hangupArgs]),
									(hangupError, hangup) => {
										if (hangupError) {
											settle(false);
											return;
										}
										hangup.on("close", () => settle());
										hangup.resume();
										hangup.stderr.resume();
									},
								);
							} catch {
								settle(false);
							}
						});
					const scans = runHangupScans(scan);
					state.scans = scans;
					const fallback = setTimeout(() => {
						scans.cancel();
					}, HANGUP_FALLBACK_MS);
					fallback.unref?.();
					conn.once("close", scans.cancel);
					void scans.done.then(() => {
						clearTimeout(fallback);
						state.scans = undefined;
						const pendingStream = state.stream;
						state.stream = undefined;
						state.phase = "closed";
						pendingStream?.end();
						closeSsh();
					});
				};

				ws.once("close", () => {
					if (state.phase === "connecting") {
						state.phase = "closed";
						closeSsh();
						return;
					}
					if (state.phase === "opening-exec") {
						state.phase = "closing-while-opening";
						state.execPendingFallback = setTimeout(() => {
							state.execPendingFallback = undefined;
							if (state.phase === "closing-while-opening") {
								state.phase = "closed";
								closeSsh();
							}
						}, EXEC_PENDING_FALLBACK_MS);
						state.execPendingFallback.unref?.();
						return;
					}
					if (state.phase === "open" && state.stream) {
						hangUp(state.stream);
					}
				});
				stopWhenClientIsSilent(ws);

				conn
					.once("ready", () => {
						if (state.phase !== "connecting" || ws.readyState !== ws.OPEN) {
							state.phase = "closed";
							closeSsh();
							return;
						}
						state.phase = "opening-exec";
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
							clearExecPendingFallback();
							if (err) {
								console.error("SSH exec error:", err);
								state.phase = "closed";
								ws.close();
								closeSsh();
								return;
							}

							if (state.phase === "closed") {
								stream.end();
								closeSsh();
								return;
							}

							state.stream = stream;
							// The shell is already running if the client left while it was opening.
							if (
								state.phase === "closing-while-opening" ||
								ws.readyState !== ws.OPEN
							) {
								hangUp(stream);
								return;
							}

							state.phase = "open";
							stream
								.on("close", (code: number, _signal: string) => {
									if (ws.readyState === ws.OPEN) {
										ws.send(`\nContainer closed with code: ${code}\n`);
									}
									if (state.phase === "open") {
										state.phase = "closed";
										state.stream = undefined;
										closeSsh();
										ws.close();
									}
								})
								.on("data", (data: string) => {
									_stdout += data.toString();
									if (ws.readyState === ws.OPEN) {
										ws.send(data.toString());
									}
								})
								.stderr.on("data", (data) => {
									_stderr += data.toString();
									if (ws.readyState === ws.OPEN) {
										ws.send(data.toString());
									}
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
						});
					})
					.on("error", (err) => {
						clearExecPendingFallback();
						state.phase = "closed";
						const scans = state.scans;
						state.scans = undefined;
						scans?.cancel();
						const activeStream = state.stream;
						state.stream = undefined;
						activeStream?.end();
						if (ws.readyState === ws.OPEN) {
							console.error("SSH connection error:", err);
							ws.send(`SSH error: ${err.message}`);
							ws.close();
						}
						closeSsh();
					});

				try {
					conn.connect({
						host,
						port: server.port,
						username: server.username,
						privateKey: server.sshKey?.privateKey,
						...SSH_KEEPALIVE,
					});
				} catch (error) {
					state.phase = "closed";
					throw error;
				}
			} else {
				if (IS_CLOUD) {
					ws.send("This feature is not available in the cloud version.");
					ws.close();
					return;
				}

				if (ws.readyState !== ws.OPEN) {
					return;
				}

				stopWhenClientIsSilent(ws);

				const hangUpLocal = () =>
					runHangupScans(
						() =>
							new Promise<void>((resolve) => {
								execFile("docker", hangupArgs, () => resolve());
							}),
					);
				const ptyProcess = await spawnPty(
					"docker",
					["exec", "-it", "-e", sessionMarker, "-w", "/", containerId, shell],
					{ cols, rows },
				);
				if (ws.readyState !== ws.OPEN) {
					ptyProcess.kill();
					hangUpLocal();
					return;
				}

				ptyProcess.onData((data) => {
					ws.send(data);
				});
				ptyProcess.onExit(({ exitCode }) => {
					ws.send(`\nContainer closed with code: ${exitCode}\n`);
					ws.close();
				});
				ws.once("close", () => {
					ptyProcess.kill();
					hangUpLocal();
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
			ws.close();
		}
	});
};

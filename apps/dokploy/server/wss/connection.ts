import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket, WebSocketServer } from "ws";
import { parseRequestUrl } from "../request-url";

const MAX_CLOSE_REASON_BYTES = 123;
const CLOSE_INTERNAL_ERROR = 1011;

// Generic on purpose: the session check runs first, so the error it carries
// (a database address, for one) could reach a client that has not signed in.
const CONNECTION_FAILED =
	"The panel could not open this connection. Check the panel logs.";

const UNKNOWN_PATH_RESPONSE =
	"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

// Filled as servers register, so a path has no copy to fall out of step and a
// server that was never set up (the stats one in the cloud) is not listed.
const servedUpgradePaths = new Set<string>();

// ws.close() throws on a reason longer than one control frame can carry.
export const toCloseReason = (text: string) => {
	let reason = text.slice(0, MAX_CLOSE_REASON_BYTES);
	while (Buffer.byteLength(reason) > MAX_CLOSE_REASON_BYTES) {
		reason = reason.slice(0, -1);
	}
	return reason;
};

// Each upgrade listener calls this for the same request, and destroy() is safe to repeat.
export const readUpgradePathname = (req: IncomingMessage, socket: Duplex) => {
	const url = parseRequestUrl(req);
	if (!url) {
		socket.destroy();
		return null;
	}
	return url.pathname;
};

// Without this such a socket is never freed: every listener skips it, nothing
// reads it, so even a client leaving goes unnoticed, and Node has dropped its
// timeouts by now. Next leaves it too, since an application's own server may
// listen on that path.
export const closeUnknownUpgradePaths = (
	server: Server,
	{ dev }: { dev: boolean },
) => {
	server.on("upgrade", (req, socket) => {
		const pathname = readUpgradePathname(req, socket);
		if (pathname === null || servedUpgradePaths.has(pathname)) {
			return;
		}
		// Next serves its hot reload socket from a listener of its own, and the
		// path changes between its versions.
		if (dev && pathname.startsWith("/_next/")) {
			return;
		}
		// Node removes its own error listener on upgrade, so a client resetting
		// the connection during this write would throw from the socket's callback.
		socket.on("error", () => {});
		socket.once("finish", () => socket.destroy());
		socket.end(UNKNOWN_PATH_RESPONSE);
	});
};

type ConnectionHandler = (ws: WebSocket, req: IncomingMessage) => Promise<void>;

const handleConnections = (
	wss: WebSocketServer,
	handler: ConnectionHandler,
	clientReadsText: boolean,
) => {
	if (wss.options.path) {
		servedUpgradePaths.add(wss.options.path);
	}

	wss.on("connection", (ws, req) => {
		// With no listener, EventEmitter throws this out of the socket's own
		// callback, and a malformed frame from any client is enough for that.
		ws.on("error", (error) => {
			console.error(`WebSocket error: ${error.message}`);
		});

		return handler(ws, req).catch((error: unknown) => {
			console.error("WebSocket handler failed:", error);
			if (ws.readyState !== ws.OPEN) {
				return;
			}
			if (clientReadsText) {
				ws.send(`${CONNECTION_FAILED}\n`);
			}
			ws.close(CLOSE_INTERNAL_ERROR, CONNECTION_FAILED);
		});
	});
};

export const onWebSocketConnection = (
	wss: WebSocketServer,
	handler: ConnectionHandler,
) => handleConnections(wss, handler, true);

// For a client that parses every message as JSON: plain text would throw there,
// so a failure reaches it only as the close reason.
export const onJsonWebSocketConnection = (
	wss: WebSocketServer,
	handler: ConnectionHandler,
) => handleConnections(wss, handler, false);

const CLIENT_PING_INTERVAL_MS = 30_000;

// A client that vanished without closing (a dropped network, a sleeping laptop)
// leaves no close event for a long time, and whatever the socket holds open
// stays until then. Terminates the socket when a ping goes unanswered.
export const stopWhenClientIsSilent = (
	ws: WebSocket,
	intervalMs = CLIENT_PING_INTERVAL_MS,
) => {
	let answered = true;
	ws.on("pong", () => {
		answered = true;
	});
	const timer = setInterval(() => {
		if (!answered) {
			ws.terminate();
			return;
		}
		answered = false;
		ws.ping();
	}, intervalMs);
	timer.unref();
	ws.once("close", () => clearInterval(timer));
};

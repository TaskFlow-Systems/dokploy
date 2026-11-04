import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket, WebSocketServer } from "ws";
import { parseRequestUrl } from "../request-url";

const MAX_CLOSE_REASON_BYTES = 123;
const CLOSE_INTERNAL_ERROR = 1011;

// Generic on purpose: the session check runs first, so the error it carries
// (a database address, for one) could reach a client that has not signed in.
const CONNECTION_FAILED =
	"The panel could not open this connection. Check the panel logs.";

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

type ConnectionHandler = (ws: WebSocket, req: IncomingMessage) => Promise<void>;

const handleConnections = (
	wss: WebSocketServer,
	handler: ConnectionHandler,
	clientReadsText: boolean,
) => {
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

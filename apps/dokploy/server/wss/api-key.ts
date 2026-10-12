import type { WebSocket } from "ws";

type WssSession = { authMethod?: string | null } | null | undefined;

// A shell or a raw log stream carries whatever the container prints, and a
// stream cannot be scrubbed of a secret split across two chunks. API keys read
// logs through the readLogs procedures, whose output is scrubbed.
export const rejectApiKeySession = (
	ws: Pick<WebSocket, "close">,
	session: WssSession,
) => {
	if (session?.authMethod !== "api-key") {
		return false;
	}
	ws.close(4003, "Not available to API keys");
	return true;
};

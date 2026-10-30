import type { IncomingMessage } from "node:http";
import { isApiKeySession } from "@/server/api/utils/api-key-session";
import { getRequestMeta } from "@/server/api/utils/request-meta";

type PanelRestartRequester = {
	req?: IncomingMessage;
	user: { email?: string | null; role?: string | null };
	session: { authMethod?: string | null } | null | undefined;
};

// Audit entries are stored only with an enterprise licence, so the panel's own
// log is the one record of who restarted or updated the panel.
export const logPanelRestart = (
	action: string,
	{ req, user, session }: PanelRestartRequester,
) => {
	const { ipAddress, userAgent } = getRequestMeta(req);
	const via = isApiKeySession(session) ? "an API key" : "a browser session";
	console.log(
		`[panel] ${action} requested by ${user.email || "an unknown user"} (${user.role || "no role"}) through ${via} from ${ipAddress ?? "an unknown address"}, user agent: ${userAgent ?? "none"}`,
	);
};

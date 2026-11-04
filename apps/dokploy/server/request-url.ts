import type { IncomingMessage } from "node:http";

// The target and Host come straight from the client, and `new URL` throws on a
// malformed one. Thrown from an HTTP or upgrade listener, nothing catches it.
export const parseRequestUrl = (req: IncomingMessage): URL | null => {
	try {
		return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	} catch {
		return null;
	}
};

export const isApplicationEnvUpsertRequest = (req: IncomingMessage) => {
	const url = parseRequestUrl(req);
	if (!url) {
		return false;
	}
	const pathname = url.pathname.replace(/\/+$/, "");
	const rawUrl = req.url ?? "";
	const forwardedUri = req.headers["x-forwarded-uri"];
	const forwardedPath =
		typeof forwardedUri === "string"
			? forwardedUri
			: Array.isArray(forwardedUri)
				? forwardedUri.join(" ")
				: "";
	const routeMarkers = [pathname, rawUrl, forwardedPath].join(" ");

	return (
		pathname === "/api/application/env/upsert" ||
		pathname === "/api/application.env.upsert" ||
		routeMarkers.includes("/api/application/env/upsert") ||
		routeMarkers.includes("/api/application.env.upsert")
	);
};

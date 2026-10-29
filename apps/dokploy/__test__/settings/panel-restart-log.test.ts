import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/db", () => ({ db: {} }));

const { logPanelRestart } = await import(
	"../../server/api/utils/panel-restart-log"
);

const request = (headers: Record<string, string>) =>
	({ headers }) as unknown as IncomingMessage;

describe("panel restart log", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("names the user, the address and the browser", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		logPanelRestart("Reload", {
			req: request({
				"x-forwarded-for": "198.51.100.7, 10.0.0.2",
				"user-agent": "Mozilla/5.0 Test",
			}),
			user: { email: "owner@example.com", role: "owner" },
			session: { authMethod: "session" },
		});

		expect(log).toHaveBeenCalledWith(
			"[panel] Reload requested by owner@example.com (owner) through a browser session from 198.51.100.7, user agent: Mozilla/5.0 Test",
		);
	});

	it("says when an API key started it", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		logPanelRestart("Update to agenthits-v1.1.0", {
			req: request({ "x-real-ip": "203.0.113.5" }),
			user: { email: "ci@example.com", role: "admin" },
			session: { authMethod: "api-key" },
		});

		expect(log).toHaveBeenCalledWith(
			"[panel] Update to agenthits-v1.1.0 requested by ci@example.com (admin) through an API key from 203.0.113.5, user agent: none",
		);
	});
});

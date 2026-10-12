import { describe, expect, it, vi } from "vitest";
import { rejectApiKeySession } from "../../server/wss/api-key";

describe("rejectApiKeySession", () => {
	it("closes a socket opened with an API key", () => {
		const ws = { close: vi.fn() };

		expect(rejectApiKeySession(ws, { authMethod: "api-key" })).toBe(true);
		expect(ws.close).toHaveBeenCalledWith(4003, "Not available to API keys");
	});

	it.each([{ authMethod: "session" }, {}, null, undefined])(
		"lets a browser session through (%o)",
		(session) => {
			const ws = { close: vi.fn() };

			expect(rejectApiKeySession(ws, session)).toBe(false);
			expect(ws.close).not.toHaveBeenCalled();
		},
	);
});

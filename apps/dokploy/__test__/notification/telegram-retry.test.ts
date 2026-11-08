import {
	sendTelegramNotification,
	TELEGRAM_SEND_ATTEMPTS,
} from "@dokploy/server/utils/notifications/utils";
import { Agent } from "@dokploy/server/utils/undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connection = {
	botToken: "123:token",
	chatId: "42",
	messageThreadId: null,
} as never;

const connectFailure = (code = "UND_ERR_CONNECT_TIMEOUT") =>
	Object.assign(new TypeError("fetch failed"), { cause: { code } });

const reply = (status: number, body: unknown = { ok: status === 200 }) =>
	new Response(JSON.stringify(body), { status });

const fetchMock = vi.hoisted(() => vi.fn());

// The sender posts through the undici package's fetch.
vi.mock("@dokploy/server/utils/undici", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/utils/undici")>()),
	fetch: fetchMock,
}));

const send = async () => {
	const result = sendTelegramNotification(connection, "Backup failed").then(
		() => "",
		(error: Error) => error.message,
	);
	await vi.runAllTimersAsync();
	return result;
};

beforeEach(() => {
	fetchMock.mockReset();
	vi.useFakeTimers({ toFake: ["setTimeout"] });
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("sendTelegramNotification", () => {
	it("tries again after connections that fail, and posts the message once", async () => {
		fetchMock
			.mockRejectedValueOnce(connectFailure())
			.mockRejectedValueOnce(connectFailure("ECONNREFUSED"))
			.mockRejectedValueOnce(connectFailure())
			.mockResolvedValueOnce(reply(200));

		expect(await send()).toBe("");

		expect(fetchMock).toHaveBeenCalledTimes(4);
		const calls = fetchMock.mock.calls;
		expect(new Set(calls.map(([url]) => url))).toEqual(
			new Set(["https://api.telegram.org/bot123:token/sendMessage"]),
		);
		expect(new Set(calls.map(([, init]) => init.body)).size).toBe(1);
		expect(JSON.parse(calls[0]?.[1].body)).toMatchObject({
			chat_id: "42",
			text: "Backup failed",
			parse_mode: "HTML",
		});
		const dispatcher = calls[0]?.[1].dispatcher;
		expect(dispatcher).toBeInstanceOf(Agent);
		expect(calls.every(([, init]) => init.dispatcher === dispatcher)).toBe(
			true,
		);
	});

	it("waits longer before each new attempt", async () => {
		fetchMock.mockRejectedValue(connectFailure());
		const result = sendTelegramNotification(connection, "x").catch(() => "");

		const callsAfter = async (ms: number) => {
			await vi.advanceTimersByTimeAsync(ms);
			return fetchMock.mock.calls.length;
		};
		expect(await callsAfter(0)).toBe(1);
		expect(await callsAfter(499)).toBe(1);
		expect(await callsAfter(1)).toBe(2);
		expect(await callsAfter(999)).toBe(2);
		expect(await callsAfter(1)).toBe(3);
		expect(await callsAfter(2_000)).toBe(4);
		expect(await callsAfter(4_000)).toBe(5);
		expect(await callsAfter(8_000)).toBe(6);
		await vi.runAllTimersAsync();
		await result;
		expect(fetchMock).toHaveBeenCalledTimes(TELEGRAM_SEND_ATTEMPTS);
	});

	it("gives up after the last attempt and names the last error", async () => {
		fetchMock.mockRejectedValue(connectFailure());

		expect(await send()).toBe(
			"Failed to send telegram notification: fetch failed (UND_ERR_CONNECT_TIMEOUT)",
		);
		expect(fetchMock).toHaveBeenCalledTimes(TELEGRAM_SEND_ATTEMPTS);
	});

	it("does not try again when Telegram refuses the message", async () => {
		fetchMock.mockResolvedValueOnce(
			reply(401, { ok: false, error_code: 401, description: "Unauthorized" }),
		);

		expect(await send()).toBe(
			'Failed to send telegram notification: 401 {"ok":false,"error_code":401,"description":"Unauthorized"}',
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not try again after a failure that may come after the message left", async () => {
		fetchMock.mockRejectedValueOnce(connectFailure("UND_ERR_SOCKET"));

		expect(await send()).toContain("fetch failed");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("waits as long as Telegram asks after a 429", async () => {
		fetchMock
			.mockResolvedValueOnce(
				reply(429, { ok: false, parameters: { retry_after: 3 } }),
			)
			.mockResolvedValueOnce(reply(200));
		const result = sendTelegramNotification(connection, "x");

		await vi.advanceTimersByTimeAsync(2_999);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await expect(result).resolves.toBeUndefined();
	});

	it("gives up at once when Telegram asks to wait longer than 30 s", async () => {
		fetchMock.mockResolvedValueOnce(
			reply(429, { ok: false, parameters: { retry_after: 31 } }),
		);

		expect(await send()).toContain("429");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("tries again after a server error", async () => {
		fetchMock
			.mockResolvedValueOnce(reply(502, { ok: false }))
			.mockResolvedValueOnce(reply(200));

		expect(await send()).toBe("");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

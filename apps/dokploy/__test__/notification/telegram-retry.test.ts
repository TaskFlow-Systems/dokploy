import {
	sendTelegramNotification,
	TELEGRAM_SEND_ATTEMPTS,
	TELEGRAM_SEND_BUDGET_MS,
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
	vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
	vi.spyOn(Math, "random").mockReturnValue(0.5);
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

	it("waits briefly after a failed connect, since the next one is independent", async () => {
		fetchMock.mockRejectedValue(connectFailure());
		const result = sendTelegramNotification(connection, "x").catch(() => "");

		const callsAfter = async (ms: number) => {
			await vi.advanceTimersByTimeAsync(ms);
			return fetchMock.mock.calls.length;
		};
		expect(await callsAfter(0)).toBe(1);
		expect(await callsAfter(249)).toBe(1);
		expect(await callsAfter(1)).toBe(2);
		expect(await callsAfter(499)).toBe(2);
		expect(await callsAfter(1)).toBe(3);
		expect(await callsAfter(1_000)).toBe(4);
		expect(await callsAfter(1_000)).toBe(5);
		expect(await callsAfter(1_000)).toBe(6);
		await vi.runAllTimersAsync();
		await result;
		expect(fetchMock).toHaveBeenCalledTimes(TELEGRAM_SEND_ATTEMPTS);
	});

	it("waits longer before each new attempt after a server error", async () => {
		fetchMock.mockImplementation(async () => reply(503, { ok: false }));
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
		await vi.runAllTimersAsync();
		await result;
		expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(
			TELEGRAM_SEND_ATTEMPTS,
		);
	});

	it("spreads the waits so that sends that failed together do not return together", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		fetchMock.mockRejectedValue(connectFailure());
		const result = sendTelegramNotification(connection, "x").catch(() => "");
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(187);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await vi.runAllTimersAsync();
		await result;
	});

	it("gives up after the last attempt and names the last error", async () => {
		fetchMock.mockRejectedValue(connectFailure());

		expect(await send()).toBe(
			"Failed to send telegram notification: fetch failed (UND_ERR_CONNECT_TIMEOUT) (6 attempts, 4 s)",
		);
		expect(fetchMock).toHaveBeenCalledTimes(TELEGRAM_SEND_ATTEMPTS);
	});

	it("does not try again when Telegram refuses the message", async () => {
		fetchMock.mockResolvedValueOnce(
			reply(401, { ok: false, error_code: 401, description: "Unauthorized" }),
		);

		expect(await send()).toBe(
			'Failed to send telegram notification: 401 {"ok":false,"error_code":401,"description":"Unauthorized"} (1 attempt, 0 s)',
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([400, 403, 404])("does not try again after a %i", async (status) => {
		fetchMock.mockResolvedValueOnce(reply(status, { ok: false }));

		expect(await send()).toContain(String(status));
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

	it("gives up at once when Telegram asks to wait longer than the budget allows", async () => {
		fetchMock.mockResolvedValueOnce(
			reply(429, { ok: false, parameters: { retry_after: 31 } }),
		);

		const message = await send();

		expect(message).toContain("429");
		expect(message).toContain("Telegram asks to wait 31 s");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("counts the time already spent against a long retry_after", async () => {
		fetchMock
			.mockRejectedValueOnce(connectFailure())
			.mockRejectedValueOnce(connectFailure())
			.mockResolvedValueOnce(
				reply(429, { ok: false, parameters: { retry_after: 30 } }),
			);

		const message = await send();

		expect(message).toContain("Telegram asks to wait 30 s");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("ends a Telegram that is down for good well inside the budget", async () => {
		fetchMock.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					setTimeout(() => reject(connectFailure()), 3_000);
				}),
		);
		const startedAt = Date.now();

		const message = await send();

		const elapsed = Date.now() - startedAt;
		expect(message).toContain("6 attempts");
		expect(fetchMock).toHaveBeenCalledTimes(TELEGRAM_SEND_ATTEMPTS);
		expect(elapsed).toBeGreaterThan(18_000);
		expect(elapsed).toBeLessThan(24_000);
		expect(elapsed).toBeLessThan(TELEGRAM_SEND_BUDGET_MS);
	});

	it("passes the rest of the budget to every request", async () => {
		fetchMock.mockResolvedValueOnce(reply(200));

		await send();

		const signal = fetchMock.mock.calls[0]?.[1].signal as AbortSignal;
		expect(signal).toBeInstanceOf(AbortSignal);
	});

	it("tries again after a server error", async () => {
		fetchMock
			.mockResolvedValueOnce(reply(502, { ok: false }))
			.mockResolvedValueOnce(reply(200));

		expect(await send()).toBe("");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

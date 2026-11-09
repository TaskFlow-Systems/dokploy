import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	sendTelegramNotification: vi.fn(),
	sendDiscordNotification: vi.fn(),
	sendSlackNotification: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: { notifications: { findMany: mocks.findMany } } },
}));

vi.mock("@dokploy/server/utils/notifications/utils", () => ({
	escapeHtml: (s: string) => s,
	sendTelegramNotification: mocks.sendTelegramNotification,
	sendDiscordNotification: mocks.sendDiscordNotification,
	sendSlackNotification: mocks.sendSlackNotification,
}));

const { notifyInBackground, settleBackgroundNotifications } = await import(
	"@dokploy/server/utils/notifications/background"
);
const { sendDockerCleanupNotifications } = await import(
	"@dokploy/server/utils/notifications/docker-cleanup"
);

afterEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

describe("notifyInBackground", () => {
	it("returns at once while the task is still running", async () => {
		let finish = () => {};
		const task = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);

		expect(notifyInBackground("test", task)).toBeUndefined();
		expect(task).toHaveBeenCalledTimes(1);

		let settled = false;
		const waiting = settleBackgroundNotifications().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		finish();
		await waiting;
		expect(settled).toBe(true);
	});

	it("logs a failed task, also one that throws before returning a promise", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		notifyInBackground("first", async () => {
			throw new Error("rejected");
		});
		notifyInBackground("second", () => {
			throw new Error("thrown");
		});
		await settleBackgroundNotifications();

		expect(log).toHaveBeenCalledTimes(2);
		expect(log.mock.calls.map(([message]) => message).sort()).toEqual([
			"Failed to send the first notification:",
			"Failed to send the second notification:",
		]);
	});
});

describe("channels of one event", () => {
	it("are sent together: a channel that hangs does not hold the others back", async () => {
		mocks.findMany.mockResolvedValue([
			{ telegram: { chatId: "1" } },
			{ discord: { webhookUrl: "https://example.com/hook" } },
			{ slack: { webhookUrl: "https://example.com/slack" } },
		]);
		mocks.sendTelegramNotification.mockReturnValue(new Promise(() => {}));
		mocks.sendDiscordNotification.mockResolvedValue(undefined);
		mocks.sendSlackNotification.mockResolvedValue(undefined);

		void sendDockerCleanupNotifications("org-a");
		await vi.waitFor(() => {
			expect(mocks.sendDiscordNotification).toHaveBeenCalledTimes(1);
			expect(mocks.sendSlackNotification).toHaveBeenCalledTimes(1);
		});
		expect(mocks.sendTelegramNotification).toHaveBeenCalledTimes(1);
	});

	it("still reaches the others when one fails", async () => {
		mocks.findMany.mockResolvedValue([
			{ telegram: { chatId: "1" } },
			{ discord: { webhookUrl: "https://example.com/hook" } },
		]);
		mocks.sendTelegramNotification.mockRejectedValue(new Error("down"));
		mocks.sendDiscordNotification.mockResolvedValue(undefined);
		vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(sendDockerCleanupNotifications("org-a")).resolves.toBe(
			undefined,
		);
		expect(mocks.sendDiscordNotification).toHaveBeenCalledTimes(1);
	});
});

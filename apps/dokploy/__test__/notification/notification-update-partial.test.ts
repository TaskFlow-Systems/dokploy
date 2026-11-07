import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	set: vi.fn(),
	select: vi.fn(),
	transaction: vi.fn(),
	findFirst: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			custom: { findFirst: mocks.findFirst },
			email: { findFirst: mocks.findFirst },
			gotify: { findFirst: mocks.findFirst },
			ntfy: { findFirst: mocks.findFirst },
		},
		transaction: mocks.transaction,
	},
}));

const services = await import("@dokploy/server/services/notification");

const row = { notificationId: "notification-1" };

// Each recorded set carries the name of the table it was called on.
const calls = () =>
	mocks.set.mock.calls.map(([table, values]) => ({
		table: table as string,
		values: values as Record<string, unknown>,
	}));

describe("notification update with a partial body", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		const tx = {
			update: vi.fn((table: Parameters<typeof getTableName>[0]) => ({
				set: (values: unknown) => {
					mocks.set(getTableName(table), values);
					if (Object.keys(values as object).length === 0) {
						throw new Error("No values to set");
					}
					return {
						where: vi.fn(() => ({
							returning: vi.fn(async () => [row]),
						})),
					};
				},
			})),
			select: vi.fn(() => {
				mocks.select();
				return {
					from: () => ({
						where: () => ({ limit: () => Promise.resolve([row]) }),
					}),
				};
			}),
		};
		mocks.transaction.mockImplementation(async (callback) => callback(tx));
		mocks.findFirst.mockResolvedValue(undefined);
	});

	const base = { notificationId: "notification-1" };

	const cases = [
		[
			"slack",
			() =>
				services.updateSlackNotification({
					...base,
					slackId: "s",
					dockerCleanup: true,
				} as never),
			"slack",
		],
		[
			"telegram",
			() =>
				services.updateTelegramNotification({
					...base,
					telegramId: "t",
					dockerCleanup: true,
				} as never),
			"telegram",
		],
		[
			"discord",
			() =>
				services.updateDiscordNotification({
					...base,
					discordId: "d",
					dockerCleanup: true,
				} as never),
			"discord",
		],
		[
			"email",
			() =>
				services.updateEmailNotification({
					...base,
					emailId: "e",
					dockerCleanup: true,
				} as never),
			"email",
		],
		[
			"resend",
			() =>
				services.updateResendNotification({
					...base,
					resendId: "r",
					dockerCleanup: true,
				} as never),
			"resend",
		],
		[
			"gotify",
			() =>
				services.updateGotifyNotification({
					...base,
					gotifyId: "g",
					dockerCleanup: true,
				} as never),
			"gotify",
		],
		[
			"ntfy",
			() =>
				services.updateNtfyNotification({
					...base,
					ntfyId: "n",
					dockerCleanup: true,
				} as never),
			"ntfy",
		],
		[
			"custom",
			() =>
				services.updateCustomNotification({
					...base,
					customId: "c",
					dockerCleanup: true,
				} as never),
			"custom",
		],
		[
			"lark",
			() =>
				services.updateLarkNotification({
					...base,
					larkId: "l",
					dockerCleanup: true,
				} as never),
			"lark",
		],
		[
			"teams",
			() =>
				services.updateTeamsNotification({
					...base,
					teamsId: "t",
					dockerCleanup: true,
				} as never),
			"teams",
		],
		[
			"mattermost",
			() =>
				services.updateMattermostNotification({
					...base,
					mattermostId: "m",
					dockerCleanup: true,
				} as never),
			"mattermost",
		],
		[
			"pushover",
			() =>
				services.updatePushoverNotification({
					...base,
					pushoverId: "p",
					dockerCleanup: true,
				} as never),
			"pushover",
		],
	] as const;

	it.each(cases)(
		"%s: an event flag alone updates only the notifications row",
		async (_name, run, tableName) => {
			await expect(run()).resolves.not.toThrow();
			const sets = calls();
			expect(sets.some(({ values }) => Object.keys(values).length === 0)).toBe(
				false,
			);
			expect(sets.map(({ table }) => table)).toEqual(["notification"]);
			expect(sets[0]?.values).toMatchObject({ dockerCleanup: true });
			expect(sets.map(({ table }) => table)).not.toContain(tableName);
		},
	);

	it("ntfy: a provider field still updates the provider row", async () => {
		await services.updateNtfyNotification({
			...base,
			ntfyId: "n",
			topic: "alerts",
		} as never);
		const sets = calls();
		expect(sets.map(({ table }) => table)).toEqual(["ntfy"]);
		expect(sets[0]?.values).toMatchObject({ topic: "alerts" });
		expect(mocks.select).toHaveBeenCalledTimes(1);
	});

	it("slack: event flag and provider field update both rows", async () => {
		await services.updateSlackNotification({
			...base,
			slackId: "s",
			dockerCleanup: true,
			channel: "#ops",
		} as never);
		expect(calls().map(({ table }) => table)).toEqual([
			"notification",
			"slack",
		]);
	});
});

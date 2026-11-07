import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isEncrypted } from "@dokploy/server/lib/encryption";
import { REDACTED_NOTIFICATION_SECRET } from "@dokploy/server/utils/notifications/security";
import { getTableColumns } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	select: vi.fn(),
	update: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: { notifications: { findFirst: mocks.findFirst } },
		select: mocks.select,
		update: mocks.update,
	},
}));

const {
	encryptStoredNotificationSecrets,
	findNotificationSecret,
	withStoredNotificationSecrets,
} = await import("@dokploy/server/services/notification");
const schema = await import("@dokploy/server/db/schema");

const saved = (provider: string, stored: Record<string, unknown>) => ({
	notificationId: "notification-1",
	name: "alerts",
	organizationId: "org-1",
	notificationType: provider,
	[provider]: stored,
});

describe("Test on a saved channel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("sends what the form holds when no field is a placeholder", async () => {
		const input = { botToken: "123:new-token", chatId: "42" };

		await expect(
			withStoredNotificationSecrets(
				"telegram",
				input,
				"notification-1",
				"org-1",
			),
		).resolves.toBe(input);
		expect(mocks.findFirst).not.toHaveBeenCalled();
	});

	it("takes the saved bot token in place of the placeholder", async () => {
		mocks.findFirst.mockResolvedValue(
			saved("telegram", { botToken: "123:saved-token", chatId: "42" }),
		);

		await expect(
			withStoredNotificationSecrets(
				"telegram",
				{
					botToken: REDACTED_NOTIFICATION_SECRET,
					chatId: "43",
					messageThreadId: "",
				},
				"notification-1",
				"org-1",
			),
		).resolves.toEqual({
			botToken: "123:saved-token",
			chatId: "43",
			messageThreadId: "",
		});
	});

	it("asks for the secret when the channel is not saved yet", async () => {
		await expect(
			withStoredNotificationSecrets(
				"telegram",
				{ botToken: REDACTED_NOTIFICATION_SECRET, chatId: "42" },
				undefined,
				"org-1",
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "Enter the botToken to test this channel",
		});
	});

	it("refuses a channel of another organization", async () => {
		mocks.findFirst.mockResolvedValue({
			...saved("telegram", { botToken: "123:saved-token" }),
			organizationId: "org-2",
		});

		await expect(
			withStoredNotificationSecrets(
				"telegram",
				{ botToken: REDACTED_NOTIFICATION_SECRET, chatId: "42" },
				"notification-1",
				"org-1",
			),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("refuses a channel of another provider", async () => {
		mocks.findFirst.mockResolvedValue(
			saved("slack", { webhookUrl: "https://hooks.slack.com/services/T/B/x" }),
		);

		await expect(
			withStoredNotificationSecrets(
				"telegram",
				{ botToken: REDACTED_NOTIFICATION_SECRET, chatId: "42" },
				"notification-1",
				"org-1",
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "This notification has no saved telegram settings",
		});
	});

	it("sends the saved SMTP password only to the saved server and user", async () => {
		mocks.findFirst.mockResolvedValue(
			saved("email", {
				smtpServer: "smtp.example.com",
				smtpPort: 587,
				username: "alerts@example.com",
				password: "saved-smtp-password",
			}),
		);
		const input = {
			smtpServer: "smtp.example.com",
			smtpPort: 587,
			username: "alerts@example.com",
			password: REDACTED_NOTIFICATION_SECRET,
			fromAddress: "alerts@example.com",
			toAddresses: ["ops@example.com"],
		};

		for (const [field, change] of [
			["smtpServer", { smtpServer: "smtp.collector.example.net" }],
			["smtpPort", { smtpPort: 2525 }],
			["username", { username: "other@example.net" }],
		] as const) {
			await expect(
				withStoredNotificationSecrets(
					"email",
					{ ...input, ...change },
					"notification-1",
					"org-1",
				),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: `Re-enter the SMTP password to change ${field}`,
			});
		}

		await expect(
			withStoredNotificationSecrets(
				"email",
				{ ...input, smtpServer: "SMTP.example.com" },
				"notification-1",
				"org-1",
			),
		).resolves.toMatchObject({ password: "saved-smtp-password" });
	});

	it.each([
		["gotify", "appToken"],
		["ntfy", "accessToken"],
	])(
		"sends the saved %s token only to the saved server",
		async (provider, field) => {
			mocks.findFirst.mockResolvedValue(
				saved(provider, {
					serverUrl: "https://push.example.com",
					[field]: "saved-token",
				}),
			);

			await expect(
				withStoredNotificationSecrets(
					provider as "gotify" | "ntfy",
					{
						serverUrl: "https://push.collector.example.net",
						[field]: REDACTED_NOTIFICATION_SECRET,
					},
					"notification-1",
					"org-1",
				),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: `Re-enter the ${provider} token to change serverUrl`,
			});
			await expect(
				withStoredNotificationSecrets(
					provider as "gotify" | "ntfy",
					{
						serverUrl: "https://push.example.com/",
						[field]: REDACTED_NOTIFICATION_SECRET,
					},
					"notification-1",
					"org-1",
				),
			).resolves.toMatchObject({ [field]: "saved-token" });
		},
	);

	it("sends saved custom headers only to the saved endpoint", async () => {
		mocks.findFirst.mockResolvedValue(
			saved("custom", {
				endpoint: "https://hooks.example.com/notify",
				headers: { Authorization: "Bearer saved", "X-Team": "ops" },
			}),
		);

		await expect(
			withStoredNotificationSecrets(
				"custom",
				{
					endpoint: "https://collector.example.net/",
					headers: { Authorization: REDACTED_NOTIFICATION_SECRET },
				},
				"notification-1",
				"org-1",
			),
		).rejects.toMatchObject({
			message: "Re-enter the custom notification headers to change endpoint",
		});
		await expect(
			withStoredNotificationSecrets(
				"custom",
				{
					endpoint: REDACTED_NOTIFICATION_SECRET,
					headers: {
						Authorization: REDACTED_NOTIFICATION_SECRET,
						"X-Team": "dev",
					},
				},
				"notification-1",
				"org-1",
			),
		).resolves.toEqual({
			endpoint: "https://hooks.example.com/notify",
			headers: { Authorization: "Bearer saved", "X-Team": "dev" },
		});
		await expect(
			withStoredNotificationSecrets(
				"custom",
				{
					endpoint: REDACTED_NOTIFICATION_SECRET,
					headers: { Cookie: REDACTED_NOTIFICATION_SECRET },
				},
				"notification-1",
				"org-1",
			),
		).rejects.toMatchObject({
			message: "Enter the value of the Cookie header to test this channel",
		});
	});

	it("takes both saved Pushover keys", async () => {
		mocks.findFirst.mockResolvedValue(
			saved("pushover", { userKey: "saved-user", apiToken: "saved-api" }),
		);

		await expect(
			withStoredNotificationSecrets(
				"pushover",
				{
					userKey: REDACTED_NOTIFICATION_SECRET,
					apiToken: REDACTED_NOTIFICATION_SECRET,
					priority: 0,
				},
				"notification-1",
				"org-1",
			),
		).resolves.toEqual({
			userKey: "saved-user",
			apiToken: "saved-api",
			priority: 0,
		});
	});
});

describe("revealing a saved secret", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns a secret field of the channel's provider", async () => {
		mocks.findFirst.mockResolvedValue(
			saved("telegram", { botToken: "123:saved-token", chatId: "42" }),
		);

		await expect(
			findNotificationSecret("notification-1", "org-1", "botToken"),
		).resolves.toMatchObject({ value: "123:saved-token" });
		await expect(
			findNotificationSecret("notification-1", "org-1", "chatId"),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("refuses a channel of another organization", async () => {
		mocks.findFirst.mockResolvedValue({
			...saved("telegram", { botToken: "123:saved-token" }),
			organizationId: "org-2",
		});

		await expect(
			findNotificationSecret("notification-1", "org-1", "botToken"),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});

describe("notification secrets at rest", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each([
		["slack", "webhookUrl"],
		["telegram", "botToken"],
		["discord", "webhookUrl"],
		["email", "password"],
		["resend", "apiKey"],
		["gotify", "appToken"],
		["ntfy", "accessToken"],
		["mattermost", "webhookUrl"],
		["custom", "endpoint"],
		["lark", "webhookUrl"],
		["pushover", "userKey"],
		["pushover", "apiToken"],
		["teams", "webhookUrl"],
	])("encrypts %s.%s", (table, field) => {
		const column = (
			getTableColumns(schema[table as keyof typeof schema] as never) as Record<
				string,
				{
					mapToDriverValue: (value: string) => string;
					mapFromDriverValue: (value: string) => string;
				}
			>
		)[field];
		const stored = column?.mapToDriverValue("secret-value") ?? "";

		expect(isEncrypted(stored)).toBe(true);
		expect(column?.mapFromDriverValue(stored)).toBe("secret-value");
		expect(column?.mapFromDriverValue("plain-legacy-value")).toBe(
			"plain-legacy-value",
		);
	});

	it("writes plain values once more and leaves encrypted ones", async () => {
		const encrypted = (
			getTableColumns(schema.telegram).botToken as unknown as {
				mapToDriverValue: (value: string) => string;
			}
		).mapToDriverValue("already-encrypted");
		mocks.select.mockImplementation(() => ({
			from: (table: unknown) => ({
				where: async () =>
					table === schema.telegram
						? [
								{ id: "telegram-1", value: "123:plain-token" },
								{ id: "telegram-2", value: encrypted },
							]
						: [],
			}),
		}));
		const sets: unknown[] = [];
		mocks.update.mockImplementation(() => ({
			set: (values: unknown) => {
				sets.push(values);
				return { where: async () => undefined };
			},
		}));

		await expect(encryptStoredNotificationSecrets()).resolves.toBe(1);
		expect(sets).toEqual([{ botToken: "123:plain-token" }]);
	});
});

describe("the notification form", () => {
	const form = readFileSync(
		join(
			__dirname,
			"../../components/dashboard/settings/notifications/handle-notifications.tsx",
		),
		"utf8",
	);

	it("hides every secret field behind the reveal input", () => {
		for (const field of [
			"webhookUrl",
			"botToken",
			"password",
			"apiKey",
			"appToken",
			"accessToken",
			"endpoint",
			"userKey",
			"apiToken",
		]) {
			expect(form).toContain(`secretField="${field}"`);
		}
		expect(form.match(/<NotificationSecretInput/g)).toHaveLength(13);
	});

	it("sends the channel with every Test", () => {
		const calls = form.match(/await test\w+Connection\(\{[^}]*/g) ?? [];

		expect(calls).toHaveLength(12);
		for (const call of calls) {
			expect(call).toContain("notificationId: notificationId || undefined");
		}
	});
});

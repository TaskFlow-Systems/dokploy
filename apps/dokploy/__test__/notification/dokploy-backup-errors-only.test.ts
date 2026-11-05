import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	sendTelegramNotification: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: { notifications: { findMany: mocks.findMany } } },
}));

vi.mock("@dokploy/server/utils/notifications/utils", () => ({
	escapeHtml: (text: string) => text,
	formatTelegramErrorMessage: (text: string) => text,
	sendCustomNotification: vi.fn(),
	sendDiscordNotification: vi.fn(),
	sendEmailNotification: vi.fn(),
	sendGotifyNotification: vi.fn(),
	sendLarkNotification: vi.fn(),
	sendMattermostNotification: vi.fn(),
	sendNtfyNotification: vi.fn(),
	sendPushoverNotification: vi.fn(),
	sendResendNotification: vi.fn(),
	sendSlackNotification: vi.fn(),
	sendTeamsNotification: vi.fn(),
	sendTelegramNotification: mocks.sendTelegramNotification,
}));

import {
	apiCreateCustom,
	apiCreateDiscord,
	apiCreateEmail,
	apiCreateGotify,
	apiCreateLark,
	apiCreateMattermost,
	apiCreateNtfy,
	apiCreatePushover,
	apiCreateResend,
	apiCreateSlack,
	apiCreateTeams,
	apiCreateTelegram,
	apiUpdatePushover,
	apiUpdateTelegram,
} from "@dokploy/server/db/schema/notification";
import { sendDokployBackupNotifications } from "@dokploy/server/utils/notifications/dokploy-backup";

const channel = (name: string, dokployBackupErrorsOnly: boolean) => ({
	name,
	dokployBackupErrorsOnly,
	telegram: { botToken: "token", chatId: name },
});

const notifiedChats = () =>
	mocks.sendTelegramNotification.mock.calls.map(
		([telegram]) => telegram.chatId,
	);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findMany.mockResolvedValue([
		channel("everything", false),
		channel("failures", true),
	]);
});

describe("sendDokployBackupNotifications", () => {
	it("leaves a failures-only channel out of a success message", async () => {
		await sendDokployBackupNotifications({
			type: "success",
			backupSize: "73 MB",
		});

		expect(notifiedChats()).toEqual(["everything"]);
	});

	it("tells a failures-only channel about a failure, with its cause", async () => {
		await sendDokployBackupNotifications({
			type: "error",
			errorMessage: "upload refused",
		});

		expect(notifiedChats()).toEqual(["everything", "failures"]);
		const [, text] = mocks.sendTelegramNotification.mock.calls[1] ?? [];
		expect(text).toContain("Dokploy Backup Failed");
		expect(text).toContain("upload refused");
	});
});

describe("notification input schemas", () => {
	const flags = {
		name: "alerts",
		appDeploy: false,
		appBuildError: false,
		databaseBackup: false,
		dokployBackup: true,
		volumeBackup: false,
		dokployRestart: false,
		dockerCleanup: false,
		serverThreshold: false,
	};
	const webhook = { ...flags, webhookUrl: "https://example.com/hook" };
	const creates = [
		["slack", apiCreateSlack, { ...webhook, channel: "ops" }],
		[
			"telegram",
			apiCreateTelegram,
			{ ...flags, botToken: "token", chatId: "1", messageThreadId: "" },
		],
		["discord", apiCreateDiscord, { ...webhook, decoration: false }],
		[
			"email",
			apiCreateEmail,
			{
				...flags,
				smtpServer: "smtp.example.com",
				smtpPort: 587,
				username: "user",
				password: "password",
				fromAddress: "from@example.com",
				toAddresses: ["to@example.com"],
			},
		],
		[
			"resend",
			apiCreateResend,
			{
				...flags,
				apiKey: "key",
				fromAddress: "from@example.com",
				toAddresses: ["to@example.com"],
			},
		],
		[
			"gotify",
			apiCreateGotify,
			{
				...flags,
				serverUrl: "https://example.com",
				appToken: "token",
				priority: 5,
				decoration: false,
			},
		],
		[
			"ntfy",
			apiCreateNtfy,
			{
				...flags,
				serverUrl: "https://example.com",
				topic: "topic",
				accessToken: "token",
				priority: 3,
			},
		],
		["mattermost", apiCreateMattermost, webhook],
		["custom", apiCreateCustom, { ...flags, endpoint: "https://example.com" }],
		["lark", apiCreateLark, webhook],
		["teams", apiCreateTeams, webhook],
		[
			"pushover",
			apiCreatePushover,
			{ ...flags, userKey: "user", apiToken: "token" },
		],
	] as const;

	it.each(creates)(
		"%s takes the setting and still accepts a client that does not send it",
		(_name, schema, input) => {
			const without = schema.safeParse(input);
			expect(without.error).toBeUndefined();
			expect(without.data).not.toHaveProperty("dokployBackupErrorsOnly");

			const withIt = schema.parse({
				...input,
				dokployBackupErrorsOnly: true,
			});
			expect(withIt).toMatchObject({ dokployBackupErrorsOnly: true });
		},
	);

	it("keeps the setting on updates, including Pushover's separate schema", () => {
		for (const [schema, ids] of [
			[apiUpdateTelegram, { telegramId: "t" }],
			[apiUpdatePushover, { pushoverId: "p" }],
		] as const) {
			const input = { notificationId: "n", ...ids };
			expect(
				schema.parse({ ...input, dokployBackupErrorsOnly: true }),
			).toMatchObject({ dokployBackupErrorsOnly: true });
			expect(schema.parse(input)).not.toHaveProperty("dokployBackupErrorsOnly");
		}
	});
});

describe("wiring that the type checker cannot see", () => {
	const read = (path: string) =>
		readFileSync(join(__dirname, "../../..", path), "utf8");
	const count = (text: string, needle: string) => text.split(needle).length - 1;

	it("every provider's create and update writes the setting", () => {
		const service = read("../packages/server/src/services/notification.ts");

		expect(count(service, "dokployBackup: input.dokployBackup,")).toBe(24);
		expect(
			count(service, "dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,"),
		).toBe(24);
	});

	it("the form loads and sends the setting for every provider", () => {
		const form = read(
			"dokploy/components/dashboard/settings/notifications/handle-notifications.tsx",
		);

		for (const [flag, setting] of [
			[
				"dokployBackup: notification.dokployBackup,",
				"dokployBackupErrorsOnly: notification.dokployBackupErrorsOnly,",
			],
			[
				"dokployBackup: dokployBackup,",
				"dokployBackupErrorsOnly: dokployBackupErrorsOnly,",
			],
		] as const) {
			expect(count(form, setting)).toBe(count(form, flag));
		}
	});
});

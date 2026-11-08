import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	sendTelegramNotification: vi.fn(),
	sendSlackNotification: vi.fn(),
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
	sendSlackNotification: mocks.sendSlackNotification,
	sendTeamsNotification: vi.fn(),
	sendTelegramNotification: mocks.sendTelegramNotification,
}));

import { sendDatabaseBackupNotifications } from "@dokploy/server/utils/notifications/database-backup";

const base = {
	projectName: "shop",
	applicationName: "main-db",
	databaseType: "postgres" as const,
	type: "error" as const,
	organizationId: "org-1",
	databaseName: "appdb",
	errorMessage: "pg_restore: error: password=hunter2 rejected",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findMany.mockResolvedValue([
		{
			telegram: { botToken: "token", chatId: "chat" },
			slack: { webhookUrl: "https://hooks.example.test/Database Backup" },
		},
	]);
});

describe("sendDatabaseBackupNotifications for a restore", () => {
	it("says restore, keeps the error and redacts secrets", async () => {
		await sendDatabaseBackupNotifications({ ...base, operation: "restore" });

		const text = mocks.sendTelegramNotification.mock.calls[0]![1] as string;
		expect(text).toContain("Database Restore Failed");
		expect(text).not.toContain("Backup");
		expect(text).toContain("pg_restore: error");
		expect(text).not.toContain("hunter2");

		const [slack, payload] = mocks.sendSlackNotification.mock.calls[0]!;
		expect(slack.webhookUrl).toBe("https://hooks.example.test/Database Backup");
		expect(JSON.stringify(payload)).toContain("Database Restore Failed");
		expect(JSON.stringify(payload)).not.toContain("Database Backup");
	});

	it("keeps the backup wording by default", async () => {
		await sendDatabaseBackupNotifications(base);

		expect(mocks.sendTelegramNotification.mock.calls[0]![1]).toContain(
			"Database Backup Failed",
		);
	});
});

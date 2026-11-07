import { REDACTED_NOTIFICATION_SECRET } from "@dokploy/server/utils/notifications/security";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	audit: vi.fn(),
	checkPermission: vi.fn(),
	createCustomNotification: vi.fn(),
	createDiscordNotification: vi.fn(),
	createEmailNotification: vi.fn(),
	createGotifyNotification: vi.fn(),
	createLarkNotification: vi.fn(),
	createMattermostNotification: vi.fn(),
	createNtfyNotification: vi.fn(),
	createPushoverNotification: vi.fn(),
	createResendNotification: vi.fn(),
	createSlackNotification: vi.fn(),
	createTeamsNotification: vi.fn(),
	createTelegramNotification: vi.fn(),
	findManyNotifications: vi.fn(),
	findNotificationById: vi.fn(),
	findNotificationSecret: vi.fn(),
	getWebServerSettings: vi.fn(),
	removeNotificationById: vi.fn(),
	select: vi.fn(),
	sendCustomNotification: vi.fn(),
	sendDiscordNotification: vi.fn(),
	sendEmailNotification: vi.fn(),
	sendGotifyNotification: vi.fn(),
	sendLarkNotification: vi.fn(),
	sendMattermostNotification: vi.fn(),
	sendNtfyNotification: vi.fn(),
	sendPushoverNotification: vi.fn(),
	sendResendNotification: vi.fn(),
	sendServerThresholdNotifications: vi.fn(),
	sendSlackNotification: vi.fn(),
	sendTeamsNotification: vi.fn(),
	sendTelegramNotification: vi.fn(),
	updateCustomNotification: vi.fn(),
	updateDiscordNotification: vi.fn(),
	updateEmailNotification: vi.fn(),
	updateGotifyNotification: vi.fn(),
	updateLarkNotification: vi.fn(),
	updateMattermostNotification: vi.fn(),
	updateNtfyNotification: vi.fn(),
	updatePushoverNotification: vi.fn(),
	updateResendNotification: vi.fn(),
	updateSlackNotification: vi.fn(),
	updateTeamsNotification: vi.fn(),
	updateTelegramNotification: vi.fn(),
	withStoredNotificationSecrets: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	createCustomNotification: mocks.createCustomNotification,
	createDiscordNotification: mocks.createDiscordNotification,
	createEmailNotification: mocks.createEmailNotification,
	createGotifyNotification: mocks.createGotifyNotification,
	createLarkNotification: mocks.createLarkNotification,
	createMattermostNotification: mocks.createMattermostNotification,
	createNtfyNotification: mocks.createNtfyNotification,
	createPushoverNotification: mocks.createPushoverNotification,
	createResendNotification: mocks.createResendNotification,
	createSlackNotification: mocks.createSlackNotification,
	createTeamsNotification: mocks.createTeamsNotification,
	createTelegramNotification: mocks.createTelegramNotification,
	findNotificationById: mocks.findNotificationById,
	findNotificationSecret: mocks.findNotificationSecret,
	getWebServerSettings: mocks.getWebServerSettings,
	removeNotificationById: mocks.removeNotificationById,
	sendCustomNotification: mocks.sendCustomNotification,
	sendDiscordNotification: mocks.sendDiscordNotification,
	sendEmailNotification: mocks.sendEmailNotification,
	sendGotifyNotification: mocks.sendGotifyNotification,
	sendLarkNotification: mocks.sendLarkNotification,
	sendMattermostNotification: mocks.sendMattermostNotification,
	sendNtfyNotification: mocks.sendNtfyNotification,
	sendPushoverNotification: mocks.sendPushoverNotification,
	sendResendNotification: mocks.sendResendNotification,
	sendServerThresholdNotifications: mocks.sendServerThresholdNotifications,
	sendSlackNotification: mocks.sendSlackNotification,
	sendTeamsNotification: mocks.sendTeamsNotification,
	sendTelegramNotification: mocks.sendTelegramNotification,
	updateCustomNotification: mocks.updateCustomNotification,
	updateDiscordNotification: mocks.updateDiscordNotification,
	updateEmailNotification: mocks.updateEmailNotification,
	updateGotifyNotification: mocks.updateGotifyNotification,
	updateLarkNotification: mocks.updateLarkNotification,
	updateMattermostNotification: mocks.updateMattermostNotification,
	updateNtfyNotification: mocks.updateNtfyNotification,
	updatePushoverNotification: mocks.updatePushoverNotification,
	updateResendNotification: mocks.updateResendNotification,
	updateSlackNotification: mocks.updateSlackNotification,
	updateTeamsNotification: mocks.updateTeamsNotification,
	updateTelegramNotification: mocks.updateTelegramNotification,
	withStoredNotificationSecrets: mocks.withStoredNotificationSecrets,
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			notifications: {
				findMany: mocks.findManyNotifications,
			},
		},
		select: mocks.select,
	},
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: mocks.checkPermission,
	hasPermission: vi.fn(),
	resolvePermissions: vi.fn(),
}));

vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: mocks.audit,
}));

const { notificationRouter } = await import(
	"../../server/api/routers/notification"
);

const notificationWithSecrets = {
	notificationId: "notification-1",
	name: "alerts",
	appDeploy: true,
	appBuildError: true,
	databaseBackup: false,
	volumeBackup: false,
	dokployRestart: false,
	dokployBackup: false,
	dockerCleanup: false,
	serverThreshold: false,
	notificationType: "slack",
	organizationId: "org-1",
	createdAt: "2026-06-23T00:00:00.000Z",
	slackId: "slack-1",
	slack: {
		slackId: "slack-1",
		webhookUrl: "https://hooks.slack.com/services/T/B/secret",
		channel: "ops",
	},
	email: {
		emailId: "email-1",
		smtpServer: "smtp.example.com",
		smtpPort: 587,
		username: "alerts@example.com",
		password: "smtp-secret",
		fromAddress: "alerts@example.com",
		toAddresses: ["ops@example.com"],
	},
	resend: {
		resendId: "resend-1",
		apiKey: "resend-secret",
		fromAddress: "alerts@example.com",
		toAddresses: ["ops@example.com"],
	},
};

const createCaller = (
	role = "owner",
	session: Record<string, unknown> = { id: "session-1" },
) =>
	notificationRouter.createCaller({
		db: {},
		req: {},
		res: {},
		session: {
			userId: "actor-1",
			activeOrganizationId: "org-1",
			...session,
		},
		user: {
			id: "actor-1",
			email: "owner@example.com",
			role,
			ownerId: "actor-1",
			enableEnterpriseFeatures: false,
			isValidEnterpriseLicense: false,
		},
	} as never);

describe("notification router secret and organization boundaries", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkPermission.mockResolvedValue(true);
		mocks.findNotificationById.mockResolvedValue(notificationWithSecrets);
		mocks.findManyNotifications.mockResolvedValue([notificationWithSecrets]);
		mocks.updateSlackNotification.mockResolvedValue({ notificationId: "n-1" });
		mocks.updateGotifyNotification.mockResolvedValue({ notificationId: "n-1" });
		mocks.withStoredNotificationSecrets.mockImplementation(
			async (_provider, input) => input,
		);
	});

	it("tests a saved channel with its stored secret after the update check", async () => {
		mocks.withStoredNotificationSecrets.mockResolvedValue({
			botToken: "123:saved-token",
			chatId: "42",
			messageThreadId: "",
		});

		await expect(
			createCaller().testTelegramConnection({
				notificationId: "notification-1",
				botToken: REDACTED_NOTIFICATION_SECRET,
				chatId: "42",
				messageThreadId: "",
			}),
		).resolves.toBe(true);

		expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
			notification: ["update"],
		});
		expect(mocks.withStoredNotificationSecrets).toHaveBeenCalledWith(
			"telegram",
			{
				botToken: REDACTED_NOTIFICATION_SECRET,
				chatId: "42",
				messageThreadId: "",
			},
			"notification-1",
			"org-1",
		);
		expect(mocks.sendTelegramNotification).toHaveBeenCalledWith(
			{ botToken: "123:saved-token", chatId: "42", messageThreadId: "" },
			"Hi, From Dokploy 👋",
		);
	});

	it("tests a new channel without the update check", async () => {
		await createCaller().testSlackConnection({
			webhookUrl: "https://hooks.slack.com/services/T/B/new",
			channel: "ops",
		});

		expect(mocks.checkPermission).not.toHaveBeenCalledWith(expect.anything(), {
			notification: ["update"],
		});
		expect(mocks.withStoredNotificationSecrets).toHaveBeenCalledWith(
			"slack",
			{
				webhookUrl: "https://hooks.slack.com/services/T/B/new",
				channel: "ops",
			},
			undefined,
			"org-1",
		);
	});

	it.each(["owner", "admin"])(
		"reveals a saved secret to the %s and audits it",
		async (role) => {
			mocks.findNotificationSecret.mockResolvedValue({
				notification: notificationWithSecrets,
				value: "https://hooks.slack.com/services/T/B/secret",
			});

			await expect(
				createCaller(role).revealSecret({
					notificationId: "notification-1",
					field: "webhookUrl",
				}),
			).resolves.toEqual({
				value: "https://hooks.slack.com/services/T/B/secret",
			});
			expect(mocks.findNotificationSecret).toHaveBeenCalledWith(
				"notification-1",
				"org-1",
				"webhookUrl",
			);
			expect(mocks.audit).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					action: "reveal",
					resourceType: "notification",
					resourceId: "notification-1",
				}),
			);
		},
	);

	it("does not reveal a saved secret to a member", async () => {
		await expect(
			createCaller("member").revealSecret({
				notificationId: "notification-1",
				field: "webhookUrl",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.findNotificationSecret).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("does not reveal a saved secret to an API key", async () => {
		await expect(
			createCaller("owner", { authMethod: "api-key" }).revealSecret({
				notificationId: "notification-1",
				field: "webhookUrl",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.findNotificationSecret).not.toHaveBeenCalled();
	});

	it("redacts notification secrets from one", async () => {
		const result = await createCaller().one({
			notificationId: "notification-1",
		});

		expect(result.slack?.webhookUrl).toBe(REDACTED_NOTIFICATION_SECRET);
		expect(result.email?.password).toBe(REDACTED_NOTIFICATION_SECRET);
		expect(result.resend?.apiKey).toBe(REDACTED_NOTIFICATION_SECRET);
		expect(result.email?.smtpServer).toBe("smtp.example.com");
	});

	it("redacts notification secrets from all", async () => {
		const [result] = await createCaller().all();

		expect(result?.slack?.webhookUrl).toBe(REDACTED_NOTIFICATION_SECRET);
		expect(result?.email?.password).toBe(REDACTED_NOTIFICATION_SECRET);
		expect(result?.resend?.apiKey).toBe(REDACTED_NOTIFICATION_SECRET);
	});

	it("redacts notification secrets from getEmailProviders", async () => {
		const [result] = await createCaller().getEmailProviders();

		expect(result?.email?.password).toBe(REDACTED_NOTIFICATION_SECRET);
		expect(result?.resend?.apiKey).toBe(REDACTED_NOTIFICATION_SECRET);
	});

	it("rejects cross-organization Gotify updates even outside cloud mode", async () => {
		mocks.findNotificationById.mockResolvedValue({
			...notificationWithSecrets,
			notificationId: "notification-other",
			notificationType: "gotify",
			organizationId: "org-2",
			gotifyId: "gotify-1",
			gotify: {
				gotifyId: "gotify-1",
				serverUrl: "https://gotify.example.com",
				appToken: "gotify-secret",
				priority: 5,
				decoration: true,
			},
		});

		await expect(
			createCaller().updateGotify({
				notificationId: "notification-other",
				gotifyId: "gotify-1",
			}),
		).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});

		expect(mocks.updateGotifyNotification).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("rejects provider subrecord ID mismatches on updates", async () => {
		await expect(
			createCaller().updateSlack({
				notificationId: "notification-1",
				slackId: "slack-other",
				webhookUrl: REDACTED_NOTIFICATION_SECRET,
			}),
		).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});

		expect(mocks.updateSlackNotification).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("returns the re-enter message when an email update would reuse the stored password", async () => {
		mocks.findNotificationById.mockResolvedValue({
			...notificationWithSecrets,
			notificationType: "email",
			emailId: "email-1",
		});
		mocks.updateEmailNotification.mockRejectedValue(
			new TRPCError({
				code: "BAD_REQUEST",
				message: "Re-enter the SMTP password to change smtpServer",
			}),
		);

		await expect(
			createCaller().updateEmail({
				notificationId: "notification-1",
				emailId: "email-1",
				smtpServer: "smtp.collector.example.net",
				password: REDACTED_NOTIFICATION_SECRET,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "Re-enter the SMTP password to change smtpServer",
		});
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("accepts blank required secret update values so existing secrets are preserved", async () => {
		await expect(
			createCaller().updateSlack({
				notificationId: "notification-1",
				slackId: "slack-1",
				webhookUrl: "",
			}),
		).resolves.toEqual({ notificationId: "n-1" });

		expect(mocks.updateSlackNotification).toHaveBeenCalledWith(
			expect.objectContaining({
				notificationId: "notification-1",
				organizationId: "org-1",
				slackId: "slack-1",
				webhookUrl: "",
			}),
		);
	});

	it("rejects blank remote metrics tokens before server lookup", async () => {
		await expect(
			createCaller().receiveNotification({
				ServerType: "Remote",
				Type: "CPU",
				Value: 95,
				Threshold: 90,
				Message: "cpu high",
				Timestamp: "2026-06-24T00:00:00.000Z",
				Token: "   ",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(mocks.select).not.toHaveBeenCalled();
		expect(mocks.sendServerThresholdNotifications).not.toHaveBeenCalled();
	});
});

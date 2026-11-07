import { db } from "@dokploy/server/db";
import {
	type apiCreateCustom,
	type apiCreateDiscord,
	type apiCreateEmail,
	type apiCreateGotify,
	type apiCreateLark,
	type apiCreateMattermost,
	type apiCreateNtfy,
	type apiCreatePushover,
	type apiCreateResend,
	type apiCreateSlack,
	type apiCreateTeams,
	type apiCreateTelegram,
	type apiUpdateCustom,
	type apiUpdateDiscord,
	type apiUpdateEmail,
	type apiUpdateGotify,
	type apiUpdateLark,
	type apiUpdateMattermost,
	type apiUpdateNtfy,
	type apiUpdatePushover,
	type apiUpdateResend,
	type apiUpdateSlack,
	type apiUpdateTeams,
	type apiUpdateTelegram,
	custom,
	discord,
	email,
	gotify,
	lark,
	mattermost,
	notifications,
	ntfy,
	pushover,
	resend,
	slack,
	teams,
	telegram,
} from "@dokploy/server/db/schema";
import { isEncrypted } from "@dokploy/server/lib/encryption";
import { assertStoredSecretTargetUnchanged } from "@dokploy/server/utils/security/redaction";
import { TRPCError } from "@trpc/server";
import { eq, isNotNull, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { z } from "zod";
import {
	isRedactedNotificationSecret,
	type NotificationSecretProvider,
	normalizeNotificationBaseUrl,
	normalizeNotificationHttpUrl,
	normalizeNotificationSmtpHost,
	notificationHeadersUpdateValue,
	notificationOptionalSecretUpdateValue,
	notificationSecretFields,
	notificationSecretUpdateValue,
} from "../utils/notifications/security";

export type Notification = typeof notifications.$inferSelect;

const normalizeWebhookUpdateValue = (
	value: string | undefined,
	fieldName: string,
	options?: { allowPrivateNetwork?: boolean },
) => {
	const secretValue = notificationSecretUpdateValue(value);
	return secretValue
		? normalizeNotificationHttpUrl(secretValue, { ...options, fieldName })
		: undefined;
};

const normalizeBaseUrlUpdateValue = (
	value: string | undefined,
	fieldName: string,
) => {
	const secretValue = notificationSecretUpdateValue(value);
	return secretValue
		? normalizeNotificationBaseUrl(secretValue, { fieldName })
		: undefined;
};

// Rows saved before targets were normalized must still match when the form
// sends their stored value back unchanged.
const nextTargetValue = <T>(
	raw: T | undefined,
	normalized: T | undefined,
	stored: T,
) => (normalized === undefined || raw === stored ? stored : normalized);

export const createSlackNotification = async (
	input: z.infer<typeof apiCreateSlack>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newSlack = await tx
			.insert(slack)
			.values({
				channel: input.channel,
				webhookUrl: normalizeNotificationHttpUrl(input.webhookUrl, {
					fieldName: "Slack webhook URL",
				}),
			})
			.returning()
			.then((value) => value[0]);

		if (!newSlack) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting slack",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				slackId: newSlack.slackId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "slack",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

type NotificationTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// An update that changes nothing in a table must not reach drizzle: an empty
// `set` fails with "No values to set". Undefined keys are dropped by drizzle.
const hasValues = (values: Record<string, unknown>) =>
	Object.values(values).some((value) => value !== undefined);

const updateNotificationRow = async (
	tx: NotificationTx,
	notificationId: string,
	values: Record<string, unknown>,
) => {
	if (hasValues(values)) {
		return tx
			.update(notifications)
			.set(values)
			.where(eq(notifications.notificationId, notificationId))
			.returning()
			.then((value) => value[0]);
	}
	return tx
		.select()
		.from(notifications)
		.where(eq(notifications.notificationId, notificationId))
		.limit(1)
		.then((value) => value[0]);
};

export const updateSlackNotification = async (
	input: z.infer<typeof apiUpdateSlack>,
) => {
	await db.transaction(async (tx) => {
		const newDestination = await updateNotificationRow(
			tx,
			input.notificationId,
			{
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				organizationId: input.organizationId,
				serverThreshold: input.serverThreshold,
			},
		);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		const providerValues = {
			channel: input.channel,
			webhookUrl: normalizeWebhookUpdateValue(
				input.webhookUrl,
				"Slack webhook URL",
			),
		};
		if (hasValues(providerValues)) {
			await tx
				.update(slack)
				.set(providerValues)
				.where(eq(slack.slackId, input.slackId));
		}

		return newDestination;
	});
};

export const createTelegramNotification = async (
	input: z.infer<typeof apiCreateTelegram>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newTelegram = await tx
			.insert(telegram)
			.values({
				botToken: input.botToken,
				chatId: input.chatId,
				messageThreadId: input.messageThreadId,
			})
			.returning()
			.then((value) => value[0]);

		if (!newTelegram) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting telegram",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				telegramId: newTelegram.telegramId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "telegram",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateTelegramNotification = async (
	input: z.infer<typeof apiUpdateTelegram>,
) => {
	await db.transaction(async (tx) => {
		const newDestination = await updateNotificationRow(
			tx,
			input.notificationId,
			{
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				organizationId: input.organizationId,
				serverThreshold: input.serverThreshold,
			},
		);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		const providerValues = {
			botToken: notificationSecretUpdateValue(input.botToken),
			chatId: input.chatId,
			messageThreadId: input.messageThreadId,
		};
		if (hasValues(providerValues)) {
			await tx
				.update(telegram)
				.set(providerValues)
				.where(eq(telegram.telegramId, input.telegramId));
		}

		return newDestination;
	});
};

export const createDiscordNotification = async (
	input: z.infer<typeof apiCreateDiscord>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newDiscord = await tx
			.insert(discord)
			.values({
				webhookUrl: normalizeNotificationHttpUrl(input.webhookUrl, {
					fieldName: "Discord webhook URL",
				}),
				decoration: input.decoration,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDiscord) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting discord",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				discordId: newDiscord.discordId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "discord",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateDiscordNotification = async (
	input: z.infer<typeof apiUpdateDiscord>,
) => {
	await db.transaction(async (tx) => {
		const newDestination = await updateNotificationRow(
			tx,
			input.notificationId,
			{
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				organizationId: input.organizationId,
				serverThreshold: input.serverThreshold,
			},
		);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		const providerValues = {
			webhookUrl: normalizeWebhookUpdateValue(
				input.webhookUrl,
				"Discord webhook URL",
			),
			decoration: input.decoration,
		};
		if (hasValues(providerValues)) {
			await tx
				.update(discord)
				.set(providerValues)
				.where(eq(discord.discordId, input.discordId));
		}

		return newDestination;
	});
};

export const createEmailNotification = async (
	input: z.infer<typeof apiCreateEmail>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newEmail = await tx
			.insert(email)
			.values({
				smtpServer: normalizeNotificationSmtpHost(input.smtpServer),
				smtpPort: input.smtpPort,
				username: input.username,
				password: input.password,
				fromAddress: input.fromAddress,
				toAddresses: input.toAddresses,
			})
			.returning()
			.then((value) => value[0]);

		if (!newEmail) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting email",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				emailId: newEmail.emailId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "email",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateEmailNotification = async (
	input: z.infer<typeof apiUpdateEmail>,
) => {
	const smtpServer = input.smtpServer
		? normalizeNotificationSmtpHost(input.smtpServer)
		: undefined;
	const password = notificationSecretUpdateValue(input.password);
	if (password === undefined) {
		const current = await db.query.email.findFirst({
			where: eq(email.emailId, input.emailId),
		});
		if (current?.password) {
			assertStoredSecretTargetUnchanged("SMTP password", {
				smtpServer: [
					nextTargetValue(input.smtpServer, smtpServer, current.smtpServer),
					current.smtpServer,
				],
				smtpPort: [input.smtpPort ?? current.smtpPort, current.smtpPort],
				username: [input.username ?? current.username, current.username],
			});
		}
	}

	await db.transaction(async (tx) => {
		const newDestination = await updateNotificationRow(
			tx,
			input.notificationId,
			{
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				organizationId: input.organizationId,
				serverThreshold: input.serverThreshold,
			},
		);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		const providerValues = {
			smtpServer,
			smtpPort: input.smtpPort,
			username: input.username,
			password,
			fromAddress: input.fromAddress,
			toAddresses: input.toAddresses,
		};
		if (hasValues(providerValues)) {
			await tx
				.update(email)
				.set(providerValues)
				.where(eq(email.emailId, input.emailId));
		}

		return newDestination;
	});
};

export const createResendNotification = async (
	input: z.infer<typeof apiCreateResend>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newResend = await tx
			.insert(resend)
			.values({
				apiKey: input.apiKey,
				fromAddress: input.fromAddress,
				toAddresses: input.toAddresses,
			})
			.returning()
			.then((value) => value[0]);

		if (!newResend) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting resend",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				resendId: newResend.resendId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "resend",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateResendNotification = async (
	input: z.infer<typeof apiUpdateResend>,
) => {
	await db.transaction(async (tx) => {
		const newDestination = await updateNotificationRow(
			tx,
			input.notificationId,
			{
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				organizationId: input.organizationId,
				serverThreshold: input.serverThreshold,
			},
		);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		const providerValues = {
			apiKey: notificationSecretUpdateValue(input.apiKey),
			fromAddress: input.fromAddress,
			toAddresses: input.toAddresses,
		};
		if (hasValues(providerValues)) {
			await tx
				.update(resend)
				.set(providerValues)
				.where(eq(resend.resendId, input.resendId));
		}

		return newDestination;
	});
};

export const createGotifyNotification = async (
	input: z.infer<typeof apiCreateGotify>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newGotify = await tx
			.insert(gotify)
			.values({
				serverUrl: normalizeNotificationBaseUrl(input.serverUrl, {
					fieldName: "Gotify server URL",
				}),
				appToken: input.appToken,
				priority: input.priority,
				decoration: input.decoration,
			})
			.returning()
			.then((value) => value[0]);

		if (!newGotify) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting gotify",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				gotifyId: newGotify.gotifyId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				serverThreshold: input.serverThreshold,
				notificationType: "gotify",
				organizationId: organizationId,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateGotifyNotification = async (
	input: z.infer<typeof apiUpdateGotify>,
) => {
	const serverUrl = normalizeBaseUrlUpdateValue(
		input.serverUrl,
		"Gotify server URL",
	);
	const appToken = notificationSecretUpdateValue(input.appToken);
	if (appToken === undefined) {
		const current = await db.query.gotify.findFirst({
			where: eq(gotify.gotifyId, input.gotifyId),
		});
		if (current?.appToken) {
			assertStoredSecretTargetUnchanged("Gotify app token", {
				serverUrl: [
					nextTargetValue(input.serverUrl, serverUrl, current.serverUrl),
					current.serverUrl,
				],
			});
		}
	}

	await db.transaction(async (tx) => {
		const newDestination = await updateNotificationRow(
			tx,
			input.notificationId,
			{
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				serverThreshold: input.serverThreshold,
				organizationId: input.organizationId,
			},
		);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		const providerValues = {
			serverUrl,
			appToken,
			priority: input.priority,
			decoration: input.decoration,
		};
		if (hasValues(providerValues)) {
			await tx
				.update(gotify)
				.set(providerValues)
				.where(eq(gotify.gotifyId, input.gotifyId));
		}

		return newDestination;
	});
};

export const createNtfyNotification = async (
	input: z.infer<typeof apiCreateNtfy>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newNtfy = await tx
			.insert(ntfy)
			.values({
				serverUrl: normalizeNotificationBaseUrl(input.serverUrl, {
					fieldName: "ntfy server URL",
				}),
				topic: input.topic,
				accessToken: input.accessToken ?? null,
				priority: input.priority,
			})
			.returning()
			.then((value) => value[0]);

		if (!newNtfy) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting ntfy",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				ntfyId: newNtfy.ntfyId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				serverThreshold: input.serverThreshold,
				notificationType: "ntfy",
				organizationId: organizationId,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateNtfyNotification = async (
	input: z.infer<typeof apiUpdateNtfy>,
) => {
	const serverUrl = normalizeBaseUrlUpdateValue(
		input.serverUrl,
		"ntfy server URL",
	);
	const accessToken = notificationOptionalSecretUpdateValue(input.accessToken);
	if (accessToken === undefined) {
		const current = await db.query.ntfy.findFirst({
			where: eq(ntfy.ntfyId, input.ntfyId),
		});
		if (current?.accessToken) {
			assertStoredSecretTargetUnchanged("ntfy access token", {
				serverUrl: [
					nextTargetValue(input.serverUrl, serverUrl, current.serverUrl),
					current.serverUrl,
				],
			});
		}
	}

	await db.transaction(async (tx) => {
		const newDestination = await updateNotificationRow(
			tx,
			input.notificationId,
			{
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				serverThreshold: input.serverThreshold,
				organizationId: input.organizationId,
			},
		);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		const providerValues = {
			serverUrl,
			topic: input.topic,
			accessToken,
			priority: input.priority,
		};
		if (hasValues(providerValues)) {
			await tx
				.update(ntfy)
				.set(providerValues)
				.where(eq(ntfy.ntfyId, input.ntfyId));
		}

		return newDestination;
	});
};

export const createCustomNotification = async (
	input: z.infer<typeof apiCreateCustom>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newCustom = await tx
			.insert(custom)
			.values({
				endpoint: normalizeNotificationHttpUrl(input.endpoint, {
					allowPrivateNetwork: false,
					fieldName: "Custom notification endpoint",
				}),
				headers: input.headers,
			})
			.returning()
			.then((value) => value[0]);

		if (!newCustom) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting custom",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				customId: newCustom.customId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "custom",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateCustomNotification = async (
	input: z.infer<typeof apiUpdateCustom>,
) => {
	const endpoint = normalizeWebhookUpdateValue(
		input.endpoint,
		"Custom notification endpoint",
		{ allowPrivateNetwork: false },
	);
	const headers = notificationHeadersUpdateValue(input.headers);
	if (headers === undefined) {
		const current = await db.query.custom.findFirst({
			where: eq(custom.customId, input.customId),
		});
		if (current?.headers && Object.keys(current.headers).length > 0) {
			assertStoredSecretTargetUnchanged("custom notification headers", {
				endpoint: [
					nextTargetValue(input.endpoint, endpoint, current.endpoint),
					current.endpoint,
				],
			});
		}
	}

	await db.transaction(async (tx) => {
		const newDestination = await updateNotificationRow(
			tx,
			input.notificationId,
			{
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				organizationId: input.organizationId,
				serverThreshold: input.serverThreshold,
			},
		);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		const providerValues = {
			endpoint,
			headers,
		};
		if (hasValues(providerValues)) {
			await tx
				.update(custom)
				.set(providerValues)
				.where(eq(custom.customId, input.customId));
		}

		return newDestination;
	});
};

export const findNotificationById = async (notificationId: string) => {
	const notification = await db.query.notifications.findFirst({
		where: eq(notifications.notificationId, notificationId),
		with: {
			slack: true,
			telegram: true,
			discord: true,
			email: true,
			resend: true,
			gotify: true,
			ntfy: true,
			mattermost: true,
			custom: true,
			lark: true,
			pushover: true,
			teams: true,
		},
	});
	if (!notification) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Notification not found",
		});
	}
	return notification;
};

const sameTarget = <T>(
	raw: T | undefined,
	normalize: (value: T) => T,
	stored: T,
) => {
	if (raw === undefined || raw === stored) {
		return stored;
	}
	return normalize(raw);
};

// The form gets a placeholder in place of every saved secret, so Test on a
// saved channel sends that placeholder. Here it becomes the stored secret,
// which may only reach the endpoint it was saved with, as on an update.
export const withStoredNotificationSecrets = async <
	T extends Record<string, unknown>,
>(
	provider: NotificationSecretProvider,
	input: T,
	notificationId: string | undefined,
	organizationId: string,
): Promise<T> => {
	const fields = notificationSecretFields[provider] as readonly string[];
	const redactedFields = fields.filter((field) =>
		isRedactedNotificationSecret(input[field]),
	);
	const headers =
		provider === "custom"
			? (input.headers as Record<string, string> | undefined)
			: undefined;
	const redactedHeaders = Object.entries(headers ?? {})
		.filter(([, value]) => isRedactedNotificationSecret(value))
		.map(([key]) => key);
	if (redactedFields.length === 0 && redactedHeaders.length === 0) {
		return input;
	}

	if (!notificationId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Enter the ${[...redactedFields, ...redactedHeaders].join(", ")} to test this channel`,
		});
	}
	const notification = await findNotificationById(notificationId);
	if (notification.organizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this notification",
		});
	}
	const stored = notification[provider] as Record<string, unknown> | null;
	if (!stored) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `This notification has no saved ${provider} settings`,
		});
	}

	const next: Record<string, unknown> = { ...input };
	for (const field of redactedFields) {
		if (!stored[field]) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Enter the ${field} to test this channel`,
			});
		}
		next[field] = stored[field];
	}
	if (redactedHeaders.length > 0) {
		const storedHeaders = (stored.headers ?? {}) as Record<string, string>;
		const nextHeaders = { ...headers };
		for (const key of redactedHeaders) {
			if (!(key in storedHeaders)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Enter the value of the ${key} header to test this channel`,
				});
			}
			nextHeaders[key] = storedHeaders[key] as string;
		}
		next.headers = nextHeaders;
	}

	if (provider === "email" && redactedFields.includes("password")) {
		const current = stored as typeof email.$inferSelect;
		assertStoredSecretTargetUnchanged("SMTP password", {
			smtpServer: [
				sameTarget(
					input.smtpServer as string | undefined,
					(value) => normalizeNotificationSmtpHost(value),
					current.smtpServer,
				),
				current.smtpServer,
			],
			smtpPort: [input.smtpPort ?? current.smtpPort, current.smtpPort],
			username: [input.username ?? current.username, current.username],
		});
	}
	if (
		(provider === "gotify" && redactedFields.includes("appToken")) ||
		(provider === "ntfy" && redactedFields.includes("accessToken"))
	) {
		const serverUrl = stored.serverUrl as string;
		assertStoredSecretTargetUnchanged(`${provider} token`, {
			serverUrl: [
				sameTarget(
					input.serverUrl as string | undefined,
					(value) => normalizeNotificationBaseUrl(value),
					serverUrl,
				),
				serverUrl,
			],
		});
	}
	if (
		provider === "custom" &&
		redactedHeaders.length > 0 &&
		!redactedFields.includes("endpoint")
	) {
		const endpoint = stored.endpoint as string;
		assertStoredSecretTargetUnchanged("custom notification headers", {
			endpoint: [
				sameTarget(
					input.endpoint as string | undefined,
					(value) =>
						normalizeNotificationHttpUrl(value, { allowPrivateNetwork: false }),
					endpoint,
				),
				endpoint,
			],
		});
	}

	return next as T;
};

export const findNotificationSecret = async (
	notificationId: string,
	organizationId: string,
	field: string,
) => {
	const notification = await findNotificationById(notificationId);
	if (notification.organizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this notification",
		});
	}
	const provider = notification.notificationType as NotificationSecretProvider;
	const fields = notificationSecretFields[provider] as
		| readonly string[]
		| undefined;
	const stored = notification[provider] as Record<string, unknown> | null;
	if (!fields?.includes(field) || !stored) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `This notification has no ${field}`,
		});
	}
	const value = stored[field];
	return {
		notification,
		value: typeof value === "string" ? value : "",
	};
};

export const removeNotificationById = async (notificationId: string) => {
	const result = await db
		.delete(notifications)
		.where(eq(notifications.notificationId, notificationId))
		.returning();

	return result[0];
};

export const createLarkNotification = async (
	input: z.infer<typeof apiCreateLark>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newLark = await tx
			.insert(lark)
			.values({
				webhookUrl: normalizeNotificationHttpUrl(input.webhookUrl, {
					fieldName: "Lark webhook URL",
				}),
			})
			.returning()
			.then((value) => value[0]);

		if (!newLark) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting lark",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				larkId: newLark.larkId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "lark",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateLarkNotification = async (
	input: z.infer<typeof apiUpdateLark>,
) => {
	await db.transaction(async (tx) => {
		const newDestination = await updateNotificationRow(
			tx,
			input.notificationId,
			{
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				organizationId: input.organizationId,
				serverThreshold: input.serverThreshold,
			},
		);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		const providerValues = {
			webhookUrl: normalizeWebhookUpdateValue(
				input.webhookUrl,
				"Lark webhook URL",
			),
		};
		if (hasValues(providerValues)) {
			await tx
				.update(lark)
				.set(providerValues)
				.where(eq(lark.larkId, input.larkId));
		}

		return newDestination;
	});
};

export const createTeamsNotification = async (
	input: z.infer<typeof apiCreateTeams>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newTeams = await tx
			.insert(teams)
			.values({
				webhookUrl: normalizeNotificationHttpUrl(input.webhookUrl, {
					fieldName: "Teams webhook URL",
				}),
			})
			.returning()
			.then((value) => value[0]);

		if (!newTeams) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting teams",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				teamsId: newTeams.teamsId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "teams",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateTeamsNotification = async (
	input: z.infer<typeof apiUpdateTeams>,
) => {
	await db.transaction(async (tx) => {
		const newDestination = await updateNotificationRow(
			tx,
			input.notificationId,
			{
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				organizationId: input.organizationId,
				serverThreshold: input.serverThreshold,
			},
		);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		const providerValues = {
			webhookUrl: normalizeWebhookUpdateValue(
				input.webhookUrl,
				"Teams webhook URL",
			),
		};
		if (hasValues(providerValues)) {
			await tx
				.update(teams)
				.set(providerValues)
				.where(eq(teams.teamsId, input.teamsId));
		}

		return newDestination;
	});
};

export const updateNotificationById = async (
	notificationId: string,
	notificationData: Partial<Notification>,
) => {
	const result = await db
		.update(notifications)
		.set({
			...notificationData,
		})
		.where(eq(notifications.notificationId, notificationId))
		.returning();

	return result[0];
};

export const createMattermostNotification = async (
	input: z.infer<typeof apiCreateMattermost>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newMattermost = await tx
			.insert(mattermost)
			.values({
				webhookUrl: normalizeNotificationHttpUrl(input.webhookUrl, {
					fieldName: "Mattermost webhook URL",
				}),
				channel: input.channel,
				username: input.username,
			})
			.returning()
			.then((value) => value[0]);

		if (!newMattermost) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting mattermost",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				mattermostId: newMattermost.mattermostId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "mattermost",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateMattermostNotification = async (
	input: z.infer<typeof apiUpdateMattermost>,
) => {
	await db.transaction(async (tx) => {
		const newDestination = await updateNotificationRow(
			tx,
			input.notificationId,
			{
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				organizationId: input.organizationId,
				serverThreshold: input.serverThreshold,
			},
		);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		const providerValues = {
			webhookUrl: normalizeWebhookUpdateValue(
				input.webhookUrl,
				"Mattermost webhook URL",
			),
			channel: input.channel,
			username: input.username,
		};
		if (hasValues(providerValues)) {
			await tx
				.update(mattermost)
				.set(providerValues)
				.where(eq(mattermost.mattermostId, input.mattermostId));
		}

		return newDestination;
	});
};

export const createPushoverNotification = async (
	input: z.infer<typeof apiCreatePushover>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newPushover = await tx
			.insert(pushover)
			.values({
				userKey: input.userKey,
				apiToken: input.apiToken,
				priority: input.priority,
				retry: input.retry,
				expire: input.expire,
			})
			.returning()
			.then((value) => value[0]);

		if (!newPushover) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting pushover",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				pushoverId: newPushover.pushoverId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				serverThreshold: input.serverThreshold,
				notificationType: "pushover",
				organizationId: organizationId,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updatePushoverNotification = async (
	input: z.infer<typeof apiUpdatePushover>,
) => {
	await db.transaction(async (tx) => {
		const newDestination = await updateNotificationRow(
			tx,
			input.notificationId,
			{
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				dokployBackupErrorsOnly: input.dokployBackupErrorsOnly,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				organizationId: input.organizationId,
				serverThreshold: input.serverThreshold,
			},
		);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		const providerValues = {
			userKey: notificationSecretUpdateValue(input.userKey),
			apiToken: notificationSecretUpdateValue(input.apiToken),
			priority: input.priority,
			retry: input.retry,
			expire: input.expire,
		};
		if (hasValues(providerValues)) {
			await tx
				.update(pushover)
				.set(providerValues)
				.where(eq(pushover.pushoverId, input.pushoverId));
		}

		return newDestination;
	});
};

const encryptedSecretColumns: [PgTable, PgColumn, PgColumn[]][] = [
	[slack, slack.slackId, [slack.webhookUrl]],
	[telegram, telegram.telegramId, [telegram.botToken]],
	[discord, discord.discordId, [discord.webhookUrl]],
	[email, email.emailId, [email.password]],
	[resend, resend.resendId, [resend.apiKey]],
	[gotify, gotify.gotifyId, [gotify.appToken]],
	[ntfy, ntfy.ntfyId, [ntfy.accessToken]],
	[mattermost, mattermost.mattermostId, [mattermost.webhookUrl]],
	[custom, custom.customId, [custom.endpoint]],
	[lark, lark.larkId, [lark.webhookUrl]],
	[pushover, pushover.pushoverId, [pushover.userKey, pushover.apiToken]],
	[teams, teams.teamsId, [teams.webhookUrl]],
];

// The columns read plain text through, so rows saved before they were
// encrypted stay readable; this writes each of them once more, encrypted.
export const encryptStoredNotificationSecrets = async () => {
	let encrypted = 0;
	for (const [table, id, columns] of encryptedSecretColumns) {
		for (const column of columns) {
			const rows = await db
				.select({ id: sql<string>`${id}`, value: sql<string>`${column}` })
				.from(table)
				.where(isNotNull(column));
			for (const row of rows) {
				if (!row.value || isEncrypted(row.value)) {
					continue;
				}
				await db
					.update(table)
					.set({ [column.name]: row.value } as never)
					.where(eq(id, row.id));
				encrypted += 1;
			}
		}
	}
	return encrypted;
};

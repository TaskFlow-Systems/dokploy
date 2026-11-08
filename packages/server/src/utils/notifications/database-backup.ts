import { db } from "@dokploy/server/db";
import { notifications } from "@dokploy/server/db/schema";
import DatabaseBackupEmail from "@dokploy/server/emails/emails/database-backup";
import { redactSensitiveText } from "@dokploy/server/utils/security/redaction";
import { render } from "@react-email/components";
import { format } from "date-fns";
import { and, eq } from "drizzle-orm";
import {
	escapeHtml,
	formatTelegramErrorMessage,
	sendCustomNotification as rawSendCustomNotification,
	sendDiscordNotification as rawSendDiscordNotification,
	sendEmailNotification as rawSendEmailNotification,
	sendGotifyNotification as rawSendGotifyNotification,
	sendLarkNotification as rawSendLarkNotification,
	sendMattermostNotification as rawSendMattermostNotification,
	sendNtfyNotification as rawSendNtfyNotification,
	sendPushoverNotification as rawSendPushoverNotification,
	sendResendNotification as rawSendResendNotification,
	sendSlackNotification as rawSendSlackNotification,
	sendTeamsNotification as rawSendTeamsNotification,
	sendTelegramNotification as rawSendTelegramNotification,
} from "./utils";

const relabelForRestore = (text: string) =>
	text
		.replace(/Database Backup/g, "Database Restore")
		.replace(/Database backup/g, "Database restore")
		.replace(/database backup/g, "database restore");

const relabelDeep = <T>(value: T): T => {
	if (typeof value === "string") {
		return relabelForRestore(value) as T;
	}
	if (Array.isArray(value)) {
		return value.map(relabelDeep) as T;
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, relabelDeep(item)]),
		) as T;
	}
	return value;
};

// The restore failure reuses the backup messages; only the wording changes.
// The first argument is the channel's own settings and stays as it is.
const forOperation = <F extends (channel: never, ...rest: never[]) => unknown>(
	fn: F,
	operation: "backup" | "restore",
): F =>
	operation === "backup"
		? fn
		: (((channel: never, ...rest: never[]) =>
				fn(channel, ...(rest.map(relabelDeep) as never[]))) as F);

export const sendDatabaseBackupNotifications = async (input: {
	operation?: "backup" | "restore";
	projectName: string;
	applicationName: string;
	databaseType: "postgres" | "mysql" | "mongodb" | "mariadb" | "libsql";
	type: "error" | "success";
	organizationId: string;
	errorMessage?: string;
	databaseName: string;
}) => {
	const {
		operation = "backup",
		projectName,
		applicationName,
		databaseType,
		type,
		errorMessage: rawErrorMessage,
		organizationId,
		databaseName,
	} = input;
	const sendCustomNotification = forOperation(rawSendCustomNotification, operation);
	const sendDiscordNotification = forOperation(rawSendDiscordNotification, operation);
	const sendEmailNotification = forOperation(rawSendEmailNotification, operation);
	const sendGotifyNotification = forOperation(rawSendGotifyNotification, operation);
	const sendLarkNotification = forOperation(rawSendLarkNotification, operation);
	const sendMattermostNotification = forOperation(rawSendMattermostNotification, operation);
	const sendNtfyNotification = forOperation(rawSendNtfyNotification, operation);
	const sendPushoverNotification = forOperation(rawSendPushoverNotification, operation);
	const sendResendNotification = forOperation(rawSendResendNotification, operation);
	const sendSlackNotification = forOperation(rawSendSlackNotification, operation);
	const sendTeamsNotification = forOperation(rawSendTeamsNotification, operation);
	const sendTelegramNotification = forOperation(rawSendTelegramNotification, operation);
	const errorMessage = redactSensitiveText(rawErrorMessage);
	const date = new Date();
	const unixDate = ~~(Number(date) / 1000);
	const notificationList = await db.query.notifications.findMany({
		where: and(
			eq(notifications.databaseBackup, true),
			eq(notifications.organizationId, organizationId),
		),
		with: {
			email: true,
			discord: true,
			telegram: true,
			slack: true,
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

	for (const notification of notificationList) {
		const {
			email,
			resend,
			discord,
			telegram,
			slack,
			gotify,
			ntfy,
			mattermost,
			custom,
			lark,
			pushover,
			teams,
		} = notification;
		try {
			if (email || resend) {
				const template = await render(
					DatabaseBackupEmail({
						projectName,
						applicationName,
						databaseType,
						type,
						errorMessage,
						date: date.toLocaleString(),
					}),
				).catch();

				if (email) {
					await sendEmailNotification(
						email,
						"Database backup for dokploy",
						template,
					);
				}

				if (resend) {
					await sendResendNotification(
						resend,
						"Database backup for dokploy",
						template,
					);
				}
			}

			if (discord) {
				const decorate = (decoration: string, text: string) =>
					`${discord.decoration ? decoration : ""} ${text}`.trim();

				await sendDiscordNotification(discord, {
					title:
						type === "success"
							? decorate(">", "`✅` Database Backup Successful")
							: decorate(">", "`❌` Database Backup Failed"),
					color: type === "success" ? 0x57f287 : 0xed4245,
					fields: [
						{
							name: decorate("`🛠️`", "Project"),
							value: projectName,
							inline: true,
						},
						{
							name: decorate("`⚙️`", "Application"),
							value: applicationName,
							inline: true,
						},
						{
							name: decorate("`❔`", "Database"),
							value: databaseType,
							inline: true,
						},
						{
							name: decorate("`📂`", "Database Name"),
							value: databaseName,
							inline: true,
						},
						{
							name: decorate("`📅`", "Date"),
							value: `<t:${unixDate}:D>`,
							inline: true,
						},
						{
							name: decorate("`⌚`", "Time"),
							value: `<t:${unixDate}:t>`,
							inline: true,
						},
						{
							name: decorate("`❓`", "Type"),
							value: type
								.replace("error", "Failed")
								.replace("success", "Successful"),
							inline: true,
						},
						...(type === "error" && errorMessage
							? [
									{
										name: decorate("`⚠️`", "Error Message"),
										value: `\`\`\`${errorMessage.length > 1010 ? `${errorMessage.substring(0, 1010)}...` : errorMessage}\`\`\``,
									},
								]
							: []),
					],
					timestamp: date.toISOString(),
					footer: {
						text: "Dokploy Database Backup Notification",
					},
				});
			}

			if (gotify) {
				const decorate = (decoration: string, text: string) =>
					`${gotify.decoration ? decoration : ""} ${text}\n`;

				await sendGotifyNotification(
					gotify,
					decorate(
						type === "success" ? "✅" : "❌",
						`Database Backup ${type === "success" ? "Successful" : "Failed"}`,
					),
					`${decorate("🛠️", `Project: ${projectName}`)}` +
						`${decorate("⚙️", `Application: ${applicationName}`)}` +
						`${decorate("❔", `Type: ${databaseType}`)}` +
						`${decorate("📂", `Database Name: ${databaseName}`)}` +
						`${decorate("🕒", `Date: ${date.toLocaleString()}`)}` +
						`${type === "error" && errorMessage ? decorate("❌", `Error:\n${errorMessage}`) : ""}`,
				);
			}

			if (ntfy) {
				await sendNtfyNotification(
					ntfy,
					`Database Backup ${type === "success" ? "Successful" : "Failed"}`,
					`${type === "success" ? "white_check_mark" : "x"}`,
					"",
					`🛠Project: ${projectName}\n` +
						`⚙️Application: ${applicationName}\n` +
						`❔Type: ${databaseType}\n` +
						`📂Database Name: ${databaseName}\n` +
						`🕒Date: ${date.toLocaleString()}\n` +
						`${type === "error" && errorMessage ? `❌Error:\n${errorMessage}` : ""}`,
				);
			}

			if (telegram) {
				const isError = type === "error" && errorMessage;

				const statusEmoji = type === "success" ? "✅" : "❌";
				const typeStatus = type === "success" ? "Successful" : "Failed";
				const errorMsg = isError
					? `\n\n<b>Error:</b>\n<pre>${formatTelegramErrorMessage(errorMessage)}</pre>`
					: "";

				const messageText = `<b>${statusEmoji} Database Backup ${typeStatus}</b>\n\n<b>Project:</b> ${escapeHtml(projectName)}\n<b>Application:</b> ${escapeHtml(applicationName)}\n<b>Type:</b> ${escapeHtml(databaseType)}\n<b>Database Name:</b> ${escapeHtml(databaseName)}\n<b>Date:</b> ${format(date, "PP")}\n<b>Time:</b> ${format(date, "pp")}${isError ? errorMsg : ""}`;

				await sendTelegramNotification(telegram, messageText);
			}

			if (slack) {
				const { channel } = slack;
				await sendSlackNotification(slack, {
					channel: channel,
					attachments: [
						{
							color: type === "success" ? "#00FF00" : "#FF0000",
							pretext:
								type === "success"
									? ":white_check_mark: *Database Backup Successful*"
									: ":x: *Database Backup Failed*",
							fields: [
								...(type === "error" && errorMessage
									? [
											{
												title: "Error Message",
												value: errorMessage,
												short: false,
											},
										]
									: []),
								{
									title: "Project",
									value: projectName,
									short: true,
								},
								{
									title: "Application",
									value: applicationName,
									short: true,
								},
								{
									title: "Type",
									value: databaseType,
									short: true,
								},
								{
									title: "Database Name",
									value: databaseName,
								},
								{
									title: "Time",
									value: date.toLocaleString(),
									short: true,
								},
								{
									title: "Type",
									value: type,
								},
								{
									title: "Status",
									value: type === "success" ? "Successful" : "Failed",
								},
							],
						},
					],
				});
			}

			if (mattermost) {
				const statusEmoji = type === "success" ? "✅" : "❌";
				const typeStatus = type === "success" ? "Successful" : "Failed";
				const errorMsg =
					type === "error" && errorMessage
						? `\n\n**Error:**\n\`\`\`\n${errorMessage}\n\`\`\``
						: "";

				await sendMattermostNotification(mattermost, {
					text: `**${statusEmoji} Database Backup ${typeStatus}**\n\n**Project:** ${projectName}\n**Application:** ${applicationName}\n**Type:** ${databaseType}\n**Database Name:** ${databaseName}\n**Date:** ${format(date, "PP")}\n**Time:** ${format(date, "pp")}${errorMsg}`,
					channel: mattermost.channel,
					username: mattermost.username || "Dokploy",
				});
			}

			if (custom) {
				await sendCustomNotification(custom, {
					title: `Database Backup ${type === "success" ? "Successful" : "Failed"}`,
					message:
						type === "success"
							? "Database backup completed successfully"
							: "Database backup failed",
					projectName,
					applicationName,
					databaseType,
					databaseName,
					type,
					errorMessage: errorMessage || "",
					timestamp: date.toISOString(),
					date: date.toLocaleString(),
					status: type,
				});
			}

			if (lark) {
				const limitCharacter = 800;
				const truncatedErrorMessage =
					errorMessage && errorMessage.length > limitCharacter
						? errorMessage.substring(0, limitCharacter)
						: errorMessage;

				await sendLarkNotification(lark, {
					msg_type: "interactive",
					card: {
						schema: "2.0",
						config: {
							update_multi: true,
							style: {
								text_size: {
									normal_v2: {
										default: "normal",
										pc: "normal",
										mobile: "heading",
									},
								},
							},
						},
						header: {
							title: {
								tag: "plain_text",
								content:
									type === "success"
										? "✅ Database Backup Successful"
										: "❌ Database Backup Failed",
							},
							subtitle: {
								tag: "plain_text",
								content: "",
							},
							template: type === "success" ? "green" : "red",
							padding: "12px 12px 12px 12px",
						},
						body: {
							direction: "vertical",
							padding: "12px 12px 12px 12px",
							elements: [
								{
									tag: "column_set",
									columns: [
										{
											tag: "column",
											width: "weighted",
											elements: [
												{
													tag: "markdown",
													content: `**Project:**\n${projectName}`,
													text_align: "left",
													text_size: "normal_v2",
												},
												{
													tag: "markdown",
													content: `**Database Type:**\n${databaseType}`,
													text_align: "left",
													text_size: "normal_v2",
												},
												{
													tag: "markdown",
													content: `**Status:**\n${type === "success" ? "Successful" : "Failed"}`,
													text_align: "left",
													text_size: "normal_v2",
												},
											],
											vertical_align: "top",
											weight: 1,
										},
										{
											tag: "column",
											width: "weighted",
											elements: [
												{
													tag: "markdown",
													content: `**Application:**\n${applicationName}`,
													text_align: "left",
													text_size: "normal_v2",
												},
												{
													tag: "markdown",
													content: `**Database Name:**\n${databaseName}`,
													text_align: "left",
													text_size: "normal_v2",
												},
												{
													tag: "markdown",
													content: `**Date:**\n${format(date, "PP pp")}`,
													text_align: "left",
													text_size: "normal_v2",
												},
											],
											vertical_align: "top",
											weight: 1,
										},
									],
								},
								...(type === "error" && truncatedErrorMessage
									? [
											{
												tag: "markdown",
												content: `**Error Message:**\n\`\`\`\n${truncatedErrorMessage}\n\`\`\``,
												text_align: "left",
												text_size: "normal_v2",
											},
										]
									: []),
							],
						},
					},
				});
			}

			if (pushover) {
				await sendPushoverNotification(
					pushover,
					`Database Backup ${type === "success" ? "Successful" : "Failed"}`,
					`Project: ${projectName}\nApplication: ${applicationName}\nDatabase: ${databaseType}\nDatabase Name: ${databaseName}\nDate: ${date.toLocaleString()}${type === "error" && errorMessage ? `\nError: ${errorMessage}` : ""}`,
				);
			}

			if (teams) {
				const facts = [
					{ name: "Project", value: projectName },
					{ name: "Application", value: applicationName },
					{ name: "Database Type", value: databaseType },
					{ name: "Database Name", value: databaseName },
					{ name: "Date", value: format(date, "PP pp") },
					{
						name: "Status",
						value: type === "success" ? "Successful" : "Failed",
					},
				];
				if (type === "error" && errorMessage) {
					facts.push({ name: "Error", value: errorMessage.substring(0, 500) });
				}
				await sendTeamsNotification(teams, {
					title:
						type === "success"
							? "✅ Database Backup Successful"
							: "❌ Database Backup Failed",
					facts,
				});
			}
		} catch (error) {
			console.log(error);
		}
	}
};

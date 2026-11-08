import type {
	custom,
	discord,
	email,
	gotify,
	lark,
	mattermost,
	ntfy,
	pushover,
	resend,
	slack,
	teams,
	telegram,
} from "@dokploy/server/db/schema";
import { Agent, fetch as undiciFetch } from "@dokploy/server/utils/undici";
import nodemailer from "nodemailer";
import { Resend } from "resend";
import { fetchWithPublicEgress } from "../url/network";
import {
	assertNotificationBaseUrlAllowed,
	assertNotificationHttpUrlAllowed,
	resolveNotificationSmtpTarget,
} from "./security";

export const sendEmailNotification = async (
	connection: typeof email.$inferInsert,
	subject: string,
	htmlContent: string,
	attachments?: { filename: string; content: Buffer }[],
) => {
	try {
		const {
			smtpServer,
			smtpPort,
			username,
			password,
			fromAddress,
			toAddresses,
		} = connection;
		const smtpTarget = await resolveNotificationSmtpTarget(smtpServer);
		const transporter = nodemailer.createTransport({
			host: smtpTarget.host,
			port: smtpPort,
			auth: { user: username, pass: password },
			tls: {
				servername: smtpTarget.servername,
			},
		});

		await transporter.sendMail({
			from: fromAddress,
			to: toAddresses.join(", "),
			subject,
			html: htmlContent,
			textEncoding: "base64",
			attachments,
		});
	} catch (err) {
		console.log(err);
		throw new Error(
			`Failed to send email notification ${err instanceof Error ? err.message : "Unknown error"}`,
		);
	}
};

export const sendResendNotification = async (
	connection: typeof resend.$inferInsert,
	subject: string,
	htmlContent: string,
) => {
	try {
		const client = new Resend(connection.apiKey);

		const result = await client.emails.send({
			from: connection.fromAddress,
			to: connection.toAddresses,
			subject,
			html: htmlContent,
		});

		if (result.error) {
			throw new Error(result.error.message);
		}
	} catch (err) {
		console.log(err);
		throw new Error(
			`Failed to send Resend notification ${err instanceof Error ? err.message : "Unknown error"}`,
		);
	}
};

export const sendDiscordNotification = async (
	connection: typeof discord.$inferInsert,
	embed: any,
) => {
	try {
		const webhookUrl = await assertNotificationHttpUrlAllowed(
			connection.webhookUrl,
			{
				fieldName: "Discord webhook URL",
			},
		);
		const response = await fetchWithPublicEgress(
			webhookUrl,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ embeds: [embed] }),
				redirect: "error",
			},
			{ fieldName: "Discord webhook URL" },
		);
		if (!response.ok) {
			throw new Error(
				`Failed to send discord notification ${response.statusText}`,
			);
		}
	} catch (err) {
		console.log("error", err);
		throw new Error(
			`Failed to send discord notification ${err instanceof Error ? err.message : "Unknown error"}`,
		);
	}
};

export const escapeHtml = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const formatTelegramErrorMessage = (errorMessage: string) => {
	const escaped = escapeHtml(errorMessage);
	const limit = 3000;
	if (escaped.length <= limit) return escaped;
	let end = limit;
	const ampIdx = escaped.lastIndexOf("&", end);
	if (ampIdx !== -1 && escaped.indexOf(";", ampIdx) >= end) {
		end = ampIdx;
	}
	if (
		end > 0 &&
		end < escaped.length &&
		isHighSurrogate(escaped.charCodeAt(end - 1))
	) {
		end--;
	}
	return `${escaped.substring(0, end)}…`;
};

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

// From some networks a new connection to api.telegram.org fails at random, 6 to 9
// of 20 in one measurement, while one that gets through answers in about 40 ms. A
// short connect timeout and several attempts deliver what one try with the default
// 10 s timeout lost.
export const TELEGRAM_SEND_ATTEMPTS = 6;
const TELEGRAM_CONNECT_TIMEOUT_MS = 3_000;
const TELEGRAM_RESPONSE_TIMEOUT_MS = 15_000;
const TELEGRAM_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];
const TELEGRAM_MAX_RETRY_AFTER_MS = 30_000;
// Only failures before the request left: a retry then cannot post the message twice.
const TELEGRAM_CONNECT_ERROR_CODES = new Set([
	"UND_ERR_CONNECT_TIMEOUT",
	"ECONNREFUSED",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EAI_AGAIN",
	"ENOTFOUND",
]);
const TELEGRAM_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

const connectErrorCode = (error: unknown) => {
	const cause = (error as { cause?: { code?: unknown } })?.cause;
	const code = typeof cause?.code === "string" ? cause.code : undefined;
	return code && TELEGRAM_CONNECT_ERROR_CODES.has(code) ? code : undefined;
};

const telegramRetryAfterMs = (body: string) => {
	try {
		const seconds = JSON.parse(body)?.parameters?.retry_after;
		return typeof seconds === "number" && seconds >= 0
			? seconds * 1000
			: undefined;
	} catch {
		return undefined;
	}
};

export const sendTelegramNotification = async (
	connection: typeof telegram.$inferInsert,
	messageText: string,
	inlineButton?: {
		text: string;
		url: string;
	}[][],
) => {
	const url = `https://api.telegram.org/bot${connection.botToken}/sendMessage`;
	const body = JSON.stringify({
		chat_id: connection.chatId,
		message_thread_id: connection.messageThreadId,
		text: messageText,
		parse_mode: "HTML",
		disable_web_page_preview: true,
		reply_markup: {
			inline_keyboard: inlineButton,
		},
	});
	const dispatcher = new Agent({
		connect: { timeout: TELEGRAM_CONNECT_TIMEOUT_MS },
		headersTimeout: TELEGRAM_RESPONSE_TIMEOUT_MS,
		bodyTimeout: TELEGRAM_RESPONSE_TIMEOUT_MS,
	});
	let lastError = "Unknown error";
	try {
		for (let attempt = 1; attempt <= TELEGRAM_SEND_ATTEMPTS; attempt++) {
			let waitMs = TELEGRAM_RETRY_DELAYS_MS[attempt - 1] ?? 0;
			try {
				const response = await undiciFetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body,
					dispatcher,
				});
				if (response.ok) {
					return;
				}
				const responseBody = await response.text();
				lastError = `${response.status} ${responseBody}`;
				if (!TELEGRAM_RETRY_STATUSES.has(response.status)) {
					break;
				}
				const retryAfterMs = telegramRetryAfterMs(responseBody);
				if (retryAfterMs !== undefined) {
					if (retryAfterMs > TELEGRAM_MAX_RETRY_AFTER_MS) {
						break;
					}
					waitMs = Math.max(waitMs, retryAfterMs);
				}
			} catch (error) {
				const code = connectErrorCode(error);
				lastError = `${error instanceof Error ? error.message : "Unknown error"}${code ? ` (${code})` : ""}`;
				if (!code) {
					break;
				}
			}
			if (attempt < TELEGRAM_SEND_ATTEMPTS) {
				await new Promise((resolve) => setTimeout(resolve, waitMs));
			}
		}
	} finally {
		await dispatcher.close().catch(() => undefined);
	}
	console.log(`Failed to send telegram notification: ${lastError}`);
	throw new Error(`Failed to send telegram notification: ${lastError}`);
};

export const sendSlackNotification = async (
	connection: typeof slack.$inferInsert,
	message: any,
) => {
	try {
		const webhookUrl = await assertNotificationHttpUrlAllowed(
			connection.webhookUrl,
			{
				fieldName: "Slack webhook URL",
			},
		);
		const response = await fetchWithPublicEgress(
			webhookUrl,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(message),
				redirect: "error",
			},
			{ fieldName: "Slack webhook URL" },
		);
		if (!response.ok) {
			throw new Error(
				`Failed to send slack notification ${response.statusText}`,
			);
		}
	} catch (err) {
		console.log("error", err);
		throw new Error(
			`Failed to send slack notification ${err instanceof Error ? err.message : "Unknown error"}`,
		);
	}
};

export const sendGotifyNotification = async (
	connection: typeof gotify.$inferInsert,
	title: string,
	message: string,
) => {
	const serverUrl = await assertNotificationBaseUrlAllowed(
		connection.serverUrl,
		{
			fieldName: "Gotify server URL",
		},
	);
	const response = await fetchWithPublicEgress(
		new URL("message", `${serverUrl}/`),
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Gotify-Key": connection.appToken,
			},
			body: JSON.stringify({
				title: title,
				message: message,
				priority: connection.priority,
				extras: {
					"client::display": {
						contentType: "text/plain",
					},
				},
			}),
			redirect: "error",
		},
		{ fieldName: "Gotify server URL" },
	);

	if (!response.ok) {
		throw new Error(
			`Failed to send Gotify notification: ${response.statusText}`,
		);
	}
};

export const sendNtfyNotification = async (
	connection: typeof ntfy.$inferInsert,
	title: string,
	tags: string,
	actions: string,
	message: string,
) => {
	const serverUrl = await assertNotificationBaseUrlAllowed(
		connection.serverUrl,
		{
			fieldName: "ntfy server URL",
		},
	);
	const response = await fetchWithPublicEgress(
		`${serverUrl}/${encodeURIComponent(connection.topic)}`,
		{
			method: "POST",
			headers: {
				...(connection.accessToken && {
					Authorization: `Bearer ${connection.accessToken}`,
				}),
				"X-Priority": connection.priority?.toString() || "3",
				"X-Title": title,
				"X-Tags": tags,
				"X-Actions": actions,
			},
			body: message,
			redirect: "error",
		},
		{ fieldName: "ntfy server URL" },
	);

	if (!response.ok) {
		throw new Error(`Failed to send ntfy notification: ${response.statusText}`);
	}
};

export const sendMattermostNotification = async (
	connection: typeof mattermost.$inferInsert,
	message: any,
) => {
	const payload = {
		...message,
		// Only include username if it's provided and not empty
		...(message.username?.trim() && { username: message.username }),
		// Only include channel if it's provided and not empty
		...(message.channel?.trim() && {
			channel: `#${message.channel.replace("#", "")}`,
		}),
	};

	const webhookUrl = await assertNotificationHttpUrlAllowed(
		connection.webhookUrl,
		{
			fieldName: "Mattermost webhook URL",
		},
	);
	const response = await fetchWithPublicEgress(
		webhookUrl,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			redirect: "error",
		},
		{ fieldName: "Mattermost webhook URL" },
	);

	if (!response.ok) {
		throw new Error(
			`Failed to send Mattermost notification: ${response.statusText}`,
		);
	}
};

export const sendCustomNotification = async (
	connection: typeof custom.$inferInsert,
	payload: Record<string, any>,
) => {
	try {
		// Merge default headers with custom headers (now already an object from jsonb)
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...(connection.headers || {}),
		};

		// Default body with payload
		const body = JSON.stringify(payload);

		const endpoint = await assertNotificationHttpUrlAllowed(
			connection.endpoint,
			{
				allowPrivateNetwork: false,
				fieldName: "Custom notification endpoint",
			},
		);
		const response = await fetchWithPublicEgress(
			endpoint,
			{
				method: "POST",
				headers,
				body,
				redirect: "error",
			},
			{
				allowPrivateNetwork: false,
				fieldName: "Custom notification endpoint",
			},
		);

		if (!response.ok) {
			throw new Error(
				`Failed to send custom notification: ${response.statusText}`,
			);
		}

		return response;
	} catch (error) {
		console.error("Error sending custom notification:", error);
		throw error;
	}
};

export const sendLarkNotification = async (
	connection: typeof lark.$inferInsert,
	message: any,
) => {
	try {
		const webhookUrl = await assertNotificationHttpUrlAllowed(
			connection.webhookUrl,
			{
				fieldName: "Lark webhook URL",
			},
		);
		await fetchWithPublicEgress(
			webhookUrl,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(message),
				redirect: "error",
			},
			{ fieldName: "Lark webhook URL" },
		);
	} catch (err) {
		console.log(err);
	}
};

export interface TeamsAdaptiveCardMessage {
	title: string;
	themeColor?: string;
	facts?: { name: string; value: string }[];
	potentialAction?: { type: "Action.OpenUrl"; title: string; url: string };
}

export const sendTeamsNotification = async (
	connection: typeof teams.$inferInsert,
	message: TeamsAdaptiveCardMessage,
) => {
	try {
		const bodyElements: Record<string, unknown>[] = [
			{
				type: "TextBlock",
				text: message.title,
				size: "Medium",
				weight: "Bolder",
				wrap: true,
			},
		];

		if (message.facts && message.facts.length > 0) {
			bodyElements.push({
				type: "FactSet",
				facts: message.facts.map((f) => ({
					title: f.name,
					value: f.value,
				})),
			});
		}

		const cardContent: Record<string, unknown> = {
			type: "AdaptiveCard",
			$schema: "http://adaptivecards.io/schemas/adaptive-card.json",
			version: "1.4",
			body: bodyElements,
		};

		if (message.potentialAction) {
			cardContent.actions = [
				{
					type: "Action.OpenUrl",
					title: message.potentialAction.title,
					url: message.potentialAction.url,
				},
			];
		}

		const payload = {
			type: "message",
			attachments: [
				{
					contentType: "application/vnd.microsoft.card.adaptive",
					content: cardContent,
				},
			],
		};

		const webhookUrl = await assertNotificationHttpUrlAllowed(
			connection.webhookUrl,
			{
				fieldName: "Teams webhook URL",
			},
		);
		const response = await fetchWithPublicEgress(
			webhookUrl,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				redirect: "error",
			},
			{ fieldName: "Teams webhook URL" },
		);

		if (!response.ok) {
			throw new Error(
				`Failed to send Teams notification: ${response.statusText}`,
			);
		}
	} catch (err) {
		console.log(err);
		throw new Error(
			`Failed to send Teams notification ${err instanceof Error ? err.message : "Unknown error"}`,
		);
	}
};

export const sendPushoverNotification = async (
	connection: typeof pushover.$inferInsert,
	title: string,
	message: string,
) => {
	const formData = new URLSearchParams();
	formData.append("token", connection.apiToken);
	formData.append("user", connection.userKey);
	formData.append("title", title);
	formData.append("message", message);
	formData.append("priority", connection.priority?.toString() || "0");

	// For emergency priority (2), retry and expire are required
	if (connection.priority === 2) {
		formData.append("retry", connection.retry?.toString() || "30");
		formData.append("expire", connection.expire?.toString() || "3600");
	}

	const response = await fetch("https://api.pushover.net/1/messages.json", {
		method: "POST",
		body: formData,
	});

	if (!response.ok) {
		throw new Error(
			`Failed to send Pushover notification: ${response.statusText}`,
		);
	}
};

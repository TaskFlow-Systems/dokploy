import { REDACTED_NOTIFICATION_SECRET } from "@dokploy/server/utils/notifications/security";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	customFindFirst: vi.fn(),
	emailFindFirst: vi.fn(),
	gotifyFindFirst: vi.fn(),
	ntfyFindFirst: vi.fn(),
	set: vi.fn(),
	transaction: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			custom: { findFirst: mocks.customFindFirst },
			email: { findFirst: mocks.emailFindFirst },
			gotify: { findFirst: mocks.gotifyFindFirst },
			ntfy: { findFirst: mocks.ntfyFindFirst },
		},
		transaction: mocks.transaction,
	},
}));

const {
	updateCustomNotification,
	updateEmailNotification,
	updateGotifyNotification,
	updateNtfyNotification,
} = await import("@dokploy/server/services/notification");

const notificationFields = {
	notificationId: "notification-1",
	name: "alerts",
	organizationId: "org-1",
};

const providerSets = () =>
	mocks.set.mock.calls
		.map(([values]) => values as Record<string, unknown>)
		.filter((values) => !("name" in values));

describe("notification update stored secret binding", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		const chain = {
			returning: vi.fn(async () => [{ notificationId: "notification-1" }]),
		};
		const tx = {
			update: vi.fn(() => ({
				set: (values: unknown) => {
					mocks.set(values);
					return { where: vi.fn(() => chain) };
				},
			})),
		};
		mocks.transaction.mockImplementation(async (callback) => callback(tx));
		mocks.emailFindFirst.mockResolvedValue({
			emailId: "email-1",
			smtpServer: "smtp.example.com",
			smtpPort: 587,
			username: "alerts@example.com",
			password: "stored-smtp-password",
		});
		mocks.gotifyFindFirst.mockResolvedValue({
			gotifyId: "gotify-1",
			serverUrl: "https://gotify.example.com",
			appToken: "stored-gotify-token",
		});
		mocks.ntfyFindFirst.mockResolvedValue({
			ntfyId: "ntfy-1",
			serverUrl: "https://ntfy.example.com",
			topic: "alerts",
			accessToken: "stored-ntfy-token",
		});
		mocks.customFindFirst.mockResolvedValue({
			customId: "custom-1",
			endpoint: "https://hooks.example.com/notify",
			headers: { Authorization: "Bearer stored-header-token" },
		});
	});

	it.each([
		["smtpServer", { smtpServer: "smtp.collector.example.net" }],
		["smtpPort", { smtpPort: 2525 }],
		["username", { username: "other@example.net" }],
	])(
		"rejects a new SMTP %s with the stored password",
		async (field, change) => {
			for (const password of [REDACTED_NOTIFICATION_SECRET, "", undefined]) {
				await expect(
					updateEmailNotification({
						...notificationFields,
						emailId: "email-1",
						smtpServer: "smtp.example.com",
						smtpPort: 587,
						username: "alerts@example.com",
						password,
						...change,
					}),
				).rejects.toMatchObject({
					code: "BAD_REQUEST",
					message: `Re-enter the SMTP password to change ${field}`,
				});
			}
			expect(mocks.transaction).not.toHaveBeenCalled();

			await updateEmailNotification({
				...notificationFields,
				emailId: "email-1",
				smtpServer: "SMTP.example.com",
				smtpPort: 587,
				username: "alerts@example.com",
				password: REDACTED_NOTIFICATION_SECRET,
			});
			await updateEmailNotification({
				...notificationFields,
				emailId: "email-1",
				...change,
				password: "new-smtp-password",
			});
			expect(providerSets()).toEqual([
				expect.objectContaining({
					smtpServer: "smtp.example.com",
					password: undefined,
				}),
				expect.objectContaining({ ...change, password: "new-smtp-password" }),
			]);
		},
	);

	it("rejects a new Gotify server URL with the stored app token", async () => {
		await expect(
			updateGotifyNotification({
				...notificationFields,
				gotifyId: "gotify-1",
				serverUrl: "https://collector.example.net",
				appToken: REDACTED_NOTIFICATION_SECRET,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "Re-enter the Gotify app token to change serverUrl",
		});
		expect(mocks.transaction).not.toHaveBeenCalled();

		await updateGotifyNotification({
			...notificationFields,
			gotifyId: "gotify-1",
			serverUrl: "https://gotify.example.com/",
			appToken: REDACTED_NOTIFICATION_SECRET,
			priority: 8,
		});
		expect(providerSets()).toEqual([
			expect.objectContaining({ appToken: undefined, priority: 8 }),
		]);
	});

	it("rejects a new ntfy server URL with the stored access token", async () => {
		await expect(
			updateNtfyNotification({
				...notificationFields,
				ntfyId: "ntfy-1",
				serverUrl: "https://collector.example.net",
				topic: "alerts",
				accessToken: REDACTED_NOTIFICATION_SECRET,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "Re-enter the ntfy access token to change serverUrl",
		});
		expect(mocks.transaction).not.toHaveBeenCalled();

		await updateNtfyNotification({
			...notificationFields,
			ntfyId: "ntfy-1",
			serverUrl: "https://ntfy-new.example.com",
			topic: "alerts",
			accessToken: "",
		});
		expect(providerSets()).toEqual([
			expect.objectContaining({
				serverUrl: "https://ntfy-new.example.com",
				accessToken: null,
			}),
		]);
	});

	it("rejects a new custom endpoint with the stored header values", async () => {
		for (const headers of [
			{ Authorization: REDACTED_NOTIFICATION_SECRET },
			undefined,
		]) {
			await expect(
				updateCustomNotification({
					...notificationFields,
					customId: "custom-1",
					endpoint: "https://collector.example.net/hook",
					headers,
				}),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: "Re-enter the custom notification headers to change endpoint",
			});
		}
		expect(mocks.transaction).not.toHaveBeenCalled();

		await updateCustomNotification({
			...notificationFields,
			customId: "custom-1",
			endpoint: REDACTED_NOTIFICATION_SECRET,
			headers: { Authorization: REDACTED_NOTIFICATION_SECRET },
		});
		await updateCustomNotification({
			...notificationFields,
			customId: "custom-1",
			endpoint: "https://hooks-new.example.com/notify",
			headers: { Authorization: "Bearer new-token" },
		});
		// The first call changes nothing in the custom row, so it issues no update.
		expect(providerSets()).toEqual([
			{
				endpoint: "https://hooks-new.example.com/notify",
				headers: { Authorization: "Bearer new-token" },
			},
		]);
	});
});

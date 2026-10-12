import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
	audit: vi.fn(),
	sendEmailNotification: vi.fn(),
	sendResendNotification: vi.fn(),
}));

vi.mock("@dokploy/server/db", async () => {
	const schema = await import("@dokploy/server/db/schema");
	const { createFakeDrizzleDb } = await import("../helpers/fake-drizzle-db");
	const fake = createFakeDrizzleDb({
		superPassword: schema.superPassword,
		superSession: schema.superSession,
		superPasswordToken: schema.superPasswordToken,
		account: schema.account,
		member: schema.member,
		notifications: schema.notifications,
		email: schema.email,
		resend: schema.resend,
		schedules: schema.schedules,
		backups: schema.backups,
	});
	return { db: fake.db, fake };
});

vi.mock("@dokploy/server/utils/notifications/utils", () => ({
	sendEmailNotification: mocks.sendEmailNotification,
	sendResendNotification: mocks.sendResendNotification,
}));

vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: async () => "https://panel.example.test",
	getTrustedOrigins: async () => [],
	getUserByToken: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: mocks.audit,
}));

vi.mock("@dokploy/server/services/known-secrets", async () => {
	const { EMPTY_KNOWN_SECRET_MATCHER } = await import(
		"@dokploy/server/utils/security/secret-scrub"
	);
	return {
		getKnownSecretMatcher: async () => EMPTY_KNOWN_SECRET_MATCHER,
		resetKnownSecretMatcherCache: () => {},
	};
});

const schema = await import("@dokploy/server/db/schema");
const { fake } = (await import("@dokploy/server/db")) as unknown as {
	fake: ReturnType<
		typeof import("../helpers/fake-drizzle-db")["createFakeDrizzleDb"]
	>;
};
const service = await import("@dokploy/server/services/super-password");
const { createTRPCRouter, protectedProcedure, publicProcedure } = await import(
	"@/server/api/trpc"
);
const { superPasswordRouter } = await import(
	"@/server/api/routers/super-password"
);
const { userRouter } = await import("@/server/api/routers/user");

const handled = vi.fn((name: string) => name);

const testRouter = createTRPCRouter({
	application: createTRPCRouter({
		one: protectedProcedure.query(() => handled("application.one")),
		update: protectedProcedure.mutation(() => handled("application.update")),
		revealEnvironment: protectedProcedure.mutation(() =>
			handled("application.revealEnvironment"),
		),
	}),
	user: createTRPCRouter({
		update: protectedProcedure
			.input(
				z.object({
					email: z.string().optional(),
					firstName: z.string().optional(),
				}),
			)
			.mutation(() => handled("user.update")),
	}),
	schedule: createTRPCRouter({
		create: protectedProcedure
			.input(z.object({ scheduleType: z.string() }))
			.mutation(() => handled("schedule.create")),
		runManually: protectedProcedure
			.input(z.object({ scheduleId: z.string() }))
			.mutation(() => handled("schedule.runManually")),
	}),
	settings: createTRPCRouter({
		health: publicProcedure.query(() => handled("settings.health")),
	}),
	superPassword: superPasswordRouter,
});

const owner = {
	id: "user-1",
	email: "owner@example.test",
	role: "owner" as const,
	ownerId: "user-1",
};

const browserCaller = () =>
	testRouter.createCaller({
		db: {},
		req: {
			headers: { "user-agent": "Browser/1.0", "x-real-ip": "203.0.113.7" },
		},
		res: {},
		user: owner,
		session: {
			id: "session-1",
			userId: owner.id,
			activeOrganizationId: "org-1",
			authMethod: "session",
		},
	} as never);

const apiKeyCaller = () =>
	testRouter.createCaller({
		db: {},
		req: { headers: {} },
		res: {},
		user: owner,
		session: {
			userId: owner.id,
			activeOrganizationId: "org-1",
			authMethod: "api-key",
			apiKeyId: "key-1",
		},
	} as never);

const setSuperPassword = () =>
	service.setSuperPassword({ userId: owner.id, password: "super-password-1" });

const openSuperSession = () =>
	service.openSuperSession({ userId: owner.id, sessionId: "session-1" });

const expectSuperSessionError = async (
	promise: Promise<unknown>,
	reason:
		| "api-key-write-locked"
		| "super-session-required"
		| "browser-session-required",
) => {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(TRPCError);
	expect(error).toMatchObject({
		code: "FORBIDDEN",
		message: service.SUPER_SESSION_MESSAGES[reason],
	});
	expect(service.getSuperSessionDenial(error)).toBe(reason);
};

beforeEach(() => {
	fake.reset();
	vi.clearAllMocks();
});

describe("super session guard without a super password", () => {
	it("keeps today's behaviour for API keys and browser sessions", async () => {
		await expect(apiKeyCaller().application.update()).resolves.toBe(
			"application.update",
		);
		await expect(browserCaller().application.revealEnvironment()).resolves.toBe(
			"application.revealEnvironment",
		);
		await expect(
			browserCaller().user.update({ email: "new@example.test" }),
		).resolves.toBe("user.update");
	});

	it("never reveals secrets to API keys, with or without a super password", async () => {
		await expect(
			apiKeyCaller().application.revealEnvironment(),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message:
				"This procedure returns secret values and is not available to API keys",
		});
		expect(handled).not.toHaveBeenCalled();
	});
});

describe("super session guard with a super password", () => {
	beforeEach(async () => {
		await setSuperPassword();
	});

	it("makes API keys read-only while the super session is closed", async () => {
		await expect(apiKeyCaller().application.one()).resolves.toBe(
			"application.one",
		);
		await expectSuperSessionError(
			apiKeyCaller().application.update(),
			"api-key-write-locked",
		);
		expect(handled).not.toHaveBeenCalledWith("application.update");
	});

	it("allows API key writes while the super session is open", async () => {
		await openSuperSession();
		await expect(apiKeyCaller().application.update()).resolves.toBe(
			"application.update",
		);
	});

	it("never lets API keys run dangerous procedures, even while open", async () => {
		await expectSuperSessionError(
			apiKeyCaller().application.revealEnvironment(),
			"browser-session-required",
		);
		await openSuperSession();
		await expectSuperSessionError(
			apiKeyCaller().application.revealEnvironment(),
			"browser-session-required",
		);
		expect(handled).not.toHaveBeenCalledWith("application.revealEnvironment");
	});

	it("needs an open super session for dangerous procedures from the browser", async () => {
		await expect(browserCaller().application.update()).resolves.toBe(
			"application.update",
		);
		await expectSuperSessionError(
			browserCaller().application.revealEnvironment(),
			"super-session-required",
		);

		await openSuperSession();
		await expect(browserCaller().application.revealEnvironment()).resolves.toBe(
			"application.revealEnvironment",
		);
	});

	it("treats only credential changes in user.update as dangerous", async () => {
		await expect(
			browserCaller().user.update({ firstName: "New", email: owner.email }),
		).resolves.toBe("user.update");
		await expectSuperSessionError(
			browserCaller().user.update({ email: "attacker@example.test" }),
			"super-session-required",
		);
	});

	it("treats host-level schedules as dangerous", async () => {
		await expect(
			browserCaller().schedule.create({ scheduleType: "server" }),
		).resolves.toBe("schedule.create");
		await expectSuperSessionError(
			browserCaller().schedule.create({ scheduleType: "dokploy-server" }),
			"super-session-required",
		);

		fake.seed(schema.schedules, {
			scheduleId: "schedule-1",
			name: "host",
			cronExpression: "* * * * *",
			command: "true",
			scheduleType: "dokploy-server",
		});
		await expectSuperSessionError(
			browserCaller().schedule.runManually({ scheduleId: "schedule-1" }),
			"super-session-required",
		);
		await openSuperSession();
		await expect(
			browserCaller().schedule.runManually({ scheduleId: "schedule-1" }),
		).resolves.toBe("schedule.runManually");
	});

	it("adds the denial reason to the error shape for the UI", () => {
		const error = new TRPCError({
			code: "FORBIDDEN",
			message: service.SUPER_SESSION_MESSAGES["super-session-required"],
			cause: new service.SuperSessionError("super-session-required"),
		});
		const formatter = (
			testRouter as unknown as {
				_def: {
					_config: {
						errorFormatter: (opts: unknown) => {
							data: { superSession: unknown };
						};
					};
				};
			}
		)._def._config.errorFormatter;

		expect(
			formatter({ error, shape: { data: {} }, type: "mutation", path: "x" })
				.data.superSession,
		).toBe("super-session-required");
		expect(
			formatter({
				error: new TRPCError({ code: "FORBIDDEN" }),
				shape: { data: {} },
				type: "mutation",
				path: "x",
			}).data.superSession,
		).toBeNull();
	});
});

describe("superPassword router", () => {
	it("reports status to API keys without the hash", async () => {
		await setSuperPassword();
		const status = await apiKeyCaller().superPassword.status();

		expect(status).toMatchObject({
			isSet: true,
			active: false,
			expiresAt: null,
			viaApiKey: true,
		});
		expect(JSON.stringify(status)).not.toContain("$2");
	});

	it("only lets browser sessions set, unlock and extend", async () => {
		await expect(
			apiKeyCaller().superPassword.set({ password: "super-password-1" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		await browserCaller().superPassword.set({ password: "super-password-1" });

		await expect(browserCaller().superPassword.extend()).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
		});
		await expect(
			apiKeyCaller().superPassword.unlock({ password: "super-password-1" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		const unlocked = await browserCaller().superPassword.unlock({
			password: "super-password-1",
		});
		expect(unlocked.expiresAt.getTime()).toBeGreaterThan(Date.now());
		expect(fake.rows(schema.superSession)[0]).toMatchObject({
			openedBySessionId: "session-1",
		});

		await expect(apiKeyCaller().superPassword.extend()).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(browserCaller().superPassword.extend()).resolves.toMatchObject(
			{
				expiresAt: expect.any(Date),
			},
		);
	});

	it("closes access and needs the super password to turn it off", async () => {
		await setSuperPassword();
		await openSuperSession();

		await browserCaller().superPassword.close();
		await expect(service.getSuperSessionState(owner.id)).resolves.toMatchObject(
			{
				active: false,
			},
		);

		await expect(
			browserCaller().superPassword.disable({ password: "wrong-password" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await browserCaller().superPassword.disable({
			password: "super-password-1",
		});
		await expect(service.getSuperSessionState(owner.id)).resolves.toMatchObject(
			{
				isSet: false,
			},
		);
	});

	it("closes access from the email link without signing in", async () => {
		await setSuperPassword();
		await openSuperSession();
		const { token } = await service.createSuperPasswordToken({
			userId: owner.id,
			type: "lock",
		});
		const anonymous = testRouter.createCaller({
			db: {},
			req: { headers: {} },
			res: {},
			user: null,
			session: null,
		} as never);

		await expect(
			anonymous.superPassword.lockWithToken({ token }),
		).resolves.toEqual({ closed: true });
		await expect(
			anonymous.superPassword.lockWithToken({ token }),
		).resolves.toEqual({ closed: false });
		await expect(service.getSuperSessionState(owner.id)).resolves.toMatchObject(
			{
				active: false,
			},
		);
	});
});

describe("login password changes", () => {
	it("rejects a new login password equal to the super password", async () => {
		const bcrypt = await import("bcrypt");
		fake.seed(schema.account, {
			id: "account-1",
			accountId: "account-1",
			providerId: "credential",
			userId: owner.id,
			password: await bcrypt.hash("login-password-1", 4),
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		await setSuperPassword();
		await openSuperSession();

		await expect(
			userRouter
				.createCaller({
					db: {},
					req: { headers: {} },
					res: {},
					user: owner,
					session: {
						id: "session-1",
						userId: owner.id,
						activeOrganizationId: "org-1",
						authMethod: "session",
					},
				} as never)
				.update({
					email: owner.email,
					currentPassword: "login-password-1",
					password: "super-password-1",
				}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "The login password must differ from your super password",
		});
		expect(
			await bcrypt.compare(
				"login-password-1",
				String(fake.rows(schema.account)[0]?.password),
			),
		).toBe(true);
	});
});

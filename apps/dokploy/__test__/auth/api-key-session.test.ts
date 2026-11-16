import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createApiKey: vi.fn(),
	getSession: vi.fn(),
	handler: vi.fn(),
	insert: vi.fn(),
	memberFindFirst: vi.fn(),
	memberInsertValues: vi.fn(),
	apiKeyFindFirst: vi.fn(),
	organizationFindFirst: vi.fn(),
	authOptions: undefined as any,
	checkPermission: vi.fn(),
	createAuthMiddleware: vi.fn((middleware) => middleware),
	registerSSOProvider: vi.fn(),
	select: vi.fn(),
	ssoProviderFindFirst: vi.fn(),
	ssoPlugin: vi.fn((options) => {
		mocks.ssoPluginOptions = options;
		return {};
	}),
	ssoPluginOptions: undefined as any,
	trustedOriginsWhere: vi.fn(),
	updateSSOProvider: vi.fn(),
	verifyApiKey: vi.fn(),
	webServerSettingsFindFirst: vi.fn(),
}));

vi.mock("better-auth", () => ({
	betterAuth: vi.fn((options) => {
		mocks.authOptions = options;
		return {
			handler: mocks.handler,
			api: {
				createApiKey: mocks.createApiKey,
				getSession: mocks.getSession,
				registerSSOProvider: mocks.registerSSOProvider,
				updateSSOProvider: mocks.updateSSOProvider,
				verifyApiKey: mocks.verifyApiKey,
			},
		};
	}),
}));

vi.mock("better-auth/api", () => ({
	APIError: class APIError extends Error {
		status: string;

		constructor(status: string, options?: { message?: string }) {
			super(options?.message ?? status);
			this.status = status;
		}
	},
	createAuthMiddleware: mocks.createAuthMiddleware,
}));

vi.mock("better-auth/adapters/drizzle", () => ({
	drizzleAdapter: vi.fn(() => ({})),
}));

vi.mock("@better-auth/api-key", () => ({
	apiKey: vi.fn(() => ({})),
}));

vi.mock("@better-auth/sso", () => ({
	sso: mocks.ssoPlugin,
}));

vi.mock("better-auth/plugins", () => ({
	admin: vi.fn(() => ({})),
	organization: vi.fn(() => ({})),
	twoFactor: vi.fn(() => ({})),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		insert: mocks.insert,
		select: mocks.select,
		query: {
			apikey: {
				findFirst: mocks.apiKeyFindFirst,
			},
			webServerSettings: {
				findFirst: mocks.webServerSettingsFindFirst,
			},
			member: {
				findFirst: mocks.memberFindFirst,
			},
			organization: {
				findFirst: mocks.organizationFindFirst,
			},
			ssoProvider: {
				findFirst: mocks.ssoProviderFindFirst,
			},
		},
	},
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: mocks.checkPermission,
}));

const { validateRequest } = await import(
	"../../../../packages/server/src/lib/auth"
);
const { shouldBlockEmailPasswordSignIn } = await import(
	"../../../../packages/server/src/lib/auth"
);
const { resolveTrustedOriginsForAuthRequest } = await import(
	"../../../../packages/server/src/lib/auth"
);
const { canProvisionSsoMembershipForEmail } = await import(
	"../../../../packages/server/src/lib/auth"
);
const { drizzleAdapter } = await import("better-auth/adapters/drizzle");
const { organization } = await import("better-auth/plugins");

// Captured before any beforeEach clears the mock call history.
const drizzleAdapterOptions = vi.mocked(drizzleAdapter).mock.calls[0]?.[1];
const organizationOptions = vi.mocked(organization).mock.calls[0]?.[0];

// validateRequest keeps its answer per request object, so every case needs
// its own request.
const apiKeyRequest = () =>
	({
		headers: {
			"x-api-key": "dokploy-test-key",
		},
	}) as unknown as IncomingMessage;

const userRecord = {
	id: "user-1",
	firstName: "Ada",
	lastName: "Lovelace",
	email: "ada@example.com",
	emailVerified: true,
	image: null,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	updatedAt: new Date("2026-01-02T00:00:00.000Z"),
	twoFactorEnabled: false,
	enableEnterpriseFeatures: false,
	isValidEnterpriseLicense: false,
};

describe("validateRequest API key sessions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkPermission.mockResolvedValue(undefined);
		mocks.verifyApiKey.mockResolvedValue({
			valid: true,
			key: { id: "api-key-1" },
			error: null,
		});
		mocks.apiKeyFindFirst.mockResolvedValue({
			id: "api-key-1",
			metadata: JSON.stringify({ organizationId: "org-1" }),
			user: userRecord,
		});
		mocks.webServerSettingsFindFirst.mockResolvedValue({ enforceSSO: false });
		mocks.trustedOriginsWhere.mockResolvedValue([
			{ trustedOrigins: ["https://8.8.8.8"] },
		]);
		mocks.select.mockReturnValue({
			from: () => ({
				innerJoin: () => ({
					where: mocks.trustedOriginsWhere,
				}),
			}),
		});
		mocks.insert.mockReturnValue({
			values: mocks.memberInsertValues,
		});
	});

	it("rejects API key sessions when the key owner lacks api.read", async () => {
		mocks.memberFindFirst.mockResolvedValue({
			role: "member",
			organization: {
				ownerId: "user-1",
			},
		});
		mocks.checkPermission.mockRejectedValue(new Error("Permission denied"));

		await expect(validateRequest(apiKeyRequest())).resolves.toEqual({
			session: null,
			user: null,
		});
	});

	it("rejects API key metadata for an organization the key owner is not a member of", async () => {
		mocks.memberFindFirst.mockResolvedValue(undefined);

		await expect(validateRequest(apiKeyRequest())).resolves.toEqual({
			session: null,
			user: null,
		});
	});

	it("builds an API key session only after membership is verified", async () => {
		mocks.memberFindFirst.mockResolvedValue({
			role: "owner",
			organization: {
				ownerId: "user-1",
			},
		});

		await expect(validateRequest(apiKeyRequest())).resolves.toMatchObject({
			session: {
				userId: "user-1",
				activeOrganizationId: "org-1",
			},
			user: {
				id: "user-1",
				role: "owner",
				ownerId: "user-1",
			},
		});
		expect(mocks.checkPermission).toHaveBeenCalledWith(
			{
				user: { id: "user-1" },
				session: { activeOrganizationId: "org-1" },
			},
			{ api: ["read"] },
		);
	});

	it("verifies the API key once when the same request is validated twice", async () => {
		mocks.memberFindFirst.mockResolvedValue({
			role: "owner",
			organization: {
				ownerId: "user-1",
			},
		});
		const request = apiKeyRequest();

		const first = await validateRequest(request);
		const second = await validateRequest(request);

		expect(second).toBe(first);
		expect(first).toMatchObject({
			session: { userId: "user-1", activeOrganizationId: "org-1" },
		});
		expect(mocks.verifyApiKey).toHaveBeenCalledTimes(1);

		await validateRequest(apiKeyRequest());
		expect(mocks.verifyApiKey).toHaveBeenCalledTimes(2);
	});
});

describe("validateRequest cookie sessions", () => {
	const cookieRequest = () =>
		({
			headers: { cookie: "better-auth.session_token=token" },
		}) as unknown as IncomingMessage;

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSession.mockResolvedValue({
			session: {
				id: "session-1",
				userId: "user-1",
				activeOrganizationId: "org-1",
			},
			user: { id: "user-1", email: "ada@example.com" },
		});
	});

	it("resolves ownerId to the owner of the active organization", async () => {
		mocks.memberFindFirst.mockResolvedValue({
			role: "admin",
			organization: { id: "org-1", ownerId: "owner-1" },
			user: { enableEnterpriseFeatures: true, isValidEnterpriseLicense: true },
		});

		await expect(validateRequest(cookieRequest())).resolves.toMatchObject({
			session: { id: "session-1", activeOrganizationId: "org-1" },
			user: {
				id: "user-1",
				role: "admin",
				ownerId: "owner-1",
				enableEnterpriseFeatures: true,
				isValidEnterpriseLicense: true,
			},
		});
	});

	it("falls back to the user itself when there is no membership", async () => {
		mocks.memberFindFirst.mockResolvedValue(undefined);

		await expect(validateRequest(cookieRequest())).resolves.toMatchObject({
			session: { activeOrganizationId: "" },
			user: {
				id: "user-1",
				role: "member",
				ownerId: "user-1",
				enableEnterpriseFeatures: false,
				isValidEnterpriseLicense: false,
			},
		});
	});
});

describe("Better Auth 1.7 configuration", () => {
	it("runs the Drizzle adapter with native transactions", () => {
		expect(drizzleAdapterOptions).toMatchObject({
			provider: "pg",
			transaction: true,
		});
	});

	it("does not declare ownerId as a Better Auth user column", () => {
		expect(mocks.authOptions.user.additionalFields).not.toHaveProperty(
			"ownerId",
		);
	});

	it("declares the NOT NULL organization ownerId column", () => {
		expect(
			organizationOptions?.schema?.organization?.additionalFields?.ownerId,
		).toMatchObject({ type: "string", required: true, input: false });
	});
});

describe("Better Auth trusted origins", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.webServerSettingsFindFirst.mockResolvedValue({
			enforceSSO: false,
			host: "dokploy.example.com",
			serverIp: "203.0.113.10",
		});
		mocks.trustedOriginsWhere.mockResolvedValue([
			{ trustedOrigins: ["https://8.8.8.8"] },
		]);
		mocks.select.mockReturnValue({
			from: () => ({
				innerJoin: () => ({
					where: mocks.trustedOriginsWhere,
				}),
			}),
		});
	});

	it("does not apply tenant trusted origins to ordinary Better Auth requests", async () => {
		await expect(
			resolveTrustedOriginsForAuthRequest(
				new Request("https://dokploy.example.com/api/auth/callback/sso"),
			),
		).resolves.toEqual([
			"http://203.0.113.10:3000",
			"https://dokploy.example.com",
		]);
		expect(mocks.trustedOriginsWhere).not.toHaveBeenCalled();
	});

	it("scopes tenant trusted origins to the SSO register transaction", async () => {
		await expect(
			resolveTrustedOriginsForAuthRequest(
				new Request("https://dokploy.example.com/api/auth/sso/register"),
			),
		).resolves.toEqual([
			"http://203.0.113.10:3000",
			"https://dokploy.example.com",
			"https://8.8.8.8",
		]);
		expect(mocks.trustedOriginsWhere).toHaveBeenCalledTimes(1);
	});

	it("skips database-backed origins during the Next production build", async () => {
		vi.stubEnv("NEXT_PHASE", "phase-production-build");

		try {
			await expect(
				resolveTrustedOriginsForAuthRequest(
					new Request("https://dokploy.example.com/api/auth/sso/register"),
				),
			).resolves.toEqual([]);
		} finally {
			vi.unstubAllEnvs();
		}

		expect(mocks.webServerSettingsFindFirst).not.toHaveBeenCalled();
		expect(mocks.trustedOriginsWhere).not.toHaveBeenCalled();
	});

	it("skips database-backed origins during the build-next lifecycle", async () => {
		vi.stubEnv("npm_lifecycle_event", "build-next");
		vi.stubEnv("npm_lifecycle_script", "next build --webpack");

		try {
			await expect(
				resolveTrustedOriginsForAuthRequest(
					new Request("https://dokploy.example.com/api/auth/sso/register"),
				),
			).resolves.toEqual([]);
		} finally {
			vi.unstubAllEnvs();
		}

		expect(mocks.webServerSettingsFindFirst).not.toHaveBeenCalled();
		expect(mocks.trustedOriginsWhere).not.toHaveBeenCalled();
	});
});

describe("Better Auth SSO enforcement", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.webServerSettingsFindFirst.mockResolvedValue({ enforceSSO: false });
	});

	it("blocks direct email/password sign-in while enforceSSO is enabled", async () => {
		mocks.webServerSettingsFindFirst.mockResolvedValue({ enforceSSO: true });

		await expect(
			shouldBlockEmailPasswordSignIn("/sign-in/email"),
		).resolves.toBe(true);
		await expect(
			mocks.authOptions.hooks.before({ path: "/sign-in/email" }),
		).rejects.toThrow(
			"Email and password sign-in is disabled while SSO is enforced",
		);
	});

	it("does not block SSO endpoints or password sign-in when enforceSSO is off", async () => {
		await expect(shouldBlockEmailPasswordSignIn("/sso/callback")).resolves.toBe(
			false,
		);
		await expect(
			shouldBlockEmailPasswordSignIn("/sign-in/email"),
		).resolves.toBe(false);
	});
});

describe("Better Auth account linking policy", () => {
	it("does not globally trust tenant SSO providers for implicit account linking", () => {
		const authSource = readFileSync(
			new URL("../../../../packages/server/src/lib/auth.ts", import.meta.url),
			"utf8",
		);

		expect(authSource).toMatch(/trustedProviders:\s*\["github",\s*"google"\]/);
		expect(authSource).toContain("allowDifferentEmails: false");
		expect(authSource).not.toContain("getTrustedProviders");
		expect(authSource).not.toContain("allowDifferentEmails: true");
	});
});

describe("Better Auth SSO domain verification", () => {
	it("enables Better Auth domain verification for SSO providers", () => {
		expect(mocks.ssoPluginOptions.domainVerification).toEqual({
			enabled: true,
		});
	});

	it("keeps IdP-initiated SAML disabled", () => {
		expect(mocks.ssoPluginOptions.saml).toEqual({ allowIdpInitiated: false });
	});
});

describe("Better Auth SSO identity gate", () => {
	const validate = (email: string, source: Record<string, unknown>) =>
		mocks.authOptions.user.validateUserInfo({ user: { email }, source }, {});

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.ssoProviderFindFirst.mockResolvedValue({
			organizationId: "org-acme",
			domain: "acme.com",
			domainVerified: true,
		});
	});

	it.each(["sso-oidc", "sso-saml"])(
		"rejects %s identities outside the provider domains before the user is created",
		async (method) => {
			await expect(
				validate("attacker@evil.com", {
					method,
					action: "create-user",
					sso: { providerId: "acme-sso" },
				}),
			).resolves.toMatchObject({ error: "sso_email_domain_not_allowed" });
		},
	);

	it("rejects linking an SSO account through an unverified provider domain", async () => {
		mocks.ssoProviderFindFirst.mockResolvedValue({
			organizationId: "org-acme",
			domain: "acme.com",
			domainVerified: false,
		});

		await expect(
			validate("ada@acme.com", {
				method: "sso-oidc",
				action: "link-account",
				sso: { providerId: "acme-sso" },
			}),
		).resolves.toMatchObject({ error: "sso_email_domain_not_allowed" });
	});

	it("rejects identities from an unknown SSO provider", async () => {
		mocks.ssoProviderFindFirst.mockResolvedValue(undefined);

		await expect(
			validate("ada@acme.com", {
				method: "sso-saml",
				action: "create-user",
				sso: { providerId: "missing" },
			}),
		).resolves.toMatchObject({ error: "sso_email_domain_not_allowed" });
	});

	it("allows SSO identities from a verified provider domain", async () => {
		await expect(
			validate("ada@engineering.acme.com", {
				method: "sso-oidc",
				action: "create-user",
				sso: { providerId: "acme-sso" },
			}),
		).resolves.toBeUndefined();
	});

	it("does not gate returning SSO sign-ins or non-SSO identities", async () => {
		await expect(
			validate("ada@evil.com", {
				method: "sso-oidc",
				action: "sign-in",
				sso: { providerId: "acme-sso" },
			}),
		).resolves.toBeUndefined();
		await expect(
			validate("ada@evil.com", {
				method: "email-password",
				action: "create-user",
			}),
		).resolves.toBeUndefined();
		expect(mocks.ssoProviderFindFirst).not.toHaveBeenCalled();
	});
});

describe("Better Auth SSO membership provisioning", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.memberFindFirst.mockResolvedValue({
			role: "owner",
		});
		mocks.ssoProviderFindFirst.mockResolvedValue({
			providerId: "acme-sso",
			organizationId: "org-acme",
			domain: "acme.com,example.org",
			domainVerified: true,
		});
		mocks.insert.mockReturnValue({
			values: mocks.memberInsertValues,
		});
	});

	it("matches verified SSO provider domains before membership provisioning", () => {
		expect(
			canProvisionSsoMembershipForEmail("ada@engineering.acme.com", {
				organizationId: "org-acme",
				domain: "acme.com,example.org",
				domainVerified: true,
			}),
		).toBe(true);
		expect(
			canProvisionSsoMembershipForEmail("ada@evil.com", {
				organizationId: "org-acme",
				domain: "acme.com,example.org",
				domainVerified: true,
			}),
		).toBe(false);
		expect(
			canProvisionSsoMembershipForEmail("ada@acme.com", {
				organizationId: "org-acme",
				domain: "acme.com",
				domainVerified: false,
			}),
		).toBe(false);
	});

	it("fails closed before Better Auth organization provisioning when explicit providerId email domain mismatches", async () => {
		await expect(
			mocks.ssoPluginOptions.organizationProvisioning.getRole({
				user: {
					id: "user-sso",
					email: "attacker@evil.com",
				},
				userInfo: {},
				provider: {
					providerId: "acme-sso",
					organizationId: "org-acme",
					domain: "acme.com",
					domainVerified: true,
				},
			}),
		).rejects.toThrow("SSO email domain is not allowed for this provider");
	});

	it("fails closed before Better Auth organization provisioning when provider domain is unverified", async () => {
		await expect(
			mocks.ssoPluginOptions.organizationProvisioning.getRole({
				user: {
					id: "user-sso",
					email: "ada@acme.com",
				},
				userInfo: {},
				provider: {
					providerId: "acme-sso",
					organizationId: "org-acme",
					domain: "acme.com",
					domainVerified: false,
				},
			}),
		).rejects.toThrow("SSO email domain is not allowed for this provider");
	});

	it("allows Better Auth organization provisioning only after explicit providerId email domain eligibility passes", async () => {
		await expect(
			mocks.ssoPluginOptions.organizationProvisioning.getRole({
				user: {
					id: "user-sso",
					email: "ada@engineering.acme.com",
				},
				userInfo: {},
				provider: {
					providerId: "acme-sso",
					organizationId: "org-acme",
					domain: "acme.com",
					domainVerified: true,
				},
			}),
		).resolves.toBe("member");
	});

	it("assigns the organization default role through Better Auth provisioning", async () => {
		mocks.organizationFindFirst.mockResolvedValueOnce({ defaultRole: "admin" });

		await expect(
			mocks.ssoPluginOptions.organizationProvisioning.getRole({
				user: {
					id: "user-sso",
					email: "ada@acme.com",
				},
				userInfo: {},
				provider: {
					providerId: "acme-sso",
					organizationId: "org-acme",
					domain: "acme.com",
					domainVerified: true,
				},
			}),
		).resolves.toBe("admin");
	});

	it("does not insert a second membership when the SSO user already belongs to the organization", async () => {
		mocks.memberFindFirst
			.mockResolvedValueOnce({ role: "owner" })
			.mockResolvedValueOnce({ id: "member-1" });

		await expect(
			mocks.authOptions.databaseHooks.user.create.after(
				{
					id: "user-sso",
					email: "ada@acme.com",
				},
				{
					path: "/sso/callback/acme-sso",
					params: {
						providerId: "acme-sso",
					},
				},
			),
		).resolves.toBeUndefined();

		expect(mocks.insert).not.toHaveBeenCalled();
	});

	it("fails closed before inserting SSO membership when email domain mismatches provider domains", async () => {
		await expect(
			mocks.authOptions.databaseHooks.user.create.after(
				{
					id: "user-sso",
					email: "attacker@evil.com",
				},
				{
					path: "/sso/callback/acme-sso",
					params: {
						providerId: "acme-sso",
					},
				},
			),
		).rejects.toThrow("SSO email domain is not allowed for this provider");

		expect(mocks.ssoProviderFindFirst).toHaveBeenCalledTimes(1);
		expect(mocks.insert).not.toHaveBeenCalled();
	});

	it("provisions SSO membership only after the local email domain check passes", async () => {
		mocks.memberFindFirst
			.mockResolvedValueOnce({ role: "owner" })
			.mockResolvedValueOnce(undefined);

		await expect(
			mocks.authOptions.databaseHooks.user.create.after(
				{
					id: "user-sso",
					email: "ada@engineering.acme.com",
				},
				{
					path: "/sso/callback/acme-sso",
					params: {
						providerId: "acme-sso",
					},
				},
			),
		).resolves.toBeUndefined();

		expect(mocks.memberInsertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-sso",
				organizationId: "org-acme",
				role: "member",
				isDefault: true,
			}),
		);
	});
});

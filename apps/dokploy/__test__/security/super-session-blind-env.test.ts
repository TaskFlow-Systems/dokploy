import {
	applications,
	environments,
	projects,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/db", async () => {
	const schema = await import("@dokploy/server/db/schema");
	const { createFakeDrizzleDb } = await import("../helpers/fake-drizzle-db");
	const fake = createFakeDrizzleDb({
		superPassword: schema.superPassword,
		superSession: schema.superSession,
		account: schema.account,
		applications: schema.applications,
		project: schema.projects,
		environment: schema.environments,
		webServerSettings: schema.webServerSettings,
	});
	return { db: fake.db, fake };
});

vi.mock("@dokploy/server/services/permission", () => ({
	checkEnvironmentAccess: vi.fn(),
	checkPermission: vi.fn(),
	checkProjectAccess: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	findMemberByUserId: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

// API key responses are scrubbed of the secrets the panel stores, which are
// read from tables this suite's fake database does not have.
vi.mock("@dokploy/server/services/known-secrets", () => ({
	getKnownSecretMatcher: async () => ({ size: 0, pattern: null, literals: [] }),
	resetKnownSecretMatcherCache: () => {},
}));

const { fake } = (await import("@dokploy/server/db")) as unknown as {
	fake: ReturnType<
		typeof import("../helpers/fake-drizzle-db")["createFakeDrizzleDb"]
	>;
};
const service = await import("@dokploy/server/services/super-password");
const { envRouter } = await import("@/server/api/routers/env");
const { createTRPCRouter } = await import("@/server/api/trpc");

const router = createTRPCRouter({ env: envRouter });

const createCaller = (authMethod: "api-key" | "session") =>
	router.createCaller({
		db: {},
		req: {},
		res: {},
		session: {
			id: "session-1",
			userId: "user-1",
			activeOrganizationId: "org-1",
			authMethod,
		},
		user: { id: "user-1", role: "owner", email: "owner@example.test" },
	} as never).env;

const target = { scope: "application", id: "app-1" } as const;

const storedEnv = () => fake.rows(applications)[0]?.env;

describe("blind env procedures and the super session", () => {
	beforeEach(() => {
		fake.reset();
		fake.seed(projects, {
			projectId: "project-1",
			name: "Project One",
			organizationId: "org-1",
		});
		fake.seed(environments, {
			environmentId: "environment-1",
			name: "production",
			projectId: "project-1",
		});
		fake.seed(applications, {
			applicationId: "app-1",
			name: "App One",
			appName: "app-one",
			environmentId: "environment-1",
			env: "SERVICE_URL=https://app.example.test\n",
		});
	});

	it("keeps API key writes working while no super password is set", async () => {
		const result = await createCaller("api-key").applyChanges({
			...target,
			set: { ADDED_NAME: "1" },
		});

		expect(result.changed).toBe(true);
		expect(storedEnv()).toContain("ADDED_NAME=1");
	});

	it("rejects API key writes while the super session is closed but still lists keys", async () => {
		await service.setSuperPassword({
			userId: "user-1",
			password: "super-password-1",
		});

		const error = await createCaller("api-key")
			.applyChanges({ ...target, generate: { SERVICE_TOKEN: {} } })
			.catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(TRPCError);
		expect((error as TRPCError).code).toBe("FORBIDDEN");
		expect((error as TRPCError).message).toBe(
			service.SUPER_SESSION_MESSAGES["api-key-write-locked"],
		);
		expect(storedEnv()).toBe("SERVICE_URL=https://app.example.test\n");

		const keys = await createCaller("api-key").keys(target);
		expect(keys.variables).toEqual([
			{ name: "SERVICE_URL", secret: false, empty: false },
		]);
	});

	it("rejects API key dry runs while the super session is closed", async () => {
		await service.setSuperPassword({
			userId: "user-1",
			password: "super-password-1",
		});

		await expect(
			createCaller("api-key").applyChanges({
				...target,
				set: { SERVICE_URL: "https://guess.example.test" },
				dryRun: true,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("accepts API key writes while the super session is open", async () => {
		await service.setSuperPassword({
			userId: "user-1",
			password: "super-password-1",
		});
		await service.openSuperSession({
			userId: "user-1",
			sessionId: "session-1",
		});

		const result = await createCaller("api-key").applyChanges({
			...target,
			set: { ADDED_NAME: "1" },
		});

		expect(result.changed).toBe(true);
		expect(storedEnv()).toContain("ADDED_NAME=1");
	});

	it("lets a browser session write without an open super session", async () => {
		await service.setSuperPassword({
			userId: "user-1",
			password: "super-password-1",
		});

		const result = await createCaller("session").applyChanges({
			...target,
			set: { ADDED_NAME: "1" },
		});

		expect(result.changed).toBe(true);
	});
});

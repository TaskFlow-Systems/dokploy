import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	audit: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	findApplicationById: vi.fn(),
	upsertApplicationEnvironment: vi.fn(),
	validateRequest: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findApplicationById: mocks.findApplicationById,
	upsertApplicationEnvironment: mocks.upsertApplicationEnvironment,
	validateRequest: mocks.validateRequest,
}));

vi.mock("@dokploy/server/db", async () => {
	const schema = await import("@dokploy/server/db/schema");
	const { createFakeDrizzleDb } = await import("../helpers/fake-drizzle-db");
	const fake = createFakeDrizzleDb({
		superPassword: schema.superPassword,
		superSession: schema.superSession,
		account: schema.account,
	});
	return { db: fake.db, fake };
});

vi.mock("@dokploy/server/services/permission", () => ({
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));
vi.mock("@/server/queues/queueSetup", () => ({ myQueue: { add: vi.fn() } }));
vi.mock("@/server/utils/deploy", () => ({ deploy: vi.fn() }));

const { fake } = (await import("@dokploy/server/db")) as unknown as {
	fake: ReturnType<
		typeof import("../helpers/fake-drizzle-db")["createFakeDrizzleDb"]
	>;
};
const service = await import("@dokploy/server/services/super-password");
const { handleApplicationEnvUpsert } = await import(
	"@/pages/api/application.env.upsert"
);

const createResponse = () => {
	const response = {
		statusCode: 0,
		body: undefined as unknown,
		setHeader: vi.fn(),
		status(code: number) {
			response.statusCode = code;
			return response;
		},
		json(body: unknown) {
			response.body = body;
			return response;
		},
	};
	return response;
};

const callUpsert = async () => {
	const response = createResponse();
	await handleApplicationEnvUpsert(
		{
			method: "POST",
			body: { applicationId: "app-1", variables: { API_URL: "https://x" } },
		} as never,
		response as never,
	);
	return response;
};

describe("application env upsert endpoint and the super session", () => {
	beforeEach(() => {
		fake.reset();
		vi.clearAllMocks();
		mocks.validateRequest.mockResolvedValue({
			user: { id: "user-1", role: "owner", email: "owner@example.test" },
			session: { activeOrganizationId: "org-1", authMethod: "api-key" },
		});
		mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
		mocks.upsertApplicationEnvironment.mockResolvedValue({
			changed: false,
			dryRun: false,
		});
	});

	it("keeps API key writes working while no super password is set", async () => {
		const response = await callUpsert();

		expect(response.statusCode).toBe(200);
		expect(mocks.upsertApplicationEnvironment).toHaveBeenCalled();
	});

	it("rejects API key writes while the super session is closed", async () => {
		await service.setSuperPassword({
			userId: "user-1",
			password: "super-password-1",
		});

		const response = await callUpsert();

		expect(response.statusCode).toBe(403);
		expect(response.body).toEqual({
			message: service.SUPER_SESSION_MESSAGES["api-key-write-locked"],
		});
		expect(mocks.upsertApplicationEnvironment).not.toHaveBeenCalled();
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

		const response = await callUpsert();

		expect(response.statusCode).toBe(200);
		expect(mocks.upsertApplicationEnvironment).toHaveBeenCalled();
	});
});

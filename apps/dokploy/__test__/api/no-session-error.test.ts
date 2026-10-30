import { EventEmitter } from "node:events";
import { createOpenApiNextHandler } from "@dokploy/trpc-openapi";
import { TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
	validateRequest: vi.fn(),
	hasValidLicense: vi.fn(),
}));

vi.mock("@dokploy/server/lib/auth", async (importOriginal) => ({
	...(await importOriginal<object>()),
	validateRequest: mocks.validateRequest,
}));

vi.mock(
	"@dokploy/server/services/proprietary/license-key",
	async (original) => ({
		...(await original<object>()),
		hasValidLicense: mocks.hasValidLicense,
	}),
);

vi.mock("@dokploy/server/services/known-secrets", () => ({
	getKnownSecretMatcher: async () => null,
	resetKnownSecretMatcherCache: () => {},
}));

const {
	adminProcedure,
	cliProcedure,
	createTRPCContext,
	createTRPCRouter,
	enterpriseOwnerProcedure,
	enterpriseProcedure,
	ownerProcedure,
	protectedProcedure,
	publicProcedure,
	withPermission,
} = await import("@/server/api/trpc");

const openapi = (path: `/${string}`) => ({
	openapi: { method: "GET" as const, path },
});
const result = z.object({ ok: z.boolean() });

const query = (procedure: typeof publicProcedure, path: `/${string}`) =>
	procedure
		.meta(openapi(path))
		.input(z.object({}))
		.output(result)
		.query(() => ({ ok: true }));

const router = createTRPCRouter({
	open: query(publicProcedure, "/open"),
	signedIn: query(protectedProcedure, "/signed-in"),
	cli: query(cliProcedure, "/cli"),
	admin: query(adminProcedure, "/admin"),
	owner: query(ownerProcedure, "/owner"),
	enterprise: query(enterpriseProcedure, "/enterprise"),
	enterpriseOwner: query(enterpriseOwnerProcedure, "/enterprise-owner"),
	otherOrganization: protectedProcedure
		.meta(openapi("/other-organization"))
		.input(z.object({}))
		.output(result)
		.query(() => {
			throw new TRPCError({ code: "UNAUTHORIZED" });
		}),
	permitted: withPermission("project", "create")
		.meta(openapi("/permitted"))
		.input(z.object({}))
		.output(result)
		.query(() => ({ ok: true })),
});

type Role = "owner" | "admin" | "member";

const signedInAs = (role: Role) => ({
	session: {
		id: "session-1",
		userId: "user-1",
		activeOrganizationId: "org-1",
		authMethod: "session",
	},
	user: {
		id: "user-1",
		email: "user-1@example.test",
		role,
		ownerId: "user-1",
	},
});

const noSession = { session: null, user: null };

const callHttp = async (path: keyof typeof router, state: object) => {
	mocks.validateRequest.mockResolvedValue(state);
	const response = await fetchRequestHandler({
		endpoint: "/api/trpc",
		req: new Request(
			`http://localhost/api/trpc/${String(path)}?input=${encodeURIComponent(JSON.stringify(superjson.serialize({})))}`,
		),
		router,
		createContext: () =>
			createTRPCContext({ req: { headers: {} }, res: {} } as never),
	});
	const body = (await response.json()) as { error?: unknown; result?: unknown };
	return {
		status: response.status,
		error: body.error
			? (superjson.deserialize(body.error as never) as {
					message: string;
					code: number;
					data: Record<string, unknown>;
				})
			: null,
	};
};

const callRest = async (path: string, state: object) => {
	mocks.validateRequest.mockResolvedValue(state);
	const request = Object.assign(new EventEmitter(), {
		method: "GET",
		url: `/api${path}`,
		headers: { host: "localhost" },
		query: { trpc: [path.slice(1)] },
		socket: {},
	});
	const response = Object.assign(new EventEmitter(), {
		statusCode: 0,
		body: undefined as unknown,
		setHeader: () => response,
		end: (body?: string) => {
			response.body = body ? JSON.parse(body) : undefined;
		},
	});
	await createOpenApiNextHandler({
		router,
		createContext: () =>
			createTRPCContext({ req: { headers: {} }, res: {} } as never),
	})(request as never, response as never);
	return {
		status: response.statusCode,
		body: response.body as Record<string, unknown> & {
			data?: Record<string, unknown>;
		},
	};
};

const comparable = ({ body }: { body: { data?: Record<string, unknown> } }) => {
	const {
		stack: _stack,
		path: _path,
		noSession: _mark,
		...data
	} = body.data ?? {};
	return { ...body, data };
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.hasValidLicense.mockResolvedValue(true);
});

describe("a request without a session", () => {
	it.each([
		"signedIn",
		"cli",
		"admin",
		"owner",
		"enterprise",
		"enterpriseOwner",
		"permitted",
	] as const)("is answered 401 and marked on %s", async (path) => {
		const { status, error } = await callHttp(path, noSession);

		expect(status).toBe(401);
		expect(error?.message).toBe("UNAUTHORIZED");
		expect(error?.data).toMatchObject({
			code: "UNAUTHORIZED",
			httpStatus: 401,
			noSession: true,
		});
	});

	it("still reaches public procedures", async () => {
		const { status, error } = await callHttp("open", noSession);

		expect(status).toBe(200);
		expect(error).toBeNull();
	});
});

describe("a signed-in user who is not allowed", () => {
	it.each([
		["cli", "member"],
		["admin", "member"],
		["owner", "member"],
		["owner", "admin"],
		["enterprise", "member"],
		["enterpriseOwner", "member"],
		["enterpriseOwner", "admin"],
	] as const)(
		"gets an unmarked UNAUTHORIZED from %s as %s",
		async (path, role) => {
			const { status, error } = await callHttp(path, signedInAs(role));

			expect(status).toBe(401);
			expect(error?.message).toBe("UNAUTHORIZED");
			expect(error?.data).toMatchObject({
				code: "UNAUTHORIZED",
				httpStatus: 401,
				noSession: false,
			});
		},
	);

	it("gets an unmarked UNAUTHORIZED for a resource of another organization", async () => {
		const { status, error } = await callHttp(
			"otherOrganization",
			signedInAs("owner"),
		);

		expect(status).toBe(401);
		expect(error?.data).toMatchObject({ noSession: false });
	});

	it("is not marked when the licence is missing", async () => {
		mocks.hasValidLicense.mockResolvedValue(false);
		const { status, error } = await callHttp("enterprise", signedInAs("owner"));

		expect(status).toBe(403);
		expect(error?.data).toMatchObject({ code: "FORBIDDEN", noSession: false });
	});

	it.each([
		["signedIn", "member"],
		["cli", "admin"],
		["admin", "owner"],
		["owner", "owner"],
		["enterprise", "admin"],
		["enterpriseOwner", "owner"],
	] as const)(
		"still reaches %s as %s when the role is enough",
		async (path, role) => {
			const { status, error } = await callHttp(path, signedInAs(role));

			expect(status).toBe(200);
			expect(error).toBeNull();
		},
	);
});

describe("answers over the REST adapter", () => {
	it("keep the status, message and body shape of an unmarked UNAUTHORIZED", async () => {
		const missingSession = await callRest("/signed-in", noSession);
		const wrongRole = await callRest("/owner", signedInAs("member"));

		expect(missingSession.status).toBe(401);
		expect(wrongRole.status).toBe(401);
		expect(missingSession.body).toMatchObject({
			message: "UNAUTHORIZED",
			code: "UNAUTHORIZED",
		});
		expect(comparable(missingSession)).toEqual(comparable(wrongRole));
		expect(missingSession.body.data?.noSession).toBe(true);
		expect(wrongRole.body.data?.noSession).toBe(false);
	});
});

import { EventEmitter } from "node:events";
import {
	applications,
	compose,
	environments,
	postgres,
	projects,
} from "@dokploy/server/db/schema";
import {
	getApplicationEnvRevision,
	getComposeEnvRevision,
	getEnvFieldRevision,
} from "@dokploy/server/utils/env-upsert";
import { createOpenApiNextHandler } from "@dokploy/trpc-openapi";
import { TRPCError } from "@trpc/server";
import { parse } from "dotenv";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	audit: vi.fn(),
	checkEnvironmentAccess: vi.fn(),
	checkPermission: vi.fn(),
	checkProjectAccess: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	findMemberByUserId: vi.fn(),
}));

vi.mock("@dokploy/server/db", async () => {
	const schema = await import("@dokploy/server/db/schema");
	const { createFakeDrizzleDb } = await import("../helpers/fake-drizzle-db");
	const fake = createFakeDrizzleDb({
		applications: schema.applications,
		compose: schema.compose,
		postgres: schema.postgres,
		mysql: schema.mysql,
		mariadb: schema.mariadb,
		mongo: schema.mongo,
		redis: schema.redis,
		libsql: schema.libsql,
		projects: schema.projects,
		environments: schema.environments,
		project: schema.projects,
		environment: schema.environments,
		webServerSettings: schema.webServerSettings,
	});
	return { db: fake.db, fake };
});

vi.mock("@dokploy/server/services/permission", () => ({
	checkEnvironmentAccess: mocks.checkEnvironmentAccess,
	checkPermission: mocks.checkPermission,
	checkProjectAccess: mocks.checkProjectAccess,
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
	findMemberByUserId: mocks.findMemberByUserId,
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

const { fake } = (await import("@dokploy/server/db")) as unknown as {
	fake: ReturnType<
		typeof import("../helpers/fake-drizzle-db")["createFakeDrizzleDb"]
	>;
};
const { envRouter } = await import("@/server/api/routers/env");
const { createTRPCRouter } = await import("@/server/api/trpc");

const SENTINEL = "sentinel-value-0001";
const OTHER_SENTINEL = "sentinel-value-0002";

const router = createTRPCRouter({ env: envRouter });

const createContext = (role: "owner" | "member" = "owner") =>
	({
		db: {},
		req: {},
		res: {},
		session: { userId: "user-1", activeOrganizationId: "org-1" },
		user: { id: "user-1", role, email: "user-1@example.test" },
	}) as never;

const createCaller = (role: "owner" | "member" = "owner") =>
	router.createCaller(createContext(role)).env;

const callRest = async (
	method: "GET" | "POST",
	path: string,
	payload: Record<string, unknown>,
) => {
	const request = Object.assign(new EventEmitter(), {
		method,
		url: `/api/${path}`,
		headers: { host: "localhost", "content-type": "application/json" },
		query: { trpc: [path], ...(method === "GET" ? payload : {}) },
		socket: {},
		...(method === "POST" ? { body: payload } : {}),
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
		createContext: () => createContext(),
	})(request as never, response as never);

	return { status: response.statusCode, body: response.body };
};

const ctxMatcher = expect.objectContaining({
	session: expect.objectContaining({ activeOrganizationId: "org-1" }),
});

const storedEnv = (
	table: Parameters<typeof fake.rows>[0],
	field = "env",
	index = 0,
) => fake.rows(table)[index]?.[field] as string | null;

const seed = () => {
	fake.seed(projects, {
		projectId: "project-1",
		name: "Project One",
		organizationId: "org-1",
		env: `SHARED_URL=https://shared.example.test\nSHARED_TOKEN=${SENTINEL}\n`,
	});
	fake.seed(projects, {
		projectId: "project-2",
		name: "Foreign Project",
		organizationId: "org-2",
		env: `FOREIGN_TOKEN=${OTHER_SENTINEL}\n`,
	});
	fake.seed(environments, {
		environmentId: "environment-1",
		name: "production",
		projectId: "project-1",
		env: `STAGE_TOKEN=${SENTINEL}\n`,
	});
	fake.seed(environments, {
		environmentId: "environment-2",
		name: "foreign",
		projectId: "project-2",
		env: "",
	});
	fake.seed(applications, {
		applicationId: "app-1",
		name: "App One",
		appName: "app-one",
		environmentId: "environment-1",
		env: `# App settings\nSERVICE_URL=https://app.example.test\nSERVICE_TOKEN=${SENTINEL}\nEMPTY_FLAG=\nSERVICE_URL=https://override.example.test\n`,
		buildArgs: "BUILD_MODE=release\n",
		buildSecrets: null,
	});
	fake.seed(applications, {
		applicationId: "app-2",
		name: "Foreign App",
		appName: "foreign-app",
		environmentId: "environment-2",
		env: `FOREIGN_TOKEN=${OTHER_SENTINEL}\n`,
	});
	fake.seed(compose, {
		composeId: "compose-1",
		name: "Compose One",
		appName: "compose-one",
		environmentId: "environment-1",
		env: null,
	});
	fake.seed(postgres, {
		postgresId: "postgres-1",
		name: "Postgres One",
		appName: "postgres-one",
		environmentId: "environment-1",
		databaseName: "app",
		databaseUser: "app",
		databasePassword: "fixture-password",
		dockerImage: "postgres:18",
		env: `POSTGRES_INITDB_ARGS=--data-checksums\nREPLICATION_PASSWORD=${OTHER_SENTINEL}\n`,
	});
};

const expectTrpcError = async (promise: Promise<unknown>, code: string) => {
	const error = await promise.then(
		() => null,
		(reason: unknown) => reason,
	);
	expect(error).toBeInstanceOf(TRPCError);
	expect((error as TRPCError).code).toBe(code);
	return error as TRPCError;
};

beforeEach(() => {
	fake.reset();
	vi.resetAllMocks();
	mocks.findMemberByUserId.mockResolvedValue({
		accessedProjects: ["project-1"],
		accessedEnvironments: ["environment-1"],
	});
	seed();
});

describe("env.keys", () => {
	it("lists names with flags and a revision but never a value", async () => {
		const result = await createCaller().keys({
			scope: "application",
			id: "app-1",
		});

		expect(result).toEqual({
			scope: "application",
			id: "app-1",
			field: "env",
			revision: getApplicationEnvRevision("app-1", storedEnv(applications)),
			variables: [
				{ name: "SERVICE_URL", secret: false, empty: false },
				{ name: "SERVICE_TOKEN", secret: true, empty: false },
				{ name: "EMPTY_FLAG", secret: false, empty: true },
			],
		});
		expect(JSON.stringify(result)).not.toContain(SENTINEL);
		expect(JSON.stringify(result)).not.toContain("example.test");
		expect(
			mocks.checkServicePermissionAndAccess,
		).toHaveBeenCalledExactlyOnceWith(ctxMatcher, "app-1", {
			envVars: ["read"],
		});
		expect(fake.locks).toEqual([]);
	});

	it("reads build args and build secrets of an application", async () => {
		const buildArgs = await createCaller().keys({
			scope: "application",
			id: "app-1",
			field: "buildArgs",
		});
		const buildSecrets = await createCaller().keys({
			scope: "application",
			id: "app-1",
			field: "buildSecrets",
		});

		expect(buildArgs.variables).toEqual([
			{ name: "BUILD_MODE", secret: false, empty: false },
		]);
		expect(buildArgs.revision).toBe(
			getEnvFieldRevision(
				"application",
				"app-1",
				"buildArgs",
				"BUILD_MODE=release\n",
			),
		);
		expect(buildSecrets.variables).toEqual([]);
		expect(buildSecrets.revision).toBe(
			getEnvFieldRevision("application", "app-1", "buildSecrets", ""),
		);
	});

	it("rejects build fields for every other scope", async () => {
		for (const scope of ["compose", "postgres", "project"] as const) {
			await expectTrpcError(
				createCaller().keys({ scope, id: "any-id", field: "buildArgs" }),
				"BAD_REQUEST",
			);
		}
		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
	});

	it("checks project access and the project variable permission", async () => {
		const result = await createCaller("member").keys({
			scope: "project",
			id: "project-1",
		});

		expect(result.variables.map(({ name }) => name)).toEqual([
			"SHARED_URL",
			"SHARED_TOKEN",
		]);
		expect(result.revision).toBe(
			getEnvFieldRevision("project", "project-1", "env", storedEnv(projects)),
		);
		expect(mocks.findMemberByUserId).toHaveBeenCalledWith("user-1", "org-1");
		expect(mocks.checkPermission).toHaveBeenCalledExactlyOnceWith(ctxMatcher, {
			projectEnvVars: ["read"],
		});
		expect(mocks.checkProjectAccess).not.toHaveBeenCalled();
	});

	it("rejects a member who has no access to the project", async () => {
		mocks.findMemberByUserId.mockResolvedValue({ accessedProjects: [] });

		await expectTrpcError(
			createCaller("member").keys({ scope: "project", id: "project-1" }),
			"UNAUTHORIZED",
		);
		expect(mocks.checkPermission).not.toHaveBeenCalled();
	});

	it("checks environment access and the environment variable permission", async () => {
		const result = await createCaller().keys({
			scope: "environment",
			id: "environment-1",
		});

		expect(result.variables).toEqual([
			{ name: "STAGE_TOKEN", secret: true, empty: false },
		]);
		expect(mocks.checkEnvironmentAccess).toHaveBeenCalledExactlyOnceWith(
			ctxMatcher,
			"environment-1",
			"read",
		);
		expect(mocks.checkPermission).toHaveBeenCalledExactlyOnceWith(ctxMatcher, {
			environmentEnvVars: ["read"],
		});
	});

	it("rejects a resource of another organization before any permission check", async () => {
		for (const input of [
			{ scope: "application", id: "app-2" },
			{ scope: "project", id: "project-2" },
			{ scope: "environment", id: "environment-2" },
		] as const) {
			const error = await expectTrpcError(
				createCaller().keys(input),
				"UNAUTHORIZED",
			);
			expect(error.message).not.toContain(OTHER_SENTINEL);
		}
		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
		expect(mocks.checkPermission).not.toHaveBeenCalled();
	});

	it("reports a missing resource and a scope that does not match the id", async () => {
		await expectTrpcError(
			createCaller().keys({ scope: "application", id: "missing" }),
			"NOT_FOUND",
		);
		await expectTrpcError(
			createCaller().keys({ scope: "postgres", id: "app-1" }),
			"NOT_FOUND",
		);
	});

	it("stops when the permission check fails", async () => {
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new TRPCError({ code: "UNAUTHORIZED", message: "Permission denied" }),
		);

		await expectTrpcError(
			createCaller().keys({ scope: "application", id: "app-1" }),
			"UNAUTHORIZED",
		);
	});

	it("refuses to list a field that could not be decrypted", async () => {
		fake.rows(postgres)[0]!.env = "enc:v1:bm90LXJlYWxseS1lbmNyeXB0ZWQ=";

		await expectTrpcError(
			createCaller().keys({ scope: "postgres", id: "postgres-1" }),
			"PRECONDITION_FAILED",
		);
	});
});

describe("env.applyChanges", () => {
	it("sets literal values and reports created, updated and unchanged", async () => {
		const before = storedEnv(applications);
		const result = await createCaller().applyChanges({
			scope: "application",
			id: "app-1",
			set: {
				SERVICE_URL: "https://next.example.test",
				SERVICE_TOKEN: SENTINEL,
				NEW_TOKEN: OTHER_SENTINEL,
			},
		});

		const after = storedEnv(applications);
		expect(after).toBe(
			`# App settings\nSERVICE_URL=https://app.example.test\nSERVICE_TOKEN=${SENTINEL}\nEMPTY_FLAG=\nSERVICE_URL=https://next.example.test\nNEW_TOKEN=${OTHER_SENTINEL}\n`,
		);
		expect(result).toEqual({
			scope: "application",
			id: "app-1",
			field: "env",
			changed: true,
			revision: getApplicationEnvRevision("app-1", after),
			dryRun: false,
			variables: [
				{
					name: "SERVICE_URL",
					action: "updated",
					source: "set",
					secret: false,
				},
				{
					name: "SERVICE_TOKEN",
					action: "unchanged",
					source: "set",
					secret: true,
				},
				{ name: "NEW_TOKEN", action: "created", source: "set", secret: true },
			],
		});
		expect(result.revision).not.toBe(
			getApplicationEnvRevision("app-1", before),
		);
		expect(JSON.stringify(result)).not.toContain(SENTINEL);
		expect(JSON.stringify(result)).not.toContain("example.test");
		expect(
			mocks.checkServicePermissionAndAccess,
		).toHaveBeenCalledExactlyOnceWith(ctxMatcher, "app-1", {
			envVars: ["write"],
		});
		expect(fake.locks).toEqual([{ table: "application", strength: "update" }]);
	});

	it("audits a change once without any variable data", async () => {
		await createCaller().applyChanges({
			scope: "application",
			id: "app-1",
			set: { NEW_TOKEN: OTHER_SENTINEL },
		});

		expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(ctxMatcher, {
			action: "update",
			resourceType: "application",
			resourceId: "app-1",
			resourceName: "app-one",
		});
	});

	it("picks the audit resource type and name per scope", async () => {
		const cases = [
			{
				input: { scope: "compose", id: "compose-1" },
				event: { resourceType: "compose", resourceName: "Compose One" },
			},
			{
				input: { scope: "postgres", id: "postgres-1" },
				event: { resourceType: "service", resourceName: "postgres-one" },
			},
			{
				input: { scope: "project", id: "project-1" },
				event: { resourceType: "project", resourceName: "Project One" },
			},
			{
				input: { scope: "environment", id: "environment-1" },
				event: { resourceType: "environment", resourceName: "production" },
			},
		] as const;

		for (const { input, event } of cases) {
			mocks.audit.mockClear();
			await createCaller().applyChanges({ ...input, set: { ADDED_NAME: "1" } });

			expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(ctxMatcher, {
				action: "update",
				resourceId: input.id,
				...event,
			});
		}
	});

	it("does not write or audit when nothing changes", async () => {
		const before = storedEnv(applications);
		const result = await createCaller().applyChanges({
			scope: "application",
			id: "app-1",
			set: { SERVICE_TOKEN: SENTINEL },
			remove: ["ABSENT_NAME"],
		});

		expect(result.changed).toBe(false);
		expect(result.revision).toBe(getApplicationEnvRevision("app-1", before));
		expect(result.variables.map(({ action }) => action)).toEqual([
			"unchanged",
			"missing",
		]);
		expect(storedEnv(applications)).toBe(before);
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("removes variables and reports names that do not exist", async () => {
		const result = await createCaller().applyChanges({
			scope: "application",
			id: "app-1",
			remove: ["SERVICE_URL", "ABSENT_NAME", "SERVICE_URL"],
		});

		expect(storedEnv(applications)).toBe(
			`# App settings\nSERVICE_TOKEN=${SENTINEL}\nEMPTY_FLAG=\n`,
		);
		expect(result.variables).toEqual([
			{
				name: "SERVICE_URL",
				action: "removed",
				source: "remove",
				secret: false,
			},
			{
				name: "ABSENT_NAME",
				action: "missing",
				source: "remove",
				secret: false,
			},
		]);
	});

	it("updates and removes a multi-line value as one variable", async () => {
		fake.rows(postgres)[0]!.env =
			`BEFORE=1\nPRIVATE_BLOCK="first line\nINNER_NAME=${SENTINEL}\nlast line"\nAFTER=2\n`;

		await createCaller().applyChanges({
			scope: "postgres",
			id: "postgres-1",
			set: { PRIVATE_BLOCK: "one line" },
		});
		expect(storedEnv(postgres)).toBe(
			'BEFORE=1\nPRIVATE_BLOCK="one line"\nAFTER=2\n',
		);

		fake.rows(postgres)[0]!.env =
			`BEFORE=1\nPRIVATE_BLOCK='first line\nINNER_NAME=${SENTINEL}\nlast line'\nAFTER=2\n`;
		await createCaller().applyChanges({
			scope: "postgres",
			id: "postgres-1",
			remove: ["PRIVATE_BLOCK"],
		});
		expect(storedEnv(postgres)).toBe("BEFORE=1\nAFTER=2\n");
	});

	it("generates values server-side in the requested length and format", async () => {
		const formats = {
			DEFAULT_TOKEN: { options: {}, pattern: /^[A-Za-z0-9_-]{48}$/ },
			URL_TOKEN: {
				options: { length: 64, format: "base64url" },
				pattern: /^[A-Za-z0-9_-]{64}$/,
			},
			HEX_TOKEN: {
				options: { length: 33, format: "hex" },
				pattern: /^[0-9a-f]{33}$/,
			},
			PLAIN_TOKEN: {
				options: { length: 128, format: "alphanumeric" },
				pattern: /^[A-Za-z0-9]{128}$/,
			},
			SHORT_TOKEN: {
				options: { length: 16, format: "alphanumeric" },
				pattern: /^[A-Za-z0-9]{16}$/,
			},
		} as const;
		const generate = Object.fromEntries(
			Object.entries(formats).map(([name, { options }]) => [name, options]),
		);

		const first = await createCaller().applyChanges({
			scope: "compose",
			id: "compose-1",
			generate,
		});
		const firstValues = parse(storedEnv(compose) ?? "");
		const second = await createCaller().applyChanges({
			scope: "compose",
			id: "compose-1",
			generate,
		});
		const secondValues = parse(storedEnv(compose) ?? "");

		for (const [name, { pattern }] of Object.entries(formats)) {
			expect(firstValues[name]).toMatch(pattern);
			expect(secondValues[name]).toMatch(pattern);
			expect(secondValues[name]).not.toBe(firstValues[name]);
			expect(JSON.stringify(first)).not.toContain(firstValues[name]);
			expect(JSON.stringify(second)).not.toContain(secondValues[name]);
		}
		expect(first.variables.map(({ action }) => action)).toEqual(
			Object.keys(formats).map(() => "created"),
		);
		expect(second.variables.map(({ action }) => action)).toEqual(
			Object.keys(formats).map(() => "updated"),
		);
		expect(first.variables.every(({ source }) => source === "generate")).toBe(
			true,
		);
		expect(first.revision).toBe(
			getComposeEnvRevision(
				"compose-1",
				Object.entries(firstValues)
					.map(([name, value]) => `${name}=${value}`)
					.join("\n"),
			),
		);
		expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(
			secondValues.DEFAULT_TOKEN,
		);
	});

	it("generates nothing on a dry run and reports the would-be actions", async () => {
		const before = storedEnv(applications);
		const result = await createCaller().applyChanges({
			scope: "application",
			id: "app-1",
			generate: { SERVICE_TOKEN: {}, NEW_TOKEN: { format: "hex" } },
			set: { SERVICE_URL: "https://next.example.test" },
			remove: ["EMPTY_FLAG"],
			dryRun: true,
		});

		expect(result).toEqual({
			scope: "application",
			id: "app-1",
			field: "env",
			changed: true,
			revision: getApplicationEnvRevision("app-1", before),
			dryRun: true,
			variables: [
				{
					name: "SERVICE_URL",
					action: "updated",
					source: "set",
					secret: false,
				},
				{
					name: "SERVICE_TOKEN",
					action: "updated",
					source: "generate",
					secret: true,
				},
				{
					name: "NEW_TOKEN",
					action: "created",
					source: "generate",
					secret: true,
				},
				{
					name: "EMPTY_FLAG",
					action: "removed",
					source: "remove",
					secret: false,
				},
			],
		});
		expect(storedEnv(applications)).toBe(before);
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("rejects generate options outside the allowed range", async () => {
		for (const options of [
			{ length: 15 },
			{ length: 129 },
			{ length: 32.5 },
			{ format: "base64" },
		]) {
			await expectTrpcError(
				createCaller().applyChanges({
					scope: "application",
					id: "app-1",
					generate: { NEW_TOKEN: options as never },
				}),
				"BAD_REQUEST",
			);
		}
	});

	it("copies a variable from another scope without returning it", async () => {
		const result = await createCaller().applyChanges({
			scope: "application",
			id: "app-1",
			copy: {
				UPSTREAM_TOKEN: {
					fromScope: "project",
					fromId: "project-1",
					fromName: "SHARED_TOKEN",
				},
				REPLICA_PASSWORD: {
					fromScope: "postgres",
					fromId: "postgres-1",
					fromName: "REPLICATION_PASSWORD",
				},
				SERVICE_TOKEN: {
					fromScope: "environment",
					fromId: "environment-1",
					fromName: "STAGE_TOKEN",
				},
			},
		});

		const values = parse(storedEnv(applications) ?? "");
		expect(values.UPSTREAM_TOKEN).toBe(SENTINEL);
		expect(values.REPLICA_PASSWORD).toBe(OTHER_SENTINEL);
		expect(result.variables).toEqual([
			{
				name: "UPSTREAM_TOKEN",
				action: "created",
				source: "copy",
				secret: true,
			},
			{
				name: "REPLICA_PASSWORD",
				action: "created",
				source: "copy",
				secret: true,
			},
			{
				name: "SERVICE_TOKEN",
				action: "unchanged",
				source: "copy",
				secret: true,
			},
		]);
		expect(JSON.stringify(result)).not.toContain(SENTINEL);
		expect(JSON.stringify(result)).not.toContain(OTHER_SENTINEL);
		expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(SENTINEL);

		expect(mocks.checkServicePermissionAndAccess.mock.calls).toEqual([
			[ctxMatcher, "app-1", { envVars: ["write"] }],
			[ctxMatcher, "postgres-1", { envVars: ["read"] }],
		]);
		expect(mocks.checkPermission.mock.calls).toEqual([
			[ctxMatcher, { projectEnvVars: ["read"] }],
			[ctxMatcher, { environmentEnvVars: ["read"] }],
		]);
		expect(mocks.checkEnvironmentAccess).toHaveBeenCalledExactlyOnceWith(
			ctxMatcher,
			"environment-1",
			"read",
		);
		expect(mocks.checkProjectAccess).not.toHaveBeenCalled();
		expect(fake.locks).toEqual([{ table: "application", strength: "update" }]);
	});

	it("renames a variable by copying and removing within one field", async () => {
		const result = await createCaller().applyChanges({
			scope: "application",
			id: "app-1",
			copy: {
				RENAMED_TOKEN: {
					fromScope: "application",
					fromId: "app-1",
					fromName: "SERVICE_TOKEN",
				},
			},
			remove: ["SERVICE_TOKEN"],
		});

		expect(parse(storedEnv(applications) ?? "")).toEqual({
			SERVICE_URL: "https://override.example.test",
			EMPTY_FLAG: "",
			RENAMED_TOKEN: SENTINEL,
		});
		expect(result.variables).toEqual([
			{
				name: "RENAMED_TOKEN",
				action: "created",
				source: "copy",
				secret: true,
			},
			{
				name: "SERVICE_TOKEN",
				action: "removed",
				source: "remove",
				secret: true,
			},
		]);
		expect(mocks.checkServicePermissionAndAccess.mock.calls).toEqual([
			[ctxMatcher, "app-1", { envVars: ["write"] }],
			[ctxMatcher, "app-1", { envVars: ["read"] }],
		]);
	});

	it("copies between fields of one application", async () => {
		await createCaller().applyChanges({
			scope: "application",
			id: "app-1",
			field: "buildSecrets",
			copy: {
				BUILD_TOKEN: {
					fromScope: "application",
					fromId: "app-1",
					fromName: "SERVICE_TOKEN",
				},
				BUILD_MODE: {
					fromScope: "application",
					fromId: "app-1",
					fromField: "buildArgs",
					fromName: "BUILD_MODE",
				},
			},
		});

		expect(storedEnv(applications, "buildSecrets")).toBe(
			`BUILD_TOKEN=${SENTINEL}\nBUILD_MODE=release`,
		);
		expect(storedEnv(applications, "buildArgs")).toBe("BUILD_MODE=release\n");
	});

	it("rejects a copy whose source variable does not exist, naming only names", async () => {
		const before = storedEnv(applications);
		const error = await expectTrpcError(
			createCaller().applyChanges({
				scope: "application",
				id: "app-1",
				set: { NEW_NAME: OTHER_SENTINEL },
				copy: {
					UPSTREAM_TOKEN: {
						fromScope: "project",
						fromId: "project-1",
						fromName: "ABSENT_NAME",
					},
				},
			}),
			"BAD_REQUEST",
		);

		expect(error.message).toBe(
			"Variable ABSENT_NAME does not exist in env of project project-1",
		);
		expect(storedEnv(applications)).toBe(before);
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("requires read access to the organization of a copy source", async () => {
		const before = storedEnv(applications);
		const copyFrom = (fromScope: "application" | "project", fromId: string) =>
			createCaller().applyChanges({
				scope: "application",
				id: "app-1",
				copy: {
					STOLEN_TOKEN: { fromScope, fromId, fromName: "FOREIGN_TOKEN" },
				},
			});

		await expectTrpcError(copyFrom("application", "app-2"), "UNAUTHORIZED");
		await expectTrpcError(copyFrom("project", "project-2"), "UNAUTHORIZED");
		await expectTrpcError(copyFrom("project", "missing"), "NOT_FOUND");
		expect(storedEnv(applications)).toBe(before);
		expect(fake.locks).toEqual([]);
	});

	it("does not copy when the read permission on the source is denied", async () => {
		mocks.checkServicePermissionAndAccess.mockImplementation(
			async (_ctx, _id, permissions) => {
				if (permissions.envVars.includes("read")) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "Permission denied",
					});
				}
			},
		);
		const before = storedEnv(applications);

		await expectTrpcError(
			createCaller().applyChanges({
				scope: "application",
				id: "app-1",
				copy: {
					REPLICA_PASSWORD: {
						fromScope: "postgres",
						fromId: "postgres-1",
						fromName: "REPLICATION_PASSWORD",
					},
				},
			}),
			"UNAUTHORIZED",
		);
		expect(storedEnv(applications)).toBe(before);
	});

	it("rejects a name that appears in more than one operation list", async () => {
		const copy = {
			fromScope: "project",
			fromId: "project-1",
			fromName: "SHARED_TOKEN",
		} as const;
		const conflicts = [
			{ set: { SAME_NAME: "1" }, remove: ["SAME_NAME"] },
			{ set: { SAME_NAME: "1" }, generate: { SAME_NAME: {} } },
			{ set: { SAME_NAME: "1" }, copy: { SAME_NAME: copy } },
			{ generate: { SAME_NAME: {} }, copy: { SAME_NAME: copy } },
			{ generate: { SAME_NAME: {} }, remove: ["SAME_NAME"] },
			{ copy: { SAME_NAME: copy }, remove: ["SAME_NAME"] },
		];

		for (const operations of conflicts) {
			await expectTrpcError(
				createCaller().applyChanges({
					scope: "application",
					id: "app-1",
					...operations,
				}),
				"BAD_REQUEST",
			);
		}
		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
	});

	it("requires at least one operation and valid variable names", async () => {
		const invalid = [
			{},
			{ set: {}, remove: [], generate: {}, copy: {} },
			{ set: { "1INVALID": "1" } },
			{ remove: ["HAS-DASH"] },
			{ generate: { "HAS SPACE": {} } },
			{
				copy: {
					VALID_NAME: {
						fromScope: "project",
						fromId: "project-1",
						fromName: "has.dot",
					},
				},
			},
		];

		for (const operations of invalid) {
			await expectTrpcError(
				createCaller().applyChanges({
					scope: "application",
					id: "app-1",
					...(operations as object),
				}),
				"BAD_REQUEST",
			);
		}
	});

	it("rejects redacted placeholders instead of storing them", async () => {
		const before = storedEnv(applications);

		for (const placeholder of ["__DOKPLOY_REDACTED_SECRET__", "[REDACTED]"]) {
			const error = await expectTrpcError(
				createCaller().applyChanges({
					scope: "application",
					id: "app-1",
					set: { SERVICE_TOKEN: placeholder, SERVICE_URL: "https://x.test" },
				}),
				"BAD_REQUEST",
			);
			expect(error.message).toBe(
				"Environment variables contain redacted secret placeholders: SERVICE_TOKEN",
			);
		}
		expect(storedEnv(applications)).toBe(before);
		expect(fake.locks).toEqual([]);
	});

	it("rejects a stale expected revision and accepts the current one", async () => {
		const before = storedEnv(postgres);
		const current = getEnvFieldRevision(
			"postgres",
			"postgres-1",
			"env",
			before,
		);

		const error = await expectTrpcError(
			createCaller().applyChanges({
				scope: "postgres",
				id: "postgres-1",
				set: { ADDED_NAME: "1" },
				expectedRevision: getEnvFieldRevision(
					"postgres",
					"postgres-1",
					"env",
					"OLDER=1",
				),
			}),
			"CONFLICT",
		);
		expect(error.message).toBe("Environment revision does not match");
		expect(storedEnv(postgres)).toBe(before);

		const result = await createCaller().applyChanges({
			scope: "postgres",
			id: "postgres-1",
			set: { ADDED_NAME: "1" },
			expectedRevision: current,
		});
		expect(result.revision).toBe(
			getEnvFieldRevision("postgres", "postgres-1", "env", storedEnv(postgres)),
		);
		expect(result.revision).not.toBe(current);
	});

	it("shares revisions with the application and compose upsert endpoints", async () => {
		const application = await createCaller().applyChanges({
			scope: "application",
			id: "app-1",
			set: { ADDED_NAME: "1" },
			expectedRevision: getApplicationEnvRevision(
				"app-1",
				storedEnv(applications),
			),
		});
		const composeResult = await createCaller().applyChanges({
			scope: "compose",
			id: "compose-1",
			set: { ADDED_NAME: "1" },
			expectedRevision: getComposeEnvRevision("compose-1", null),
		});

		expect(application.revision).toBe(
			getApplicationEnvRevision("app-1", storedEnv(applications)),
		);
		expect(composeResult.revision).toBe(
			getComposeEnvRevision("compose-1", "ADDED_NAME=1"),
		);
		expect(storedEnv(compose)).toBe("ADDED_NAME=1");
	});

	it("edits build args and build secrets of an application only", async () => {
		const result = await createCaller().applyChanges({
			scope: "application",
			id: "app-1",
			field: "buildArgs",
			set: { BUILD_MODE: "debug", BUILD_TOKEN: SENTINEL },
		});

		expect(storedEnv(applications, "buildArgs")).toBe(
			`BUILD_MODE=debug\nBUILD_TOKEN=${SENTINEL}\n`,
		);
		expect(result.field).toBe("buildArgs");
		expect(result.revision).toBe(
			getEnvFieldRevision(
				"application",
				"app-1",
				"buildArgs",
				storedEnv(applications, "buildArgs"),
			),
		);
		expect(storedEnv(applications)).toContain("SERVICE_URL=");

		for (const scope of ["compose", "postgres", "environment"] as const) {
			await expectTrpcError(
				createCaller().applyChanges({
					scope,
					id: "any-id",
					field: "buildSecrets",
					set: { BUILD_TOKEN: "1" },
				}),
				"BAD_REQUEST",
			);
		}
		await expectTrpcError(
			createCaller().applyChanges({
				scope: "application",
				id: "app-1",
				copy: {
					BUILD_TOKEN: {
						fromScope: "project",
						fromId: "project-1",
						fromField: "buildArgs",
						fromName: "SHARED_TOKEN",
					},
				},
			}),
			"BAD_REQUEST",
		);
	});

	it("applies the project update checks and the project variable permission", async () => {
		await createCaller("member").applyChanges({
			scope: "project",
			id: "project-1",
			set: { SHARED_URL: "https://next.example.test" },
		});

		expect(parse(storedEnv(projects) ?? "").SHARED_URL).toBe(
			"https://next.example.test",
		);
		expect(mocks.checkProjectAccess).toHaveBeenCalledExactlyOnceWith(
			ctxMatcher,
			"update",
			"project-1",
		);
		expect(mocks.findMemberByUserId).toHaveBeenCalledWith("user-1", "org-1");
		expect(mocks.checkPermission).toHaveBeenCalledExactlyOnceWith(ctxMatcher, {
			projectEnvVars: ["write"],
		});
		expect(fake.locks).toEqual([{ table: "project", strength: "update" }]);
	});

	it("applies the environment update checks and the environment variable permission", async () => {
		await createCaller().applyChanges({
			scope: "environment",
			id: "environment-1",
			remove: ["STAGE_TOKEN"],
		});

		expect(storedEnv(environments)).toBe("");
		expect(mocks.checkEnvironmentAccess).toHaveBeenCalledExactlyOnceWith(
			ctxMatcher,
			"environment-1",
			"update",
		);
		expect(mocks.checkPermission).toHaveBeenCalledExactlyOnceWith(ctxMatcher, {
			environmentEnvVars: ["write"],
		});
	});

	it("does not write to another organization or without the write permission", async () => {
		await expectTrpcError(
			createCaller().applyChanges({
				scope: "application",
				id: "app-2",
				set: { ADDED_NAME: "1" },
			}),
			"UNAUTHORIZED",
		);
		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();

		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new TRPCError({ code: "UNAUTHORIZED", message: "Permission denied" }),
		);
		await expectTrpcError(
			createCaller().applyChanges({
				scope: "application",
				id: "app-1",
				set: { ADDED_NAME: "1" },
			}),
			"UNAUTHORIZED",
		);

		expect(storedEnv(applications, "env", 0)).not.toContain("ADDED_NAME");
		expect(storedEnv(applications, "env", 1)).not.toContain("ADDED_NAME");
		expect(fake.locks).toEqual([]);
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("reports a missing target", async () => {
		await expectTrpcError(
			createCaller().applyChanges({
				scope: "compose",
				id: "missing",
				set: { ADDED_NAME: "1" },
			}),
			"NOT_FOUND",
		);
	});

	it("refuses to edit a field that could not be decrypted", async () => {
		const ciphertext = "enc:v1:bm90LXJlYWxseS1lbmNyeXB0ZWQ=";
		fake.rows(postgres)[0]!.env = ciphertext;

		await expectTrpcError(
			createCaller().applyChanges({
				scope: "postgres",
				id: "postgres-1",
				set: { ADDED_NAME: "1" },
			}),
			"PRECONDITION_FAILED",
		);
		expect(storedEnv(postgres)).toBe(ciphertext);
	});

	it("refuses an edit that the stored text cannot take safely", async () => {
		fake.rows(postgres)[0]!.env = `BROKEN_QUOTE="${SENTINEL}`;

		const error = await expectTrpcError(
			createCaller().applyChanges({
				scope: "postgres",
				id: "postgres-1",
				set: { NEXT_NAME: " # note" },
			}),
			"BAD_REQUEST",
		);

		expect(error.message).toBe(
			"Environment variables cannot be edited safely: BROKEN_QUOTE, NEXT_NAME",
		);
		expect(storedEnv(postgres)).toBe(`BROKEN_QUOTE="${SENTINEL}`);
		expect(mocks.audit).not.toHaveBeenCalled();
	});
});

describe("env layout", () => {
	const appLayout = [
		{ type: "comment", ref: "c1", text: "App settings" },
		{ type: "hidden", ref: "h1", kind: "overridden", variable: "SERVICE_URL" },
		{ type: "variable", name: "SERVICE_TOKEN" },
		{ type: "variable", name: "EMPTY_FLAG" },
		{ type: "variable", name: "SERVICE_URL" },
	];
	const sectioned = [
		{ type: "comment", text: "=== Web ===" },
		{ type: "hidden", ref: "h1" },
		{ type: "variable", name: "SERVICE_URL" },
		{ type: "variable", name: "EMPTY_FLAG" },
		{ type: "blank" },
		{ type: "comment", text: "=== Auth ===" },
		{ type: "comment", ref: "c1", text: "Signs sessions" },
		{ type: "variable", name: "SERVICE_TOKEN" },
	] as const;
	const sectionedEnv = `# === Web ===\nSERVICE_URL=https://app.example.test\nSERVICE_URL=https://override.example.test\nEMPTY_FLAG=\n\n# === Auth ===\n# Signs sessions\nSERVICE_TOKEN=${SENTINEL}\n`;

	it("reads the layout with names, comments and a revision but never a value", async () => {
		const result = await createCaller().layout({
			scope: "application",
			id: "app-1",
		});

		expect(result).toEqual({
			scope: "application",
			id: "app-1",
			field: "env",
			revision: getApplicationEnvRevision("app-1", storedEnv(applications)),
			variables: [
				{ name: "SERVICE_URL", secret: false, empty: false },
				{ name: "SERVICE_TOKEN", secret: true, empty: false },
				{ name: "EMPTY_FLAG", secret: false, empty: true },
			],
			layout: appLayout,
		});
		expect(JSON.stringify(result)).not.toContain(SENTINEL);
		expect(JSON.stringify(result)).not.toContain("example.test");
		expect(
			mocks.checkServicePermissionAndAccess,
		).toHaveBeenCalledExactlyOnceWith(ctxMatcher, "app-1", {
			envVars: ["read"],
		});
		expect(fake.locks).toEqual([]);
	});

	it("checks the project variable permission before showing a layout", async () => {
		mocks.checkPermission.mockRejectedValueOnce(
			new TRPCError({ code: "UNAUTHORIZED", message: "denied" }),
		);

		await expectTrpcError(
			createCaller().layout({ scope: "project", id: "project-1" }),
			"UNAUTHORIZED",
		);
		expect(mocks.checkPermission).toHaveBeenCalledExactlyOnceWith(ctxMatcher, {
			projectEnvVars: ["read"],
		});
	});

	it("rearranges variables into sections under the row lock and audits once", async () => {
		const before = storedEnv(applications);
		const result = await createCaller().applyChanges({
			scope: "application",
			id: "app-1",
			layout: [...sectioned],
			expectedRevision: getApplicationEnvRevision("app-1", before),
		});

		const after = storedEnv(applications);
		expect(after).toBe(sectionedEnv);
		expect(parse(after ?? "")).toEqual(parse(before ?? ""));
		expect(result).toEqual({
			scope: "application",
			id: "app-1",
			field: "env",
			changed: true,
			revision: getApplicationEnvRevision("app-1", after),
			dryRun: false,
			variables: [],
			layout: [
				{ type: "comment", ref: "c1", text: "=== Web ===" },
				{
					type: "hidden",
					ref: "h1",
					kind: "overridden",
					variable: "SERVICE_URL",
				},
				{ type: "variable", name: "SERVICE_URL" },
				{ type: "variable", name: "EMPTY_FLAG" },
				{ type: "blank" },
				{ type: "comment", ref: "c2", text: "=== Auth ===" },
				{ type: "comment", ref: "c3", text: "Signs sessions" },
				{ type: "variable", name: "SERVICE_TOKEN" },
			],
		});
		expect(JSON.stringify(result)).not.toContain(SENTINEL);
		expect(fake.locks).toEqual([{ table: "application", strength: "update" }]);
		expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(ctxMatcher, {
			action: "update",
			resourceType: "application",
			resourceId: "app-1",
			resourceName: "app-one",
		});
		expect(
			mocks.checkServicePermissionAndAccess,
		).toHaveBeenCalledExactlyOnceWith(ctxMatcher, "app-1", {
			envVars: ["write"],
		});
	});

	it("previews a layout on a dry run without writing or auditing", async () => {
		const before = storedEnv(applications);
		const result = await createCaller().applyChanges({
			scope: "application",
			id: "app-1",
			layout: [...sectioned],
			dryRun: true,
			expectedRevision: getApplicationEnvRevision("app-1", before),
		});

		expect(result.changed).toBe(true);
		expect(result.dryRun).toBe(true);
		expect(result.revision).toBe(getApplicationEnvRevision("app-1", before));
		expect(result.layout?.map(({ type }) => type)).toEqual([
			"comment",
			"hidden",
			"variable",
			"variable",
			"blank",
			"comment",
			"comment",
			"variable",
		]);
		expect(storedEnv(applications)).toBe(before);
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("does not write or audit a layout that is sent back unchanged", async () => {
		const before = storedEnv(applications);
		const result = await createCaller().applyChanges({
			scope: "application",
			id: "app-1",
			layout: appLayout as never,
			expectedRevision: getApplicationEnvRevision("app-1", before),
		});

		expect(result).toMatchObject({ changed: false, layout: appLayout });
		expect(storedEnv(applications)).toBe(before);
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("rearranges build args of an application and variables of a project", async () => {
		await createCaller().applyChanges({
			scope: "application",
			id: "app-1",
			field: "buildArgs",
			layout: [
				{ type: "comment", text: "Build" },
				{ type: "variable", name: "BUILD_MODE" },
			],
			expectedRevision: getEnvFieldRevision(
				"application",
				"app-1",
				"buildArgs",
				"BUILD_MODE=release\n",
			),
		});
		await createCaller().applyChanges({
			scope: "project",
			id: "project-1",
			layout: [
				{ type: "variable", name: "SHARED_TOKEN" },
				{ type: "variable", name: "SHARED_URL" },
			],
			expectedRevision: getEnvFieldRevision(
				"project",
				"project-1",
				"env",
				storedEnv(projects),
			),
		});

		expect(storedEnv(applications, "buildArgs")).toBe(
			"# Build\nBUILD_MODE=release\n",
		);
		expect(storedEnv(projects)).toBe(
			`SHARED_TOKEN=${SENTINEL}\nSHARED_URL=https://shared.example.test\n`,
		);
	});

	it("rejects a layout combined with value changes or without a revision", async () => {
		const before = storedEnv(applications);

		const combined = await expectTrpcError(
			createCaller().applyChanges({
				scope: "application",
				id: "app-1",
				set: { NEW_NAME: "1" },
				layout: [...sectioned],
				expectedRevision: getApplicationEnvRevision("app-1", before),
			}),
			"BAD_REQUEST",
		);
		const unpinned = await expectTrpcError(
			createCaller().applyChanges({
				scope: "application",
				id: "app-1",
				layout: [...sectioned],
			}),
			"BAD_REQUEST",
		);
		const empty = await expectTrpcError(
			createCaller().applyChanges({
				scope: "application",
				id: "app-1",
				layout: [{ type: "comment" }, ...sectioned],
				expectedRevision: getApplicationEnvRevision("app-1", before),
			}),
			"BAD_REQUEST",
		);

		expect(combined.message).toContain("layout cannot be combined");
		expect(unpinned.message).toContain("expectedRevision");
		expect(empty.message).toContain("A comment needs a ref, a text or both");
		expect(storedEnv(applications)).toBe(before);
		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
	});

	it("rejects a stale revision without writing", async () => {
		const before = storedEnv(applications);

		await expectTrpcError(
			createCaller().applyChanges({
				scope: "application",
				id: "app-1",
				layout: [...sectioned],
				expectedRevision: "stale",
			}),
			"CONFLICT",
		);
		expect(storedEnv(applications)).toBe(before);
	});

	it("rejects a layout that drops a variable, naming only names", async () => {
		const before = storedEnv(applications);

		const error = await expectTrpcError(
			createCaller().applyChanges({
				scope: "application",
				id: "app-1",
				layout: sectioned.filter(
					(item) => item.type !== "variable" || item.name !== "SERVICE_TOKEN",
				),
				expectedRevision: getApplicationEnvRevision("app-1", before),
			}),
			"BAD_REQUEST",
		);

		expect(error.message).toContain(
			"The layout leaves out variables: SERVICE_TOKEN.",
		);
		expect(error.message).not.toContain(SENTINEL);
		expect(storedEnv(applications)).toBe(before);
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("rejects comment text that carries a redacted placeholder", async () => {
		const before = storedEnv(applications);

		const error = await expectTrpcError(
			createCaller().applyChanges({
				scope: "application",
				id: "app-1",
				layout: [{ type: "comment", text: "old [REDACTED]" }, ...sectioned],
				expectedRevision: getApplicationEnvRevision("app-1", before),
			}),
			"BAD_REQUEST",
		);

		expect(error.message).toContain("layout[0]");
		expect(storedEnv(applications)).toBe(before);
	});
});

describe("REST routes", () => {
	it("serves GET /env.keys from query parameters", async () => {
		const response = await callRest("GET", "env.keys", {
			scope: "application",
			id: "app-1",
			field: "buildArgs",
		});

		expect(response).toEqual({
			status: 200,
			body: {
				scope: "application",
				id: "app-1",
				field: "buildArgs",
				revision: getEnvFieldRevision(
					"application",
					"app-1",
					"buildArgs",
					"BUILD_MODE=release\n",
				),
				variables: [{ name: "BUILD_MODE", secret: false, empty: false }],
			},
		});
	});

	it("serves POST /env.apply from a JSON body", async () => {
		const response = await callRest("POST", "env.apply", {
			scope: "application",
			id: "app-1",
			set: { SERVICE_URL: "https://next.example.test" },
			generate: { NEW_TOKEN: { length: 24, format: "hex" } },
			copy: {
				UPSTREAM_TOKEN: {
					fromScope: "project",
					fromId: "project-1",
					fromName: "SHARED_TOKEN",
				},
			},
			remove: ["EMPTY_FLAG"],
		});

		const values = parse(storedEnv(applications) ?? "");
		expect(values).toEqual({
			SERVICE_URL: "https://next.example.test",
			SERVICE_TOKEN: SENTINEL,
			NEW_TOKEN: expect.stringMatching(/^[0-9a-f]{24}$/),
			UPSTREAM_TOKEN: SENTINEL,
		});
		expect(response).toEqual({
			status: 200,
			body: {
				scope: "application",
				id: "app-1",
				field: "env",
				changed: true,
				revision: getApplicationEnvRevision("app-1", storedEnv(applications)),
				dryRun: false,
				variables: [
					{
						name: "SERVICE_URL",
						action: "updated",
						source: "set",
						secret: false,
					},
					{
						name: "NEW_TOKEN",
						action: "created",
						source: "generate",
						secret: true,
					},
					{
						name: "UPSTREAM_TOKEN",
						action: "created",
						source: "copy",
						secret: true,
					},
					{
						name: "EMPTY_FLAG",
						action: "removed",
						source: "remove",
						secret: false,
					},
				],
			},
		});
		expect(JSON.stringify(response)).not.toContain(SENTINEL);
		expect(JSON.stringify(response)).not.toContain(values.NEW_TOKEN);
	});

	it("serves GET /env.layout and a layout through POST /env.apply", async () => {
		const read = await callRest("GET", "env.layout", {
			scope: "postgres",
			id: "postgres-1",
		});
		const layout = (read.body as { layout: unknown[]; revision: string })
			.layout;
		const applied = await callRest("POST", "env.apply", {
			scope: "postgres",
			id: "postgres-1",
			layout: [{ type: "comment", text: "Replication" }, ...layout.reverse()],
			expectedRevision: (read.body as { revision: string }).revision,
		});

		expect(read.status).toBe(200);
		expect(layout).toEqual([
			{ type: "variable", name: "REPLICATION_PASSWORD" },
			{ type: "variable", name: "POSTGRES_INITDB_ARGS" },
		]);
		expect(applied.status).toBe(200);
		expect(storedEnv(postgres)).toBe(
			`# Replication\nREPLICATION_PASSWORD=${OTHER_SENTINEL}\nPOSTGRES_INITDB_ARGS=--data-checksums\n`,
		);
		expect(JSON.stringify([read, applied])).not.toContain(OTHER_SENTINEL);
	});

	it("maps errors to HTTP statuses without echoing values", async () => {
		const conflict = await callRest("POST", "env.apply", {
			scope: "application",
			id: "app-1",
			set: { ADDED_NAME: OTHER_SENTINEL },
			expectedRevision: "stale",
		});
		const invalid = await callRest("POST", "env.apply", {
			scope: "application",
			id: "app-1",
			set: { SAME_NAME: OTHER_SENTINEL },
			remove: ["SAME_NAME"],
		});
		const missing = await callRest("GET", "env.keys", {
			scope: "compose",
			id: "missing",
		});

		expect(conflict.status).toBe(409);
		expect(invalid.status).toBe(400);
		expect(missing.status).toBe(404);
		expect(JSON.stringify([conflict, invalid, missing])).not.toContain(
			OTHER_SENTINEL,
		);
	});

	it("has no REST route under the tRPC procedure name", async () => {
		const response = await callRest("POST", "env.applyChanges", {
			scope: "application",
			id: "app-1",
			set: { ADDED_NAME: "1" },
		});

		expect(response.status).toBe(404);
		expect(storedEnv(applications)).not.toContain("ADDED_NAME");
	});
});

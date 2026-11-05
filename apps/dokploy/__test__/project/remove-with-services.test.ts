import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	deleteEnvironment: vi.fn(),
	deleteProject: vi.fn(),
	findEnvironmentById: vi.fn(),
	findProjectById: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	deleteEnvironment: mocks.deleteEnvironment,
	deleteProject: mocks.deleteProject,
	findEnvironmentById: mocks.findEnvironmentById,
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	findLibsqlById: vi.fn(),
	findMariadbById: vi.fn(),
	findMongoById: vi.fn(),
	findMySqlById: vi.fn(),
	findPostgresById: vi.fn(),
	findProjectById: mocks.findProjectById,
	findRedisById: vi.fn(),
	getAccessibleServerIds: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({ db: {} }));

vi.mock("@dokploy/server/services/permission", () => ({
	checkEnvironmentAccess: vi.fn(),
	checkEnvironmentDeletionPermission: vi.fn(),
	checkPermission: vi.fn(),
	checkProjectAccess: vi.fn(),
	findMemberByUserId: vi.fn(),
	hasPermission: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

const { projectRouter } = await import("../../server/api/routers/project");
const { environmentRouter } = await import(
	"../../server/api/routers/environment"
);

const context = {
	db: {},
	req: {},
	res: {},
	session: {
		id: "session-1",
		userId: "user-1",
		activeOrganizationId: "org-1",
	},
	user: { id: "user-1", ownerId: "user-1", role: "owner" },
} as never;

const SERVICE_TYPES = [
	"applications",
	"compose",
	"libsql",
	"mariadb",
	"mongo",
	"mysql",
	"postgres",
	"redis",
] as const;

const environment = (service?: (typeof SERVICE_TYPES)[number]) => ({
	environmentId: "env-1",
	name: "staging",
	isDefault: false,
	projectId: "project-1",
	project: { projectId: "project-1", organizationId: "org-1" },
	...Object.fromEntries(
		SERVICE_TYPES.map((type) => [type, type === service ? [{}] : []]),
	),
});

const project = (service?: (typeof SERVICE_TYPES)[number]) => ({
	projectId: "project-1",
	organizationId: "org-1",
	name: "project",
	environments: [environment(), environment(service)],
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.deleteProject.mockResolvedValue({ projectId: "project-1" });
	mocks.deleteEnvironment.mockResolvedValue({ environmentId: "env-1" });
});

describe("project.remove", () => {
	const remove = () =>
		projectRouter.createCaller(context).remove({ projectId: "project-1" });

	it.each(SERVICE_TYPES)("refuses a project that has %s", async (service) => {
		mocks.findProjectById.mockResolvedValue(project(service));

		await expect(remove()).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("still has services"),
		});
		expect(mocks.deleteProject).not.toHaveBeenCalled();
	});

	it("removes an empty project", async () => {
		mocks.findProjectById.mockResolvedValue(project());

		await remove();

		expect(mocks.deleteProject).toHaveBeenCalledWith("project-1");
	});
});

describe("environment.remove", () => {
	const remove = () =>
		environmentRouter.createCaller(context).remove({ environmentId: "env-1" });

	it.each(SERVICE_TYPES)(
		"refuses an environment that has %s",
		async (service) => {
			mocks.findEnvironmentById.mockResolvedValue(environment(service));

			await expect(remove()).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining("still has services"),
			});
			expect(mocks.deleteEnvironment).not.toHaveBeenCalled();
		},
	);

	it("removes an empty environment", async () => {
		mocks.findEnvironmentById.mockResolvedValue(environment());

		await remove();

		expect(mocks.deleteEnvironment).toHaveBeenCalledWith("env-1");
	});
});

import { REDACTED_SECRET_VALUE } from "@dokploy/server/utils/security/redaction";
import { beforeEach, describe, expect, it, vi } from "vitest";

const serverMocks = vi.hoisted(() => ({
	deleteProject: vi.fn(),
	findEnvironmentById: vi.fn(),
	findProjectById: vi.fn(),
	updateProjectById: vi.fn(),
}));

const permissionMocks = vi.hoisted(() => ({
	checkPermission: vi.fn(),
	checkProjectAccess: vi.fn(),
	findMemberByUserId: vi.fn(),
	hasPermission: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	deleteProject: serverMocks.deleteProject,
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	findEnvironmentById: serverMocks.findEnvironmentById,
	findLibsqlById: vi.fn(),
	findMariadbById: vi.fn(),
	findMongoById: vi.fn(),
	findMySqlById: vi.fn(),
	findPostgresById: vi.fn(),
	findProjectById: serverMocks.findProjectById,
	findRedisById: vi.fn(),
	getAccessibleServerIds: vi.fn(),
	updateProjectById: serverMocks.updateProjectById,
}));

vi.mock("@dokploy/server/db", () => ({ db: {} }));

vi.mock("@dokploy/server/services/permission", () => ({
	addNewEnvironment: vi.fn(),
	addNewProject: vi.fn(),
	checkPermission: permissionMocks.checkPermission,
	checkProjectAccess: permissionMocks.checkProjectAccess,
	findMemberByUserId: permissionMocks.findMemberByUserId,
	hasPermission: permissionMocks.hasPermission,
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(),
}));

const { projectRouter } = await import("../../server/api/routers/project");

const caller = projectRouter.createCaller({
	db: {},
	req: {},
	res: {},
	session: {
		id: "session-1",
		userId: "user-1",
		activeOrganizationId: "org-1",
	},
	user: { id: "user-1", ownerId: "owner-1", role: "member" },
} as never);

const projectRow = () => ({
	projectId: "project-1",
	organizationId: "org-1",
	name: "project",
	env: "PROJECT_SECRET=secret",
	environments: [],
});

const sourceEnvironment = () => ({
	environmentId: "env-1",
	name: "production",
	projectId: "project-1",
	env: "ENV_SECRET=secret",
	applications: [],
	compose: [],
	libsql: [],
	mariadb: [],
	mongo: [],
	mysql: [],
	postgres: [],
	redis: [],
	project: projectRow(),
});

const grantEnvRead = (granted: boolean) => {
	permissionMocks.hasPermission.mockResolvedValue(granted);
};

describe("project mutation responses", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		permissionMocks.findMemberByUserId.mockResolvedValue({
			role: "member",
			accessedProjects: ["project-1"],
			accessedEnvironments: ["env-1"],
			accessedServices: [],
		});
		serverMocks.findProjectById.mockResolvedValue(projectRow());
		serverMocks.updateProjectById.mockResolvedValue(projectRow());
		serverMocks.deleteProject.mockResolvedValue(projectRow());
		serverMocks.findEnvironmentById.mockResolvedValue(sourceEnvironment());
	});

	it("returns project env from update and remove only with projectEnvVars read", async () => {
		grantEnvRead(false);

		const updated = await caller.update({
			projectId: "project-1",
			name: "renamed",
		});
		const removed = await caller.remove({ projectId: "project-1" });

		expect(updated?.env).toBe(REDACTED_SECRET_VALUE);
		expect(removed?.env).toBe(REDACTED_SECRET_VALUE);
		expect(permissionMocks.hasPermission).toHaveBeenCalledWith(
			expect.anything(),
			{ projectEnvVars: ["read"] },
		);

		grantEnvRead(true);

		await expect(
			caller.update({ projectId: "project-1", name: "renamed" }),
		).resolves.toMatchObject({ env: "PROJECT_SECRET=secret" });
		await expect(
			caller.remove({ projectId: "project-1" }),
		).resolves.toMatchObject({ env: "PROJECT_SECRET=secret" });
	});

	it("returns shared env from a same-project duplicate only with read access", async () => {
		const duplicate = () =>
			caller.duplicate({
				sourceEnvironmentId: "env-1",
				name: "copy",
				includeServices: false,
				duplicateInSameProject: true,
			});
		grantEnvRead(false);

		const redacted = await duplicate();

		expect(redacted).toMatchObject({
			environmentId: "env-1",
			projectId: "project-1",
			env: REDACTED_SECRET_VALUE,
			project: { env: REDACTED_SECRET_VALUE },
		});

		grantEnvRead(true);

		await expect(duplicate()).resolves.toMatchObject({
			env: "ENV_SECRET=secret",
			project: { env: "PROJECT_SECRET=secret" },
		});
	});
});

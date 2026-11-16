import { REDACTED_SECRET_VALUE } from "@dokploy/server/utils/security/redaction";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	checkPermission: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	findMemberByUserId: vi.fn(),
	findScheduleById: vi.fn(),
	schedulesFindMany: vi.fn(),
	serverFindFirst: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	removeScheduleJob: vi.fn(),
	scheduleJob: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			schedules: {
				findMany: mocks.schedulesFindMany,
			},
			server: {
				findFirst: mocks.serverFindFirst,
			},
		},
	},
}));

vi.mock("@dokploy/server/index", () => ({
	IS_CLOUD: false,
	removeScheduleJob: vi.fn(),
	runCommand: vi.fn(),
	scheduleJob: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: mocks.checkPermission,
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
	findMemberByUserId: mocks.findMemberByUserId,
}));

vi.mock("@dokploy/server/services/schedule", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/services/schedule")>();
	return {
		...actual,
		findScheduleById: mocks.findScheduleById,
	};
});

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(),
}));

vi.mock("@/server/api/utils/placement-access", () => ({
	assertTargetServerAccess: vi.fn(),
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
}));

const { scheduleRouter } = await import("../../server/api/routers/schedule");

const createCaller = () =>
	scheduleRouter.createCaller({
		user: { id: "user-1" },
		session: { activeOrganizationId: "org-1" },
	} as never);

const sharedEnvironment = {
	environmentId: "environment-1",
	env: "ENVIRONMENT_SHARED=environment-secret",
	project: {
		projectId: "project-1",
		organizationId: "org-1",
		env: "PROJECT_SHARED=project-secret",
	},
};

const remoteServer = {
	serverId: "server-1",
	name: "remote",
	organizationId: "org-1",
	command: "echo server-command-secret",
	metricsConfig: {
		server: { token: "metrics-token", port: 4500 },
		containers: { refreshRate: 60 },
	},
};

const expectNoSecrets = (value: unknown) => {
	const serialized = JSON.stringify(value);
	for (const secret of [
		"compose-env-secret",
		"file-secret",
		"repo-token",
		"compose-refresh-token",
		"environment-secret",
		"project-secret",
		"server-command-secret",
		"metrics-token",
	]) {
		expect(serialized).not.toContain(secret);
	}
};

describe("schedule read redaction", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkPermission.mockResolvedValue(undefined);
		mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
		mocks.findMemberByUserId.mockResolvedValue({ role: "admin" });
		mocks.serverFindFirst.mockResolvedValue(remoteServer);
	});

	it("redacts the bound compose service and shared env in one", async () => {
		mocks.findScheduleById.mockResolvedValue({
			scheduleId: "schedule-1",
			name: "nightly",
			scheduleType: "compose",
			command: "echo ok",
			applicationId: null,
			composeId: "compose-1",
			serverId: null,
			organizationId: null,
			application: null,
			server: null,
			compose: {
				composeId: "compose-1",
				appName: "compose-one",
				env: "COMPOSE_SECRET=compose-env-secret",
				composeFile:
					"services:\n  api:\n    environment:\n      TOKEN: file-secret",
				customGitUrl: "https://repo-user:repo-token@example.com/org/repo.git",
				refreshToken: "compose-refresh-token",
				environment: sharedEnvironment,
			},
		});

		const schedule = await createCaller().one({ scheduleId: "schedule-1" });

		expect(schedule).toMatchObject({
			command: "echo ok",
			compose: {
				appName: "compose-one",
				env: REDACTED_SECRET_VALUE,
				composeFile: REDACTED_SECRET_VALUE,
				refreshToken: REDACTED_SECRET_VALUE,
				environment: {
					env: REDACTED_SECRET_VALUE,
					project: { env: REDACTED_SECRET_VALUE, organizationId: "org-1" },
				},
			},
		});
		expectNoSecrets(schedule);
	});

	it("redacts the bound server and application shared env in one", async () => {
		mocks.findScheduleById.mockResolvedValue({
			scheduleId: "schedule-1",
			name: "nightly",
			scheduleType: "server",
			command: "echo ok",
			applicationId: null,
			composeId: null,
			serverId: "server-1",
			organizationId: null,
			application: {
				applicationId: "app-1",
				appName: "app-one",
				environment: sharedEnvironment,
			},
			compose: null,
			server: { ...remoteServer, organization: { id: "org-1" } },
		});

		const schedule = await createCaller().one({ scheduleId: "schedule-1" });

		expect(schedule.server).toMatchObject({
			name: "remote",
			command: REDACTED_SECRET_VALUE,
			metricsConfig: { server: { token: REDACTED_SECRET_VALUE } },
			organization: { id: "org-1" },
		});
		expectNoSecrets(schedule);
	});

	it("redacts the server row in list", async () => {
		mocks.schedulesFindMany.mockResolvedValue([
			{
				scheduleId: "schedule-1",
				name: "nightly",
				scheduleType: "server",
				command: "echo ok",
				serverId: "server-1",
				application: null,
				compose: null,
				server: remoteServer,
				deployments: [],
			},
		]);

		const schedules = await createCaller().list({
			id: "server-1",
			scheduleType: "server",
		});

		expect(schedules).toHaveLength(1);
		expect(schedules[0]).toMatchObject({
			command: "echo ok",
			server: {
				name: "remote",
				command: REDACTED_SECRET_VALUE,
				metricsConfig: { server: { token: REDACTED_SECRET_VALUE, port: 4500 } },
			},
		});
		expectNoSecrets(schedules);
	});
});

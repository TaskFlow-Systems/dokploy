import { beforeEach, describe, expect, it, vi } from "vitest";

type Service = {
	appName: string;
	serverId: string | null;
	organizationId: string;
	id: string;
};

const mocks = vi.hoisted(() => {
	const services = new Map<string, Map<string, Service>>();
	const idColumns: Record<string, string> = {
		applications: "applicationId",
		compose: "composeId",
		postgres: "postgresId",
		mysql: "mysqlId",
		mariadb: "mariadbId",
		mongo: "mongoId",
		redis: "redisId",
		libsql: "libsqlId",
		previewDeployments: "previewDeploymentId",
	};
	const findFirst =
		(table: string) =>
		async ({ where }: { where: { value: string } }) => {
			const service = services.get(table)?.get(where.value);
			if (!service) return undefined;
			return {
				[idColumns[table] as string]: service.id,
				appName: service.appName,
				serverId: service.serverId,
				environment: {
					project: { organizationId: service.organizationId },
				},
			};
		};
	return {
		services,
		query: Object.fromEntries(
			Object.keys(idColumns).map((table) => [
				table,
				{ findFirst: findFirst(table) },
			]),
		),
		execAsync: vi.fn(),
		checkServicePermissionAndAccess: vi.fn(),
	};
});

vi.mock("drizzle-orm", async (importOriginal) => ({
	...(await importOriginal<typeof import("drizzle-orm")>()),
	eq: (_column: unknown, value: unknown) => ({ value }),
}));
vi.mock("@dokploy/server/db", () => ({
	db: { query: mocks.query },
}));
vi.mock("@dokploy/server/services/permission", () => ({
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
}));

import { assertContainerMetricsServiceAccess } from "@/server/api/utils/monitoring-access";

const ctx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

const addService = (table: string, service: Service) => {
	const rows = mocks.services.get(table) ?? new Map<string, Service>();
	rows.set(service.appName, service);
	mocks.services.set(table, rows);
};

const inspectResult = (name: string, labels: Record<string, string> | null) =>
	mocks.execAsync.mockResolvedValue({
		stdout: `${JSON.stringify({ name, labels })}\n`,
		stderr: "",
	});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.services.clear();
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	addService("compose", {
		id: "compose-1",
		appName: "shop-abc123",
		serverId: null,
		organizationId: "org-1",
	});
});

describe("assertContainerMetricsServiceAccess", () => {
	it("checks access to the compose service that owns a container", async () => {
		inspectResult("/shop-abc123-worker-1", {
			"com.docker.compose.project": "shop-abc123",
			"com.docker.compose.service": "worker",
		});

		await assertContainerMetricsServiceAccess(ctx, "shop-abc123-worker-1");

		expect(mocks.execAsync).toHaveBeenCalledWith(
			expect.stringContaining("shop-abc123-worker-1"),
		);
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			ctx,
			"compose-1",
			{ monitoring: ["read"] },
		);
	});

	it("checks access to the stack that owns a task container", async () => {
		addService("compose", {
			id: "stack-1",
			appName: "blog-def456",
			serverId: null,
			organizationId: "org-1",
		});
		inspectResult("/blog-def456_web.1.k2j3h4", {
			"com.docker.stack.namespace": "blog-def456",
			"com.docker.swarm.service.name": "blog-def456_web",
		});

		await assertContainerMetricsServiceAccess(ctx, "blog-def456_web.1.k2j3h4");

		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			ctx,
			"stack-1",
			{ monitoring: ["read"] },
		);
	});

	it("does not inspect containers when the name is a service", async () => {
		await assertContainerMetricsServiceAccess(ctx, "shop-abc123");

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			ctx,
			"compose-1",
			{ monitoring: ["read"] },
		);
	});

	it("denies a container resolved by an ID prefix instead of its name", async () => {
		inspectResult("/shop-abc123-worker-1", {
			"com.docker.compose.project": "shop-abc123",
		});

		await expect(
			assertContainerMetricsServiceAccess(ctx, "3f9a1c"),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
	});

	it("denies a container whose service is in another organization", async () => {
		addService("compose", {
			id: "compose-2",
			appName: "other-xyz789",
			serverId: null,
			organizationId: "org-2",
		});
		inspectResult("/other-xyz789-db-1", {
			"com.docker.compose.project": "other-xyz789",
		});

		await expect(
			assertContainerMetricsServiceAccess(ctx, "other-xyz789-db-1"),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
	});

	it("ignores labels that point at a service on a remote server", async () => {
		addService("compose", {
			id: "compose-3",
			appName: "remote-qwe321",
			serverId: "server-1",
			organizationId: "org-1",
		});
		inspectResult("/remote-qwe321-api-1", {
			"com.docker.compose.project": "remote-qwe321",
		});

		await expect(
			assertContainerMetricsServiceAccess(ctx, "remote-qwe321-api-1"),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("denies containers without labels or when docker fails", async () => {
		inspectResult("/loose-container", null);
		await expect(
			assertContainerMetricsServiceAccess(ctx, "loose-container"),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		mocks.execAsync.mockRejectedValue(new Error("No such container"));
		await expect(
			assertContainerMetricsServiceAccess(ctx, "missing-container"),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
	});

	it("does not resolve containers for a metrics server request", async () => {
		await expect(
			assertContainerMetricsServiceAccess(
				ctx,
				"shop-abc123-worker-1",
				"server-1",
			),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("rejects names that are not docker identifiers without running docker", async () => {
		await expect(
			assertContainerMetricsServiceAccess(ctx, "x; rm -rf /"),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});
});

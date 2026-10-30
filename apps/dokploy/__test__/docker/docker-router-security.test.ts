import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	audit: vi.fn(),
	assertLocalDockerContainerAccess: vi.fn(),
	assertLocalDockerContainerOrSystemAccess: vi.fn(),
	checkPermission: vi.fn(),
	containerKill: vi.fn(),
	containerRemove: vi.fn(),
	containerRestart: vi.fn(),
	containerStart: vi.fn(),
	containerStop: vi.fn(),
	deleteContainerFile: vi.fn(),
	findMemberByUserId: vi.fn(),
	findServerById: vi.fn(),
	getAccessibleServerIds: vi.fn(),
	getConfig: vi.fn(),
	getContainers: vi.fn(),
	getContainersByAppLabel: vi.fn(),
	getContainersByAppNameMatch: vi.fn(),
	getDockerEvents: vi.fn(),
	getServiceContainersByAppName: vi.fn(),
	getStackContainersByAppName: vi.fn(),
	listContainerFiles: vi.fn(),
	readContainerFile: vi.fn(),
	uploadFileToContainer: vi.fn(),
	writeContainerFile: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	containerKill: mocks.containerKill,
	containerRemove: mocks.containerRemove,
	containerRestart: mocks.containerRestart,
	containerStart: mocks.containerStart,
	containerStop: mocks.containerStop,
	deleteContainerFile: mocks.deleteContainerFile,
	findServerById: mocks.findServerById,
	getAccessibleServerIds: mocks.getAccessibleServerIds,
	getConfig: mocks.getConfig,
	getContainers: mocks.getContainers,
	getContainersByAppLabel: mocks.getContainersByAppLabel,
	getContainersByAppNameMatch: mocks.getContainersByAppNameMatch,
	getDockerEvents: mocks.getDockerEvents,
	getServiceContainersByAppName: mocks.getServiceContainersByAppName,
	getStackContainersByAppName: mocks.getStackContainersByAppName,
	listContainerFiles: mocks.listContainerFiles,
	readContainerFile: mocks.readContainerFile,
	uploadFileToContainer: mocks.uploadFileToContainer,
	writeContainerFile: mocks.writeContainerFile,
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: mocks.checkPermission,
	findMemberByUserId: mocks.findMemberByUserId,
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: mocks.audit,
}));

vi.mock("@/server/api/utils/local-docker-access", () => ({
	assertLocalDockerContainerAccess: mocks.assertLocalDockerContainerAccess,
	assertLocalDockerContainerOrSystemAccess:
		mocks.assertLocalDockerContainerOrSystemAccess,
}));

const { dockerRouter } = await import("../../server/api/routers/docker");

const createCaller = (authMethod: "session" | "api-key" = "session") =>
	dockerRouter.createCaller({
		db: {},
		req: {},
		res: {},
		session: {
			userId: "user-1",
			activeOrganizationId: "org-1",
			...(authMethod === "api-key" ? { authMethod } : {}),
		},
		user: {
			id: "user-1",
			role: "member",
		},
	} as never);

describe("docker router assigned-server boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkPermission.mockResolvedValue(undefined);
		mocks.findMemberByUserId.mockResolvedValue({ role: "admin" });
		mocks.findServerById.mockResolvedValue({
			serverId: "server-1",
			organizationId: "org-1",
		});
		mocks.assertLocalDockerContainerAccess.mockResolvedValue({
			Id: "container-1",
			Config: {
				Labels: {
					"com.docker.swarm.service.name": "app-1",
				},
			},
		});
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-1"]));
		mocks.getContainers.mockResolvedValue([{ Id: "container-1" }]);
		mocks.containerRestart.mockResolvedValue(undefined);
	});

	it("denies inaccessible server container listings before Docker service access", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().getContainers({ serverId: "server-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.getContainers).not.toHaveBeenCalled();
	});

	it("denies inaccessible server container mutations before side effects", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().restartContainer({
				containerId: "container-1",
				serverId: "server-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.containerRestart).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("allows accessible server container listings", async () => {
		await expect(
			createCaller().getContainers({ serverId: "server-1" }),
		).resolves.toEqual([{ Id: "container-1" }]);

		expect(mocks.getAccessibleServerIds).toHaveBeenCalledWith({
			userId: "user-1",
			activeOrganizationId: "org-1",
		});
		expect(mocks.getContainers).toHaveBeenCalledWith("server-1");
	});

	it("denies non-admin docker host operations before Docker service access", async () => {
		mocks.findMemberByUserId.mockResolvedValue({ role: "member" });

		await expect(
			createCaller().getContainers({ serverId: "server-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.getAccessibleServerIds).not.toHaveBeenCalled();
		expect(mocks.getContainers).not.toHaveBeenCalled();
	});

	it("binds local container mutations to an authorized service before side effects", async () => {
		await expect(
			createCaller().restartContainer({
				containerId: "container-1",
			}),
		).resolves.toBeUndefined();

		expect(mocks.getAccessibleServerIds).not.toHaveBeenCalled();
		expect(mocks.assertLocalDockerContainerAccess).toHaveBeenCalledWith(
			expect.anything(),
			"container-1",
			"execute",
		);
		expect(mocks.containerRestart).toHaveBeenCalledWith(
			"container-1",
			undefined,
		);
	});

	it("denies unbound local container mutations before side effects", async () => {
		mocks.assertLocalDockerContainerAccess.mockRejectedValue(
			new TRPCError({ code: "UNAUTHORIZED" }),
		);

		await expect(
			createCaller().restartContainer({
				containerId: "container-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.containerRestart).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("requires docker.execute for container lifecycle actions", async () => {
		const caller = createCaller();

		await caller.restartContainer({ containerId: "container-1" });
		await caller.startContainer({ containerId: "container-1" });
		await caller.stopContainer({ containerId: "container-1" });
		await caller.killContainer({ containerId: "container-1" });

		expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
			docker: ["execute"],
		});
		expect(
			mocks.checkPermission.mock.calls.filter(
				([, permissions]) =>
					JSON.stringify(permissions) === JSON.stringify({ docker: ["read"] }),
			),
		).toHaveLength(0);
	});

	it("requires docker.delete for container removal", async () => {
		await createCaller().removeContainer({ containerId: "container-1" });

		expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
			docker: ["delete"],
		});
	});

	it("requires docker.inspect for container config inspection", async () => {
		mocks.getConfig.mockResolvedValue({ Config: { Env: ["SECRET=value"] } });

		await createCaller().getConfig({ containerId: "container-1" });

		expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
			docker: ["inspect"],
		});
		expect(mocks.assertLocalDockerContainerAccess).toHaveBeenCalledWith(
			expect.anything(),
			"container-1",
			"inspect",
		);
		expect(mocks.getConfig).not.toHaveBeenCalled();
	});

	it("requires docker.write for container file uploads", async () => {
		const file = new File(["content"], "config.txt", { type: "text/plain" });

		await createCaller().uploadFileToContainer({
			containerId: "container-1",
			file,
			destinationPath: "/tmp/config.txt",
		});

		expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
			docker: ["write"],
		});
		expect(mocks.assertLocalDockerContainerAccess).toHaveBeenCalledWith(
			expect.anything(),
			"container-1",
			"write",
		);
		expect(mocks.uploadFileToContainer).toHaveBeenCalledWith(
			"container-1",
			expect.any(Buffer),
			"config.txt",
			"/tmp/config.txt",
			null,
		);
	});
});

describe("docker router container file and event boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkPermission.mockResolvedValue(undefined);
		mocks.findMemberByUserId.mockResolvedValue({ role: "admin" });
		mocks.findServerById.mockResolvedValue({
			serverId: "server-1",
			organizationId: "org-1",
		});
		mocks.assertLocalDockerContainerAccess.mockResolvedValue({
			Id: "resolved-container-1",
			Config: {
				Labels: {
					"com.docker.swarm.service.name": "app-1",
				},
			},
		});
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-1"]));
		mocks.listContainerFiles.mockResolvedValue([]);
		mocks.readContainerFile.mockResolvedValue({ content: "" });
		mocks.getDockerEvents.mockResolvedValue([]);
		mocks.assertLocalDockerContainerOrSystemAccess.mockImplementation(
			(ctx, containerId, permission) =>
				mocks.assertLocalDockerContainerAccess(ctx, containerId, permission),
		);
	});

	const fileCalls = (
		caller: ReturnType<typeof createCaller>,
		serverId?: string,
	) => [
		{
			name: "listContainerFiles",
			run: () =>
				caller.listContainerFiles({
					containerId: "container-1",
					path: "/",
					serverId,
				}),
			sideEffect: mocks.listContainerFiles,
		},
		{
			name: "readContainerFile",
			run: () =>
				caller.readContainerFile({
					containerId: "container-1",
					path: "/etc/app.env",
					serverId,
				}),
			sideEffect: mocks.readContainerFile,
		},
		{
			name: "writeContainerFile",
			run: () =>
				caller.writeContainerFile({
					containerId: "container-1",
					path: "/etc/app.env",
					content: "KEY=value",
					serverId,
				}),
			sideEffect: mocks.writeContainerFile,
		},
		{
			name: "deleteContainerFile",
			run: () =>
				caller.deleteContainerFile({
					containerId: "container-1",
					path: "/etc/app.env",
					serverId,
				}),
			sideEffect: mocks.deleteContainerFile,
		},
	];

	it("denies non-admin container file access before Docker side effects", async () => {
		mocks.findMemberByUserId.mockResolvedValue({ role: "member" });

		for (const call of fileCalls(createCaller())) {
			await expect(call.run(), call.name).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
			expect(call.sideEffect, call.name).not.toHaveBeenCalled();
		}
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("denies container file access on inaccessible servers", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		for (const call of fileCalls(createCaller(), "server-1")) {
			await expect(call.run(), call.name).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
			expect(call.sideEffect, call.name).not.toHaveBeenCalled();
		}
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("denies local container file access for containers outside the caller's services", async () => {
		mocks.assertLocalDockerContainerAccess.mockRejectedValue(
			new TRPCError({ code: "UNAUTHORIZED" }),
		);

		for (const call of fileCalls(createCaller())) {
			await expect(call.run(), call.name).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
			expect(call.sideEffect, call.name).not.toHaveBeenCalled();
		}
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("binds local container file reads to the authorized container", async () => {
		const caller = createCaller();

		await caller.listContainerFiles({ containerId: "container-1", path: "/" });
		await caller.readContainerFile({
			containerId: "container-1",
			path: "/etc/app.env",
		});

		expect(mocks.assertLocalDockerContainerAccess).toHaveBeenCalledWith(
			expect.anything(),
			"container-1",
			"read",
		);
		expect(mocks.listContainerFiles).toHaveBeenCalledWith(
			"resolved-container-1",
			"/",
			undefined,
		);
		expect(mocks.readContainerFile).toHaveBeenCalledWith(
			"resolved-container-1",
			"/etc/app.env",
			undefined,
		);
	});

	it("requires docker.write for container file writes", async () => {
		await createCaller().writeContainerFile({
			containerId: "container-1",
			path: "/etc/app.env",
			content: "KEY=value",
		});

		expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
			docker: ["write"],
		});
		expect(mocks.assertLocalDockerContainerAccess).toHaveBeenCalledWith(
			expect.anything(),
			"container-1",
			"write",
		);
		expect(mocks.writeContainerFile).toHaveBeenCalledWith(
			"resolved-container-1",
			"/etc/app.env",
			"KEY=value",
			undefined,
		);
	});

	it("requires docker.delete for container file deletes", async () => {
		await createCaller().deleteContainerFile({
			containerId: "container-1",
			path: "/etc/app.env",
		});

		expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), {
			docker: ["delete"],
		});
		expect(mocks.assertLocalDockerContainerAccess).toHaveBeenCalledWith(
			expect.anything(),
			"container-1",
			"delete",
		);
		expect(mocks.deleteContainerFile).toHaveBeenCalledWith(
			"resolved-container-1",
			"/etc/app.env",
			undefined,
		);
	});

	describe("panel system containers", () => {
		const systemContainer = {
			Id: "system-container-1",
			Config: { Labels: {} },
		};

		beforeEach(() => {
			mocks.assertLocalDockerContainerOrSystemAccess.mockImplementation(
				async (_ctx, _containerId, _permission, assertSystemAccess) => {
					await assertSystemAccess();
					return systemContainer;
				},
			);
		});

		it("opens system container files for owners and admins", async () => {
			for (const call of fileCalls(createCaller())) {
				await call.run();
				expect(call.sideEffect, call.name).toHaveBeenCalledWith(
					"system-container-1",
					expect.anything(),
					...(call.name === "writeContainerFile"
						? [expect.anything(), undefined]
						: [undefined]),
				);
			}
		});

		it("keeps members out of system container files", async () => {
			mocks.findMemberByUserId.mockResolvedValue({ role: "member" });

			for (const call of fileCalls(createCaller())) {
				await expect(call.run(), call.name).rejects.toMatchObject({
					code: "UNAUTHORIZED",
				});
				expect(call.sideEffect, call.name).not.toHaveBeenCalled();
			}
		});

		it("never opens system container files through an API key", async () => {
			for (const call of fileCalls(createCaller("api-key"))) {
				await expect(call.run(), call.name).rejects.toMatchObject({
					code: "FORBIDDEN",
				});
				expect(call.sideEffect, call.name).not.toHaveBeenCalled();
			}
		});
	});

	it("denies non-admin Docker event reads", async () => {
		mocks.findMemberByUserId.mockResolvedValue({ role: "member" });

		await expect(createCaller().getEvents({})).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});

		expect(mocks.getDockerEvents).not.toHaveBeenCalled();
	});

	it("denies Docker event reads on inaccessible servers", async () => {
		mocks.getAccessibleServerIds.mockResolvedValue(new Set(["server-2"]));

		await expect(
			createCaller().getEvents({ serverId: "server-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.getDockerEvents).not.toHaveBeenCalled();
	});

	it("checks admin role and server access before reading Docker events", async () => {
		await expect(
			createCaller().getEvents({ serverId: "server-1", minutes: 5 }),
		).resolves.toEqual([]);

		expect(mocks.findMemberByUserId).toHaveBeenCalledWith("user-1", "org-1");
		expect(mocks.getAccessibleServerIds).toHaveBeenCalledWith({
			userId: "user-1",
			activeOrganizationId: "org-1",
		});
		expect(mocks.getDockerEvents).toHaveBeenCalledWith("server-1", 5);
	});
});

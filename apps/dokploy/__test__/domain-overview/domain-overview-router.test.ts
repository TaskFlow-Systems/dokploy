import type { DomainOverviewAccess } from "@dokploy/server/services/domain-overview";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	checkProtectedResourceAccess: vi.fn(),
	createAuditLog: vi.fn(),
	deleteUnusedCertificates: vi.fn(),
	findMember: vi.fn(),
	findServers: vi.fn(),
	getDomainOverview: vi.fn(),
	getTraefikLogs: vi.fn(),
	hasValidLicense: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			member: { findFirst: mocks.findMember },
			server: { findMany: mocks.findServers },
		},
	},
}));

vi.mock("@dokploy/server/services/proprietary/audit-log", () => ({
	createAuditLog: mocks.createAuditLog,
}));

vi.mock("@dokploy/server/services/domain-overview", () => ({
	deleteUnusedCertificates: mocks.deleteUnusedCertificates,
	getDomainOverview: mocks.getDomainOverview,
	getTraefikLogs: mocks.getTraefikLogs,
}));

vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: mocks.hasValidLicense,
}));

vi.mock("@dokploy/server/services/super-password", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/super-password")
	>()),
	checkProtectedResourceAccess: mocks.checkProtectedResourceAccess,
}));

vi.mock("@dokploy/server/services/known-secrets", async () => {
	const { EMPTY_KNOWN_SECRET_MATCHER } = await import(
		"@dokploy/server/utils/security/secret-scrub"
	);
	return {
		getKnownSecretMatcher: async () => EMPTY_KNOWN_SECRET_MATCHER,
		resetKnownSecretMatcherCache: () => {},
	};
});

const { appRouter } = await import("@/server/api/root");

type Role = "owner" | "admin" | "member";

const useMember = (role: Role, traefikFiles: boolean) => {
	mocks.findMember.mockResolvedValue({
		role,
		canAccessToTraefikFiles: traefikFiles,
		accessedServers: [],
	});
};

const createCaller = (
	role: Role,
	options: { traefikFiles?: boolean; authMethod?: "api-key" } = {},
) => {
	useMember(role, options.traefikFiles ?? false);
	return appRouter.createCaller({
		db: {},
		req: {},
		res: {},
		session: {
			id: "session-1",
			userId: "user-1",
			activeOrganizationId: "org-1",
			authMethod: options.authMethod ?? "session",
		},
		user: {
			id: "user-1",
			email: "operator@example.test",
			role,
		},
	} as never);
};

const overviewAccess = (): DomainOverviewAccess => {
	const call = mocks.getDomainOverview.mock.calls[0];
	if (!call) {
		throw new Error("getDomainOverview was not called");
	}
	return call[1] as DomainOverviewAccess;
};

describe("domain overview router access", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findServers.mockResolvedValue([
			{ serverId: "server-1" },
			{ serverId: "server-2" },
		]);
		mocks.hasValidLicense.mockResolvedValue(false);
		mocks.checkProtectedResourceAccess.mockResolvedValue(null);
		mocks.getDomainOverview.mockResolvedValue({
			rows: [],
			serverErrors: [],
		});
		mocks.getTraefikLogs.mockResolvedValue({ lines: [] });
	});

	it("refuses the overview to a member without Traefik file access", async () => {
		await expect(
			createCaller("member").domainOverview.list(),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.getDomainOverview).not.toHaveBeenCalled();
	});

	it("refuses the Traefik logs to a member without Traefik file access", async () => {
		const caller = createCaller("member");

		await expect(
			caller.domainOverview.traefikLogs({ serverId: "server-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(caller.domainOverview.traefikLogs({})).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(mocks.getTraefikLogs).not.toHaveBeenCalled();
	});

	it("refuses anonymous callers before reading anything", async () => {
		const caller = appRouter.createCaller({
			db: {},
			req: {},
			res: {},
			session: null,
			user: null,
		} as never);

		await expect(caller.domainOverview.list()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		await expect(caller.domainOverview.traefikLogs({})).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(mocks.getDomainOverview).not.toHaveBeenCalled();
		expect(mocks.getTraefikLogs).not.toHaveBeenCalled();
	});

	it("returns the overview to an admin for the active organization", async () => {
		const result = await createCaller("admin").domainOverview.list();

		expect(result).toEqual({ rows: [], serverErrors: [] });
		expect(mocks.getDomainOverview).toHaveBeenCalledWith(
			"org-1",
			expect.objectContaining({
				canReadCertificates: true,
				canReadHost: expect.any(Function),
			}),
		);
	});

	it("gives a member with Traefik file access the remote servers only", async () => {
		await createCaller("member", { traefikFiles: true }).domainOverview.list();
		const access = overviewAccess();

		await expect(access.canReadHost(null)).resolves.toBe(false);
		await expect(access.canReadHost("server-1")).resolves.toBe(true);
		await expect(access.canReadHost("server-9")).resolves.toBe(false);
	});

	it("keeps certificate data closed for a member even with an open super session", async () => {
		await createCaller("member", { traefikFiles: true }).domainOverview.list();

		expect(overviewAccess().canReadCertificates).toBe(false);
	});

	it("keeps certificate data closed while the owner's super session is closed", async () => {
		mocks.checkProtectedResourceAccess.mockResolvedValue(
			"super-session-required",
		);

		await createCaller("owner").domainOverview.list();

		expect(overviewAccess().canReadCertificates).toBe(false);
	});

	it("opens certificate data to an owner with an open super session", async () => {
		await createCaller("owner").domainOverview.list();

		expect(overviewAccess().canReadCertificates).toBe(true);
		expect(mocks.checkProtectedResourceAccess).toHaveBeenCalledWith({
			userId: "user-1",
			viaApiKey: false,
		});
	});

	it("never opens certificate data through an API key", async () => {
		mocks.checkProtectedResourceAccess.mockImplementation(
			async ({ viaApiKey }: { viaApiKey: boolean }) =>
				viaApiKey ? "browser-session-required" : null,
		);

		await createCaller("owner", {
			authMethod: "api-key",
		}).domainOverview.list();

		expect(overviewAccess().canReadCertificates).toBe(false);
		expect(mocks.checkProtectedResourceAccess).toHaveBeenCalledWith({
			userId: "user-1",
			viaApiKey: true,
		});
	});

	it("passes a remote server to the Traefik logs for a member with Traefik file access", async () => {
		const caller = createCaller("member", { traefikFiles: true });

		await caller.domainOverview.traefikLogs({ serverId: "server-1" });

		expect(mocks.getTraefikLogs).toHaveBeenCalledWith("org-1", "server-1");
	});

	it("refuses the panel's own host to a member with Traefik file access", async () => {
		const caller = createCaller("member", { traefikFiles: true });

		await expect(caller.domainOverview.traefikLogs({})).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			message: "Local host operations require owner or admin access",
		});
		expect(mocks.getTraefikLogs).not.toHaveBeenCalled();
	});

	it("refuses Traefik logs for a server outside the active organization", async () => {
		await expect(
			createCaller("admin").domainOverview.traefikLogs({
				serverId: "server-9",
			}),
		).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this server",
		});
		expect(mocks.getTraefikLogs).not.toHaveBeenCalled();
	});

	it("reads the local host when no server is chosen", async () => {
		await createCaller("owner").domainOverview.traefikLogs({});

		expect(mocks.getTraefikLogs).toHaveBeenCalledWith("org-1", null);
	});

	it("classifies the certificate deletion as a write", async () => {
		const { PROCEDURE_ACCESS } = await import(
			"@/server/api/utils/procedure-access"
		);

		expect(PROCEDURE_ACCESS["domainOverview.deleteUnusedCertificates"]).toBe(
			"write",
		);
	});
});

describe("domain overview certificate deletion access", () => {
	const input = { serverId: "server-1", domains: ["old.example.com"] };

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findServers.mockResolvedValue([
			{ serverId: "server-1" },
			{ serverId: "server-2" },
		]);
		mocks.hasValidLicense.mockResolvedValue(false);
		mocks.checkProtectedResourceAccess.mockResolvedValue(null);
		mocks.deleteUnusedCertificates.mockResolvedValue({
			status: "deleted",
			code: "ok",
			message: "done",
			backupFile: "acme.json.bak-20261012T101500Z",
			logFile: null,
		});
	});

	it("refuses a member without Traefik file access", async () => {
		await expect(
			createCaller("member").domainOverview.deleteUnusedCertificates(input),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.deleteUnusedCertificates).not.toHaveBeenCalled();
	});

	it("refuses a member with Traefik file access because the certificate file is protected", async () => {
		await expect(
			createCaller("member", {
				traefikFiles: true,
			}).domainOverview.deleteUnusedCertificates(input),
		).rejects.toBeDefined();
		expect(mocks.deleteUnusedCertificates).not.toHaveBeenCalled();
	});

	it("refuses an admin without an open super session", async () => {
		mocks.checkProtectedResourceAccess.mockResolvedValue(
			"super-session-required",
		);

		await expect(
			createCaller("admin").domainOverview.deleteUnusedCertificates(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.deleteUnusedCertificates).not.toHaveBeenCalled();
		expect(mocks.createAuditLog).not.toHaveBeenCalled();
	});

	it("refuses a server outside the active organization", async () => {
		await expect(
			createCaller("admin").domainOverview.deleteUnusedCertificates({
				serverId: "server-9",
				domains: ["old.example.com"],
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.deleteUnusedCertificates).not.toHaveBeenCalled();
	});

	it("deletes for an admin with an open super session and audits who, where, what and the result", async () => {
		mocks.hasValidLicense.mockResolvedValue(true);

		const result =
			await createCaller("admin").domainOverview.deleteUnusedCertificates(
				input,
			);

		expect(result).toMatchObject({ status: "deleted" });
		expect(mocks.deleteUnusedCertificates).toHaveBeenCalledWith(
			"org-1",
			"server-1",
			["old.example.com"],
		);
		expect(mocks.createAuditLog).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				userId: "user-1",
				userEmail: "operator@example.test",
				action: "delete",
				resourceType: "certificate",
				resourceName: "old.example.com",
				metadata: expect.objectContaining({
					serverId: "server-1",
					domains: ["old.example.com"],
					result: "deleted",
					backupFile: "acme.json.bak-20261012T101500Z",
				}),
			}),
		);
	});

	it("audits a refused request", async () => {
		mocks.deleteUnusedCertificates.mockResolvedValue({
			status: "refused",
			refused: [{ domain: "old.example.com", reason: "in_use", message: "x" }],
		});

		await createCaller("admin").domainOverview.deleteUnusedCertificates(input);

		expect(mocks.createAuditLog).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({ result: "refused" }),
			}),
		);
	});

	it("audits a failure of the service and rethrows it", async () => {
		mocks.deleteUnusedCertificates.mockRejectedValue(new Error("boom"));

		await expect(
			createCaller("admin").domainOverview.deleteUnusedCertificates(input),
		).rejects.toThrow("boom");
		expect(mocks.createAuditLog).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({ result: "error" }),
			}),
		);
	});

	it("rejects an empty or oversized list", async () => {
		await expect(
			createCaller("admin").domainOverview.deleteUnusedCertificates({
				serverId: "server-1",
				domains: [],
			}),
		).rejects.toBeDefined();
		expect(mocks.deleteUnusedCertificates).not.toHaveBeenCalled();
	});
});

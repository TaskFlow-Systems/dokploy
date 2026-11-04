import { REDACTED_SECRET_VALUE } from "@dokploy/server/utils/security/redaction";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	audit: vi.fn(),
	checkServiceAccess: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	findLibsqlById: vi.fn(),
	hasPermission: vi.fn(),
	noop: vi.fn(),
	updateLibsqlById: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findApplicationById: mocks.noop,
	findComposeById: mocks.noop,
	findLibsqlById: mocks.findLibsqlById,
	findMariadbById: mocks.noop,
	findMongoById: mocks.noop,
	findMySqlById: mocks.noop,
	findPostgresById: mocks.noop,
	findRedisById: mocks.noop,
	updateLibsqlById: mocks.updateLibsqlById,
}));

vi.mock("@dokploy/server/db", () => ({ db: {} }));

vi.mock("@dokploy/server/services/permission", () => ({
	addNewService: mocks.noop,
	checkServiceAccess: mocks.checkServiceAccess,
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
	findMemberByUserId: mocks.noop,
	hasPermission: mocks.hasPermission,
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

vi.mock("@/server/db", () => ({ db: {} }));

const { libsqlRouter } = await import("../../server/api/routers/libsql");

const STORED = "http://panel:secret@primary:5001";
const SHOWN = `http://panel:${REDACTED_SECRET_VALUE}@primary:5001`;

const caller = () =>
	libsqlRouter.createCaller({
		db: {},
		req: {},
		res: {},
		session: {
			activeOrganizationId: "org-1",
			id: "session-1",
			userId: "user-1",
		},
		user: { id: "user-1", ownerId: "user-1", role: "owner" },
	} as never);

const saved = () => mocks.updateLibsqlById.mock.calls[0]?.[1];

describe("libsql primary URL", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkServiceAccess.mockResolvedValue(undefined);
		mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
		mocks.hasPermission.mockResolvedValue(false);
		mocks.findLibsqlById.mockResolvedValue({
			libsqlId: "libsql-1",
			appName: "replica",
			databasePassword: "own",
			env: null,
			sqldNode: "replica",
			sqldPrimaryUrl: STORED,
			environment: {
				env: null,
				project: { env: null, organizationId: "org-1" },
			},
		});
		mocks.updateLibsqlById.mockResolvedValue({
			libsqlId: "libsql-1",
			appName: "replica",
		});
	});

	it("reads with the password hidden and the host readable", async () => {
		const libsql = await caller().one({ libsqlId: "libsql-1" });

		expect(libsql.sqldPrimaryUrl).toBe(SHOWN);
		expect(JSON.stringify(libsql)).not.toContain("secret");
	});

	it("saves only after the check libsql.update has always made", async () => {
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new Error("no permission"),
		);

		await expect(
			caller().update({
				libsqlId: "libsql-1",
				sqldPrimaryUrl: "http://fixed:5001",
			}),
		).rejects.toThrow("no permission");

		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"libsql-1",
			{ service: ["create"] },
		);
		expect(mocks.updateLibsqlById).not.toHaveBeenCalled();
	});

	it("saves a corrected URL", async () => {
		await caller().update({
			libsqlId: "libsql-1",
			sqldPrimaryUrl: "http://fixed:5001",
		});

		expect(saved().sqldPrimaryUrl).toBe("http://fixed:5001");
	});

	it("keeps the stored password when the URL comes back as it was shown", async () => {
		await caller().update({ libsqlId: "libsql-1", sqldPrimaryUrl: SHOWN });

		expect(saved().sqldPrimaryUrl).toBe(STORED);
	});

	it("does not send the stored password to a host the caller picks", async () => {
		const elsewhere = `http://panel:${REDACTED_SECRET_VALUE}@elsewhere:5001`;

		await caller().update({ libsqlId: "libsql-1", sqldPrimaryUrl: elsewhere });

		expect(saved().sqldPrimaryUrl).toBe(elsewhere);
	});

	it("leaves the URL alone when another field is saved", async () => {
		await caller().update({ libsqlId: "libsql-1", command: "" });

		expect(saved().sqldPrimaryUrl).toBeUndefined();
		expect(saved().command).toBe("");
	});

	// Both have zod defaults, which .partial() keeps. A save of anything would turn
	// namespaces off on the next deploy.
	it.each([
		["the primary URL", { sqldPrimaryUrl: "http://fixed:5001" }],
		["the custom command", { command: "" }],
		["the name", { name: "renamed" }],
	])(
		"does not touch namespaces or the image when %s is saved",
		async (_, fields) => {
			await caller().update({ libsqlId: "libsql-1", ...fields });

			expect(saved()).not.toHaveProperty("enableNamespaces");
			expect(saved()).not.toHaveProperty("dockerImage");
		},
	);

	it("still saves namespaces and the image when they are sent", async () => {
		await caller().update({
			libsqlId: "libsql-1",
			enableNamespaces: true,
			dockerImage: "custom:1",
		});

		expect(saved().enableNamespaces).toBe(true);
		expect(saved().dockerImage).toBe("custom:1");
	});
});

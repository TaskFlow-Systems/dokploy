import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MemberRow = {
	id: string;
	role: string;
	organizationId: string;
	userId: string;
	user: { email: string };
};

const mocks = vi.hoisted(() => ({
	members: [] as MemberRow[],
	customRoles: {} as Record<string, Record<string, string[]>>,
	memberFindFirst: vi.fn(),
	userFindFirst: vi.fn(),
	invitationFindFirst: vi.fn(),
	orgRoleFindFirst: vi.fn(),
	orgRoleFindMany: vi.fn(),
	updateSet: vi.fn(),
	insertValues: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			member: { findFirst: mocks.memberFindFirst },
			user: { findFirst: mocks.userFindFirst },
			invitation: { findFirst: mocks.invitationFindFirst },
			organizationRole: {
				findFirst: mocks.orgRoleFindFirst,
				findMany: mocks.orgRoleFindMany,
			},
		},
		update: vi.fn(() => ({
			set: (...args: unknown[]) => {
				mocks.updateSet(...args);
				return { where: () => Promise.resolve() };
			},
		})),
		insert: vi.fn(() => ({
			values: (...args: unknown[]) => {
				mocks.insertValues(...args);
				return { returning: () => Promise.resolve([{ id: "invite-1" }]) };
			},
		})),
	},
}));

vi.mock("@dokploy/server/index", () => ({ IS_CLOUD: false }));

// The real assertRoleAssignmentAllowed runs against the tables above; only the
// procedure's own permission gate is stubbed.
vi.mock("@dokploy/server/services/permission", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/permission")
	>()),
	checkPermission: vi.fn(async () => undefined),
}));

vi.mock(
	"@dokploy/server/services/proprietary/license-key",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@dokploy/server/services/proprietary/license-key")
		>()),
		hasValidLicense: vi.fn(async () => true),
	}),
);

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));
vi.mock("@/server/api/utils/plan-limits", () => ({
	assertMemberLimit: vi.fn(async () => undefined),
}));

const { organizationRouter } = await import(
	"@/server/api/routers/organization"
);

const render = (where: SQL) => new PgDialect().sqlToQuery(where);

const findMember = ({ where }: { where: SQL }) => {
	const { sql, params } = render(where);
	if (sql === '"member"."id" = $1') {
		return Promise.resolve(mocks.members.find((row) => row.id === params[0]));
	}
	if (sql === '("member"."user_id" = $1 and "member"."organization_id" = $2)') {
		return Promise.resolve(
			mocks.members.find(
				(row) => row.userId === params[0] && row.organizationId === params[1],
			),
		);
	}
	throw new Error(`Unexpected member query: ${sql}`);
};

const findCustomRoles = ({ where }: { where: SQL }) => {
	const { sql, params } = render(where);
	expect(sql).toBe(
		'("organization_role"."organization_id" = $1 and "organization_role"."role" = $2)',
	);
	const permission = mocks.customRoles[params[1] as string];
	return Promise.resolve(
		params[0] === "org-a" && permission
			? [{ role: params[1], permission: JSON.stringify(permission) }]
			: [],
	);
};

const callerAs = (role: string, userId = "caller-1") => {
	mocks.members.push({
		id: "member-1",
		role,
		organizationId: "org-a",
		userId,
		user: { email: "caller@example.com" },
	});
	return organizationRouter.createCaller({
		user: { id: userId, role },
		session: { activeOrganizationId: "org-a" },
	} as never);
};

const targetMember = (role: string) => {
	mocks.members.push({
		id: "member-2",
		role,
		organizationId: "org-a",
		userId: "victim-1",
		user: { email: "victim@example.com" },
	});
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.members = [];
	mocks.customRoles = {
		deployer: { deployment: ["read", "create"] },
		"user-manager": {
			member: ["read", "update", "create"],
			deployment: ["read", "create"],
		},
		"server-operator": {
			deployment: ["read", "create"],
			server: ["read", "execute"],
		},
	};
	mocks.memberFindFirst.mockImplementation(findMember);
	mocks.orgRoleFindMany.mockImplementation(findCustomRoles);
	mocks.orgRoleFindFirst.mockResolvedValue({ role: "deployer" });
	mocks.userFindFirst.mockResolvedValue(undefined);
	mocks.invitationFindFirst.mockResolvedValue(undefined);
});

describe("updateMemberRole — privileged roles keep working", () => {
	it("owner can promote a member to admin", async () => {
		targetMember("member");
		await expect(
			callerAs("owner").updateMemberRole({
				memberId: "member-2",
				role: "admin",
			}),
		).resolves.toBe(true);
		expect(mocks.updateSet).toHaveBeenCalledWith({ role: "admin" });
	});

	it("admin can assign a custom role to a member", async () => {
		targetMember("member");
		await expect(
			callerAs("admin").updateMemberRole({
				memberId: "member-2",
				role: "deployer",
			}),
		).resolves.toBe(true);
		expect(mocks.updateSet).toHaveBeenCalledWith({ role: "deployer" });
	});

	it("a custom role with member:update can still assign a non-admin custom role", async () => {
		targetMember("member");
		await expect(
			callerAs("user-manager").updateMemberRole({
				memberId: "member-2",
				role: "deployer",
			}),
		).resolves.toBe(true);
		expect(mocks.updateSet).toHaveBeenCalledWith({ role: "deployer" });
	});
});

describe("updateMemberRole — privilege escalation is blocked", () => {
	it("an admin cannot promote a member to admin: only the owner grants it", async () => {
		targetMember("member");
		await expect(
			callerAs("admin").updateMemberRole({
				memberId: "member-2",
				role: "admin",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateSet).not.toHaveBeenCalled();
	});

	it("a custom role cannot promote a member to admin", async () => {
		targetMember("member");
		await expect(
			callerAs("user-manager").updateMemberRole({
				memberId: "member-2",
				role: "admin",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateSet).not.toHaveBeenCalled();
	});

	it("a custom role cannot demote an existing admin", async () => {
		targetMember("admin");
		await expect(
			callerAs("user-manager").updateMemberRole({
				memberId: "member-2",
				role: "member",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateSet).not.toHaveBeenCalled();
	});

	it("an admin cannot change another admin's role (pre-existing rule)", async () => {
		targetMember("admin");
		await expect(
			callerAs("admin").updateMemberRole({
				memberId: "member-2",
				role: "member",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateSet).not.toHaveBeenCalled();
	});

	it("a custom role cannot hand out permissions it does not have", async () => {
		targetMember("member");
		await expect(
			callerAs("user-manager").updateMemberRole({
				memberId: "member-2",
				role: "server-operator",
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Cannot assign a role with permissions you do not have",
		});
		expect(mocks.updateSet).not.toHaveBeenCalled();
	});

	it("a role that does not exist in the organization cannot be assigned", async () => {
		targetMember("member");
		await expect(
			callerAs("admin").updateMemberRole({
				memberId: "member-2",
				role: "ghost",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.updateSet).not.toHaveBeenCalled();
	});
});

describe("inviteMember — admin ceiling", () => {
	it("a custom role cannot invite an admin", async () => {
		await expect(
			callerAs("user-manager").inviteMember({
				email: "new@example.com",
				role: "admin",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.insertValues).not.toHaveBeenCalled();
	});

	it("an admin cannot invite an admin", async () => {
		await expect(
			callerAs("admin").inviteMember({
				email: "new@example.com",
				role: "admin",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.insertValues).not.toHaveBeenCalled();
	});

	it("a custom role cannot invite with a role above its own permissions", async () => {
		await expect(
			callerAs("user-manager").inviteMember({
				email: "new@example.com",
				role: "server-operator",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.insertValues).not.toHaveBeenCalled();
	});
});

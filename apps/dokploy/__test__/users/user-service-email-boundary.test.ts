import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

type InvitationRow = { email: string; status: string; expiresAt: Date };

const mocks = vi.hoisted(() => ({
	dbUpdate: vi.fn(),
	updateReturning: vi.fn(),
	updateSet: vi.fn(),
	updateWhere: vi.fn(),
	findUser: vi.fn(),
	findInvitation: vi.fn(),
	invitations: [] as InvitationRow[],
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		update: mocks.dbUpdate,
		query: {
			user: { findFirst: mocks.findUser },
			invitation: { findFirst: mocks.findInvitation },
		},
	},
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	auth: {},
}));

const { updateUser } = await import("@dokploy/server/services/user");

// The mock answers like the database would, so the case for an expired
// invitation depends on the query's own expiry condition.
const findPendingInvitation = ({ where }: { where: SQL }) => {
	const { sql, params } = new PgDialect().sqlToQuery(where);
	expect(sql).toBe(
		'(lower("invitation"."email") = $1 and "invitation"."status" = $2 and "invitation"."expires_at" > $3)',
	);
	const [email, status, now] = params as [string, string, string | Date];
	const nowTime = new Date(now).getTime();
	return Promise.resolve(
		mocks.invitations.find(
			(row) =>
				row.email.toLowerCase() === email &&
				row.status === status &&
				row.expiresAt.getTime() > nowTime,
		),
	);
};

describe("updateUser email verification boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.invitations = [];
		mocks.findUser.mockResolvedValue({ email: "old@example.com" });
		mocks.findInvitation.mockImplementation(findPendingInvitation);
		mocks.dbUpdate.mockReturnValue({
			set: mocks.updateSet,
		});
		mocks.updateSet.mockReturnValue({
			where: mocks.updateWhere,
		});
		mocks.updateWhere.mockReturnValue({
			returning: mocks.updateReturning,
		});
		mocks.updateReturning.mockResolvedValue([{ id: "user-1" }]);
	});

	it("resets emailVerified when the profile email changes", async () => {
		await updateUser("user-1", {
			email: "new@example.com",
			firstName: "Ada",
		});

		expect(mocks.findInvitation).toHaveBeenCalledTimes(1);
		expect(mocks.updateSet).toHaveBeenCalledWith({
			email: "new@example.com",
			firstName: "Ada",
			emailVerified: false,
		});
	});

	it("refuses an email that has a pending, unexpired invitation", async () => {
		mocks.invitations = [
			{
				email: "invitee@example.com",
				status: "pending",
				expiresAt: new Date(Date.now() + 60 * 60 * 1000),
			},
		];

		await expect(
			updateUser("user-1", { email: "Invitee@Example.com" }),
		).rejects.toThrow("This email address can't be used");

		expect(mocks.dbUpdate).not.toHaveBeenCalled();
		expect(mocks.updateSet).not.toHaveBeenCalled();
	});

	it("lets an email through when its pending invitation has expired", async () => {
		mocks.invitations = [
			{
				email: "invitee@example.com",
				status: "pending",
				expiresAt: new Date(Date.now() - 60 * 1000),
			},
		];

		await updateUser("user-1", { email: "invitee@example.com" });

		expect(mocks.findInvitation).toHaveBeenCalledTimes(1);
		expect(mocks.updateSet).toHaveBeenCalledWith({
			email: "invitee@example.com",
			emailVerified: false,
		});
	});

	it("does not change emailVerified for profile updates without email", async () => {
		await updateUser("user-1", {
			firstName: "Ada",
			lastName: "Lovelace",
		});

		expect(mocks.findUser).not.toHaveBeenCalled();
		expect(mocks.findInvitation).not.toHaveBeenCalled();
		expect(mocks.updateSet).toHaveBeenCalledWith({
			firstName: "Ada",
			lastName: "Lovelace",
		});
	});
});

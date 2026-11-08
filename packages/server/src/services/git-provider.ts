import { db } from "@dokploy/server/db";
import { gitProvider, member } from "@dokploy/server/db/schema";
import { hasValidLicense } from "@dokploy/server/services/proprietary/license-key";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";

export type GitProvider = typeof gitProvider.$inferSelect;
type GitProviderSession = {
	userId: string;
	activeOrganizationId: string;
};

const githubSecretKeys = [
	"githubClientSecret",
	"githubPrivateKey",
	"githubWebhookSecret",
] as const;

const gitlabSecretKeys = [
	"secret",
	"webhookSecret",
	"accessToken",
	"refreshToken",
] as const;

const giteaSecretKeys = [
	"clientSecret",
	"webhookSecret",
	"accessToken",
	"refreshToken",
] as const;

const bitbucketSecretKeys = ["appPassword", "apiToken"] as const;

const omitKeys = <T extends object>(value: T, keys: readonly string[]) => {
	const redacted = { ...value } as Record<string, unknown>;
	for (const key of keys) {
		delete redacted[key];
	}
	return redacted as T;
};

const redactNullable = <T extends object | null | undefined>(
	value: T,
	keys: readonly string[],
) => {
	if (!value) {
		return value;
	}
	return omitKeys(value, keys);
};

export const redactGithubProvider = <T extends object | null | undefined>(
	provider: T,
) => redactNullable(provider, githubSecretKeys);

export const redactGitlabProvider = <T extends object | null | undefined>(
	provider: T,
) => redactNullable(provider, gitlabSecretKeys);

export const redactGiteaProvider = <T extends object | null | undefined>(
	provider: T,
) => redactNullable(provider, giteaSecretKeys);

export const redactBitbucketProvider = <T extends object | null | undefined>(
	provider: T,
) => redactNullable(provider, bitbucketSecretKeys);

export const redactGitProviderSecrets = <
	T extends {
		github?: object | null;
		gitlab?: object | null;
		bitbucket?: object | null;
		gitea?: object | null;
	},
>(
	entity: T,
) => ({
	...entity,
	github: redactGithubProvider(entity.github),
	gitlab: redactGitlabProvider(entity.gitlab),
	bitbucket: redactBitbucketProvider(entity.bitbucket),
	gitea: redactGiteaProvider(entity.gitea),
});

export const removeGitProvider = async (gitProviderId: string) => {
	const result = await db
		.delete(gitProvider)
		.where(eq(gitProvider.gitProviderId, gitProviderId))
		.returning();

	return result[0];
};

export const findGitProviderById = async (gitProviderId: string) => {
	const result = await db.query.gitProvider.findFirst({
		where: eq(gitProvider.gitProviderId, gitProviderId),
	});

	if (!result) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Git Provider not found",
		});
	}
	return result;
};

export const updateGitProvider = async (
	gitProviderId: string,
	input: Partial<GitProvider>,
) => {
	return await db
		.update(gitProvider)
		.set({
			...input,
		})
		.where(eq(gitProvider.gitProviderId, gitProviderId))
		.returning()
		.then((response) => response[0]);
};

// Returns true if the user can edit the git source configuration of an existing
// deploy that is connected to the given provider.
// Owner/admin: always yes.
// Member: only if they own the provider or it's shared with the org.
// Being in accessedGitProviders only grants permission to connect NEW deploys,
// not to modify the git config of an existing deploy owned by someone else.
export const canEditDeployGitSource = async (
	gitProviderId: string,
	session: { userId: string; activeOrganizationId: string },
): Promise<boolean> => {
	const { userId, activeOrganizationId } = session;

	const memberRecord = await db.query.member.findFirst({
		where: and(
			eq(member.userId, userId),
			eq(member.organizationId, activeOrganizationId),
		),
		columns: { role: true },
	});

	if (memberRecord?.role === "owner") return true;

	const provider = await db.query.gitProvider.findFirst({
		where: eq(gitProvider.gitProviderId, gitProviderId),
		columns: { userId: true, sharedWithOrganization: true },
	});

	if (!provider) return false;

	return provider.userId === userId || provider.sharedWithOrganization;
};

export const getAccessibleGitProviderIds = async (session: {
	userId: string;
	activeOrganizationId: string;
}): Promise<Set<string>> => {
	const { userId, activeOrganizationId } = session;

	const allOrgProviders = await db.query.gitProvider.findMany({
		where: eq(gitProvider.organizationId, activeOrganizationId),
		columns: {
			gitProviderId: true,
			userId: true,
			sharedWithOrganization: true,
		},
	});

	const memberRecord = await db.query.member.findFirst({
		where: and(
			eq(member.userId, userId),
			eq(member.organizationId, activeOrganizationId),
		),
		columns: { accessedGitProviders: true, role: true },
	});

	if (memberRecord?.role === "owner" || memberRecord?.role === "admin") {
		return new Set(allOrgProviders.map((p) => p.gitProviderId));
	}

	const licensed = await hasValidLicense(activeOrganizationId);
	const assignedSet = licensed
		? new Set(memberRecord?.accessedGitProviders ?? [])
		: new Set<string>();

	const result = new Set<string>();
	for (const p of allOrgProviders) {
		if (
			p.userId === userId ||
			p.sharedWithOrganization ||
			assignedSet.has(p.gitProviderId)
		) {
			result.add(p.gitProviderId);
		}
	}
	return result;
};

/**
 * Authorizes read access to a specific git provider for the current session.
 * Throws if the provider belongs to a different organization (cross-org IDOR)
 * or if the caller is not entitled to it within the active organization.
 *
 * This only proves the caller may *use* the provider (e.g. pick it as a repo
 * source when creating a deploy) - it does NOT mean they may see its raw
 * credentials. Being able to use a shared provider and being able to read its
 * OAuth tokens / client secrets / private keys are different privileges; gate
 * the latter with canViewGitProviderSecrets before returning secret fields.
 */
export async function assertGitProviderAccess(
	gitProviderId: string | null | undefined,
	session: GitProviderSession,
): Promise<void>;
export async function assertGitProviderAccess(
	session: GitProviderSession,
	provider: { gitProviderId: string; organizationId: string },
): Promise<void>;
export async function assertGitProviderAccess(
	a: GitProviderSession | string | null | undefined,
	b: GitProviderSession | { gitProviderId: string; organizationId: string },
): Promise<void> {
	if (typeof a === "string" || a == null) {
		const gitProviderId = a;
		const session = b as GitProviderSession;
		if (!gitProviderId) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Git Provider not found",
			});
		}
		const accessibleIds = await getAccessibleGitProviderIds(session);
		if (!accessibleIds.has(gitProviderId)) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You are not authorized to access this Git provider",
			});
		}
		return;
	}
	const session = a as GitProviderSession;
	const provider = b as { gitProviderId: string; organizationId: string };
	if (provider.organizationId !== session.activeOrganizationId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Git provider not found",
		});
	}
	const accessibleIds = await getAccessibleGitProviderIds(session);
	if (!accessibleIds.has(provider.gitProviderId)) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "You don't have access to this git provider",
		});
	}
}

export const assertGitProviderManagementAccess = async (
	gitProviderId: string | null | undefined,
	session: GitProviderSession,
) => {
	if (!gitProviderId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Git Provider not found",
		});
	}

	const memberRecord = await db.query.member.findFirst({
		where: and(
			eq(member.userId, session.userId),
			eq(member.organizationId, session.activeOrganizationId),
		),
		columns: {
			role: true,
		},
	});

	if (memberRecord?.role === "owner" || memberRecord?.role === "admin") {
		return;
	}

	const gitProviderRecord = await db.query.gitProvider.findFirst({
		where: eq(gitProvider.gitProviderId, gitProviderId),
		columns: {
			userId: true,
			organizationId: true,
		},
	});

	if (
		!gitProviderRecord ||
		gitProviderRecord.organizationId !== session.activeOrganizationId ||
		gitProviderRecord.userId !== session.userId
	) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to manage this Git provider",
		});
	}
};

// Being allowed to use a shared provider (assertGitProviderAccess) must not
// imply being allowed to read its raw OAuth tokens / client secrets / private
// keys. Only the provider's owner or an org owner/admin gets those back.
export const canViewGitProviderSecrets = async (
	session: { userId: string; activeOrganizationId: string },
	provider: { userId: string; organizationId: string },
): Promise<boolean> => {
	if (provider.organizationId !== session.activeOrganizationId) return false;
	if (provider.userId === session.userId) return true;

	const memberRecord = await db.query.member.findFirst({
		where: and(
			eq(member.userId, session.userId),
			eq(member.organizationId, session.activeOrganizationId),
		),
		columns: { role: true },
	});

	return memberRecord?.role === "owner" || memberRecord?.role === "admin";
};

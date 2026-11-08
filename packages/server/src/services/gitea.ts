import { db } from "@dokploy/server/db";
import {
	type apiCreateGitea,
	gitea,
	gitProvider,
} from "@dokploy/server/db/schema";
import {
	assertStoredSecretTargetUnchanged,
	changedSecretTargetFields,
	secretUpdateValue,
} from "@dokploy/server/utils/security/redaction";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { z } from "zod";

export type Gitea = typeof gitea.$inferSelect;

export const createGitea = async (
	input: z.infer<typeof apiCreateGitea>,
	organizationId: string,
	userId: string,
) => {
	return await db.transaction(async (tx) => {
		const { webhookSecret, ...giteaInput } = input;
		const newGitProvider = await tx
			.insert(gitProvider)
			.values({
				providerType: "gitea",
				organizationId: organizationId,
				name: input.name,
				userId: userId,
			})
			.returning()
			.then((response) => response[0]);

		if (!newGitProvider) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the Git provider",
			});
		}

		const giteaProvider = await tx
			.insert(gitea)
			.values({
				...giteaInput,
				gitProviderId: newGitProvider?.gitProviderId,
				webhookSecret: secretUpdateValue(webhookSecret),
			})
			.returning()
			.then((response: (typeof gitea.$inferSelect)[]) => response[0]);

		if (!giteaProvider) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the Gitea provider",
			});
		}

		return {
			giteaId: giteaProvider.giteaId,
			clientId: giteaProvider.clientId,
			giteaUrl: giteaProvider.giteaUrl,
		};
	});
};

export const findGiteaById = async (giteaId: string) => {
	try {
		const giteaProviderResult = await db.query.gitea.findFirst({
			where: eq(gitea.giteaId, giteaId),
			with: {
				gitProvider: true,
			},
		});

		if (!giteaProviderResult) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Gitea Provider not found",
			});
		}

		return giteaProviderResult;
	} catch (error) {
		throw error;
	}
};

export const findGiteaGitProviderId = async (giteaId: string) => {
	const giteaProviderResult = await db.query.gitea.findFirst({
		where: eq(gitea.giteaId, giteaId),
		columns: {
			gitProviderId: true,
		},
	});

	if (!giteaProviderResult) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Gitea Provider not found",
		});
	}

	return giteaProviderResult.gitProviderId;
};

const giteaTargetFields = ["giteaUrl", "giteaInternalUrl", "clientId"] as const;

// OAuth tokens and the client secret are sent to the Gitea URL, so a caller
// may only move the provider to another URL by entering the secret again, and
// tokens issued by the old instance are dropped.
const bindStoredGiteaSecrets = async (
	giteaId: string,
	input: Partial<Gitea>,
) => {
	if (giteaTargetFields.every((field) => input[field] === undefined)) {
		return {};
	}
	const current = await db.query.gitea.findFirst({
		where: eq(gitea.giteaId, giteaId),
	});
	if (!current) {
		return {};
	}

	const targets = Object.fromEntries(
		giteaTargetFields.map((field) => [
			field,
			[
				input[field] === undefined ? current[field] : input[field],
				current[field],
			] as const,
		]),
	);
	if (
		current.clientSecret &&
		secretUpdateValue(input.clientSecret) === undefined
	) {
		assertStoredSecretTargetUnchanged("Gitea client secret", targets);
	}

	const urlChanged = changedSecretTargetFields(targets).some(
		(field) => field !== "clientId",
	);
	return urlChanged
		? {
				accessToken: input.accessToken ?? null,
				refreshToken: input.refreshToken ?? null,
				expiresAt: input.expiresAt ?? null,
			}
		: {};
};

export const updateGitea = async (giteaId: string, input: Partial<Gitea>) => {
	try {
		const { clientSecret, webhookSecret, ...giteaInput } = input;
		const nextClientSecret = secretUpdateValue(clientSecret);
		const nextWebhookSecret = secretUpdateValue(webhookSecret);
		const tokenReset = await bindStoredGiteaSecrets(giteaId, input);
		const updateResult = await db
			.update(gitea)
			.set({
				...giteaInput,
				...tokenReset,
				...(nextClientSecret !== undefined && {
					clientSecret: nextClientSecret,
				}),
				...(nextWebhookSecret !== undefined && {
					webhookSecret: nextWebhookSecret,
				}),
			})
			.where(eq(gitea.giteaId, giteaId))
			.returning();

		const result = updateResult[0] as Gitea | undefined;

		if (!result) {
			throw new Error(`Failed to update Gitea provider with ID ${giteaId}`);
		}

		return result;
	} catch (error) {
		throw error;
	}
};

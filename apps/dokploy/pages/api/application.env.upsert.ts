import {
	findApplicationById,
	IS_CLOUD,
	upsertApplicationEnvironment,
	validateRequest,
} from "@dokploy/server";
import { apiUpsertApplicationEnv } from "@dokploy/server/db/schema";
import { assertDeploymentNotFrozen } from "@dokploy/server/services/deployment-freeze";
import { resetKnownSecretMatcherCache } from "@dokploy/server/services/known-secrets";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { appendForcedFreezeNote } from "@dokploy/server/utils/deployments/deploy-freeze-shared";
import { TRPCError } from "@trpc/server";
import type { NextApiRequest, NextApiResponse } from "next";
import { ZodError } from "zod";
import { audit } from "@/server/api/utils/audit";
import { resolveForcedDeployAuditMetadata } from "@/server/api/utils/deploy-freeze-audit";
import type { DeploymentJob } from "@/server/queues/queue-types";
import { myQueue } from "@/server/queues/queueSetup";
import { deploy } from "@/server/utils/deploy";

const getErrorStatus = (error: unknown) => {
	if (error instanceof ZodError) {
		return 400;
	}

	if (!(error instanceof TRPCError)) {
		return 500;
	}

	switch (error.code) {
		case "BAD_REQUEST":
			return 400;
		case "UNAUTHORIZED":
			return 403;
		case "NOT_FOUND":
			return 404;
		case "CONFLICT":
			return 409;
		case "PRECONDITION_FAILED":
			return 412;
		default:
			return 500;
	}
};

const getErrorMessage = (error: unknown) => {
	if (error instanceof ZodError) {
		return "Invalid request body";
	}

	if (error instanceof Error) {
		return error.message;
	}

	return "Internal server error";
};

export const handleApplicationEnvUpsert = async (
	req: NextApiRequest,
	res: NextApiResponse,
) => {
	if (req.method !== "POST") {
		res.setHeader("Allow", "POST");
		res.status(405).json({ message: "Method Not Allowed" });
		return;
	}

	const { session, user } = await validateRequest(req);

	if (!user || !session) {
		res.status(401).json({ message: "Unauthorized" });
		return;
	}

	const ctx = {
		session: {
			...session,
			activeOrganizationId: session.activeOrganizationId || "",
		},
		user: {
			...user,
			role: user.role as "owner" | "member" | "admin",
		},
	};

	try {
		const input = apiUpsertApplicationEnv.parse(req.body);

		await checkServicePermissionAndAccess(
			ctx,
			input.applicationId,
			input.redeploy
				? {
						envVars: ["write"],
						deployment: ["create"],
					}
				: {
						envVars: ["write"],
					},
		);

		const bypassedFreeze =
			input.redeploy && !input.dryRun
				? await assertDeploymentNotFrozen({
						scopeType: "application",
						scopeId: input.applicationId,
						force: input.force,
						source: "api",
					})
				: null;

		const result = await upsertApplicationEnvironment(input);
		let redeployed = false;

		if (!result.dryRun && result.changed) {
			resetKnownSecretMatcherCache();
			const application = await findApplicationById(input.applicationId);

			await audit(ctx, {
				action: "update",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});

			if (input.redeploy) {
				const forcedAuditMetadata = resolveForcedDeployAuditMetadata(
					"application.env.upsert",
					input.applicationId,
					ctx,
					bypassedFreeze,
				);
				const jobData: DeploymentJob = {
					applicationId: input.applicationId,
					titleLog: "Rebuild deployment",
					descriptionLog: appendForcedFreezeNote(
						"Environment variables updated",
						bypassedFreeze,
					),
					type: "redeploy",
					applicationType: "application",
					server: !!application.serverId,
					...(bypassedFreeze || input.force ? { bypassFreeze: true } : {}),
				};

				if (IS_CLOUD && application.serverId) {
					jobData.serverId = application.serverId;
					deploy(jobData).catch((error) => {
						console.error("Background deployment failed:", error);
					});
				} else {
					await myQueue.add(
						"deployments",
						{ ...jobData },
						{
							removeOnComplete: true,
							removeOnFail: true,
						},
					);
				}

				await audit(ctx, {
					action: "rebuild",
					resourceType: "application",
					resourceId: application.applicationId,
					resourceName: application.appName,
					...(forcedAuditMetadata ? { metadata: forcedAuditMetadata } : {}),
				});
				redeployed = true;
			}
		}

		res.status(200).json({
			...result,
			redeployed,
		});
	} catch (error) {
		res.status(getErrorStatus(error)).json({ message: getErrorMessage(error) });
	}
};

export default handleApplicationEnvUpsert;

import {
	claimDeploymentOperation,
	deployApplication,
	deployCompose,
	deployPreviewApplication,
	ExactDeploymentFinalizationError,
	finalizeDeploymentOperation,
	getEffectiveDeploymentFreeze,
	rebuildApplication,
	rebuildCompose,
	rebuildPreviewApplication,
	recordSkippedEffectiveDeploymentFreeze,
	updateApplicationStatus,
	updateCompose,
	updatePreviewDeployment,
} from "@dokploy/server";
import type { DeployJob } from "./schema.js";

export const deploy = async (job: DeployJob) => {
	try {
		if (job.applicationType === "application") {
			if (!job.bypassFreeze) {
				const { effective: activeFreeze, environmentId } =
					await getEffectiveDeploymentFreeze({
						scopeType: "application",
						scopeId: job.applicationId,
					});
				if (activeFreeze) {
					await recordSkippedEffectiveDeploymentFreeze({
						scopeType: "application",
						scopeId: job.applicationId,
						environmentId,
						source: "queue",
					});
					return true;
				}
			}
			await updateApplicationStatus(job.applicationId, "running");
			if (job.server) {
				if (job.type === "redeploy") {
					await rebuildApplication({
						applicationId: job.applicationId,
						titleLog: job.titleLog || "Rebuild deployment",
						descriptionLog: job.descriptionLog || "",
					});
				} else if (job.type === "deploy") {
					await deployApplication({
						applicationId: job.applicationId,
						titleLog: job.titleLog || "Manual deployment",
						descriptionLog: job.descriptionLog || "",
					});
				}
			}
		} else if (job.applicationType === "compose") {
			if (!job.bypassFreeze) {
				const { effective: activeFreeze, environmentId } =
					await getEffectiveDeploymentFreeze({
						scopeType: "compose",
						scopeId: job.composeId,
					});
				if (activeFreeze) {
					await recordSkippedEffectiveDeploymentFreeze({
						scopeType: "compose",
						scopeId: job.composeId,
						environmentId,
						source: "queue",
					});
					if (job.operationId) {
						const claimed = await claimDeploymentOperation(
							job.composeId,
							job.operationId,
						);
						if (claimed) {
							await finalizeDeploymentOperation(job.operationId, "failed");
						}
					}
					return true;
				}
			}
			if (job.operationId) {
				const claimed = await claimDeploymentOperation(
					job.composeId,
					job.operationId,
				);
				if (!claimed) return true;
			}
			await updateCompose(job.composeId, {
				composeStatus: "running",
			});

			if (job.operationId) {
				await deployCompose({
					composeId: job.composeId,
					titleLog: job.titleLog || "Manual deployment",
					descriptionLog: job.descriptionLog || "",
					operationId: job.operationId,
					expectedRevision: job.expectedRevision,
				});
			} else if (job.server) {
				if (job.type === "redeploy") {
					await rebuildCompose({
						composeId: job.composeId,
						titleLog: job.titleLog || "Rebuild deployment",
						descriptionLog: job.descriptionLog || "",
					});
				} else if (job.type === "deploy") {
					await deployCompose({
						composeId: job.composeId,
						titleLog: job.titleLog || "Manual deployment",
						descriptionLog: job.descriptionLog || "",
					});
				}
			}
		} else if (job.applicationType === "application-preview") {
			await updatePreviewDeployment(job.previewDeploymentId, {
				previewStatus: "running",
			});
			if (job.server) {
				if (job.type === "redeploy") {
					await rebuildPreviewApplication({
						applicationId: job.applicationId,
						titleLog: job.titleLog || "Rebuild Preview Deployment",
						descriptionLog: job.descriptionLog || "",
						previewDeploymentId: job.previewDeploymentId,
					});
				} else if (job.type === "deploy") {
					await deployPreviewApplication({
						applicationId: job.applicationId,
						titleLog: job.titleLog || "Preview Deployment",
						descriptionLog: job.descriptionLog || "",
						previewDeploymentId: job.previewDeploymentId,
					});
				}
			}
		}
	} catch (e) {
		if (job.applicationType === "application") {
			await updateApplicationStatus(job.applicationId, "error");
		} else if (job.applicationType === "compose") {
			if (job.operationId && !(e instanceof ExactDeploymentFinalizationError)) {
				await Promise.allSettled([
					finalizeDeploymentOperation(job.operationId, "failed"),
					updateCompose(job.composeId, { composeStatus: "error" }),
				]);
			} else if (!job.operationId) {
				await updateCompose(job.composeId, {
					composeStatus: "error",
				});
			}
		} else if (job.applicationType === "application-preview") {
			await updatePreviewDeployment(job.previewDeploymentId, {
				previewStatus: "error",
			});
		}

		throw e;
	}

	return true;
};

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import "dotenv/config";
import {
	assertSignedDeploymentCancelJob,
	assertSignedDeploymentJobsReadRequest,
	assertSignedDeploymentQueueJob,
} from "@dokploy/server";
import { zValidator } from "@hono/zod-validator";
import { Inngest } from "inngest";
import { serve as serveInngest } from "inngest/hono";
import { isValidApiKey } from "./auth.js";
import { logger } from "./logger.js";
import {
	type DeployJob,
	signedCancelDeploymentSchema,
	signedDeployJobSchema,
	signedDeploymentJobsReadSchema,
} from "./schema.js";
import {
	DeploymentQueueUnavailableError,
	fetchDeploymentJobs,
} from "./service.js";
import { deploy } from "./utils.js";

export const app = new Hono();

const usedDeploymentSignatures = new Map<string, number>();

const consumeDeploymentSignature = (signature: string, expiresAt: number) => {
	const now = Date.now();
	for (const [usedSignature, usedExpiresAt] of usedDeploymentSignatures) {
		if (usedExpiresAt <= now) {
			usedDeploymentSignatures.delete(usedSignature);
		}
	}
	const existingExpiresAt = usedDeploymentSignatures.get(signature);
	if (existingExpiresAt && existingExpiresAt > now) {
		throw new Error("Deployment job scoped claim has already been used");
	}
	usedDeploymentSignatures.set(signature, expiresAt);
};

// Initialize Inngest client
export const inngest = new Inngest({
	id: "dokploy-deployments",
	name: "Dokploy Deployment Service",
});

export const deploymentFunction = inngest.createFunction(
	{
		id: "deploy-application",
		name: "Deploy Application",
		concurrency: [
			{
				key: "event.data.serverId",
				limit: 1,
			},
		],
		retries: 0,
		cancelOn: [
			{
				event: "deployment/cancelled",
				if: "async.data.applicationId == event.data.applicationId || async.data.composeId == event.data.composeId",
				timeout: "1h", // Allow cancellation for up to 1 hour
			},
		],
		triggers: [{ event: "deployment/requested" }],
	},

	async ({ event, step }) => {
		const jobData = event.data as DeployJob;

		return await step.run("execute-deployment", async () => {
			logger.info("Deploying started");

			try {
				const result = await deploy(jobData);
				logger.info({ result }, "Deployment finished");

				// Send success event
				await inngest.send({
					name: "deployment/completed",
					data: {
						...jobData,
						result,
						status: "success",
					},
				});

				return result;
			} catch (error) {
				logger.error({ jobData, error }, "Deployment failed");

				// Send failure event
				await inngest.send({
					name: "deployment/failed",
					data: {
						...jobData,
						error: error instanceof Error ? error.message : String(error),
						status: "failed",
					},
				});

				throw error;
			}
		});
	},
);

if (!process.env.API_KEY) {
	console.error(
		"API_KEY is not set; all authenticated routes will be rejected",
	);
}

app.use(async (c, next) => {
	if (c.req.path === "/health" || c.req.path === "/api/inngest") {
		return next();
	}

	const authHeader = c.req.header("X-API-Key");

	if (!isValidApiKey(process.env.API_KEY, authHeader)) {
		return c.json({ message: "Invalid API Key" }, 403);
	}

	return next();
});

app.post("/deploy", zValidator("json", signedDeployJobSchema), async (c) => {
	const signedData = c.req.valid("json");
	const data = await assertSignedDeploymentQueueJob(signedData, {
		operation: "deploy",
	});
	consumeDeploymentSignature(signedData.signature, signedData.scope.expiresAt);
	logger.info({ data }, "Received deployment request");

	try {
		// Send event to Inngest instead of adding to Redis queue
		await inngest.send({
			id:
				data.applicationType === "compose" &&
				"operationId" in data &&
				data.operationId
					? `deployment:${data.operationId}`
					: `deployment:${signedData.signature}`,
			name: "deployment/requested",
			data,
		});

		logger.info(
			{
				serverId: data.serverId,
			},
			"Deployment event sent to Inngest",
		);

		return c.json(
			{
				message: "Deployment Added to Inngest Queue",
				serverId: data.serverId,
			},
			200,
		);
	} catch (error) {
		logger.error({ error }, "Failed to send deployment event");
		return c.json(
			{
				message: "Failed to queue deployment",
				error: error instanceof Error ? error.message : String(error),
			},
			500,
		);
	}
});

app.post(
	"/cancel-deployment",
	zValidator("json", signedCancelDeploymentSchema),
	async (c) => {
		const signedData = c.req.valid("json");
		const data = await assertSignedDeploymentCancelJob(signedData, {
			operation: "cancel",
		});
		consumeDeploymentSignature(
			signedData.signature,
			signedData.scope.expiresAt,
		);
		logger.info({ data }, "Received cancel deployment request");

		try {
			// Send cancellation event to Inngest

			await inngest.send({
				id: `deployment-cancel:${signedData.signature}`,
				name: "deployment/cancelled",
				data,
			});

			const identifier =
				data.applicationType === "application"
					? `applicationId: ${data.applicationId}`
					: `composeId: ${data.composeId}`;

			logger.info(
				{
					...data,
					identifier,
				},
				"Deployment cancellation event sent",
			);

			return c.json({
				message: "Deployment cancellation requested",
				applicationType: data.applicationType,
			});
		} catch (error) {
			logger.error({ error }, "Failed to send deployment cancellation event");
			return c.json(
				{
					message: "Failed to cancel deployment",
					error: error instanceof Error ? error.message : String(error),
				},
				500,
			);
		}
	},
);

app.get("/health", async (c) => {
	return c.json({ status: "ok" });
});

app.post(
	"/jobs",
	zValidator("json", signedDeploymentJobsReadSchema),
	async (c) => {
		const signedData = c.req.valid("json");
		const serverId = await assertSignedDeploymentJobsReadRequest(signedData);
		consumeDeploymentSignature(
			signedData.signature,
			signedData.scope.expiresAt,
		);

		try {
			const rows = await fetchDeploymentJobs(serverId);
			return c.json(rows);
		} catch (error) {
			if (error instanceof DeploymentQueueUnavailableError) {
				const status = error.reason === "not-configured" ? 503 : 502;
				return c.json({ message: "Deployment queue is unavailable" }, status);
			}
			logger.error({ serverId, error }, "Failed to fetch jobs from Inngest");
			return c.json({ message: "Deployment queue is unavailable" }, 502);
		}
	},
);

// Serve Inngest functions endpoint
app.on(
	["GET", "POST", "PUT"],
	"/api/inngest",
	serveInngest({
		client: inngest,
		functions: [deploymentFunction],
	}),
);

const port = Number.parseInt(process.env.PORT || "3000", 10);
if (!process.env.VITEST) {
	logger.info({ port }, "Starting Deployments Server with Inngest ✅");
	serve({ fetch: app.fetch, port });
}

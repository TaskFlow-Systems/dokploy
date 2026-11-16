import {
	createDestination,
	execAsync,
	execAsyncRemote,
	findDestinationById,
	getAccessibleServerIds,
	IS_CLOUD,
	removeDestinationById,
	updateDestinationById,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { runDestinationConnectionTest } from "@dokploy/server/utils/destination/connection-test";
import {
	type DestinationConnectionTestReport,
	formatDestinationConnectionTestReport,
	isDestinationConnectionTestPassed,
} from "@dokploy/server/utils/destination/connection-test-report";
import { assertDestinationEndpointAllowed } from "@dokploy/server/utils/destination/endpoint";
import {
	isRedactedSecretValue,
	redactSecretFields,
	redactSecretFieldsList,
	redactSensitiveText,
} from "@dokploy/server/utils/security/redaction";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateDestination,
	apiFindOneDestination,
	apiRemoveDestination,
	apiTestDestinationConnection,
	apiUpdateDestination,
	destinations,
} from "@/server/db/schema";

const assertDestinationServerAccess = async (
	ctx: { session: Parameters<typeof getAccessibleServerIds>[0] },
	serverId?: string,
) => {
	if (!serverId) {
		return;
	}

	const accessibleIds = await getAccessibleServerIds(ctx.session);
	if (!accessibleIds.has(serverId)) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this server",
		});
	}
};

const normalizeDestinationEndpointInput = async <
	T extends { endpoint: string },
>(
	input: T,
) => ({
	...input,
	endpoint: await assertDestinationEndpointAllowed(input.endpoint, {
		allowPrivateNetwork: !IS_CLOUD,
		fieldName: "S3 endpoint",
	}),
});

export const destinationRouter = createTRPCRouter({
	create: withPermission("destination", "create")
		.input(apiCreateDestination)
		.mutation(async ({ input, ctx }) => {
			try {
				const destinationInput = await normalizeDestinationEndpointInput(input);
				const result = await createDestination(
					destinationInput,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "destination",
					resourceId: result.destinationId,
					resourceName: input.name,
				});
				return redactSecretFields(result, ["secretAccessKey"]);
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the destination",
					cause: error,
				});
			}
		}),
	testConnection: withPermission("destination", "create")
		.input(apiTestDestinationConnection)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD && !input.serverId) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Server not found",
				});
			}
			await assertDestinationServerAccess(ctx, input.serverId);

			const { destinationId, ...connectionInput } = input;
			if (isRedactedSecretValue(connectionInput.secretAccessKey)) {
				if (!destinationId) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"The secret access key is hidden. Enter it again or pass destinationId to test the saved destination.",
					});
				}
				const destination = await findDestinationById(destinationId);
				if (destination.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not allowed to access this destination",
					});
				}
				connectionInput.secretAccessKey = destination.secretAccessKey;
			}

			let report: DestinationConnectionTestReport;
			try {
				const destinationInput =
					await normalizeDestinationEndpointInput(connectionInput);
				report = await runDestinationConnectionTest(
					destinationInput,
					(command) =>
						IS_CLOUD
							? execAsyncRemote(destinationInput.serverId || "", command)
							: execAsync(command),
				);
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? redactSensitiveText(error.message)
							: "Error connecting to bucket",
					cause: error,
				});
			}

			if (!isDestinationConnectionTestPassed(report)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: formatDestinationConnectionTestReport(report),
				});
			}
			return report;
		}),
	one: withPermission("destination", "read")
		.input(apiFindOneDestination)
		.query(async ({ input, ctx }) => {
			const destination = await findDestinationById(input.destinationId);
			if (destination.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not allowed to access this destination",
				});
			}
			return redactSecretFields(destination, ["secretAccessKey"]);
		}),
	all: withPermission("destination", "read").query(async ({ ctx }) => {
		const destinationList = await db.query.destinations.findMany({
			where: eq(destinations.organizationId, ctx.session.activeOrganizationId),
			orderBy: [desc(destinations.createdAt)],
		});
		return redactSecretFieldsList(destinationList, ["secretAccessKey"]);
	}),
	remove: withPermission("destination", "delete")
		.input(apiRemoveDestination)
		.mutation(async ({ input, ctx }) => {
			try {
				const destination = await findDestinationById(input.destinationId);

				if (destination.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not allowed to delete this destination",
					});
				}
				const result = await removeDestinationById(
					input.destinationId,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "delete",
					resourceType: "destination",
					resourceId: input.destinationId,
					resourceName: destination.name,
				});
				return redactSecretFields(result, ["secretAccessKey"]);
			} catch (error) {
				throw error;
			}
		}),
	update: withPermission("destination", "create")
		.input(apiUpdateDestination)
		.mutation(async ({ input, ctx }) => {
			try {
				const destination = await findDestinationById(input.destinationId);
				if (destination.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not allowed to update this destination",
					});
				}
				const secretAccessKey = isRedactedSecretValue(input.secretAccessKey)
					? destination.secretAccessKey
					: input.secretAccessKey;
				const destinationInput = await normalizeDestinationEndpointInput(input);
				const result = await updateDestinationById(input.destinationId, {
					...destinationInput,
					secretAccessKey,
					organizationId: ctx.session.activeOrganizationId,
				});
				await audit(ctx, {
					action: "update",
					resourceType: "destination",
					resourceId: input.destinationId,
					resourceName: input.name,
				});
				return redactSecretFields(result, ["secretAccessKey"]);
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? error?.message
							: "Error connecting to bucket",
					cause: error,
				});
			}
		}),
});

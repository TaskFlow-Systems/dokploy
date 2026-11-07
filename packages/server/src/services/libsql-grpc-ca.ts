import { db } from "@dokploy/server/db";
import { libsqlGrpcCa } from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import {
	createLibsqlGrpcCa,
	type LibsqlGrpcCa,
} from "../utils/databases/libsql-grpc-tls";

export const getLibsqlGrpcCa = async (
	organizationId: string,
): Promise<LibsqlGrpcCa> => {
	const find = () =>
		db.query.libsqlGrpcCa.findFirst({
			where: eq(libsqlGrpcCa.organizationId, organizationId),
		});
	const existing = await find();
	if (existing) return existing;

	await db
		.insert(libsqlGrpcCa)
		.values({ organizationId, ...(await createLibsqlGrpcCa(organizationId)) })
		.onConflictDoNothing();
	// Two first deployments at once: the one that lost keeps the other's authority.
	const created = await find();
	if (!created) {
		throw new Error("The libSQL certificate authority could not be saved");
	}
	return created;
};

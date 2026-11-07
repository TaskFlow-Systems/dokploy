import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./account";
import { encryptedText } from "./utils";

// Signs the certificates of an organization's libSQL nodes. Port 5001 checks
// nothing else: without a client certificate from this authority, anyone who
// reaches it could copy and change the whole database.
export const libsqlGrpcCa = pgTable("libsql_grpc_ca", {
	organizationId: text("organizationId")
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	certificate: text("certificate").notNull(),
	privateKey: encryptedText("privateKey").notNull(),
	createdAt: timestamp("createdAt").notNull().defaultNow(),
});

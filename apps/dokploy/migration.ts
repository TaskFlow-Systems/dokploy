import { dbUrl } from "@dokploy/server/db";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const sql = postgres(dbUrl, { max: 1 });
const db = drizzle(sql);

await migrate(db, { migrationsFolder: "drizzle" })
	.then(() => {
		console.log("Migration complete");
		sql.end();
	})
	.catch((error) => {
		console.log("Migration failed", error);
		// Keep `&& node dist/server.mjs` from starting on a partially migrated
		// schema: Better Auth refuses every request when its tables do not match,
		// while a failed start is retried by the orchestrator.
		process.exitCode = 1;
	})
	.finally(() => {
		sql.end();
	});

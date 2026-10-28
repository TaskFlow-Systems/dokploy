import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { dbUrl } from "./constants";
import * as schema from "./schema";

export * from "./schema";
export { and, eq };

type Database = PostgresJsDatabase<typeof schema>;

// Este módulo se evalúa varias veces por proceso (copias duplicadas por
// esbuild y los chunks de Next); el cache en globalThis garantiza un solo
// pool de conexiones por proceso.
const globalForDb = globalThis as unknown as {
	db?: Database;
};

if (!globalForDb.db) {
	// postgres.js keeps every connection it opens for 30-60 minutes. The panel
	// is idle most of the time, and each idle backend holds memory in Postgres.
	globalForDb.db = drizzle(postgres(dbUrl, { idle_timeout: 60 }), {
		schema,
	});
}

export const db: Database = globalForDb.db;

export { dbUrl };

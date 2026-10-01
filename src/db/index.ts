import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { databaseOptions } from "../lib/database-config";
const globalDb = globalThis as unknown as {
  mandatPool?: Pool;
  mandatDb?: ReturnType<typeof createDb>;
};
function createDb(pool: Pool) {
  return drizzle(pool, { schema });
}
function createPool() {
  const pool = new Pool(databaseOptions());
  // pg has already removed the idle connection. Later queries can reconnect;
  // never log the error/client because they may contain connection secrets.
  pool.on("error", () => console.error("database_idle_connection_error"));
  return pool;
}
export function getDb() {
  if (!process.env.DATABASE_URL)
    throw new Error(
      "DATABASE_URL mancante. Configurare PostgreSQL per la beta.",
    );
  globalDb.mandatPool ??= createPool();
  return (globalDb.mandatDb ??= createDb(globalDb.mandatPool));
}
export async function closeDb() {
  await globalDb.mandatPool?.end();
  globalDb.mandatDb = undefined;
  globalDb.mandatPool = undefined;
}

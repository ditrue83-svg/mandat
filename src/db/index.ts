import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { databaseOptions } from "../lib/database-config";
const globalDb = globalThis as unknown as {
  mandatPool?: Pool;
  mandatDb?: ReturnType<typeof createDb>;
  mandatLedgerPool?: Pool;
  mandatLedgerDb?: ReturnType<typeof createDb>;
};
function createDb(pool: Pool) {
  return drizzle(pool, { schema });
}
function createPool(purpose: "app" | "ledger" = "app") {
  const pool = new Pool(databaseOptions(process.env, purpose));
  // pg has already removed the idle connection. Later queries can reconnect;
  // never log the error/client because they may contain connection secrets.
  pool.on("error", () => console.error("database_idle_connection_error"));
  return pool;
}
export function getDb(purpose: "app" | "ledger" = "app") {
  if (!process.env.DATABASE_URL)
    throw new Error(
      "DATABASE_URL mancante. Configurare PostgreSQL per la beta.",
    );
  // Metering must still acquire a connection when all general-purpose clients
  // are occupied. This single-client pool never holds a provider request open.
  if (purpose === "ledger") {
    globalDb.mandatLedgerPool ??= createPool("ledger");
    return (globalDb.mandatLedgerDb ??= createDb(globalDb.mandatLedgerPool));
  }
  globalDb.mandatPool ??= createPool();
  return (globalDb.mandatDb ??= createDb(globalDb.mandatPool));
}
export async function closeDb() {
  await Promise.all([
    globalDb.mandatPool?.end(),
    globalDb.mandatLedgerPool?.end(),
  ]);
  globalDb.mandatDb = undefined;
  globalDb.mandatPool = undefined;
  globalDb.mandatLedgerDb = undefined;
  globalDb.mandatLedgerPool = undefined;
}

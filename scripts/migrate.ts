import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { databaseOptions } from "../src/lib/database-config";
async function main() {
  const pool = new Pool(databaseOptions(process.env, "migration"));
  try {
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
    console.info("Migrazioni applicate.");
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    "Migrazione non riuscita. Verificare connessione, certificato e permessi; dettagli omessi per proteggere i segreti.",
  );
  process.exit(1);
});

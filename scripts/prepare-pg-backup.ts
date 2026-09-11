import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { databaseOptions, databaseProvider } from "../src/lib/database-config";

// Run only in an ephemeral worker container with /backup mounted to a private
// temporary directory. No credential is returned on stdout or in process args.
async function main() {
  if (databaseProvider() !== "supabase") throw new Error();
  const connection = databaseOptions(process.env, "probe");
  const ssl = typeof connection.ssl === "object" ? connection.ssl : undefined;
  const ca = ssl?.ca;
  const values = {
    PGHOST: connection.host,
    PGPORT: connection.port,
    PGUSER: connection.user,
    PGPASSWORD: connection.password,
    PGDATABASE: connection.database,
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: ca ? "/backup/ca.pem" : "/etc/ssl/certs/ca-certificates.crt",
    PGCONNECT_TIMEOUT: "10",
    PGAPPNAME: "mandat-backup",
  };
  if (Object.values(values).some((value) => /[\r\n\0]/.test(String(value))))
    throw new Error();
  if (typeof ca === "string")
    await writeFile(join("/backup", "ca.pem"), ca, { mode: 0o600, flag: "wx" });
  await writeFile(
    join("/backup", "pg.env"),
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
    { mode: 0o600, flag: "wx" },
  );
}
main().catch(() => {
  console.error(
    "Configurazione del client backup non riuscita. Verificare connessione e certificato Supabase.",
  );
  process.exitCode = 1;
});

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

async function main() {
  const template = await readFile(".env.example", "utf8");
  const databaseSecret = randomBytes(32).toString("base64url");
  const secret = () => randomBytes(32).toString("base64url");
  const content = template
    .replace(
      /^DATABASE_URL=.*$/m,
      `DATABASE_URL=postgresql://mandat:${databaseSecret}@db:5432/mandat`,
    )
    .replace(/^POSTGRES_PASSWORD=.*$/m, `POSTGRES_PASSWORD=${databaseSecret}`)
    .replace(/^BETTER_AUTH_SECRET=.*$/m, `BETTER_AUTH_SECRET=${secret()}`)
    .replace(/^RESTIC_PASSWORD=.*$/m, `RESTIC_PASSWORD=${secret()}`);
  await writeFile(".env.production.local", content, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    "Configurazione preparata in .env.production.local, accessibile soltanto al proprietario. Segreti locali generati; completare gli accessi Infomaniak quando disponibili. Nessun valore segreto viene mostrato.",
  );
}
main().catch((error) => {
  console.error(
    (error as { code?: string }).code === "EEXIST"
      ? "Il file .env.production.local esiste già: non è stato modificato."
      : "Preparazione non riuscita. Verificare la presenza di .env.example e i permessi della cartella.",
  );
  process.exitCode = 1;
});

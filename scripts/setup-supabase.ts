import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { parseEnv } from "node:util";

async function main() {
  const path = ".env.production.local";
  let content = await readFile(path, "utf8");
  const env = parseEnv(content);
  if (env.DATABASE_PROVIDER === "supabase") {
    console.info(
      "Supabase è già selezionato: configurazione e credenziali conservate.",
    );
    return;
  }
  const current = new URL(env.DATABASE_URL || "");
  if (!["db", "localhost", "127.0.0.1"].includes(current.hostname))
    throw new Error("External database already configured");
  const updates = {
    DATABASE_PROVIDER: "supabase",
    DATABASE_URL: "",
    DATABASE_POOL_MAX: "3",
    QUEUE_POOL_MAX: "3",
    SUPABASE_PROJECT_REF: "",
    SUPABASE_REGION: "eu-central-2",
    DATABASE_SSL_CA_BASE64: "",
    COMPOSE_FILE: "compose.supabase.yml",
    DATABASE_CLIENT_IMAGE: "postgres:17-bookworm",
  };
  for (const [key, value] of Object.entries(updates)) {
    const line = new RegExp(`^${key}=.*$`, "m");
    content = line.test(content)
      ? content.replace(line, `${key}=${value}`)
      : `${content.trimEnd()}\n${key}=${value}\n`;
  }
  const temporary = `${path}.supabase.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary);
    throw error;
  }
  console.info(
    "Configurazione predisposta per Supabase Zurigo. Segreti applicativi conservati; completare la connessione dal pannello. Nessun progetto remoto creato.",
  );
}
main().catch(() => {
  console.error(
    "Configurazione non modificata: verificare .env.production.local e che non contenga già un database esterno. Nessun segreto viene mostrato.",
  );
  process.exitCode = 1;
});

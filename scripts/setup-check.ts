import { readFile, stat } from "node:fs/promises";
import { parseEnv, parseArgs } from "node:util";
import { Pool } from "pg";
import nodemailer from "nodemailer";
import { databaseOptions } from "../src/lib/database-config";
import {
  aiBaseUrl,
  inspectSetup,
  setupGroupConfigured,
  type SetupCheck,
} from "../src/lib/setup";

async function main() {
  const { values } = parseArgs({
    options: {
      env: { type: "string" },
      connections: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const file = values.env ?? (process.env.APP_MODE ? undefined : ".env.local");
  const env: Record<string, string | undefined> = { ...process.env };
  let mode: number | undefined;
  if (file) {
    const content = await readFile(file, "utf8");
    Object.assign(env, parseEnv(content));
    mode = (await stat(file)).mode;
  }
  const checks = inspectSetup(env);
  if (mode !== undefined)
    checks.push({
      id: "ENV_FILE_PERMISSIONS",
      group: "app",
      status: mode & 0o077 ? "invalid" : "ok",
      message:
        mode & 0o077
          ? "Limitare la lettura del file di configurazione al proprietario (chmod 600)"
          : "Permessi del file limitati al proprietario",
    });
  if (values.connections) {
    const probe = async (
      id: string,
      group: string,
      fn: () => Promise<void>,
    ) => {
      if (!setupGroupConfigured(checks, group)) {
        checks.push({
          id,
          group,
          status: "manual",
          message:
            "Connessione non tentata: completare prima la configurazione del servizio",
        });
        return;
      }
      try {
        await fn();
        checks.push({
          id,
          group,
          status: "ok",
          message: "Connessione verificata",
        });
      } catch {
        checks.push({
          id,
          group,
          status: "invalid",
          message:
            "Connessione non verificata. Controllare accesso, rete e configurazione nel Manager; dettagli tecnici omessi per proteggere i segreti",
        });
      }
    };
    await probe("DATABASE_CONNECTION", "database", async () => {
      const pool = new Pool({
        ...databaseOptions(env, "probe"),
        query_timeout: 8000,
        max: 1,
      });
      try {
        const result = await pool.query(
          "SELECT to_regclass('public.companies') AS companies, to_regclass('public.publication_versions') AS versions, to_regclass('public.administrators') AS administrators",
        );
        if (Object.values(result.rows[0]).some((value) => value === null))
          throw new Error("Migrations missing");
      } finally {
        await pool.end();
      }
    });
    await probe("SMTP_CONNECTION", "email", async () => {
      const transport = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT || 587),
        secure: env.SMTP_PORT === "465",
        requireTLS: env.SMTP_PORT !== "465",
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
        connectionTimeout: 8000,
        socketTimeout: 8000,
        tls: { minVersion: "TLSv1.2" },
      });
      try {
        await transport.verify();
      } finally {
        transport.close();
      }
    });
    await probe("AI_MODEL_AVAILABLE", "ai", async () => {
      const response = await fetch(
        `${aiBaseUrl(env).replace(/\/$/, "")}/models`,
        {
          headers: { Authorization: `Bearer ${env.LLM_API_KEY}` },
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok) throw new Error("Model list unavailable");
      const result = (await response.json()) as { data?: { id: string }[] };
      if (!result.data?.some((model) => model.id === env.LLM_MODEL))
        throw new Error("Model not available");
    });
  }
  const blocking = checks.filter(
    (c) => c.status === "missing" || c.status === "invalid",
  ).length;
  const report = {
    configurationReady: blocking === 0,
    pilotReady: false,
    connectionsRequested: values.connections,
    blockingChecks: blocking,
    checks,
  };
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log("Mandat — controllo prima dell’attivazione\n");
    const labels: Record<SetupCheck["status"], string> = {
      ok: "OK",
      missing: "MANCA",
      invalid: "DA CORREGGERE",
      manual: "DA VERIFICARE",
    };
    for (const check of checks)
      console.log(`[${labels[check.status]}] ${check.id}: ${check.message}`);
    console.log(
      `\n${blocking ? `${blocking} controlli di configurazione da completare.` : "Configurazione coerente."} Il collaudo del pilota richiede anche le verifiche manuali elencate.`,
    );
    console.log(
      values.connections
        ? "Nessuna email inviata e nessuna generazione AI richiesta."
        : "Controllo locale: nessuna connessione ai servizi esterni.",
    );
  }
  if (blocking) process.exitCode = 1;
}
main().catch(() => {
  console.error(
    "Controllo non eseguito. Verificare il file e gli argomenti: --env <file> [--connections] [--json]. Nessun segreto viene mostrato.",
  );
  process.exitCode = 1;
});

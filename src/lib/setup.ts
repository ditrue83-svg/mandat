import { z } from "zod";
import { databaseOptions } from "./database-config";
import { smtpPassword } from "./smtp-config";
import {
  aiProviderConfiguration,
  MISTRAL_LARGE_3_MODEL,
} from "./ai-provider-config";
import {
  documentaryAiConfiguration,
  documentaryAiProvider,
  documentarySourceReasoningEffort,
} from "./documentary-ai-config";

export type SetupEnvironment = Record<string, string | undefined>;
export type SetupCheck = {
  id: string;
  group: string;
  status: "ok" | "missing" | "invalid" | "manual";
  message: string;
};
const placeholder =
  /^(?:change[_ -]?me|replace[_ -]?me|your[_ -].*|example.*|test-only.*)$/i;
const present = (value: string | undefined) =>
  Boolean(value?.trim() && !placeholder.test(value.trim()));
function url(value: string | undefined) {
  try {
    return new URL(value!);
  } catch {
    return null;
  }
}
function decode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}
export function aiBaseUrl(env: SetupEnvironment) {
  return aiProviderConfiguration(env).baseUrl;
}
export function inspectSetup(env: SetupEnvironment): SetupCheck[] {
  const checks: SetupCheck[] = [];
  const add = (
    id: string,
    group: string,
    valid: boolean,
    message: string,
    missing = false,
  ) =>
    checks.push({
      id,
      group,
      status: valid ? "ok" : missing ? "missing" : "invalid",
      message: valid ? "Configurato" : message,
    });
  const required = (id: string, group: string) =>
    add(
      id,
      group,
      present(env[id]),
      `Configurare ${id} con un valore effettivo`,
      !env[id]?.trim(),
    );
  add(
    "APP_MODE",
    "app",
    env.APP_MODE === "live",
    "Per l’attivazione impostare APP_MODE=live",
    !env.APP_MODE,
  );
  const app = url(env.APP_URL);
  add(
    "APP_URL",
    "app",
    Boolean(
      app &&
      app.protocol === "https:" &&
      !app.username &&
      !app.password &&
      app.pathname === "/" &&
      !app.search &&
      !app.hash,
    ),
    "APP_URL deve essere l’origine HTTPS pubblica, senza percorso o credenziali",
    !env.APP_URL,
  );
  add(
    "DOMAIN",
    "app",
    Boolean(env.DOMAIN && app?.hostname === env.DOMAIN),
    "DOMAIN deve coincidere con il dominio di APP_URL",
    !env.DOMAIN,
  );
  checks.push({
    id: "DOMAIN_OWNERSHIP",
    group: "app",
    status: "manual",
    message:
      "Confermare disponibilità e titolarità del dominio, DNS verso il VPS svizzero e certificato HTTPS",
  });
  add(
    "BETTER_AUTH_SECRET",
    "app",
    present(env.BETTER_AUTH_SECRET) &&
      (env.BETTER_AUTH_SECRET?.length ?? 0) >= 43,
    "Generare almeno 32 byte casuali per BETTER_AUTH_SECRET",
    !env.BETTER_AUTH_SECRET,
  );
  add(
    "FOUNDER_EMAIL",
    "app",
    z.email().safeParse(env.FOUNDER_EMAIL).success,
    "Impostare un indirizzo email valido per il fondatore",
    !env.FOUNDER_EMAIL,
  );
  const db = url(env.DATABASE_URL);
  const dbValid = Boolean(
    db &&
    ["postgres:", "postgresql:"].includes(db.protocol) &&
    present(decode(db.password)) &&
    db.username &&
    db.pathname.length > 1 &&
    !db.search &&
    !db.hash,
  );
  add(
    "DATABASE_URL",
    "database",
    dbValid,
    "Configurare un URL PostgreSQL con utente, password effettiva e database, senza parametri aggiuntivi",
    !env.DATABASE_URL,
  );
  if ((env.DATABASE_PROVIDER || "local") === "local") {
    for (const key of ["POSTGRES_USER", "POSTGRES_DB", "POSTGRES_PASSWORD"])
      required(key, "database");
    add(
      "POSTGRES_MATCH",
      "database",
      Boolean(
        dbValid &&
        decode(db!.username) === env.POSTGRES_USER &&
        decode(db!.password) === env.POSTGRES_PASSWORD &&
        decode(db!.pathname.slice(1)) === env.POSTGRES_DB,
      ),
      "DATABASE_URL e POSTGRES_* devono indicare lo stesso accesso",
    );
  }
  let connectionValid = true;
  let connectionMessage = "";
  try {
    databaseOptions(env);
    databaseOptions(env, "queue");
  } catch (error) {
    connectionValid = false;
    connectionMessage =
      error instanceof Error
        ? error.message
        : "Configurazione database non valida";
  }
  add(
    "DATABASE_CONNECTION_CONFIG",
    "database",
    connectionValid,
    connectionMessage,
  );
  if (env.DATABASE_PROVIDER === "supabase") {
    add(
      "COMPOSE_FILE",
      "database",
      env.COMPOSE_FILE === "compose.supabase.yml",
      "Per il deployment Supabase usare COMPOSE_FILE=compose.supabase.yml",
      !env.COMPOSE_FILE,
    );
    checks.push({
      id: "SUPABASE_RESIDENCY",
      group: "database",
      status: "manual",
      message:
        "Verificare Zurigo nel pannello e residenza di log/backup prima di inserire dati delle ditte: la regione dichiarata nel file non prova la configurazione del servizio",
    });
    checks.push({
      id: "SUPABASE_DATA_API",
      group: "database",
      status: "manual",
      message:
        "Usare un progetto dedicato Mandat con Data API disabilitata; applicare migrazioni e verificare il blocco dei ruoli client sulle tabelle interne",
    });
  }
  add(
    "SMTP_HOST",
    "email",
    ["mail.infomaniak.com", "smtps.aruba.it"].includes(env.SMTP_HOST || ""),
    "Usare il server SMTP configurato: smtps.aruba.it oppure mail.infomaniak.com",
    !env.SMTP_HOST,
  );
  add(
    "SMTP_PORT",
    "email",
    env.SMTP_HOST === "smtps.aruba.it"
      ? env.SMTP_PORT === "465"
      : ["465", "587"].includes(env.SMTP_PORT || "587"),
    "Per Aruba usare 465 con TLS; per Infomaniak 465 TLS oppure 587 STARTTLS",
  );
  add(
    "SMTP_USER",
    "email",
    z.email().safeParse(env.SMTP_USER).success,
    "SMTP_USER deve essere l’indirizzo completo della casella",
    !env.SMTP_USER,
  );
  let passwordValid = false;
  try {
    passwordValid = present(smtpPassword(env));
  } catch {
    // Report only the field, never parser details or credentials.
  }
  add(
    "SMTP_PASSWORD",
    "email",
    passwordValid,
    "Configurare SMTP_PASSWORD_BASE64 con setup:smtp-password oppure SMTP_PASSWORD, senza combinarli",
    !env.SMTP_PASSWORD && !env.SMTP_PASSWORD_BASE64,
  );
  const sender = env.MAIL_FROM?.match(/<([^<>]+)>$/)?.[1] ?? env.MAIL_FROM;
  add(
    "MAIL_FROM",
    "email",
    z.email().safeParse(sender).success && !/[\r\n]/.test(env.MAIL_FROM ?? ""),
    "MAIL_FROM deve contenere un indirizzo mittente valido",
    !env.MAIL_FROM,
  );
  checks.push({
    id: "MAIL_DELIVERY",
    group: "email",
    status: "manual",
    message:
      "Verificare SPF/DKIM/DMARC e consegna a una casella reale; l’autenticazione SMTP da sola non prova il recapito",
  });
  const mistral = env.LLM_PROVIDER === "mistral-eu";
  required(mistral ? "MISTRAL_API_KEY" : "LLM_API_KEY", "ai");
  required("LLM_MODEL", "ai");
  add(
    "LLM_PROVIDER",
    "ai",
    !env.LLM_PROVIDER ||
      ["infomaniak", "mistral-eu"].includes(env.LLM_PROVIDER),
    "Scegliere infomaniak oppure mistral-eu",
  );
  if (mistral)
    add(
      "MISTRAL_MODEL",
      "ai",
      env.LLM_MODEL === MISTRAL_LARGE_3_MODEL,
      "Per Mistral UE configurare mistral-large-2512",
    );
  if (!mistral && !env.LLM_API_BASE_URL)
    add(
      "INFOMANIAK_AI_PRODUCT_ID",
      "ai",
      /^\d+$/.test(env.INFOMANIAK_AI_PRODUCT_ID ?? ""),
      "Inserire l’identificativo del prodotto AI Services",
      !env.INFOMANIAK_AI_PRODUCT_ID,
    );
  let ai: URL | null = null;
  try {
    ai = url(aiBaseUrl(env));
  } catch {
    /* Report below without configuration values. */
  }
  add(
    mistral ? "MISTRAL_API_BASE_URL" : "LLM_API_BASE_URL",
    "ai",
    Boolean(
      ai &&
      ai.protocol === "https:" &&
      (mistral
        ? ai.hostname === "api.eu.mistral.ai"
        : ai.hostname === "api.infomaniak.com") &&
      !ai.port &&
      !ai.username &&
      !ai.password &&
      !ai.search &&
      !ai.hash &&
      (mistral
        ? ai.pathname === "/v1"
        : /^\/2\/ai\/\d+\/openai\/v1\/?$/.test(ai.pathname)),
    ),
    mistral
      ? "Configurare esclusivamente https://api.eu.mistral.ai/v1"
      : "Configurare l’endpoint AI Infomaniak v2 del prodotto",
  );
  if (mistral)
    add(
      "LLM_REASONING_EFFORT",
      "ai",
      !env.LLM_REASONING_EFFORT || env.LLM_REASONING_EFFORT === "none",
      "Per Mistral Large 3 lasciare vuoto oppure none",
    );
  if (
    env.DOCUMENTARY_LLM_PROVIDER ||
    env.DOCUMENTARY_LLM_MODEL ||
    env.DOCUMENTARY_COMPARISON_ENABLED === "true"
  ) {
    let valid = false;
    try {
      const configuration = documentaryAiConfiguration(env);
      const connection = aiProviderConfiguration(env, configuration.provider);
      const endpoint = new URL(connection.baseUrl);
      documentarySourceReasoningEffort(env);
      valid =
        present(env[connection.apiKeyEnv]) &&
        (configuration.provider === "mistral-eu" ||
          (endpoint.hostname === "api.infomaniak.com" &&
            !endpoint.port &&
            /^\/2\/ai\/\d+\/openai\/v1\/?$/.test(endpoint.pathname)));
    } catch {
      /* No secrets or arbitrary exception text in the setup report. */
    }
    add(
      "DOCUMENTARY_AI_CONFIGURATION",
      "documentary-ai",
      valid,
      "Configurare fornitore, modello, chiave dedicata, modalità e tariffe CHF del confronto documentario",
    );
  }
  let usesMistral = mistral;
  try {
    usesMistral ||= documentaryAiProvider(env) === "mistral-eu";
  } catch {
    /* Already reported as invalid. */
  }
  if (usesMistral)
    checks.push({
      id: "MISTRAL_DATA_SETTINGS",
      group: "ai",
      status: "manual",
      message:
        "Verificare opt-out API da Anonymous improvement data nel pannello Mistral. Regione UE e conservazione dei dati sono controlli distinti; validare l’informativa prima del rilascio.",
    });
  for (const key of ["LLM_INPUT_CHF_PER_MILLION", "LLM_OUTPUT_CHF_PER_MILLION"])
    add(
      key,
      "ai",
      present(env[key]) &&
        Number.isFinite(Number(env[key])) &&
        Number(env[key]) > 0,
      `Inserire la tariffa verificata per ${key}, incluse imposte applicabili`,
      !env[key],
    );
  add(
    "AI_MONTHLY_BUDGET_CHF",
    "ai",
    Number.isFinite(Number(env.AI_MONTHLY_BUDGET_CHF)) &&
      Number(env.AI_MONTHLY_BUDGET_CHF) > 0 &&
      Number(env.AI_MONTHLY_BUDGET_CHF) <= 40,
    "Per la beta impostare un limite AI superiore a zero e non oltre CHF 40",
    !env.AI_MONTHLY_BUDGET_CHF,
  );
  checks.push({
    id: "AI_QUALITY",
    group: "ai",
    status: "manual",
    message:
      "Validare riassunti, citazioni e pertinenza su un campione; impostare anche il limite presso il fornitore AI",
  });
  const repository = env.RESTIC_REPOSITORY;
  const backup = repository?.startsWith("s3:")
    ? url(repository.slice(3))
    : null;
  add(
    "RESTIC_REPOSITORY",
    "backup",
    Boolean(
      backup &&
      backup.protocol === "https:" &&
      !backup.username &&
      !backup.password &&
      !backup.search &&
      !backup.hash &&
      backup.pathname.length > 1 &&
      backup.hostname.endsWith(".infomaniak.com"),
    ),
    "Configurare il repository S3 HTTPS Swiss Backup con endpoint e bucket forniti dal Manager",
    !repository,
  );
  for (const key of [
    "RESTIC_PASSWORD",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_DEFAULT_REGION",
  ])
    required(key, "backup");
  add(
    "RESTIC_PASSWORD_UNIQUE",
    "backup",
    Boolean(
      present(env.RESTIC_PASSWORD) &&
      env.RESTIC_PASSWORD !== env.POSTGRES_PASSWORD &&
      env.RESTIC_PASSWORD !== (db ? decode(db.password) : undefined) &&
      env.RESTIC_PASSWORD !== env.AWS_SECRET_ACCESS_KEY &&
      env.RESTIC_PASSWORD !== env.BETTER_AUTH_SECRET,
    ),
    "La password di cifratura Restic deve essere distinta dagli altri segreti",
  );
  checks.push({
    id: "BACKUP_RESTORE",
    group: "backup",
    status: "manual",
    message:
      "Eseguire backup e ripristino completo dal repository svizzero prima del pilota",
  });
  add(
    "FOGLIO_REUSE_CONFIRMED",
    "sources",
    ["true", "false"].includes(env.FOGLIO_REUSE_CONFIRMED ?? "false"),
    "Usare soltanto true o false",
  );
  checks.push({
    id: "FOGLIO_COVERAGE",
    group: "sources",
    status: "manual",
    message:
      env.FOGLIO_REUSE_CONFIRMED === "true"
        ? "Conservare la conferma delle condizioni di riutilizzo del Foglio TI"
        : "Foglio TI disattivato: dichiarare l’assenza della fonte ai piloti",
  });
  return checks;
}
export function setupGroupConfigured(checks: SetupCheck[], group: string) {
  return (
    checks.some((c) => c.group === group) &&
    !checks.some(
      (c) => c.group === group && ["missing", "invalid"].includes(c.status),
    )
  );
}

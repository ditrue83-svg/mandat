import { X509Certificate } from "node:crypto";
import type { PoolConfig } from "pg";

type Environment = Record<string, string | undefined>;
type Purpose = "app" | "queue" | "migration" | "probe";

export function databaseProvider(env: Environment = process.env) {
  const provider = env.DATABASE_PROVIDER || "local";
  if (provider !== "local" && provider !== "supabase")
    throw new Error("DATABASE_PROVIDER deve essere local o supabase");
  return provider;
}

// Separate connection fields prevent URI parameters from overriding TLS or users.
// Every error is static: never include the URI, username, password or certificate.
export function databaseOptions(
  env: Environment = process.env,
  purpose: Purpose = "app",
): PoolConfig {
  const provider = databaseProvider(env);
  let target: URL;
  let user: string;
  let password: string;
  let database: string;
  try {
    target = new URL(env.DATABASE_URL || "");
    user = decodeURIComponent(target.username);
    password = decodeURIComponent(target.password);
    database = decodeURIComponent(target.pathname.slice(1));
    if (
      !["postgres:", "postgresql:"].includes(target.protocol) ||
      !user ||
      !password ||
      !database ||
      database.includes("/") ||
      target.search ||
      target.hash
    )
      throw new Error();
  } catch {
    throw new Error(
      "DATABASE_URL non valido: usare un URL PostgreSQL senza parametri aggiuntivi",
    );
  }
  const maximum = Number(
    purpose === "queue"
      ? env.QUEUE_POOL_MAX || "3"
      : env.DATABASE_POOL_MAX || "3",
  );
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 10)
    throw new Error("I pool PostgreSQL devono avere da 1 a 10 connessioni");
  const options: PoolConfig = {
    host: target.hostname.replace(/^\[|\]$/g, ""),
    port: Number(target.port || "5432"),
    user,
    password,
    database,
    max: purpose === "migration" || purpose === "probe" ? 1 : maximum,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 30000,
    application_name: `mandat-${purpose}`,
  };
  if (
    provider === "local" &&
    !["db", "localhost", "127.0.0.1", "::1"].includes(options.host!)
  )
    throw new Error(
      "DATABASE_PROVIDER=local consente soltanto il database Docker o locale; selezionare supabase per il servizio gestito",
    );
  if (provider === "supabase") {
    const ref = env.SUPABASE_PROJECT_REF || "";
    if (!/^[a-z0-9]{16,32}$/.test(ref))
      throw new Error(
        "Configurare SUPABASE_PROJECT_REF dal pannello del progetto",
      );
    if (env.SUPABASE_REGION !== "eu-central-2")
      throw new Error(
        "Per Mandat selezionare la regione specifica Zurigo (eu-central-2)",
      );
    const direct =
      target.hostname === `db.${ref}.supabase.co` && !user.includes(".");
    const session =
      /^aws-\d+-eu-central-2\.pooler\.supabase\.com$/.test(target.hostname) &&
      user.endsWith(`.${ref}`) &&
      /^[a-zA-Z0-9_]+\.[a-z0-9]+$/.test(user);
    if (
      (!direct && !session) ||
      options.port !== 5432 ||
      database !== "postgres"
    )
      throw new Error(
        "Copiare la connessione diretta o Session pooler di Zurigo, porta 5432; Transaction pooler non supportato",
      );
    let ca: string | undefined;
    if (env.DATABASE_SSL_CA_BASE64) {
      try {
        ca = Buffer.from(env.DATABASE_SSL_CA_BASE64, "base64").toString("utf8");
        new X509Certificate(ca);
      } catch {
        throw new Error(
          "DATABASE_SSL_CA_BASE64 deve contenere il certificato CA del progetto in formato PEM codificato base64",
        );
      }
    }
    options.ssl = {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ...(ca ? { ca } : {}),
    };
  }
  return options;
}

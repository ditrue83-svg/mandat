import { smtpPassword } from "./smtp-config";

export function isDemo() {
  return process.env.APP_MODE === "demo";
}
export function appUrl() {
  const value = process.env.APP_URL;
  if (!value) throw new Error("APP_URL non configurato");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("APP_URL non valido");
  return url.origin;
}
export function assertProductionConfig() {
  if (isDemo())
    throw new Error(
      "La modalità dimostrativa non può avviare il worker o operazioni di produzione.",
    );
  for (const key of [
    "DATABASE_URL",
    "APP_URL",
    "BETTER_AUTH_SECRET",
    "SMTP_HOST",
    "SMTP_USER",
    "MAIL_FROM",
  ])
    if (!process.env[key]) throw new Error(`Configurazione mancante: ${key}`);
  smtpPassword(process.env);
  if ((process.env.BETTER_AUTH_SECRET?.length ?? 0) < 32)
    throw new Error(
      "BETTER_AUTH_SECRET deve contenere almeno 32 caratteri casuali",
    );
}

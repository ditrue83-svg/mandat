type SmtpEnvironment = Record<string, string | undefined>;

// Base64 preserves password characters across Node, Next.js and Compose env files.
// It is an encoding, not encryption: the environment file must remain private.
export function smtpPassword(env: SmtpEnvironment): string {
  const raw = env.SMTP_PASSWORD || "";
  const encoded = env.SMTP_PASSWORD_BASE64 || "";
  if (raw && encoded) throw new Error("Configurare una sola password SMTP");
  let password = raw;
  if (encoded) {
    try {
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded) throw new Error();
      password = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      throw new Error("Password SMTP codificata non valida");
    }
  }
  if (!password || /[\r\n\0]/.test(password))
    throw new Error("Password SMTP mancante o non valida");
  return password;
}

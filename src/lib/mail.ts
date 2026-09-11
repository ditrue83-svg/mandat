import nodemailer from "nodemailer";
export function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
export async function sendMail(message: {
  to: string;
  subject: string;
  html: string;
  text: string;
  messageId?: string;
}) {
  if (process.env.APP_MODE === "demo")
    throw new Error("Invio email disabilitato in modalità dimostrativa");
  for (const key of ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM"])
    if (!process.env[key]) throw new Error(`Email non configurata: ${key}`);
  transport ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_PORT === "465",
    requireTLS: process.env.SMTP_PORT !== "465",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    connectionTimeout: 15000,
    socketTimeout: 30000,
    tls: { minVersion: "TLSv1.2" },
  });
  return transport.sendMail({
    from: process.env.MAIL_FROM,
    ...message,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}
export function emailLayout(content: string) {
  return `<html lang="it"><body style="margin:0;background:#f5f7f3;font-family:Arial,sans-serif;color:#183d32"><div style="max-width:600px;margin:auto;padding:32px 24px"><h1 style="font-size:28px">mandat.</h1>${content}<hr style="border:0;border-top:1px solid #dce4d6;margin:28px 0"><p style="font-size:12px;color:#78856e">Mandat · Beta Radar<br>Pubblicazione non ufficiale. Verifica sempre fonti, requisiti e scadenze originali.</p></div></body></html>`;
}

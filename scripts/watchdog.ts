import { readFile, writeFile, mkdir } from "node:fs/promises";
import { sendMail, emailLayout } from "../src/lib/mail";
import { appUrl } from "../src/lib/config";
async function main() {
  if (!process.env.FOUNDER_EMAIL)
    throw new Error("FOUNDER_EMAIL non configurata");
  await mkdir(".data", { recursive: true });
  let previous = "unknown";
  try {
    previous = JSON.parse(await readFile(".data/watchdog.json", "utf8")).status;
  } catch {}
  let ok = false;
  try {
    ok = (
      await fetch(`${appUrl()}/api/readiness`, {
        signal: AbortSignal.timeout(10000),
      })
    ).ok;
  } catch {}
  const status = ok ? "up" : "down";
  if (status !== previous && (!ok || previous === "down")) {
    const text = ok
      ? "Mandat risponde di nuovo e il worker è attivo."
      : "Mandat richiede un controllo: servizio non raggiungibile, worker fermo, problema critico aperto oppure limite AI raggiunto. Controlla l’area fondatore e i servizi sul VPS.";
    await sendMail({
      to: process.env.FOUNDER_EMAIL,
      subject: ok
        ? "Mandat: servizio ripristinato"
        : "Mandat: controllo operativo richiesto",
      text,
      html: emailLayout(`<p>${text}</p>`),
    });
  }
  await writeFile(
    ".data/watchdog.json",
    JSON.stringify({ status, checkedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  if (!ok) process.exitCode = 1;
}
main().catch((e) => {
  console.error("watchdog_failed", e instanceof Error ? e.message : "Errore");
  process.exit(1);
});

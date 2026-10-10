import { closeDb } from "../src/db";
import { setLoginCredentials } from "../src/lib/login-credentials";

async function main() {
  if (process.env.APP_MODE !== "live")
    throw new Error("Configurare APP_MODE=live.");
  const email = process.env.LOGIN_EMAIL || process.env.FOUNDER_EMAIL;
  const username = process.env.LOGIN_USERNAME;
  if (!email || !username)
    throw new Error("Configurare account e nome utente.");
  // The password comes from stdin, never a CLI argument, repository or log.
  let password = "";
  for await (const chunk of process.stdin) {
    password += chunk.toString();
    if (password.length > 130)
      throw new Error("Password fuori dai limiti consentiti.");
  }
  password = password.replace(/\r?\n$/, "");
  await setLoginCredentials({
    email,
    username,
    password,
    replaceExisting: process.env.LOGIN_REPLACE === "1",
    requireAdministrator: !process.env.LOGIN_EMAIL,
  });
  console.info(
    "Credenziali configurate. Ruoli e ditta invariati; sessioni precedenti revocate.",
  );
}
main()
  .catch(() => {
    console.error(
      "Configurazione credenziali non riuscita. Verificare account, invito e unicità del nome utente; dettagli omessi.",
    );
    process.exitCode = 1;
  })
  .finally(closeDb);

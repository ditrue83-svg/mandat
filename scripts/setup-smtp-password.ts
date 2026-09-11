import { constants, type Stats } from "node:fs";
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { z } from "zod";

const unchangedError =
  "Configurazione non modificata. Verificare i file locali, i permessi 0600, il server SMTP supportato, l’indirizzo della casella e i campi SMTP_PASSWORD e SMTP_PASSWORD_BASE64 vuoti. Il file password è stato conservato.";
const cleanupError =
  "Configurazione aggiornata, ma il file password non è stato eliminato. Rimuoverlo manualmente dopo aver verificato che la password sia conservata al sicuro.";

type ProtectedFile = {
  handle: FileHandle;
  stat: Stats;
  content: string;
};

function isProtectedFile(stat: Stats) {
  return stat.isFile() && (stat.mode & 0o7777) === 0o600;
}

function sameFile(first: Stats, second: Stats) {
  return first.dev === second.dev && first.ino === second.ino;
}

async function readProtectedFile(path: string): Promise<ProtectedFile> {
  const named = await lstat(path);
  if (!isProtectedFile(named)) throw new Error();
  // Check the descriptor too, including replacements after the pathname check.
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!isProtectedFile(stat) || !sameFile(named, stat)) throw new Error();
    const content = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(await handle.readFile());
    return { handle, stat, content };
  } catch {
    await handle.close();
    throw new Error();
  }
}

async function assertUnchanged(path: string, original: ProtectedFile) {
  const current = await readProtectedFile(path);
  try {
    if (
      !sameFile(original.stat, current.stat) ||
      original.content !== current.content
    )
      throw new Error();
    const named = await lstat(path);
    if (!isProtectedFile(named) || !sameFile(named, current.stat))
      throw new Error();
  } finally {
    await current.handle.close();
  }
}

export async function setupSmtpPassword({
  envPath,
  passwordFilePath,
}: {
  envPath: string;
  passwordFilePath: string;
}): Promise<void> {
  let envFile: ProtectedFile | undefined;
  let passwordFile: ProtectedFile | undefined;
  let temporaryPath: string | undefined;
  let committed = false;
  try {
    envFile = await readProtectedFile(envPath);
    passwordFile = await readProtectedFile(passwordFilePath);
    if (sameFile(envFile.stat, passwordFile.stat)) throw new Error();

    const originalContent = envFile.content;
    const env = parseEnv(originalContent);
    if (
      !["mail.infomaniak.com", "smtps.aruba.it"].includes(
        env.SMTP_HOST ?? "",
      ) ||
      !z.email().safeParse(env.SMTP_USER).success ||
      env.SMTP_PASSWORD !== "" ||
      env.SMTP_PASSWORD_BASE64 !== ""
    )
      throw new Error();

    // Remove one editor-added line ending, preserving intentional spaces and BOM.
    const password = passwordFile.content.replace(/\r?\n$/, "");
    if (!password || /[\r\n\0]/.test(password)) throw new Error();
    // Base64 avoids the different quote and dollar-expansion rules in Node,
    // Next.js and Compose dotenv readers. File permissions protect the secret;
    // this encoding is not encryption.
    const encodedPassword = Buffer.from(password, "utf8").toString("base64");

    // Only accept one complete empty assignment. Incomplete quotes and multiline
    // values must never turn adjacent configuration into part of the password.
    const emptyAssignments = ["SMTP_PASSWORD", "SMTP_PASSWORD_BASE64"].map(
      (key) => {
        const assignments = [
          ...originalContent.matchAll(
            new RegExp(
              `^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=[^\\r\\n]*$`,
              "gm",
            ),
          ),
        ];
        if (assignments.length !== 1) throw new Error();
        const assignment = assignments[0];
        const previousValue = assignment[0].slice(
          assignment[0].indexOf("=") + 1,
        );
        if (
          !/^[\t ]*(?:''|""|``)?[\t ]*(?:#.*)?$/.test(previousValue) ||
          parseEnv(assignment[0])[key] !== ""
        )
          throw new Error();
        return assignment;
      },
    );
    const assignment = emptyAssignments[1];
    const equalsAt = assignment[0].indexOf("=");
    const replacement = `${assignment[0].slice(0, equalsAt + 1)}${encodedPassword}`;
    const content =
      originalContent.slice(0, assignment.index) +
      replacement +
      originalContent.slice(assignment.index + assignment[0].length);
    const updated = parseEnv(content);
    if (
      updated.SMTP_PASSWORD_BASE64 !== encodedPassword ||
      Buffer.from(updated.SMTP_PASSWORD_BASE64, "base64").toString("utf8") !==
        password ||
      Object.keys(env).length !== Object.keys(updated).length ||
      Object.entries(env).some(
        ([key, value]) =>
          key !== "SMTP_PASSWORD_BASE64" && updated[key] !== value,
      )
    )
      throw new Error();

    temporaryPath = join(
      dirname(envPath),
      `.env.mandat-smtp-password-${randomUUID()}.tmp`,
    );
    const temporary = await open(temporaryPath, "wx", 0o600);
    try {
      await temporary.chmod(0o600);
      await temporary.writeFile(content, "utf8");
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    await assertUnchanged(envPath, envFile);
    await assertUnchanged(passwordFilePath, passwordFile);
    await rename(temporaryPath, envPath);
    temporaryPath = undefined;
    committed = true;
    await assertUnchanged(passwordFilePath, passwordFile);
    await unlink(passwordFilePath);
  } catch {
    // Never propagate filesystem or parser details that could contain secrets.
    throw new Error(committed ? cleanupError : unchangedError);
  } finally {
    await envFile?.handle.close().catch(() => undefined);
    await passwordFile?.handle.close().catch(() => undefined);
    if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
  }
}

async function main(args: string[]) {
  const options = new Map<string, string>();
  if (args.length !== 4) throw new Error(unchangedError);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !["--env", "--password-file"].includes(key) ||
      !value ||
      options.has(key)
    )
      throw new Error(unchangedError);
    options.set(key, value);
  }
  if (!options.has("--env") || !options.has("--password-file"))
    throw new Error(unchangedError);
  await setupSmtpPassword({
    envPath: options.get("--env")!,
    passwordFilePath: options.get("--password-file")!,
  });
  console.info(
    "Password SMTP salvata nella configurazione protetta; file temporaneo eliminato. Nessuna connessione di rete o invio email eseguiti.",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      error instanceof Error && error.message === cleanupError
        ? cleanupError
        : unchangedError,
    );
    process.exitCode = 1;
  });

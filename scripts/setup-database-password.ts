import { constants, type Stats } from "node:fs";
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { databaseOptions } from "../src/lib/database-config";

const unchangedError =
  "Configurazione non modificata. Verificare i file locali, i permessi 0600 e il modello Supabase Zurigo con password CHANGE_ME. Il file password è stato conservato.";
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
  // O_NOFOLLOW also protects the open between the pathname and descriptor checks.
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

export async function setupDatabasePassword({
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

    const env = parseEnv(envFile.content);
    if (env.DATABASE_PROVIDER !== "supabase") throw new Error();
    const target = new URL(env.DATABASE_URL || "");
    if (decodeURIComponent(target.password) !== "CHANGE_ME") throw new Error();

    // Remove one editor-added line ending, preserving intentional password spaces.
    const password = passwordFile.content.replace(/\r?\n$/, "");
    if (!password || /[\r\n\0]/.test(password)) throw new Error();
    target.password = encodeURIComponent(password);
    const databaseUrl = target.toString();
    databaseOptions({ ...env, DATABASE_URL: databaseUrl }, "probe");

    // Accept one complete, single-line dotenv assignment. Ambiguous or multiline
    // assignments are rejected instead of risking changes to adjacent secrets.
    const assignments = [
      ...envFile.content.matchAll(
        /^[\t ]*(?:export[\t ]+)?DATABASE_URL[\t ]*=[^\r\n]*$/gm,
      ),
    ];
    if (
      assignments.length !== 1 ||
      parseEnv(assignments[0][0]).DATABASE_URL !== env.DATABASE_URL
    )
      throw new Error();
    const assignment = assignments[0];
    const equalsAt = assignment[0].indexOf("=");
    const replacement = `${assignment[0].slice(0, equalsAt + 1)}${databaseUrl}`;
    const content =
      envFile.content.slice(0, assignment.index) +
      replacement +
      envFile.content.slice(assignment.index + assignment[0].length);
    const updated = parseEnv(content);
    if (
      updated.DATABASE_URL !== databaseUrl ||
      Object.keys(env).length !== Object.keys(updated).length ||
      Object.entries(env).some(
        ([key, value]) => key !== "DATABASE_URL" && updated[key] !== value,
      )
    )
      throw new Error();

    temporaryPath = join(
      dirname(envPath),
      `.env.mandat-password-${randomUUID()}.tmp`,
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
    // Never propagate filesystem, parser or connection details containing secrets.
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
  await setupDatabasePassword({
    envPath: options.get("--env")!,
    passwordFilePath: options.get("--password-file")!,
  });
  console.info(
    "Password database salvata nella configurazione protetta; file temporaneo eliminato. Nessuna connessione di rete eseguita.",
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

import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, promisify } from "node:util";
import { execFile } from "node:child_process";
import { setupDatabasePassword } from "../scripts/setup-database-password";
import { databaseOptions } from "../src/lib/database-config";

const ref = "abcdefghijklmnopqrst";
const templateUrl = `postgresql://postgres.${ref}:CHANGE_ME@aws-1-eu-central-2.pooler.supabase.com:5432/postgres`;
const template = [
  "# Local fixture, containing no real credentials",
  "DATABASE_PROVIDER=supabase",
  `DATABASE_URL=${templateUrl}`,
  `SUPABASE_PROJECT_REF=${ref}`,
  "SUPABASE_REGION=eu-central-2",
  'OTHER_SECRET="unchanged # fixture with spaces"',
  "MULTILINE_SECRET='first fixture line\nsecond fixture line'",
  "",
].join("\n");
const directories: string[] = [];

async function fixture(content = template, password = "fixture-password\n") {
  const directory = await mkdtemp(join(tmpdir(), "mandat-db-password-"));
  directories.push(directory);
  const envPath = join(directory, ".env.production.local");
  const passwordFilePath = join(directory, "password.txt");
  await writeFile(envPath, content, { mode: 0o600 });
  await writeFile(passwordFilePath, password, { mode: 0o600 });
  return { directory, envPath, passwordFilePath };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("inserimento locale protetto della password Supabase", () => {
  it("preserva gli altri valori e i byte circostanti, codifica la password e cancella il file solo dopo il salvataggio", async () => {
    const password = "  spazio:@/#?%+$\\\"'é🔒  ";
    const files = await fixture(template, `${password}\r\n`);
    const before = await lstat(files.envPath);
    await setupDatabasePassword(files);
    const content = await readFile(files.envPath, "utf8");
    const actual = parseEnv(content);
    expect(databaseOptions(actual).password).toBe(password);
    expect(content.replace(/^DATABASE_URL=.*$/m, "DATABASE_URL=fixture")).toBe(
      template.replace(/^DATABASE_URL=.*$/m, "DATABASE_URL=fixture"),
    );
    expect(actual.OTHER_SECRET).toBe(parseEnv(template).OTHER_SECRET);
    expect(actual.MULTILINE_SECRET).toBe(parseEnv(template).MULTILINE_SECRET);
    expect((await lstat(files.envPath)).mode & 0o7777).toBe(0o600);
    expect((await lstat(files.envPath)).ino).not.toBe(before.ino);
    await expect(lstat(files.passwordFilePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(files.directory)).toEqual([".env.production.local"]);
  });

  it("accetta una connessione direct, un'assegnazione export quotata e nessun newline finale nella password", async () => {
    const url = `postgresql://postgres:CHANGE_ME@db.${ref}.supabase.co:5432/postgres`;
    const content = template.replace(
      `DATABASE_URL=${templateUrl}`,
      `export DATABASE_URL = "${url}"`,
    );
    const files = await fixture(content, "untrimmed fixture ");
    await setupDatabasePassword(files);
    const env = parseEnv(await readFile(files.envPath, "utf8"));
    expect(databaseOptions(env).password).toBe("untrimmed fixture ");
  });

  it("preserva i fine riga CRLF dell'env e un carattere BOM iniziale nella password", async () => {
    const content = template.replaceAll("\n", "\r\n");
    const files = await fixture(content, "\ufefffixture\n");
    await setupDatabasePassword(files);
    const updated = await readFile(files.envPath, "utf8");
    expect(databaseOptions(parseEnv(updated)).password).toBe("\ufefffixture");
    expect(updated.replace(/^DATABASE_URL=.*$/m, "DATABASE_URL=fixture")).toBe(
      content.replace(/^DATABASE_URL=.*$/m, "DATABASE_URL=fixture"),
    );
  });

  it("rifiuta UTF-8 non valido senza sostituire caratteri della password", async () => {
    const files = await fixture();
    const invalid = Buffer.from([0x66, 0x80, 0x6f]);
    await writeFile(files.passwordFilePath, invalid);
    await expect(setupDatabasePassword(files)).rejects.toThrow(
      "Configurazione non modificata.",
    );
    expect(await readFile(files.envPath, "utf8")).toBe(template);
    expect(await readFile(files.passwordFilePath)).toEqual(invalid);
  });

  it.each([
    "",
    "\n",
    "\r\n",
    "fixture\n\n",
    "fixture\nsecret",
    "fixture\r",
    "fixture\0secret",
  ])(
    "rifiuta password vuote o multilinea, conservando entrambi i file (%j)",
    async (password) => {
      const files = await fixture(template, password);
      await expect(setupDatabasePassword(files)).rejects.toThrow(
        "Configurazione non modificata.",
      );
      expect(await readFile(files.envPath, "utf8")).toBe(template);
      expect(await readFile(files.passwordFilePath, "utf8")).toBe(password);
      expect(await readdir(files.directory)).toHaveLength(2);
    },
  );

  it.each(["envPath", "passwordFilePath"] as const)(
    "rifiuta permessi aperti e collegamenti simbolici per %s",
    async (key) => {
      const files = await fixture();
      await chmod(files[key], 0o640);
      await expect(setupDatabasePassword(files)).rejects.toThrow(
        "Configurazione non modificata.",
      );
      await chmod(files[key], 0o600);
      const alias = join(files.directory, "alias");
      await symlink(files[key], alias);
      await expect(
        setupDatabasePassword({ ...files, [key]: alias }),
      ).rejects.toThrow("Configurazione non modificata.");
      expect(await readFile(files.envPath, "utf8")).toBe(template);
      expect(await readFile(files.passwordFilePath, "utf8")).toBe(
        "fixture-password\n",
      );
    },
  );

  it("rifiuta la stessa configurazione come file password, anche tramite hard link", async () => {
    const files = await fixture();
    const alias = join(files.directory, "hardlink");
    await link(files.envPath, alias);
    for (const passwordFilePath of [files.envPath, alias])
      await expect(
        setupDatabasePassword({ ...files, passwordFilePath }),
      ).rejects.toThrow("Configurazione non modificata.");
    expect(await readFile(files.envPath, "utf8")).toBe(template);
  });

  it("rifiuta directory, senza modificarne il contenuto", async () => {
    const files = await fixture();
    const directory = join(files.directory, "directory");
    await mkdir(directory, { mode: 0o600 });
    try {
      await expect(
        setupDatabasePassword({ ...files, passwordFilePath: directory }),
      ).rejects.toThrow("Configurazione non modificata.");
      expect(await readFile(files.envPath, "utf8")).toBe(template);
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it.each([
    template.replace("CHANGE_ME", "already-configured-fixture"),
    template.replace("eu-central-2", "eu-west-1"),
    template.replace("DATABASE_PROVIDER=supabase", "DATABASE_PROVIDER=local"),
    template.replace(":5432/", ":6543/"),
    template.replace(
      `SUPABASE_PROJECT_REF=${ref}`,
      "SUPABASE_PROJECT_REF=wrong",
    ),
    `${template}DATABASE_URL=${templateUrl}\n`,
    template.replace(
      `DATABASE_URL=${templateUrl}`,
      `DATABASE_URL='${templateUrl}\n'`,
    ),
  ])(
    "rifiuta connessioni esistenti o modelli non sicuri senza mostrare valori",
    async (content) => {
      const files = await fixture(content, "secret-fixture-not-in-errors");
      const error = await setupDatabasePassword(files).catch((cause) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("secret-fixture-not-in-errors");
      expect(String(error)).not.toContain(ref);
      expect(await readFile(files.envPath, "utf8")).toBe(content);
      expect(await readFile(files.passwordFilePath, "utf8")).toBe(
        "secret-fixture-not-in-errors",
      );
    },
  );

  it("CLI: argomenti espliciti, successo senza segreti ed errori senza percorsi sensibili", async () => {
    const files = await fixture(template, "cli-fixture-password");
    const execute = promisify(execFile);
    const script = "scripts/setup-database-password.ts";
    const result = await execute(process.execPath, [
      "--import",
      "tsx",
      script,
      "--password-file",
      files.passwordFilePath,
      "--env",
      files.envPath,
    ]);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Nessuna connessione di rete eseguita");
    expect(result.stdout).not.toContain("cli-fixture-password");
    const failed = await execute(process.execPath, [
      "--import",
      "tsx",
      script,
      "--env",
      "sensitive-fixture-path",
    ]).catch(
      (error: { stdout: string; stderr: string; code: number }) => error,
    );
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toContain("Configurazione non modificata");
    expect(failed.stderr).not.toContain("sensitive-fixture-path");
  });
});

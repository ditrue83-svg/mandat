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
import { setupSmtpPassword } from "../scripts/setup-smtp-password";

const template = [
  "# Local fixture, containing no real credentials",
  "SMTP_HOST=smtps.aruba.it",
  "SMTP_PORT=465",
  "SMTP_USER=fixture@example.com",
  "SMTP_PASSWORD=",
  "SMTP_PASSWORD_BASE64=",
  'OTHER_SECRET="unchanged # fixture with spaces"',
  "MULTILINE_SECRET='first fixture line\nsecond fixture line'",
  "",
].join("\n");
const directories: string[] = [];

async function fixture(content = template, password = "fixture-password\n") {
  const directory = await mkdtemp(join(tmpdir(), "mandat-smtp-password-"));
  directories.push(directory);
  const envPath = join(directory, ".env.production.local");
  const passwordFilePath = join(directory, "password.txt");
  await writeFile(envPath, content, { mode: 0o600 });
  await writeFile(passwordFilePath, password, { mode: 0o600 });
  return { directory, envPath, passwordFilePath };
}

function decodedPassword(content: string) {
  return Buffer.from(
    parseEnv(content).SMTP_PASSWORD_BASE64!,
    "base64",
  ).toString("utf8");
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("inserimento locale protetto della password SMTP", () => {
  it("preserva tutti gli altri byte, codifica i caratteri speciali e cancella il file dopo il salvataggio atomico", async () => {
    const password = "  spazio:@/#?%+$VAR${OTHER_SECRET}\\n\\\"'`é🔒  ";
    const files = await fixture(template, `${password}\r\n`);
    const before = await lstat(files.envPath);
    await setupSmtpPassword(files);
    const content = await readFile(files.envPath, "utf8");
    const actual = parseEnv(content);
    expect(decodedPassword(content)).toBe(password);
    expect(actual.SMTP_PASSWORD_BASE64).toBe(
      Buffer.from(password).toString("base64"),
    );
    expect(actual.SMTP_PASSWORD).toBe("");
    expect(
      content.replace(/^SMTP_PASSWORD_BASE64=.*$/m, "SMTP_PASSWORD_BASE64="),
    ).toBe(template);
    expect(actual.OTHER_SECRET).toBe(parseEnv(template).OTHER_SECRET);
    expect(actual.MULTILINE_SECRET).toBe(parseEnv(template).MULTILINE_SECRET);
    expect((await lstat(files.envPath)).mode & 0o7777).toBe(0o600);
    expect((await lstat(files.envPath)).ino).not.toBe(before.ino);
    await expect(lstat(files.passwordFilePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(files.directory)).toEqual([".env.production.local"]);
  });

  it.each(["''", '""', "``", " # fixture comment"])(
    "accetta Infomaniak, export e il valore vuoto %j senza newline finale nella password",
    async (emptyValue) => {
      const content = template
        .replace("smtps.aruba.it", "mail.infomaniak.com")
        .replace(
          "SMTP_PASSWORD_BASE64=",
          `export SMTP_PASSWORD_BASE64 = ${emptyValue}`,
        );
      const files = await fixture(content, " untrimmed fixture ");
      await setupSmtpPassword(files);
      const updated = await readFile(files.envPath, "utf8");
      expect(decodedPassword(updated)).toBe(" untrimmed fixture ");
      expect(updated).toContain("export SMTP_PASSWORD_BASE64 =");
    },
  );

  it("preserva CRLF dell’env e il BOM iniziale della password", async () => {
    const content = template.replaceAll("\n", "\r\n");
    const files = await fixture(content, "\ufefffixture\n");
    await setupSmtpPassword(files);
    const updated = await readFile(files.envPath, "utf8");
    expect(decodedPassword(updated)).toBe("\ufefffixture");
    expect(
      updated.replace(/^SMTP_PASSWORD_BASE64=.*$/m, "SMTP_PASSWORD_BASE64="),
    ).toBe(content);
  });

  it.each(["envPath", "passwordFilePath"] as const)(
    "rifiuta UTF-8 non valido in %s senza correggere o cancellare i file",
    async (key) => {
      const files = await fixture();
      const invalid = Buffer.from([0x66, 0x80, 0x6f]);
      await writeFile(files[key], invalid);
      const beforeEnv = await readFile(files.envPath);
      const beforePassword = await readFile(files.passwordFilePath);
      await expect(setupSmtpPassword(files)).rejects.toThrow(
        "Configurazione non modificata.",
      );
      expect(await readFile(files.envPath)).toEqual(beforeEnv);
      expect(await readFile(files.passwordFilePath)).toEqual(beforePassword);
    },
  );

  it.each([
    "",
    "\n",
    "\r\n",
    "fixture\n\n",
    "fixture\nsecret",
    "fixture\r",
    "fixture\0secret",
  ])(
    "rifiuta password vuote, multilinea o NUL conservando entrambi i file (%j)",
    async (password) => {
      const files = await fixture(template, password);
      await expect(setupSmtpPassword(files)).rejects.toThrow(
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
      await expect(setupSmtpPassword(files)).rejects.toThrow(
        "Configurazione non modificata.",
      );
      await chmod(files[key], 0o600);
      const alias = join(files.directory, "alias");
      await symlink(files[key], alias);
      await expect(
        setupSmtpPassword({ ...files, [key]: alias }),
      ).rejects.toThrow("Configurazione non modificata.");
      expect(await readFile(files.envPath, "utf8")).toBe(template);
      expect(await readFile(files.passwordFilePath, "utf8")).toBe(
        "fixture-password\n",
      );
    },
  );

  it("rifiuta la stessa configurazione come file password anche tramite hard link", async () => {
    const files = await fixture();
    const alias = join(files.directory, "hardlink");
    await link(files.envPath, alias);
    for (const passwordFilePath of [files.envPath, alias])
      await expect(
        setupSmtpPassword({ ...files, passwordFilePath }),
      ).rejects.toThrow("Configurazione non modificata.");
    expect(await readFile(files.envPath, "utf8")).toBe(template);
    expect(await readFile(files.passwordFilePath, "utf8")).toBe(
      "fixture-password\n",
    );
  });

  it("rifiuta directory senza modificarne il contenuto", async () => {
    const files = await fixture();
    const directory = join(files.directory, "directory");
    await mkdir(directory, { mode: 0o600 });
    try {
      await expect(
        setupSmtpPassword({ ...files, passwordFilePath: directory }),
      ).rejects.toThrow("Configurazione non modificata.");
      expect(await readFile(files.envPath, "utf8")).toBe(template);
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it.each([
    template.replace("SMTP_PASSWORD=", "SMTP_PASSWORD=existing-fixture"),
    template.replace(
      "SMTP_PASSWORD_BASE64=",
      "SMTP_PASSWORD_BASE64=Zml4dHVyZQ==",
    ),
    template.replace("smtps.aruba.it", "unsupported.example.com"),
    template.replace("fixture@example.com", "not-an-email"),
    template.replace("SMTP_PASSWORD=\n", ""),
    template.replace("SMTP_PASSWORD_BASE64=\n", ""),
    `${template}SMTP_PASSWORD_BASE64=\n`,
    `${template}export SMTP_PASSWORD=\n`,
    template.replace("SMTP_PASSWORD_BASE64=", "SMTP_PASSWORD_BASE64='\n'"),
    template.replace("SMTP_PASSWORD_BASE64=", "SMTP_PASSWORD_BASE64='"),
    template.replace("SMTP_PASSWORD=", 'SMTP_PASSWORD="\n"'),
  ])(
    "rifiuta password esistenti e configurazioni ambigue senza mostrare valori",
    async (content) => {
      const password = "secret-fixture-not-in-errors";
      const files = await fixture(content, password);
      const error = await setupSmtpPassword(files).catch((cause) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("Configurazione non modificata.");
      expect(String(error)).not.toContain(password);
      expect(String(error)).not.toContain(
        Buffer.from(password).toString("base64"),
      );
      expect(String(error)).not.toContain("fixture@example.com");
      expect(await readFile(files.envPath, "utf8")).toBe(content);
      expect(await readFile(files.passwordFilePath, "utf8")).toBe(password);
      expect(await readdir(files.directory)).toHaveLength(2);
    },
  );

  it("CLI: richiede argomenti espliciti e non mostra segreti o percorsi sensibili", async () => {
    const password = "cli-fixture-password";
    const files = await fixture(template, password);
    const execute = promisify(execFile);
    const script = "scripts/setup-smtp-password.ts";
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
    expect(result.stdout).toContain(
      "Nessuna connessione di rete o invio email eseguiti",
    );
    expect(result.stdout).not.toContain(password);
    expect(result.stdout).not.toContain(
      Buffer.from(password).toString("base64"),
    );
    for (const args of [
      ["--env", "sensitive-fixture-path"],
      ["--env", "sensitive-fixture-path", "--env", "second-path"],
      ["--unknown", "sensitive-fixture-path", "--env", files.envPath],
    ]) {
      const failed = await execute(process.execPath, [
        "--import",
        "tsx",
        script,
        ...args,
      ]).catch(
        (error: { stdout: string; stderr: string; code: number }) => error,
      );
      expect(failed.stdout).toBe("");
      expect(failed.stderr).toContain("Configurazione non modificata");
      expect(failed.stderr).not.toContain("sensitive-fixture-path");
    }
  });
});

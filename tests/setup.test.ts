import { describe, it, expect } from "vitest";
import {
  inspectSetup,
  setupGroupConfigured,
  type SetupEnvironment,
} from "../src/lib/setup";

// Invented configuration used only by the pure validator: no network requests.
const configured: SetupEnvironment = {
  APP_MODE: "live",
  APP_URL: "https://mandat.example",
  DOMAIN: "mandat.example",
  BETTER_AUTH_SECRET: "random-secret-placeholder-for-unit-tests-123456789",
  FOUNDER_EMAIL: "founder@example.invalid",
  DATABASE_URL: "postgresql://mandat:only-a-test-password@db:5432/mandat",
  POSTGRES_USER: "mandat",
  POSTGRES_PASSWORD: "only-a-test-password",
  POSTGRES_DB: "mandat",
  SMTP_HOST: "mail.infomaniak.com",
  SMTP_PORT: "587",
  SMTP_USER: "radar@example.invalid",
  SMTP_PASSWORD: "mail-secret-fixture",
  MAIL_FROM: "Mandat <radar@example.invalid>",
  LLM_API_KEY: "model-secret-fixture",
  INFOMANIAK_AI_PRODUCT_ID: "123",
  LLM_MODEL: "mistralai/Ministral-3-14B-Instruct-2512",
  LLM_INPUT_CHF_PER_MILLION: "0.4",
  LLM_OUTPUT_CHF_PER_MILLION: "0.5",
  AI_MONTHLY_BUDGET_CHF: "40",
  RESTIC_REPOSITORY: "s3:https://s3.swiss-backup99.infomaniak.com/test-bucket",
  RESTIC_PASSWORD: "distinct-backup-secret",
  AWS_ACCESS_KEY_ID: "access-fixture",
  AWS_SECRET_ACCESS_KEY: "object-secret-fixture",
  AWS_DEFAULT_REGION: "us-east-1",
  FOGLIO_REUSE_CONFIRMED: "false",
};
describe("Controllo configurazione senza segreti", () => {
  it("validates a complete Mistral EU configuration without requiring an Infomaniak key", () => {
    const env = {
      ...configured,
      LLM_PROVIDER: "mistral-eu",
      LLM_MODEL: "mistral-large-2512",
      LLM_API_KEY: "",
      INFOMANIAK_AI_PRODUCT_ID: "",
      MISTRAL_API_KEY: "mistral-fixture-secret",
    };
    const checks = inspectSetup(env);
    expect(setupGroupConfigured(checks, "ai")).toBe(true);
    expect(checks.find((c) => c.id === "MISTRAL_DATA_SETTINGS")?.status).toBe(
      "manual",
    );
    expect(JSON.stringify(checks)).not.toContain(env.MISTRAL_API_KEY);
    for (const base of [
      "https://api.mistral.ai/v1",
      "https://api.us.mistral.ai/v1",
    ])
      expect(
        setupGroupConfigured(
          inspectSetup({ ...env, MISTRAL_API_BASE_URL: base }),
          "ai",
        ),
      ).toBe(false);
  });

  it("blocks a documentary migration with missing credentials, prices or stale model settings", () => {
    const env = {
      ...configured,
      DOCUMENTARY_LLM_PROVIDER: "mistral-eu",
      MISTRAL_API_KEY: "mistral-fixture-secret",
      DOCUMENTARY_LLM_INPUT_CHF_PER_MILLION: "0.6",
      DOCUMENTARY_LLM_OUTPUT_CHF_PER_MILLION: "1.8",
    };
    expect(setupGroupConfigured(inspectSetup(env), "documentary-ai")).toBe(
      true,
    );
    for (const incomplete of [
      { MISTRAL_API_KEY: "" },
      { DOCUMENTARY_LLM_INPUT_CHF_PER_MILLION: "" },
      { DOCUMENTARY_LLM_MODEL: "mistral-large-latest" },
      { DOCUMENTARY_SOURCE_REASONING_EFFORT: "high" },
      { DOCUMENTARY_LLM_PROVIDER: "mistral-global" },
    ])
      expect(
        setupGroupConfigured(
          inspectSetup({ ...env, ...incomplete }),
          "documentary-ai",
        ),
      ).toBe(false);
    expect(
      setupGroupConfigured(inspectSetup({ ...env, MISTRAL_API_KEY: "" }), "ai"),
    ).toBe(true);
  });
  it("distingue configurazione coerente da collaudo reale ancora necessario", () => {
    const checks = inspectSetup(configured);
    expect(
      checks.filter((c) => ["missing", "invalid"].includes(c.status)),
    ).toEqual([]);
    expect(setupGroupConfigured(checks, "ai")).toBe(true);
    expect(checks.find((c) => c.id === "BACKUP_RESTORE")?.status).toBe(
      "manual",
    );
    expect(checks.find((c) => c.id === "FOGLIO_COVERAGE")?.message).toContain(
      "disattivato",
    );
  });
  it("rileva la demo e i segnaposto della configurazione iniziale", () => {
    const checks = inspectSetup({
      ...configured,
      APP_MODE: "demo",
      POSTGRES_PASSWORD: "CHANGE_ME",
      DATABASE_URL: "postgresql://mandat:CHANGE_ME@db:5432/mandat",
      LLM_API_KEY: "",
    });
    expect(checks.find((c) => c.id === "APP_MODE")?.status).toBe("invalid");
    expect(setupGroupConfigured(checks, "database")).toBe(false);
    expect(setupGroupConfigured(checks, "ai")).toBe(false);
  });
  it("accetta Aruba con TLS sulla porta 465 e password codificata", () => {
    const password = " a$VAR#'\"`\\passwordè ";
    const env = {
      ...configured,
      SMTP_HOST: "smtps.aruba.it",
      SMTP_PORT: "465",
      SMTP_PASSWORD: "",
      SMTP_PASSWORD_BASE64: Buffer.from(password).toString("base64"),
    };
    expect(setupGroupConfigured(inspectSetup(env), "email")).toBe(true);
    for (const port of ["587", "25", ""]) {
      expect(
        inspectSetup({ ...env, SMTP_PORT: port }).find(
          (c) => c.id === "SMTP_PORT",
        )?.status,
      ).toBe("invalid");
    }
    expect(JSON.stringify(inspectSetup(env))).not.toContain(password);
    expect(JSON.stringify(inspectSetup(env))).not.toContain(
      env.SMTP_PASSWORD_BASE64,
    );
  });
  it("blocca password SMTP ambigue, malformate e host non configurati", () => {
    for (const env of [
      { ...configured, SMTP_PASSWORD_BASE64: "c2VjcmV0" },
      { ...configured, SMTP_PASSWORD: "", SMTP_PASSWORD_BASE64: "%%%" },
      { ...configured, SMTP_HOST: "unconfigured.example" },
    ]) {
      expect(setupGroupConfigured(inspectSetup(env), "email")).toBe(false);
    }
  });
  it("rifiuta HTTP, credenziali nelle URL, provider estranei e budget superiore a quello beta", () => {
    const checks = inspectSetup({
      ...configured,
      APP_URL: "http://user:secret@mandat.example",
      LLM_API_BASE_URL: "https://api.example.com/2/ai/123/openai/v1",
      AI_MONTHLY_BUDGET_CHF: "41",
    });
    for (const id of ["APP_URL", "LLM_API_BASE_URL", "AI_MONTHLY_BUDGET_CHF"])
      expect(checks.find((c) => c.id === id)?.status).toBe("invalid");
  });
  it("gestisce password codificate e riconosce accessi database incoerenti", () => {
    const env = {
      ...configured,
      POSTGRES_PASSWORD: "secret:@with-percent%",
      DATABASE_URL:
        "postgresql://mandat:secret%3A%40with-percent%25@db:5432/mandat",
    };
    expect(setupGroupConfigured(inspectSetup(env), "database")).toBe(true);
    expect(
      setupGroupConfigured(
        inspectSetup({ ...env, POSTGRES_DB: "wrong" }),
        "database",
      ),
    ).toBe(false);
    expect(() =>
      inspectSetup({
        ...env,
        DATABASE_URL: "postgresql://mandat:%wrong@db:5432/mandat",
      }),
    ).not.toThrow();
    expect(
      setupGroupConfigured(
        inspectSetup({
          ...env,
          DATABASE_URL: `${env.DATABASE_URL}?user=another&password=another`,
        }),
        "database",
      ),
    ).toBe(false);
  });
  it("non include password, chiavi, email o URL private nel report", () => {
    const output = JSON.stringify(inspectSetup(configured));
    for (const key of [
      "BETTER_AUTH_SECRET",
      "FOUNDER_EMAIL",
      "DATABASE_URL",
      "POSTGRES_PASSWORD",
      "SMTP_USER",
      "SMTP_PASSWORD",
      "LLM_API_KEY",
      "RESTIC_PASSWORD",
      "AWS_SECRET_ACCESS_KEY",
    ])
      expect(output).not.toContain(configured[key]);
  });
  it("richiede una chiave di cifratura backup separata", () => {
    expect(
      inspectSetup({
        ...configured,
        RESTIC_PASSWORD: configured.POSTGRES_PASSWORD,
      }).find((c) => c.id === "RESTIC_PASSWORD_UNIQUE")?.status,
    ).toBe("invalid");
  });
});

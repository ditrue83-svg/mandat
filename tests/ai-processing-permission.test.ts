import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import type { CompanyProfile } from "../src/lib/domain";
import { getDemoOpportunities } from "../src/lib/demo";
import { PILOT_PARTICIPATION_TERMS_VERSION } from "../src/lib/pilot-participation";

const injected = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => injected.db }));
vi.mock("@/lib/profile-matching", () => ({
  enqueueProfileMatching: vi.fn(async () => "invented-job"),
}));
vi.mock("@/lib/viewer", () => ({
  HttpError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
import { enqueueProfileMatching } from "../src/lib/profile-matching";
import {
  AI_PROCESSING_NOTICE_HASH,
  assertCompanyAiProcessing,
  companyAllowsAiProcessing,
  readAiProcessingStatus,
  setCompanyAiProcessing,
} from "../src/lib/ai-processing-permission";
import { AI_PROCESSING_NOTICE_VERSION } from "../src/lib/ai-processing-notice";
import { classify } from "../src/worker/ai";

const pg = new PGlite(),
  db = drizzle(pg, { schema });
const profile: CompanyProfile = {
  name: "Ditta inventata",
  activities: "Pulizia di uffici, profilo inventato riservato al test",
  employees: 2,
  sectors: ["pulizie"],
  zones: ["Tutto il Ticino"],
  keywords: [],
  exclusions: [],
  minValue: null,
  maxValue: null,
  emailEnabled: false,
};
beforeAll(async () => {
  injected.db = db;
  vi.stubGlobal("fetch", async () => {
    throw new Error("Network forbidden in permission tests");
  });
  await pg.exec(
    "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;",
  );
  await migrate(db, { migrationsFolder: "drizzle" });
});
beforeEach(() => {
  vi.stubEnv("LLM_PROVIDER", "openai");
  vi.stubEnv("DOCUMENTARY_LLM_PROVIDER", "openai");
  vi.stubEnv("LLM_MODEL", "gpt-6-luna");
  vi.stubEnv("OPENAI_API_BASE_URL", "https://api.openai.com/v1");
  vi.stubEnv("OPENAI_API_KEY", "invented-local-test-placeholder");
  vi.stubEnv("LLM_INPUT_CHF_PER_MILLION", "0.15");
  vi.stubEnv("LLM_OUTPUT_CHF_PER_MILLION", "0.75");
  vi.stubEnv("AI_MONTHLY_BUDGET_CHF", "10");
  vi.mocked(enqueueProfileMatching).mockClear();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await pg.close();
});

async function firm(admin = false) {
  const id = randomUUID();
  await db
    .insert(schema.user)
    .values({ id, name: "Titolare inventato", email: `${id}@example.invalid` });
  await db
    .insert(schema.companies)
    .values({ id, ownerId: id, profile, onboardedAt: new Date() });
  await db
    .insert(schema.invitations)
    .values({
      id,
      companyId: id,
      email: `${id}@example.invalid`,
      expiresAt: new Date("2099-01-01"),
      acceptedAt: new Date(),
      acceptedVersion: PILOT_PARTICIPATION_TERMS_VERSION,
    });
  if (admin) await db.insert(schema.administrators).values({ userId: id });
  return { companyId: id, userId: id };
}
const accept = (owner: Awaited<ReturnType<typeof firm>>) =>
  setCompanyAiProcessing({
    ...owner,
    enabled: true,
    confirmed: true,
    noticeVersion: AI_PROCESSING_NOTICE_VERSION,
    noticeHash: AI_PROCESSING_NOTICE_HASH,
  });
const receipts = (id: string) =>
  db
    .select()
    .from(schema.aiProcessingReceipts)
    .where(eq(schema.aiProcessingReceipts.companyId, id));

it("Neither participation nor founder status implicitly authorizes company-data processing", async () => {
  for (const admin of [false, true]) {
    const owner = await firm(admin);
    expect(
      await companyAllowsAiProcessing(owner.companyId, "documentary"),
    ).toBe(false);
    expect(await companyAllowsAiProcessing(owner.companyId, "legacy")).toBe(
      false,
    );
    expect(
      (await readAiProcessingStatus(owner.companyId, owner.userId)).active,
    ).toBe(false);
    expect(await receipts(owner.companyId)).toEqual([]);
  }
});

it("Records explicit acceptance once, preserving the original pilot receipt", async () => {
  const owner = await firm();
  const original = await db
    .select()
    .from(schema.invitations)
    .where(eq(schema.invitations.id, owner.companyId));
  const first = await accept(owner),
    second = await accept(owner);
  expect(first.active).toBe(true);
  expect(second).toEqual(first);
  expect(await receipts(owner.companyId)).toHaveLength(1);
  expect(vi.mocked(enqueueProfileMatching)).toHaveBeenCalledTimes(1);
  expect(
    await db
      .select()
      .from(schema.invitations)
      .where(eq(schema.invitations.id, owner.companyId)),
  ).toEqual(original);
});

it("Rejects missing confirmation, obsolete text and another company's identity", async () => {
  const owner = await firm(),
    other = await firm();
  for (const change of [
    { confirmed: false },
    { noticeVersion: "old-notice" },
    { noticeHash: "0".repeat(64) },
  ])
    await expect(
      setCompanyAiProcessing({
        ...owner,
        enabled: true,
        confirmed: true,
        noticeVersion: AI_PROCESSING_NOTICE_VERSION,
        noticeHash: AI_PROCESSING_NOTICE_HASH,
        ...change,
      }),
    ).rejects.toMatchObject({ status: 409 });
  await expect(
    accept({ companyId: other.companyId, userId: owner.userId }),
  ).rejects.toMatchObject({ status: 404 });
  expect(await receipts(owner.companyId)).toEqual([]);
  expect(await receipts(other.companyId)).toEqual([]);
  expect(vi.mocked(enqueueProfileMatching)).not.toHaveBeenCalled();
});

it("Revocation is isolated, retains history, and re-enabling creates a new receipt", async () => {
  const owner = await firm(),
    other = await firm();
  await accept(owner);
  await accept(other);
  const [old] = await receipts(owner.companyId);
  await setCompanyAiProcessing({ ...owner, enabled: false });
  expect(await companyAllowsAiProcessing(owner.companyId, "documentary")).toBe(
    false,
  );
  expect(await companyAllowsAiProcessing(other.companyId, "documentary")).toBe(
    true,
  );
  await accept(owner);
  const all = await receipts(owner.companyId);
  expect(all).toHaveLength(2);
  const historical = all.find((r) => r.id === old.id)!;
  expect(historical.revokedAt).not.toBeNull();
  expect({ ...historical, revokedAt: null }).toEqual(old);
  expect(all.filter((r) => r.revokedAt === null)).toHaveLength(1);
});

it("An OpenAI receipt does not authorize another provider or endpoint", async () => {
  const owner = await firm();
  await accept(owner);
  vi.stubEnv("DOCUMENTARY_LLM_PROVIDER", "anthropic");
  expect(await companyAllowsAiProcessing(owner.companyId, "documentary")).toBe(
    false,
  );
  expect(await companyAllowsAiProcessing(owner.companyId, "legacy")).toBe(true);
  vi.stubEnv("OPENAI_API_BASE_URL", "https://unexpected.example.invalid/v1");
  await expect(
    companyAllowsAiProcessing(owner.companyId, "legacy"),
  ).rejects.toThrow(/endpoint/);
  expect(
    await readAiProcessingStatus(owner.companyId, owner.userId),
  ).toMatchObject({ available: false, active: true });
  expect(
    await setCompanyAiProcessing({ ...owner, enabled: false }),
  ).toMatchObject({ available: false, active: false });
});

it("Revoked invitations and disabled companies remain blocked after AI acceptance", async () => {
  for (const mode of ["invitation", "company"]) {
    const owner = await firm(true);
    await accept(owner);
    if (mode === "invitation")
      await db
        .update(schema.invitations)
        .set({ revokedAt: new Date() })
        .where(eq(schema.invitations.id, owner.companyId));
    else
      await db
        .update(schema.companies)
        .set({ disabledAt: new Date() })
        .where(eq(schema.companies.id, owner.companyId));
    expect(
      await companyAllowsAiProcessing(owner.companyId, "documentary"),
    ).toBe(false);
    await expect(accept(owner)).rejects.toMatchObject({ status: 404 });
  }
});

it("The database protects receipt history, owner binding and client access", async () => {
  const owner = await firm(),
    other = await firm();
  await accept(owner);
  const [receipt] = await receipts(owner.companyId);
  await expect(
    db
      .update(schema.aiProcessingReceipts)
      .set({ noticeVersion: "rewritten" })
      .where(eq(schema.aiProcessingReceipts.id, receipt.id)),
  ).rejects.toThrow();
  await expect(
    db
      .insert(schema.aiProcessingReceipts)
      .values({ ...receipt, id: randomUUID(), userId: other.userId }),
  ).rejects.toThrow();
  await setCompanyAiProcessing({ ...owner, enabled: false });
  await expect(
    db
      .update(schema.aiProcessingReceipts)
      .set({ revokedAt: null })
      .where(eq(schema.aiProcessingReceipts.id, receipt.id)),
  ).rejects.toThrow();
  const { rows } = await pg.query<{ protected: boolean }>(
    "select relrowsecurity as protected from pg_class where relname='ai_processing_receipts'",
  );
  expect(rows[0].protected).toBe(true);
  for (const role of ["anon", "authenticated", "service_role"])
    expect(
      (
        await pg.query<{ allowed: boolean }>(
          "select has_table_privilege($1,'ai_processing_receipts','SELECT,INSERT,UPDATE,DELETE') as allowed",
          [role],
        )
      ).rows[0].allowed,
    ).toBe(false);
});

it("A revocation between the public scope read and the private legacy request prevents the latter", async () => {
  const owner = await firm();
  await accept(owner);
  const publication = {
    ...getDemoOpportunities()[0],
    id: randomUUID(),
    originalText: "Pulizia ordinaria degli uffici comunali.",
    documentPages: [],
  };
  const complete = vi.fn(async (_system: string, prompt: string) => {
    expect(prompt).not.toContain(profile.activities);
    const data = JSON.parse(prompt);
    await setCompanyAiProcessing({ ...owner, enabled: false });
    return {
      text: JSON.stringify({
        scope: "specific",
        servicePassageId: data.passages[0].id,
      }),
      inputTokens: 30,
      outputTokens: 10,
    };
  });
  await expect(
    classify(publication, profile, { complete }, () =>
      assertCompanyAiProcessing(owner.companyId, "legacy"),
    ),
  ).rejects.toThrow(/disattivati/);
  expect(complete).toHaveBeenCalledTimes(1);
  const usage = await db
    .select()
    .from(schema.aiUsage)
    .where(eq(schema.aiUsage.publicationId, publication.id));
  expect(usage.map((r) => r.purpose)).toEqual(["match-scope"]);
});

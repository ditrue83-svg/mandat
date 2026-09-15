import { beforeAll, afterAll, beforeEach, it, expect, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { demoProfile, getDemoOpportunities } from "../src/lib/demo";
import { PILOT_PARTICIPATION_TERMS_VERSION } from "../src/lib/pilot-participation";

const context = vi.hoisted(() => ({
  db: undefined as unknown,
  summary: {
    summary: "Sommario di prova senza alcuna chiamata esterna.",
    sectors: ["pulizie"] as ["pulizie"],
    requirements: [],
    evidence: [],
  },
}));
vi.mock("@/db", () => ({ getDb: () => context.db }));
vi.mock("@/worker/ai", () => ({
  summarize: vi.fn(async () => context.summary),
  classify: vi.fn(async () => ({
    score: 90,
    reason: "Pertinente nel test locale",
    uncertain: false,
    needsReview: false,
  })),
}));
import { enrichAndMatch } from "../src/worker/pipeline";
import { summarize, classify } from "../src/worker/ai";
import { getRadarStatus, listOpportunities } from "../src/lib/queries";
import { queueDigests } from "../src/worker/notifications";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const publication = {
  ...getDemoOpportunities()[1],
  id: "timestamp-test",
  externalId: "timestamp-test",
  summary: null,
  revision: "v1",
  status: "open" as const,
  visibleAt: "2026-01-01T00:00:00Z",
  deadline: null,
};

beforeAll(async () => {
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(schema.user).values({
    id: "a",
    name: "A",
    email: "a@example.invalid",
  });
  await db.insert(schema.companies).values({
    id: "a",
    ownerId: "a",
    profile: {
      ...demoProfile,
      sectors: ["pulizie"],
      exclusions: [],
      minValue: null,
      maxValue: null,
    },
    onboardedAt: new Date(),
  });
  await db.insert(schema.invitations).values({
    id: "timestamp-invitation",
    email: "a@example.invalid",
    companyId: "a",
    expiresAt: new Date("2099-01-01"),
    acceptedAt: new Date(),
    acceptedVersion: PILOT_PARTICIPATION_TERMS_VERSION,
  });
});
beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(schema.notifications);
  await db.delete(schema.settings);
  await db.delete(schema.sourceRuns);
  await db.delete(schema.matches);
  await db.delete(schema.publications);
  await db.insert(schema.publications).values({
    id: publication.id,
    canonicalId: publication.id,
    source: publication.source,
    externalId: publication.externalId,
    title: publication.title,
    status: publication.status,
    visibleAt: new Date(publication.visibleAt),
    data: publication,
    revision: publication.revision,
    updatedAt: sql`'2026-09-11 12:00:00.123456+00'::timestamptz`,
  });
});
afterAll(async () => pg.close());

it("completa analisi e matching con microsecondi PostgreSQL senza ripetere l’AI", async () => {
  const [before] = await db
    .select({
      date: schema.publications.updatedAt,
      exact: sql<string>`${schema.publications.updatedAt}::text`,
    })
    .from(schema.publications);
  expect(before.date.toISOString()).toBe("2026-09-11T12:00:00.123Z");
  expect(before.exact).toContain(".123456");

  await enrichAndMatch({ publicationId: publication.id });
  await enrichAndMatch({ publicationId: publication.id });

  const [after] = await db.select().from(schema.publications);
  expect(after.aiRevision).toBe("v1");
  expect(after.data.summary).toBe(context.summary.summary);
  expect(summarize).toHaveBeenCalledTimes(1);
  expect(classify).toHaveBeenCalledTimes(1);
  const matches = await db.select().from(schema.matches);
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({ companyId: "a", eligible: true });
});

it("mantiene il bando poco descritto in revisione senza ripetere analisi o accodare alert automatici", async () => {
  vi.stubEnv("FOGLIO_REUSE_CONFIRMED", "false");
  vi.stubEnv("APP_URL", "https://mandat.example.invalid");
  try {
    vi.mocked(classify).mockResolvedValueOnce({
      score: 0,
      reason: "La fonte non descrive abbastanza le prestazioni richieste.",
      uncertain: true,
      needsReview: true,
    });
    await enrichAndMatch({ publicationId: publication.id });
    await enrichAndMatch({ publicationId: publication.id });
    expect(classify).toHaveBeenCalledTimes(1);
    const [match] = await db.select().from(schema.matches);
    expect(match).toMatchObject({ score: 0, eligible: true, approved: null });
    expect(match.reviewNotes).toBeTruthy();
    expect(match.revision).not.toContain(":retry");
    const [company] = await db.select().from(schema.companies);
    const viewer = {
      companyId: company.id,
      userId: company.ownerId,
      profile: company.profile,
      name: "A",
      email: "a@example.invalid",
      admin: false,
      demo: false,
      invitationAcceptedAt: new Date(0).toISOString(),
      invitationAcceptanceVersion: PILOT_PARTICIPATION_TERMS_VERSION,
    };
    expect(await getRadarStatus(viewer)).toEqual({
      state: "ready",
      pendingCount: 0,
    });
    expect(await listOpportunities(viewer)).toMatchObject([
      { id: publication.id, assessment: "uncertain" },
    ]);

    const now = new Date("2026-09-12T10:00:00Z");
    await db
      .insert(schema.settings)
      .values({ key: "automation_enabled", value: true });
    await db.insert(schema.sourceRuns).values({
      id: "current-source",
      source: "simap",
      status: "success",
      finishedAt: now,
    });
    const [stored] = await db.select().from(schema.publications);
    await db.insert(schema.publications).values({
      ...stored,
      id: "uncertain-high",
      externalId: "uncertain-high",
      canonicalId: "uncertain-high",
      data: {
        ...stored.data,
        id: "uncertain-high",
        externalId: "uncertain-high",
      },
    });
    await db.insert(schema.matches).values({
      ...match,
      id: "uncertain-high-row",
      publicationId: "uncertain-high",
      score: 95,
    });
    await queueDigests(now);
    expect(await db.select().from(schema.notifications)).toEqual([]);

    // A positive control proves the empty outbox is due to the review state,
    // not a disabled sender, stale source or a global guard in this fixture.
    await db.insert(schema.publications).values({
      ...stored,
      id: "clear-match",
      externalId: "clear-match",
      canonicalId: "clear-match",
      data: { ...stored.data, id: "clear-match", externalId: "clear-match" },
    });
    await db.insert(schema.matches).values({
      ...match,
      id: "clear-match-row",
      publicationId: "clear-match",
      score: 90,
      reviewNotes: null,
    });
    await queueDigests(now);
    const notices = await db.select().from(schema.notifications);
    expect(notices).toHaveLength(1);
    expect(notices[0].items.map((item) => item.id)).toEqual(["clear-match"]);
    expect(notices[0].textBody).toContain("Pubblicazione non ufficiale.");
    expect(notices[0].html).toContain("Pubblicazione non ufficiale.");
    expect(notices[0].textBody).toContain(
      "Valutazione Mandat · Pertinenza stimata dall’AI",
    );
    expect(notices[0].textBody).toContain(match.reason);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("non rivaluta né rende candidato un lavoro escluso esplicitamente dal profilo", async () => {
  const [company] = await db.select().from(schema.companies);
  try {
    await db.update(schema.companies).set({
      profile: { ...company.profile, exclusions: ["escluso-esplicitamente"] },
    });
    await db.update(schema.publications).set({
      data: {
        ...publication,
        originalText: "Pulizia escluso-esplicitamente dal profilo.",
      },
    });
    await enrichAndMatch({ publicationId: publication.id });
    expect(classify).not.toHaveBeenCalled();
    const [match] = await db.select().from(schema.matches);
    expect(match).toMatchObject({
      score: 0,
      eligible: false,
      reason: "Contiene un’attività esclusa dal tuo profilo.",
    });
  } finally {
    await db.update(schema.companies).set({ profile: company.profile });
  }
});

it("rifiuta una risposta AI precedente a una modifica nello stesso millisecondo", async () => {
  let started!: () => void;
  let finish!: (value: Awaited<ReturnType<typeof summarize>>) => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const completion = new Promise<Awaited<ReturnType<typeof summarize>>>(
    (resolve) => {
      finish = resolve;
    },
  );
  vi.mocked(summarize).mockImplementationOnce(async () => {
    started();
    return completion;
  });
  const running = enrichAndMatch({ publicationId: publication.id });
  await waiting;
  const amended = {
    ...publication,
    sourceUrls: [
      ...publication.sourceUrls,
      "https://example.invalid/rettifica",
    ],
  };
  await db.update(schema.publications).set({
    data: amended,
    updatedAt: sql`'2026-09-11 12:00:00.123789+00'::timestamptz`,
  });
  finish(context.summary);
  await running;

  const [after] = await db.select().from(schema.publications);
  expect(after.data).toEqual(amended);
  expect(after.aiRevision).toBeNull();
  expect(classify).not.toHaveBeenCalled();
  expect(await db.select().from(schema.matches)).toEqual([]);
});

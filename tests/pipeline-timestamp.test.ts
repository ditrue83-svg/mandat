import { beforeAll, afterAll, beforeEach, it, expect, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { demoProfile, getDemoOpportunities } from "../src/lib/demo";

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
  })),
}));
import { enrichAndMatch } from "../src/worker/pipeline";
import { summarize, classify } from "../src/worker/ai";

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
});
beforeEach(async () => {
  vi.clearAllMocks();
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

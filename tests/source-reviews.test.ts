import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import type { Publication } from "../src/lib/domain";
import { isSourceDependencyCurrent } from "../src/lib/source-review-context";

const injected = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => injected.db }));
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
import {
  appendSourceReview,
  loadSourceReviewContext,
  readSourceReviewContext,
  readSourceReviewContexts,
  type LoadedSourceReview,
  type SourceReviewInput,
  type SourceReviewExecutor,
} from "../src/lib/source-reviews";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const executor = db as unknown as SourceReviewExecutor;
const viewer = { userId: "source-review-admin", admin: true, demo: false };
let next = 0;
function publication(id: string): Publication {
  return {
    id,
    externalId: id,
    source: "simap",
    title: "Avviso inventato",
    buyer: "Ente di prova",
    location: "Luogo di prova",
    canton: "TI",
    zone: null,
    publishedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    visibleAt: "2026-01-01T08:00:00Z",
    deadline: null,
    valueChf: null,
    procedure: null,
    status: "open",
    sectors: [],
    cpv: [],
    sourceUrl: `https://example.test/${id}`,
    sourceUrls: [`https://example.test/${id}`],
    originalText: `Testo documentario inventato ${id}.`,
    originalTitles: [
      {
        text: `Titre fictif ${id}.`,
        language: "fr",
        url: `https://example.test/${id}`,
        path: "title.fr",
      },
    ],
    documentPages: [
      {
        text: "Testo della pagina inventata.",
        page: 4,
        url: `https://example.test/${id}.pdf`,
      },
    ],
    summary: "Sintesi da conservare",
    requirements: [],
    evidence: [],
    documents: [
      {
        title: "Allegato",
        url: `https://example.test/${id}.pdf`,
        requiresLogin: false,
      },
    ],
    reviewRequired: false,
    reviewReasons: [],
    revision: "content-1",
  };
}
async function insertPublication() {
  const p = publication(`source-fixture-${++next}`);
  await db.insert(schema.publications).values({
    id: p.id,
    canonicalId: p.id,
    externalId: p.externalId,
    source: p.source,
    title: p.title,
    status: p.status,
    visibleAt: new Date(p.visibleAt),
    data: p,
    revision: "source-1",
    aiRevision: p.revision,
  });
  return p;
}
function draft(
  loaded: LoadedSourceReview,
  action: "opened" | "recorded" = "recorded",
): SourceReviewInput {
  let references: SourceReviewInput["references"] = [];
  if (action === "recorded" && loaded.snapshot.source.accepted) {
    const unit = loaded.snapshot.source.corpus.units.find((unit) =>
      unit.origins.some((origin) => origin.kind === "document_page"),
    )!;
    references = [
      {
        unitId: unit.id,
        originIndex: 0,
        startUtf16: 0,
        endUtf16: unit.text.length,
      },
    ];
  }
  return {
    publicationId: loaded.publication.id,
    expectedEventId: loaded.expected.eventId,
    expectedSourceSnapshotHash: loaded.expected.sourceSnapshotHash,
    expectedCorpusHash: loaded.expected.corpusHash,
    action,
    form: action === "recorded" ? "broad_scope" : null,
    references,
    note: "Giudizio umano inventato; il test verifica il protocollo.",
  };
}
async function row(id: string) {
  return (
    await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, id))
  )[0];
}

beforeAll(async () => {
  injected.db = db;
  await pg.exec(
    "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;",
  );
  await migrate(db, { migrationsFolder: "drizzle" });
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(schema.user).values({
    id: viewer.userId,
    name: "Revisore di prova",
    email: "reviewer@example.invalid",
  });
  await db.insert(schema.administrators).values({ userId: viewer.userId });
});
afterAll(() => pg.close());

it("requires an authenticated administrator on both reads and writes; actor cannot come from JSON", async () => {
  const p = await insertPublication(),
    initial = await loadSourceReviewContext(p.id, viewer);
  for (const actor of [
    { ...viewer, demo: true },
    { ...viewer, admin: false },
    { ...viewer, userId: "not-an-admin" },
  ]) {
    await expect(loadSourceReviewContext(p.id, actor)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      appendSourceReview(draft(initial), actor),
    ).rejects.toMatchObject({ status: 403 });
  }
  await expect(
    appendSourceReview({ ...draft(initial), actorId: "forged" }, viewer),
  ).rejects.toThrow();
  expect((await loadSourceReviewContext(p.id, viewer)).history).toHaveLength(0);
  const saved = await appendSourceReview(draft(initial), viewer);
  expect(saved.history[0].event.actorId).toBe(viewer.userId);
  await expect(
    loadSourceReviewContext("missing", viewer),
  ).rejects.toMatchObject({ status: 404 });
});

it("stores a human source history and exact provenance without rewriting publication JSON or manual matches", async () => {
  const p = await insertPublication();
  await db.insert(schema.companies).values({
    id: p.id,
    ownerId: viewer.userId,
    profile: {
      name: "Ditta inventata",
      activities: "Attività inventata",
      employees: 1,
      sectors: [],
      zones: [],
      keywords: [],
      exclusions: [],
      minValue: null,
      maxValue: null,
      emailEnabled: false,
    },
  });
  await db.insert(schema.matches).values({
    id: p.id,
    companyId: p.id,
    publicationId: p.id,
    revision: "manual-legacy",
    score: 80,
    reason: "Giudizio manuale da conservare",
    eligible: true,
    approved: true,
    reviewedAt: new Date("2026-01-01T09:00:00Z"),
    reviewNotes: "Nota riservata",
  });
  const before = await row(p.id),
    beforeMatch = await db
      .select()
      .from(schema.matches)
      .where(eq(schema.matches.id, p.id));
  const opened = await appendSourceReview(
    draft(await loadSourceReviewContext(p.id, viewer), "opened"),
    viewer,
  );
  expect(opened.context.state).toBe("review_required");
  const recorded = await appendSourceReview(draft(opened), viewer);
  expect(recorded.context.state).toBe("manual_source");
  expect(recorded.history).toHaveLength(2);
  expect(recorded.history[0]).toEqual(opened.history[0]);
  expect(recorded.history[1].event.evidence[0]).toMatchObject({
    quote: p.documentPages![0].text,
    origin: { page: 4, url: p.documentPages![0].url },
  });
  expect(await row(p.id)).toEqual(before);
  expect(
    await db.select().from(schema.matches).where(eq(schema.matches.id, p.id)),
  ).toEqual(beforeMatch);
  expect(beforeMatch[0].sourceReviewDependency).toBeNull();
});

it("rejects two competing event snapshots with one winner, without claiming PostgreSQL two-connection locking", async () => {
  const p = await insertPublication(),
    input = draft(await loadSourceReviewContext(p.id, viewer));
  const attempts = await Promise.allSettled([
    appendSourceReview(input, viewer),
    appendSourceReview(input, viewer),
  ]);
  expect(
    attempts.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const failure = attempts.find((result) => result.status === "rejected");
  expect(failure?.status === "rejected" && failure.reason.status).toBe(409);
  expect((await loadSourceReviewContext(p.id, viewer)).history).toHaveLength(1);
});

it("rejects changed documentary snapshot/corpus even at the same revision and keeps summary edits compatible", async () => {
  const p = await insertPublication(),
    initial = await loadSourceReviewContext(p.id, viewer);
  await expect(
    appendSourceReview(
      { ...draft(initial), expectedCorpusHash: "f".repeat(64) },
      viewer,
    ),
  ).rejects.toMatchObject({ status: 409 });
  const translated = {
    ...p,
    originalTitles: [
      ...p.originalTitles!,
      {
        text: "Nuovo titolo originale.",
        language: "it" as const,
        url: p.sourceUrl,
        path: "title.it",
      },
    ],
  };
  await db
    .update(schema.publications)
    .set({ data: translated })
    .where(eq(schema.publications.id, p.id));
  await expect(
    appendSourceReview(draft(initial), viewer),
  ).rejects.toMatchObject({ status: 409 });
  const loaded = await loadSourceReviewContext(p.id, viewer);
  await db
    .update(schema.publications)
    .set({
      data: {
        ...translated,
        summary: "Sintesi corretta",
        revision: "editorial-2",
      },
    })
    .where(eq(schema.publications.id, p.id));
  const saved = await appendSourceReview(draft(loaded), viewer);
  expect(saved.history[0].event.contentRevision).toBe("editorial-2");
  expect(saved.expected.sourceSnapshotHash).toBe(
    loaded.expected.sourceSnapshotHash,
  );
});

it("batch readers use their supplied executor, return null for legacy sources and invalidate only the changed source", async () => {
  const a = await insertPublication(),
    b = await insertPublication(),
    legacy = await insertPublication();
  const savedA = await appendSourceReview(
    draft(await loadSourceReviewContext(a.id, viewer)),
    viewer,
  );
  const savedB = await appendSourceReview(
    draft(await loadSourceReviewContext(b.id, viewer)),
    viewer,
  );
  const batch = await readSourceReviewContexts(executor, [
    a,
    { id: b.id, data: b },
    legacy,
  ]);
  expect(batch.get(a.id)).toEqual(savedA.context);
  expect(batch.get(b.id)).toEqual(savedB.context);
  expect(batch.get(legacy.id)).toBeNull();
  expect(await readSourceReviewContext(executor, legacy)).toBeNull();
  await db
    .update(schema.publications)
    .set({ data: { ...a, originalText: "Originale modificato." } })
    .where(eq(schema.publications.id, a.id));
  const changed = await loadSourceReviewContext(a.id, viewer),
    unchanged = await loadSourceReviewContext(b.id, viewer);
  expect(changed.context).toMatchObject({
    state: "review_required",
    reason: "source_changed",
  });
  expect(
    isSourceDependencyCurrent(
      savedA.context.dependency,
      changed.snapshot,
      changed.history,
    ),
  ).toBe(false);
  expect(
    isSourceDependencyCurrent(
      savedB.context.dependency,
      unchanged.snapshot,
      unchanged.history,
    ),
  ).toBe(true);
  expect(changed.history).toEqual(savedA.history);
});

it("refuses nonexistent original references and source forms on incomplete inputs, but permits opening a review", async () => {
  const p = await insertPublication(),
    loaded = await loadSourceReviewContext(p.id, viewer);
  const input = draft(loaded);
  input.references[0].originIndex = 999;
  await expect(appendSourceReview(input, viewer)).rejects.toMatchObject({
    status: 400,
  });
  await db
    .update(schema.publications)
    .set({ data: { ...p, originalText: "x".repeat(18001) } })
    .where(eq(schema.publications.id, p.id));
  const refused = await loadSourceReviewContext(p.id, viewer);
  expect(refused.context.state).toBe("input_refused");
  await expect(
    appendSourceReview(
      { ...draft(refused), references: draft(loaded).references },
      viewer,
    ),
  ).rejects.toMatchObject({ status: 400 });
  const opened = await appendSourceReview(draft(refused, "opened"), viewer);
  expect(opened.context).toMatchObject({
    state: "review_required",
    reason: "explicit_open",
  });
  expect(opened.history[0].event.corpusHash).toBeNull();
});

it("migration enforces append-only DML, source identity and unique sequence even for the owner", async () => {
  const p = await insertPublication(),
    saved = await appendSourceReview(
      draft(await loadSourceReviewContext(p.id, viewer)),
      viewer,
    );
  const record = saved.history[0];
  for (const query of [
    "UPDATE source_review_events SET sequence=sequence",
    "DELETE FROM source_review_events",
    "TRUNCATE source_review_events",
  ])
    await expect(pg.exec(query)).rejects.toThrow(/append-only/i);
  await expect(
    db.delete(schema.publications).where(eq(schema.publications.id, p.id)),
  ).rejects.toThrow();
  await expect(
    db.insert(schema.sourceReviewEvents).values({
      id: "mismatched",
      publicationId: p.id,
      sequence: 2,
      event: record.event,
      snapshot: record.snapshot,
    }),
  ).rejects.toThrow();
  await expect(
    db.insert(schema.sourceReviewEvents).values({
      id: "duplicate-sequence",
      publicationId: p.id,
      sequence: 1,
      event: { ...record.event, id: "duplicate-sequence" },
      snapshot: record.snapshot,
    }),
  ).rejects.toThrow();
  expect((await loadSourceReviewContext(p.id, viewer)).history).toEqual(
    saved.history,
  );
});

it("new history has RLS and no public/client grants, including the BYPASSRLS role", async () => {
  const protection = await pg.query<{ protected: boolean; policies: number }>(
    "SELECT relrowsecurity protected,(SELECT count(*)::int FROM pg_policies WHERE tablename='source_review_events') policies FROM pg_class WHERE oid='public.source_review_events'::regclass",
  );
  expect(protection.rows[0]).toEqual({ protected: true, policies: 0 });
  for (const role of ["anon", "authenticated", "service_role"]) {
    await pg.exec(`SET ROLE ${role}`);
    try {
      await expect(
        pg.query("SELECT * FROM public.source_review_events"),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        pg.query("TRUNCATE public.source_review_events"),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await pg.exec("RESET ROLE");
    }
    const grants = await pg.query<{ write: boolean; execute: boolean }>(
      `SELECT has_table_privilege('${role}','public.source_review_events','INSERT') write, has_function_privilege('${role}','public.reject_source_review_mutation()','EXECUTE') execute`,
    );
    expect(grants.rows[0]).toEqual({ write: false, execute: false });
  }
});

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import { PgBoss, fromPglite } from "pg-boss";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "../src/db/schema";
import { demoProfile, getDemoOpportunities } from "../src/lib/demo";

const context = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => context.db }));
vi.mock("@/worker/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/worker/ai")>()),
  summarize: vi.fn(),
  classify: vi.fn(),
}));
vi.mock("@/worker/notifications", () => ({ queueChangeNotices: vi.fn() }));
import { AiUnavailable, classify, summarize } from "../src/worker/ai";
import { enrichAndMatch, storePublication } from "../src/worker/pipeline";

let directory: string;
let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
const now = new Date("2026-09-12T10:00:00Z");
const summary = {
  summary: "Riassunto inventato per il test locale dei ritentativi.",
  sectors: ["pulizie"] as ["pulizie"],
  evidence: [],
  requirements: [],
};
const assessment = {
  score: 90,
  reason: "Esito inventato del classificatore locale.",
  uncertain: false,
  needsReview: false,
};
const profile = {
  ...demoProfile,
  sectors: ["pulizie"] as ["pulizie"],
  zones: ["Tutto il Ticino"],
  exclusions: [],
  minValue: null,
  maxValue: null,
};
const publication = {
  ...getDemoOpportunities()[1],
  id: "local-ai-retry",
  externalId: "local-ai-retry",
  canonicalKey: "local-ai-retry",
  summary: null,
  revision: "local-source-v1",
  status: "open" as const,
  canton: "TI",
  sectors: ["pulizie"] as ["pulizie"],
  visibleAt: "2026-01-01T00:00:00Z",
  deadline: null,
};
const run = () => enrichAndMatch({ publicationId: publication.id, now });
const storedMatches = () =>
  db.select().from(schema.matches).orderBy(schema.matches.companyId);
const storedIssues = () => db.select().from(schema.issues);
const sourceReview = {
  status: "required" as const,
  kind: "conflicting" as const,
  token: "00000000-0000-4000-8000-000000000001",
  sourceRevision: publication.revision,
  updatedAt: "2026-09-12T10:00:00Z",
};
async function setSourceReview(
  review:
    | typeof sourceReview
    | (Omit<typeof sourceReview, "status"> & { status: "resolved" }),
) {
  const [row] = await db
    .select()
    .from(schema.publications)
    .where(eq(schema.publications.id, publication.id));
  await db
    .update(schema.publications)
    .set({
      data: { ...row.data, sourceScopeReview: review },
      updatedAt: new Date(),
    })
    .where(eq(schema.publications.id, publication.id));
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mandat-ai-retry-"));
  pg = new PGlite(directory);
  db = drizzle(pg, { schema });
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
  for (const id of ["a", "b"]) {
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.invalid` });
    await db.insert(schema.companies).values({ id, ownerId: id, profile });
  }
}, 20000);

beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(summarize).mockResolvedValue(summary);
  vi.mocked(classify).mockResolvedValue(assessment);
  await db.delete(schema.issues);
  await db.delete(schema.matches);
  await db.delete(schema.publicationVersions);
  await db.delete(schema.publications);
  await db
    .update(schema.companies)
    .set({ profile, onboardedAt: null, disabledAt: null });
  await db
    .update(schema.companies)
    .set({ onboardedAt: now })
    .where(eq(schema.companies.id, "a"));
  await storePublication(publication);
});

afterAll(async () => {
  await pg.close();
  await rm(directory, { recursive: true, force: true });
});

it("mantiene lo stesso dubbio sulla fonte per due ditte senza chiamate AI o retry", async () => {
  await db
    .update(schema.companies)
    .set({
      onboardedAt: now,
      profile: { ...profile, activities: "Pulizia di vetrate e facciate." },
    })
    .where(eq(schema.companies.id, "b"));
  await setSourceReview(sourceReview);
  await run();
  const records = await storedMatches();
  expect(records).toHaveLength(2);
  for (const match of records) {
    expect(match).toMatchObject({ score: 0, eligible: true, approved: null });
    expect(match.reviewNotes).toBeTruthy();
    expect(match.reason).toContain("verifica della fonte");
    expect(match.revision).toContain(`:source-scope:${sourceReview.token}`);
    expect(match.revision).not.toMatch(/:retry$/);
  }
  expect(summarize).not.toHaveBeenCalled();
  expect(classify).not.toHaveBeenCalled();
  await run();
  expect(await storedMatches()).toEqual(records);
});

it("il blocco sulla fonte non annulla le esclusioni dichiarate dalla ditta", async () => {
  await db
    .update(schema.companies)
    .set({
      profile: { ...profile, exclusions: [publication.title] },
    })
    .where(eq(schema.companies.id, "a"));
  await setSourceReview(sourceReview);
  await run();
  const [match] = await storedMatches();
  expect(match).toMatchObject({ eligible: false, score: 0, reviewNotes: null });
  expect(match.reason).toContain("esclusa dal tuo profilo");
  expect(classify).not.toHaveBeenCalled();
});

it.each([true, false, "legacy-negative"] as const)(
  "conserva la decisione manuale %s quando cambia solo la verifica della fonte",
  async (decision) => {
    await run();
    const approved = decision === true;
    await db.update(schema.matches).set({
      approved,
      eligible: approved,
      reviewedAt: decision === "legacy-negative" ? null : now,
      reviewNotes: "Revisione manuale di prova",
    });
    const before = await storedMatches();
    vi.mocked(classify).mockClear();
    await setSourceReview(sourceReview);
    await run();
    expect(await storedMatches()).toEqual(before);
    await setSourceReview({
      ...sourceReview,
      status: "resolved",
      token: "00000000-0000-4000-8000-000000000002",
    });
    await run();
    expect(await storedMatches()).toEqual(before);
    expect(classify).not.toHaveBeenCalled();
  },
);

it("rivaluta soltanto la cache automatica dopo la risoluzione esplicita, senza approvare il risultato", async () => {
  await setSourceReview(sourceReview);
  await run();
  const [before] = await storedMatches();
  await setSourceReview({
    ...sourceReview,
    status: "resolved",
    token: "00000000-0000-4000-8000-000000000002",
  });
  vi.mocked(classify).mockResolvedValueOnce({ ...assessment, score: 0 });
  await run();
  const [after] = await storedMatches();
  expect(after.id).toBe(before.id);
  expect(after).toMatchObject({ eligible: false, score: 0, approved: null });
  expect(after.revision).toContain("00000000-0000-4000-8000-000000000002");
  expect(summarize).toHaveBeenCalledTimes(1);
  expect(classify).toHaveBeenCalledTimes(1);
});

it("non salva una classificazione iniziata prima della segnalazione del dubbio sulla fonte", async () => {
  vi.mocked(classify).mockImplementationOnce(async () => {
    await setSourceReview(sourceReview);
    return assessment;
  });
  await run();
  expect(await storedMatches()).toHaveLength(0);
  await run();
  const [after] = await storedMatches();
  expect(after).toMatchObject({ score: 0, eligible: true, approved: null });
  expect(classify).toHaveBeenCalledTimes(1);
});

it("non sovrascrive una segnalazione arrivata durante la sintesi", async () => {
  vi.mocked(summarize).mockImplementationOnce(async () => {
    await setSourceReview(sourceReview);
    return summary;
  });
  await run();
  const [current] = await db.select().from(schema.publications);
  expect(current.data.sourceScopeReview).toEqual(sourceReview);
  expect(current.data.summary).toBeNull();
  expect(await storedMatches()).toHaveLength(0);
  expect(classify).not.toHaveBeenCalled();
});

it("conserva il token della verifica anche se updatedAt coincide con la lettura precedente", async () => {
  const [before] = await db
    .select({
      updatedToken: sql<string>`${schema.publications.updatedAt}::text`,
    })
    .from(schema.publications);
  vi.mocked(summarize).mockImplementationOnce(async () => {
    await setSourceReview(sourceReview);
    await db.update(schema.publications).set({
      updatedAt: sql`${before.updatedToken}::timestamptz`,
    });
    return summary;
  });
  await run();
  const [current] = await db.select().from(schema.publications);
  expect(current.data.sourceScopeReview).toEqual(sourceReview);
  expect(current.data.summary).toBeNull();
  expect(await storedMatches()).toHaveLength(0);
});

it("una rettifica della fonte conserva il dubbio richiesto con la sua origine precedente", async () => {
  await setSourceReview(sourceReview);
  await storePublication({
    ...publication,
    revision: "local-source-v2",
    originalText: "Fonte aggiornata, non ancora verificata.",
  });
  const [current] = await db.select().from(schema.publications);
  expect(current.revision).toBe("local-source-v2");
  expect(current.data.sourceScopeReview).toEqual(sourceReview);
});

it("l’importazione conserva una segnalazione registrata dopo la lettura iniziale della fonte", async () => {
  const transaction = db.transaction.bind(db);
  const hook = vi
    .spyOn(db, "transaction")
    .mockImplementationOnce(async (...args) => {
      await setSourceReview(sourceReview);
      return transaction(...args);
    });
  try {
    await storePublication({ ...publication, revision: "local-source-v2" });
  } finally {
    hook.mockRestore();
  }
  const [current] = await db.select().from(schema.publications);
  expect(current.data.sourceScopeReview).toEqual(sourceReview);
  expect(current.revision).toBe("local-source-v2");
});

it("trasmette una verifica ancora aperta alla rettifica della stessa gara con nuovo identificativo", async () => {
  await setSourceReview(sourceReview);
  const revised = {
    ...publication,
    id: "local-ai-retry-new-notice",
    externalId: "local-ai-retry-new-notice",
    revision: "local-source-v2",
    publishedAt: "2026-09-13T00:00:00Z",
  };
  await storePublication(revised);
  const [current] = await db
    .select()
    .from(schema.publications)
    .where(eq(schema.publications.id, revised.id));
  expect(current.data.sourceScopeReview).toEqual(sourceReview);
});

it("propaga il dubbio dalla più recente edizione letta nella transazione", async () => {
  const middle = {
    ...publication,
    id: "middle-notice",
    externalId: "middle-notice",
    revision: "middle-revision",
    publishedAt: "2026-09-13T00:00:00Z",
  };
  const middleReview = { ...sourceReview, sourceRevision: middle.revision };
  const latest = {
    ...publication,
    id: "latest-notice",
    externalId: "latest-notice",
    revision: "latest-revision",
    publishedAt: "2026-09-14T00:00:00Z",
  };
  const transaction = db.transaction.bind(db);
  const hook = vi
    .spyOn(db, "transaction")
    .mockImplementationOnce(async (...args) => {
      // The newer predecessor did not exist when storePublication first read
      // cousins. Its source review must still reach the latest edition.
      await storePublication(middle);
      await db
        .update(schema.publications)
        .set({
          data: { ...middle, sourceScopeReview: middleReview },
        })
        .where(eq(schema.publications.id, middle.id));
      return transaction(...args);
    });
  try {
    await storePublication(latest);
  } finally {
    hook.mockRestore();
  }
  const [current] = await db
    .select()
    .from(schema.publications)
    .where(eq(schema.publications.id, latest.id));
  expect(current.status).toBe("open");
  expect(current.data.sourceScopeReview).toEqual(middleReview);
});

it("persiste lo stato pending dopo un errore di sintesi e recupera senza riusare una falsa cache", async () => {
  vi.mocked(summarize).mockRejectedValueOnce(new Error("HTTP 503 locale"));
  await expect(run()).rejects.toThrow();
  const [pendingPublication] = await db.select().from(schema.publications);
  expect(pendingPublication.aiRevision).toBeNull();
  expect(pendingPublication.data.summary).toBeNull();
  const [pending] = await storedMatches();
  expect(pending.revision).toContain(":pending:");
  expect(pending.reviewNotes).toBeTruthy();
  expect(pending.approved).toBeNull();
  expect(classify).not.toHaveBeenCalled();
  expect((await storedIssues())[0].resolvedAt).toBeNull();

  await run();
  const [ready] = await storedMatches();
  expect(ready.revision).toContain(":ready:");
  expect(ready.revision).not.toContain(":retry");
  expect(ready.reviewNotes).toBeNull();
  expect((await storedIssues())[0].resolvedAt).not.toBeNull();
  await run();
  expect(summarize).toHaveBeenCalledTimes(2);
  expect(classify).toHaveBeenCalledTimes(1);
  expect(await storedMatches()).toHaveLength(1);
});

it("recupera solo la ditta fallita conservando sintesi e valutazioni già completate", async () => {
  await db
    .update(schema.companies)
    .set({ onboardedAt: now })
    .where(eq(schema.companies.id, "b"));
  vi.mocked(classify).mockRejectedValueOnce(new Error("HTTP 429 locale"));
  await expect(run()).rejects.toThrow();
  const first = await storedMatches();
  expect(first).toHaveLength(2);
  const retry = first.find((m) => m.revision.endsWith(":retry"))!;
  const completed = first.find((m) => !m.revision.endsWith(":retry"))!;
  expect(retry.reviewNotes).toBeTruthy();
  expect(retry.approved).toBeNull();
  expect(completed.reviewNotes).toBeNull();
  await run();
  const second = await storedMatches();
  expect(second.find((m) => m.id === completed.id)).toEqual(completed);
  expect(second.find((m) => m.id === retry.id)?.revision).not.toContain(
    ":retry",
  );
  expect((await storedIssues())[0].resolvedAt).not.toBeNull();
  await run();
  expect(summarize).toHaveBeenCalledTimes(1);
  expect(classify).toHaveBeenCalledTimes(3);
});

it("ritenta il job persistito dopo chiusura di coda e database senza ripetere la sintesi", async () => {
  const createQueue = () =>
    new PgBoss({
      db: fromPglite(pg),
      backend: "pglite",
      schema: "pgboss_retry",
      schedule: false,
      supervise: false,
    });
  let queue = createQueue();
  try {
    await queue.start();
    await queue.createQueue("match-publication", {
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      policy: "singleton",
      expireInSeconds: 1800,
    });
    const id = await queue.send(
      "match-publication",
      { publicationId: publication.id },
      { singletonKey: publication.id },
    );
    const [active] = await queue.fetch("match-publication");
    vi.mocked(classify).mockRejectedValueOnce(new Error("Timeout AI locale"));
    let failed = false;
    try {
      await run();
      await queue.complete("match-publication", active.id);
    } catch (e) {
      failed = true;
      await queue.fail("match-publication", active.id, {
        message: e instanceof Error ? e.message : String(e),
      });
    }
    expect(failed).toBe(true);
    expect(
      (await queue.findJobs("match-publication", { id: id! }))[0].state,
    ).toBe("retry");
    const delayed = await pg.query<{
      deferred: boolean;
      retry_delay: number;
      retry_backoff: boolean;
    }>(
      "SELECT start_after > now() AS deferred, retry_delay, retry_backoff FROM pgboss_retry.job WHERE id = $1",
      [id],
    );
    expect(delayed.rows).toEqual([
      { deferred: true, retry_delay: 60, retry_backoff: true },
    ]);
    await queue.stop();
    await pg.close();
    pg = new PGlite(directory);
    db = drizzle(pg, { schema });
    context.db = db;
    queue = createQueue();
    await queue.start();
    expect((await storedMatches())[0].revision).toMatch(/:retry$/);
    // Advance this local fixture's due time, without a real 60-second wait.
    await pg.query(
      "UPDATE pgboss_retry.job SET start_after = now() - interval '1 second' WHERE id = $1",
      [id],
    );
    const [retry] = await queue.fetch("match-publication", {
      includeMetadata: true,
    });
    expect(retry.id).toBe(id);
    expect(retry.data).toEqual({ publicationId: publication.id });
    await run();
    await queue.complete("match-publication", retry.id);
    expect(
      (await queue.findJobs("match-publication", { id: id! }))[0].state,
    ).toBe("completed");
    expect(await queue.fetch("match-publication")).toEqual([]);
    expect((await storedMatches())[0].revision).not.toContain(":retry");
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledTimes(2);
  } finally {
    await queue.stop();
  }
}, 20000);

it("dopo una nuova revisione della fonte non riusa né la vecchia sintesi né il vecchio match", async () => {
  await run();
  const amended = {
    ...publication,
    revision: "local-source-v2",
    originalText:
      "Testo rettificato inventato: richiesta di pulizia dei locali.",
  };
  await storePublication(amended);
  const [invalidated] = await db.select().from(schema.publications);
  expect(invalidated.aiRevision).toBeNull();
  await run();
  expect(vi.mocked(summarize).mock.calls[1][0]).toMatchObject({
    revision: amended.revision,
    originalText: amended.originalText,
  });
  expect(vi.mocked(classify).mock.calls[1][0]).toMatchObject({
    revision: amended.revision,
    originalText: amended.originalText,
  });
  expect((await storedMatches())[0].revision).toContain("local-source-v2:");
  await run();
  expect(summarize).toHaveBeenCalledTimes(2);
  expect(classify).toHaveBeenCalledTimes(2);
});

it("propaga un errore di commit senza creare una cache di matching completato", async () => {
  await pg.exec(`CREATE FUNCTION reject_local_match() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Commit locale interrotto'; END; $$;
    CREATE TRIGGER reject_local_match BEFORE INSERT ON matches FOR EACH ROW EXECUTE FUNCTION reject_local_match();`);
  try {
    await expect(run()).rejects.toThrow();
    expect(await storedMatches()).toEqual([]);
    const [p] = await db.select().from(schema.publications);
    expect(p.aiRevision).toBe(publication.revision);
  } finally {
    await pg.exec(
      "DROP TRIGGER reject_local_match ON matches; DROP FUNCTION reject_local_match();",
    );
  }
  await run();
  expect(await storedMatches()).toHaveLength(1);
  expect(summarize).toHaveBeenCalledTimes(1);
  expect(classify).toHaveBeenCalledTimes(2);
});

it.each([true, false])(
  "preserva un aggiornamento concorrente (%s) del match con token SQL cambiato",
  async (approved) => {
    vi.mocked(classify).mockRejectedValueOnce(
      new Error("Timeout iniziale locale"),
    );
    await expect(run()).rejects.toThrow();
    await db
      .update(schema.matches)
      .set({ updatedAt: sql`'2026-09-12 12:00:00.123456+00'::timestamptz` });
    let started!: () => void;
    let finish!: (value: typeof assessment) => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const completion = new Promise<typeof assessment>((resolve) => {
      finish = resolve;
    });
    vi.mocked(classify).mockImplementationOnce(async () => {
      started();
      return completion;
    });
    const running = run();
    await waiting;
    await db.update(schema.matches).set({
      approved,
      reviewedAt: now,
      eligible: approved,
      reason: "Revisione manuale locale da conservare",
      reviewNotes: null,
      updatedAt: sql`'2026-09-12 12:00:00.123789+00'::timestamptz`,
    });
    const before = await storedMatches();
    finish(assessment);
    await running;
    expect(await storedMatches()).toEqual(before);
    await run();
    expect(classify).toHaveBeenCalledTimes(2);
  },
);

it.each([true, false])(
  "preserva i campi della route review (%s) senza modifiche a revision o updatedAt",
  async (approved) => {
    vi.mocked(classify).mockRejectedValueOnce(new Error("Timeout locale"));
    await expect(run()).rejects.toThrow();
    const [initial] = await storedMatches();
    let started!: () => void;
    let finish!: (value: typeof assessment) => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const response = new Promise<typeof assessment>((resolve) => {
      finish = resolve;
    });
    vi.mocked(classify).mockImplementationOnce(async () => {
      started();
      return response;
    });
    const running = run();
    await waiting;
    // Exactly the five fields written by the deployed admin review route.
    await db
      .update(schema.matches)
      .set({
        approved,
        eligible: approved,
        score: approved ? Math.max(60, initial.score) : initial.score,
        reviewedAt: now,
        reviewNotes: "Revisione manuale: a",
      })
      .where(eq(schema.matches.id, initial.id));
    const manual = await storedMatches();
    expect(manual[0].updatedAt).toEqual(initial.updatedAt);
    expect(manual[0].revision).toBe(initial.revision);
    finish(assessment);
    await running;
    expect(await storedMatches()).toEqual(manual);
    await run();
    expect(classify).toHaveBeenCalledTimes(2);
  },
);

it("rileva il nuovo reviewedAt anche nello stesso millisecondo senza altri campi cambiati", async () => {
  await run();
  await db.update(schema.matches).set({
    revision: "older-reviewed-evaluation",
    approved: true,
    eligible: true,
    reviewedAt: sql`'2026-09-12 12:00:00.123456+00'::timestamptz`,
    reviewNotes: "Revisione manuale: a",
  });
  vi.mocked(classify).mockImplementationOnce(async () => {
    await db.update(schema.matches).set({
      reviewedAt: sql`'2026-09-12 12:00:00.123789+00'::timestamptz`,
    });
    return assessment;
  });
  const [before] = await storedMatches();
  await run();
  const [after] = await storedMatches();
  expect(after).toEqual(before); // JavaScript dates alone cannot see the change.
  const [exact] = await db
    .select({ token: sql<string>`${schema.matches.reviewedAt}::text` })
    .from(schema.matches);
  expect(exact.token).toContain(".123789");
  expect(classify).toHaveBeenCalledTimes(2);
});

it("non salva una risposta AI dopo l’annullamento del job", async () => {
  const controller = new AbortController();
  vi.mocked(classify).mockImplementationOnce(async () => {
    controller.abort(new Error("Job locale annullato"));
    return assessment;
  });
  await expect(
    enrichAndMatch({
      publicationId: publication.id,
      now,
      signal: controller.signal,
    }),
  ).rejects.toThrow("Job locale annullato");
  expect(await storedMatches()).toEqual([]);
  expect(await storedIssues()).toEqual([]);
  await run();
  expect(await storedMatches()).toHaveLength(1);
  expect(summarize).toHaveBeenCalledTimes(1);
  expect(classify).toHaveBeenCalledTimes(2);
});

it("non salva la sintesi dopo l’annullamento del job", async () => {
  const controller = new AbortController();
  vi.mocked(summarize).mockImplementationOnce(async () => {
    controller.abort(new Error("Sintesi locale annullata"));
    return summary;
  });
  await expect(
    enrichAndMatch({
      publicationId: publication.id,
      now,
      signal: controller.signal,
    }),
  ).rejects.toThrow("Sintesi locale annullata");
  const [p] = await db.select().from(schema.publications);
  expect(p.aiRevision).toBeNull();
  expect(p.data.summary).toBeNull();
  expect(classify).not.toHaveBeenCalled();
  expect(await storedMatches()).toEqual([]);
  expect(await storedIssues()).toEqual([]);
});

it("non sovrascrive un match comparso durante la prima classificazione", async () => {
  vi.mocked(classify).mockImplementationOnce(async () => {
    await db.insert(schema.matches).values({
      id: "other-local-assessment",
      companyId: "a",
      publicationId: publication.id,
      revision: "assessment-committed-during-ai",
      score: 0,
      eligible: false,
      approved: false,
      reviewedAt: now,
      reason: "Valutazione locale già salvata",
    });
    return assessment;
  });
  await run();
  const [m] = await storedMatches();
  expect(m).toMatchObject({
    id: "other-local-assessment",
    revision: "assessment-committed-during-ai",
    score: 0,
    eligible: false,
    approved: false,
    reviewedAt: now,
    reason: "Valutazione locale già salvata",
  });
  expect(await storedMatches()).toHaveLength(1);
});

it("scarta la risposta di un profilo precedente e valuta il profilo corrente al giro successivo", async () => {
  const changedProfile = {
    ...profile,
    activities: "Attività aggiornate inventate: pulizia uffici.",
  };
  vi.mocked(classify).mockImplementationOnce(async () => {
    await db
      .update(schema.companies)
      .set({ profile: changedProfile })
      .where(eq(schema.companies.id, "a"));
    return assessment;
  });
  await run();
  expect(await storedMatches()).toEqual([]);
  await run();
  expect(await storedMatches()).toHaveLength(1);
  expect(vi.mocked(classify).mock.calls[1][1]).toEqual(changedProfile);
  expect(summarize).toHaveBeenCalledTimes(1);
  expect(classify).toHaveBeenCalledTimes(2);
});

it.each(["summary", "match"])(
  "conserva una sospensione %s AiUnavailable senza retry ravvicinato e la recupera al giro successivo",
  async (stage) => {
    // The budget exception inherits this existing class; no provider or ledger
    // is used here. Ordinary transport failures are covered separately above.
    const blocked = new AiUnavailable(
      "Budget/configurazione sospesi nel test locale",
    );
    if (stage === "summary")
      vi.mocked(summarize).mockRejectedValueOnce(blocked);
    else vi.mocked(classify).mockRejectedValueOnce(blocked);
    await expect(run()).resolves.toBeUndefined();
    const [pending] = await storedMatches();
    expect(pending.reviewNotes).toBeTruthy();
    expect(pending.approved).toBeNull();
    expect(
      stage === "summary"
        ? pending.revision.includes(":pending:")
        : pending.revision.endsWith(":retry"),
    ).toBe(true);
    const [issue] = await storedIssues();
    expect(issue.detail).toBe(blocked.message);
    expect(issue.resolvedAt).toBeNull();
    await run();
    expect((await storedMatches())[0].reviewNotes).toBeNull();
    expect((await storedIssues())[0].resolvedAt).not.toBeNull();
  },
);

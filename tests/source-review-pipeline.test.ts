import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { demoProfile, getDemoOpportunities } from "../src/lib/demo";
import type { Publication } from "../src/lib/domain";
import { PILOT_PARTICIPATION_TERMS_VERSION } from "../src/lib/pilot-participation";
import type { HumanSourceForm } from "../src/lib/source-review-context";

const context = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => context.db }));
vi.mock("@/worker/ai", async (original) => ({
  ...(await original<typeof import("../src/worker/ai")>()),
  summarize: vi.fn(),
  classify: vi.fn(),
}));
vi.mock("@/worker/notifications", () => ({ queueChangeNotices: vi.fn() }));
import { classify, summarize } from "../src/worker/ai";
import { enrichAndMatch, storePublication } from "../src/worker/pipeline";
import {
  appendSourceReview,
  loadSourceReviewContext,
  readSourceReviewContext,
} from "../src/lib/source-reviews";

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
const now = new Date("2026-09-13T10:00:00.000Z");
const viewer = { userId: "founder", admin: true, demo: false };
const profile = {
  ...demoProfile,
  sectors: ["pulizie"] as ["pulizie"],
  zones: ["Tutto il Ticino"],
  keywords: [],
  exclusions: [],
  minValue: null,
  maxValue: null,
};
const p: Publication = {
  ...getDemoOpportunities()[0],
  id: "source-review-pipeline",
  externalId: "source-review-pipeline",
  canonicalKey: "source-review-family",
  source: "simap",
  revision: "source-review-v1",
  title: "Pulizia di uffici, fonte inventata",
  originalText: "Pulizia periodica degli uffici comunali.",
  originalTitles: [
    {
      text: "Nettoyage des bureaux, source fictive",
      language: "fr",
      url: "https://example.invalid/source/title",
      path: "title.fr",
    },
  ],
  originalDescriptions: [
    {
      text: "Reinigung von Büros, erfundene Quelle.",
      language: "de",
      url: "https://example.invalid/source/detail",
    },
  ],
  documentPages: [
    {
      text: "Pulizia di uffici e vetrate, pagina inventata.",
      page: 2,
      url: "https://example.invalid/source.pdf",
    },
  ],
  documents: [
    {
      title: "Documento inventato",
      url: "https://example.invalid/source.pdf",
      requiresLogin: false,
    },
  ],
  sourceUrl: "https://example.invalid/source",
  sourceUrls: ["https://example.invalid/source"],
  sectors: ["pulizie"],
  canton: "TI",
  zone: null,
  valueChf: null,
  deadline: null,
  visibleAt: "2026-01-01T07:00:00.000Z",
  publishedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  status: "open",
  reviewRequired: false,
  reviewReasons: [],
  summary: "Sintesi inventata già presente.",
};
const assessment = {
  score: 85,
  reason: "Esito mock, senza valore semantico.",
  uncertain: false,
  needsReview: false,
};
const storedMatches = () =>
  db.select().from(schema.matches).orderBy(schema.matches.publicationId);
const run = (id = p.id) => enrichAndMatch({ publicationId: id, now });
async function insert(input: Publication) {
  await db.insert(schema.publications).values({
    id: input.id,
    externalId: input.externalId,
    canonicalId: input.canonicalKey ?? input.id,
    source: input.source,
    title: input.title,
    status: input.status,
    visibleAt: new Date(input.visibleAt),
    deadline: input.deadline ? new Date(input.deadline) : null,
    data: input,
    revision: input.revision,
    aiRevision: input.summary ? input.revision : null,
  });
}
async function amend(changes: Partial<Publication>) {
  const [row] = await db
    .select()
    .from(schema.publications)
    .where(eq(schema.publications.id, p.id));
  await db
    .update(schema.publications)
    .set({ data: { ...row.data, ...changes }, updatedAt: new Date() })
    .where(eq(schema.publications.id, p.id));
}
async function review(form: HumanSourceForm | "opened", id = p.id) {
  const loaded = await loadSourceReviewContext(id, viewer);
  const unit = loaded.snapshot.source.accepted
    ? loaded.snapshot.source.corpus.units.find((u) => u.text.trim())
    : undefined;
  return appendSourceReview(
    {
      publicationId: id,
      expectedEventId: loaded.expected.eventId,
      expectedSourceSnapshotHash: loaded.expected.sourceSnapshotHash,
      expectedCorpusHash: loaded.expected.corpusHash,
      action: form === "opened" ? "opened" : "recorded",
      form: form === "opened" ? null : form,
      references:
        form === "opened"
          ? []
          : [
              {
                unitId: unit!.id,
                originIndex: 0,
                startUtf16: 0,
                endUtf16: Math.min(unit!.text.length, 100),
              },
            ],
      note: "Revisione inventata per il solo test tecnico del consumer.",
    },
    viewer,
  );
}
async function beforeNextTransaction(action: () => Promise<void>) {
  let injected = false;
  // Deterministic interleaving on one local PGlite connection; this does not
  // replace a PostgreSQL test of two concurrent connections and real locks.
  context.db = new Proxy(db, {
    get(target, property) {
      if (property === "transaction")
        return async (...args: Parameters<typeof db.transaction>) => {
          if (!injected) {
            injected = true;
            await action();
          }
          return db.transaction(...args);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    await run();
    expect(injected).toBe(true);
  } finally {
    context.db = db;
  }
}
beforeEach(async () => {
  // A separate local database per test preserves the append-only history rules.
  pg = new PGlite();
  db = drizzle(pg, { schema });
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(schema.user).values([
    { id: "founder", name: "Founder", email: "founder@example.invalid" },
    { id: "firm", name: "Firm", email: "firm@example.invalid" },
  ]);
  await db.insert(schema.administrators).values({ userId: "founder" });
  await db
    .insert(schema.companies)
    .values({ id: "firm", ownerId: "firm", profile, onboardedAt: now });
  await db.insert(schema.invitations).values({
    id: "firm-invitation",
    email: "firm@example.invalid",
    companyId: "firm",
    expiresAt: new Date("2099-01-01"),
    acceptedAt: now,
    acceptedVersion: PILOT_PARTICIPATION_TERMS_VERSION,
  });
  await insert(p);
  vi.mocked(classify).mockReset().mockResolvedValue(assessment);
  vi.mocked(summarize)
    .mockReset()
    .mockResolvedValue({
      summary: "Sintesi di prova prodotta dal mock locale.",
      sectors: ["pulizie"],
      requirements: [],
      evidence: [],
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network forbidden in source-review pipeline tests");
    }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await pg.close();
});

it("mantiene il percorso senza eventi e la cache legacy senza inventare una dipendenza", async () => {
  await run();
  await run();
  expect(classify).toHaveBeenCalledTimes(1);
  expect(summarize).not.toHaveBeenCalled();
  expect(vi.mocked(classify).mock.calls[0]).toHaveLength(2);
  expect((await storedMatches())[0]).toMatchObject({
    score: 85,
    eligible: true,
    sourceReviewDependency: null,
  });
});

it.each([
  "opened",
  "defined_service",
  "broad_scope",
  "unclear",
  "conflicting",
] as const)(
  "conclude %s in revisione senza sintesi, AI o retry",
  async (form) => {
    await amend({ summary: null });
    await db.update(schema.publications).set({ aiRevision: null });
    const loaded = await review(form);
    await run();
    await run();
    expect(classify).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    const [match] = await storedMatches();
    expect(match).toMatchObject({
      score: 0,
      eligible: true,
      approved: null,
      sourceReviewDependency: loaded.context.dependency,
    });
    expect(match.reviewNotes).toBeTruthy();
    expect(match.revision).not.toContain(":retry");
    expect(match.revision).toContain(":human-source-review-v1:");
    if (form === "defined_service")
      expect(match.reason).toContain("revisione manuale separata");
  },
);

it.each(["changed", "refused"] as const)(
  "non ricorre all’AI se il corpus corrente è %s",
  async (kind) => {
    await review("defined_service");
    await amend(
      kind === "changed"
        ? {
            originalTitles: [
              ...p.originalTitles!,
              {
                text: "Titolo aggiuntivo inventato",
                language: "it",
                url: p.sourceUrl,
                path: "title.it",
              },
            ],
          }
        : { originalText: "x".repeat(18001) },
    );
    await run();
    expect(classify).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect((await storedMatches())[0]).toMatchObject({
      score: 0,
      eligible: true,
    });
    expect((await storedMatches())[0].reviewNotes).toBeTruthy();
  },
);

it("mantiene i veti espliciti del prefiltro anche quando la fonte è aperta", async () => {
  await amend({ canton: "ZH" });
  await review("opened");
  await run();
  expect((await storedMatches())[0]).toMatchObject({
    eligible: false,
    score: 0,
    reason: "Il lavoro si trova fuori dal Ticino.",
  });
  expect(classify).not.toHaveBeenCalled();
});

it.each(["low", "retry"] as const)(
  "un nuovo defined invalida il vecchio %s senza promuoverlo dal solo giudizio fonte",
  async (kind) => {
    if (kind === "low")
      vi.mocked(classify).mockResolvedValueOnce({ ...assessment, score: 10 });
    else
      vi.mocked(classify).mockRejectedValueOnce(
        new Error("Errore mock temporaneo"),
      );
    if (kind === "retry") await expect(run()).rejects.toThrow();
    else await run();
    const first = (await storedMatches())[0];
    expect(first.sourceReviewDependency).toBeNull();
    const loaded = await review("defined_service");
    expect((await storedMatches())[0]).toEqual(first);
    await run();
    await run();
    expect(classify).toHaveBeenCalledTimes(1);
    expect((await storedMatches())[0]).toMatchObject({
      score: 0,
      eligible: true,
      sourceReviewDependency: loaded.context.dependency,
    });
    expect((await storedMatches())[0].reviewNotes).toBeTruthy();
  },
);

it.each([10, 95])(
  "non riusa un vecchio automatico score %s con la stessa dipendenza documentaria",
  async (score) => {
    vi.mocked(classify).mockResolvedValueOnce({ ...assessment, score });
    await run();
    const loaded = await review("defined_service");
    await db
      .update(schema.matches)
      .set({ sourceReviewDependency: loaded.context.dependency });
    const before = (await storedMatches())[0];
    expect(before.revision).not.toContain(":human-source-review-v1:");
    await run();
    const firstManual = (await storedMatches())[0];
    expect(firstManual).toMatchObject({
      score: 0,
      eligible: true,
      approved: null,
      sourceReviewDependency: loaded.context.dependency,
    });
    expect(firstManual.revision).toContain(":human-source-review-v1:");
    expect(firstManual.reviewNotes).toBeTruthy();
    await run();
    expect((await storedMatches())[0]).toEqual(firstManual);
    expect(classify).toHaveBeenCalledTimes(1);
  },
);

it.each([true, false])(
  "conserva il giudizio manuale storico %s senza timbrargli la dipendenza",
  async (approved) => {
    await run();
    await db.update(schema.matches).set({
      approved,
      reviewedAt: now,
      eligible: approved,
      reviewNotes: "Revisione aziendale già registrata.",
    });
    const before = await storedMatches();
    await review("defined_service");
    await run();
    expect(await storedMatches()).toEqual(before);
    expect(classify).toHaveBeenCalledTimes(1);
  },
);

it("il primo evento arrivato durante l’AI impedisce il salvataggio della valutazione precedente", async () => {
  vi.mocked(classify).mockImplementationOnce(async () => {
    await review("opened");
    return assessment;
  });
  await run();
  expect(await storedMatches()).toEqual([]);
  await run();
  expect(classify).toHaveBeenCalledTimes(1);
  expect((await storedMatches())[0]).toMatchObject({
    score: 0,
    eligible: true,
  });
});

it("dopo aver rilevato una fonte cambiata non avvia altre richieste per le ditte successive", async () => {
  await db.insert(schema.user).values({
    id: "second-firm",
    name: "Second",
    email: "second@example.invalid",
  });
  await db.insert(schema.companies).values({
    id: "second-firm",
    ownerId: "second-firm",
    profile,
    onboardedAt: now,
  });
  await db.insert(schema.invitations).values({
    id: "second-firm-invitation",
    email: "second@example.invalid",
    companyId: "second-firm",
    expiresAt: new Date("2099-01-01"),
    acceptedAt: now,
    acceptedVersion: PILOT_PARTICIPATION_TERMS_VERSION,
  });
  await review("defined_service");
  await beforeNextTransaction(async () => {
    await review("opened");
  });
  expect(classify).not.toHaveBeenCalled();
  expect(await storedMatches()).toEqual([]);
  await run();
  expect(classify).not.toHaveBeenCalled();
  expect(await storedMatches()).toHaveLength(2);
  expect(
    (await storedMatches()).every(
      (match) => match.score === 0 && match.reviewNotes,
    ),
  ).toBe(true);
});

it("un nuovo originale prima del commit invalida il binding anche con lo stesso evento e revisione", async () => {
  const loaded = await review("defined_service");
  await beforeNextTransaction(async () => {
    await amend({
      documentPages: [
        ...p.documentPages!,
        {
          text: "Pagina nuova inventata",
          page: 3,
          url: "https://example.invalid/source.pdf",
        },
      ],
    });
  });
  expect(await storedMatches()).toEqual([]);
  const current = await loadSourceReviewContext(p.id, viewer);
  expect(current.context.dependency.reviewEventId).toBe(
    loaded.context.dependency.reviewEventId,
  );
  expect(current.context.dependency.corpusHash).not.toBe(
    loaded.context.dependency.corpusHash,
  );
  await run();
  expect(classify).not.toHaveBeenCalled();
  expect((await storedMatches())[0].sourceReviewDependency).toEqual(
    current.context.dependency,
  );
});

it("una revisione aziendale arrivata prima del commit prevale senza aggiornare revision o updatedAt", async () => {
  await run();
  await review("defined_service");
  let manual: Awaited<ReturnType<typeof storedMatches>>;
  await beforeNextTransaction(async () => {
    await db.update(schema.matches).set({
      approved: false,
      eligible: false,
      reviewedAt: now,
      reviewNotes: "Revisione manuale: founder",
    });
    manual = await storedMatches();
  });
  expect(await storedMatches()).toEqual(manual!);
  expect((await storedMatches())[0].sourceReviewDependency).toBeNull();
});

it("un evento durante la sintesi impedisce il suo commit e il confronto successivo", async () => {
  await amend({ summary: null });
  await db.update(schema.publications).set({ aiRevision: null });
  vi.mocked(summarize).mockImplementationOnce(async () => {
    await review("opened");
    return {
      summary: "Sintesi mock da non salvare dopo il nuovo evento.",
      sectors: [],
      requirements: [],
      evidence: [],
    };
  });
  await run();
  expect(await storedMatches()).toEqual([]);
  expect(classify).not.toHaveBeenCalled();
  const [row] = await db.select().from(schema.publications);
  expect(row.data.summary).toBeNull();
  expect(row.aiRevision).toBeNull();
  await run();
  expect(summarize).toHaveBeenCalledTimes(1);
  expect((await storedMatches())[0].score).toBe(0);
});

it("la revisione di una fonte non riscrive il match di un’altra", async () => {
  const other = {
    ...p,
    id: "other-source",
    externalId: "other-source",
    canonicalKey: "other-family",
  };
  await insert(other);
  await run(other.id);
  const before = (await storedMatches()).find(
    (m) => m.publicationId === other.id,
  )!;
  await review("opened");
  await run();
  expect(
    (await storedMatches()).find((m) => m.publicationId === other.id),
  ).toEqual(before);
  expect(await readSourceReviewContext(db, other)).toBeNull();
});

it("non clona la dipendenza della fonte precedente sulla nuova pubblicazione", async () => {
  await review("defined_service");
  await run();
  expect((await storedMatches())[0].sourceReviewDependency).not.toBeNull();
  const next = {
    ...p,
    id: "next-publication",
    externalId: "next-publication",
    revision: "source-review-v2",
    publishedAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
  };
  await storePublication(next);
  expect(
    (await storedMatches()).find((m) => m.publicationId === next.id),
  ).toMatchObject({
    sourceReviewDependency: null,
    approved: null,
    reviewedAt: null,
    eligible: false,
  });
});

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { demoProfile, demoViewer, getDemoOpportunities } from "../src/lib/demo";
import type { Publication } from "../src/lib/domain";

const context = vi.hoisted(() => ({
  db: undefined as unknown,
  requireViewer: vi.fn(),
  queue: vi.fn(),
}));
vi.mock("@/db", () => ({ getDb: () => context.db }));
vi.mock("@/lib/viewer", () => ({
  requireViewer: context.requireViewer,
  HttpError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/admin", () => ({
  getGate: vi.fn(),
  notifyInvitation: vi.fn(),
  provisionInvite: vi.fn(),
}));
vi.mock("@/worker/notifications", () => ({
  queueChangeNotices: context.queue,
  reconcileDelivery: vi.fn(),
}));
import { POST } from "../src/app/api/admin/route";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const origin = "https://mandat.example.invalid";
const note = "  I titoli originali descrivono prestazioni discordanti.  ";
const p: Publication = {
  ...getDemoOpportunities()[0],
  id: "source-p",
  externalId: "source-p",
  source: "simap",
  revision: "content-manually-corrected",
  status: "open",
  visibleAt: "2020-01-01T08:00:00Z",
  deadline: "2099-01-01T12:00:00Z",
  summary: "Sintesi corretta da conservare.",
  requirements: ["Condizione esplicita già verificata."],
  reviewRequired: false,
  reviewReasons: [],
  sourceUrl:
    "https://www.simap.ch/api/publications/v1/project/11111111-1111-4111-8111-111111111111/publication-details/22222222-2222-4222-8222-222222222222",
};
const snapshot = {
  id: p.id,
  expectedSourceRevision: "raw-source-v1",
  expectedContentRevision: p.revision,
  expectedScopeToken: null as string | null,
};
const mark = {
  action: "mark-source-scope",
  ...snapshot,
  kind: "conflicting",
  note,
};

beforeAll(async () => {
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
  for (const id of ["owner-a", "owner-b"]) {
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.invalid` });
    await db.insert(schema.companies).values({
      id,
      ownerId: id,
      profile: demoProfile,
      onboardedAt: new Date(),
    });
  }
});
beforeEach(async () => {
  vi.stubEnv("APP_URL", origin);
  context.requireViewer.mockResolvedValue({
    ...demoViewer,
    userId: "founder-private",
    demo: false,
    admin: true,
  });
  context.queue.mockClear();
  await db.delete(schema.issues);
  await db.delete(schema.publications);
  await db.insert(schema.publications).values({
    id: p.id,
    externalId: p.externalId,
    canonicalId: p.id,
    source: p.source,
    title: p.title,
    status: p.status,
    visibleAt: new Date(p.visibleAt),
    deadline: new Date(p.deadline!),
    data: p,
    revision: snapshot.expectedSourceRevision,
    aiRevision: p.revision,
    updatedAt: new Date("2026-01-01T10:00:00Z"),
  });
  await db.insert(schema.matches).values([
    {
      id: "match-a",
      publicationId: p.id,
      companyId: "owner-a",
      revision: "manual-match-revision",
      score: 82,
      reason: "Motivo già verificato",
      eligible: true,
      approved: true,
      reviewedAt: new Date("2026-01-01T10:10:00Z"),
      reviewNotes: "Nota privata precedente",
    },
    {
      id: "match-b",
      publicationId: p.id,
      companyId: "owner-b",
      revision: "automatic-match-revision",
      score: 0,
      reason: "Motivo AI precedente",
      eligible: false,
      approved: null,
    },
  ]);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});
async function post(body: unknown, requestOrigin = origin) {
  return POST(
    new Request(`${origin}/api/admin`, {
      method: "POST",
      headers: { origin: requestOrigin, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
async function state() {
  const [publication] = await db
    .select()
    .from(schema.publications)
    .where(eq(schema.publications.id, p.id));
  return {
    publication,
    matches: await db.select().from(schema.matches).orderBy(schema.matches.id),
    companies: await db
      .select()
      .from(schema.companies)
      .orderBy(schema.companies.id),
    issues: await db.select().from(schema.issues).orderBy(schema.issues.key),
  };
}
async function marked() {
  expect((await post(mark)).status).toBe(200);
  return (await state()).publication.data.sourceScopeReview!;
}

it("registra una verifica indipendente dalla ditta senza cambiare fonte, sintesi, revisioni, profili o match", async () => {
  const before = await state();
  const result = await post(mark);
  expect(result.status).toBe(200);
  const after = await state();
  const review = after.publication.data.sourceScopeReview!;
  expect(review).toEqual({
    status: "required",
    kind: "conflicting",
    token: expect.any(String),
    sourceRevision: "raw-source-v1",
    updatedAt: expect.any(String),
  });
  expect(review.token).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
  const { sourceScopeReview: _review, ...data } = after.publication.data;
  expect({
    ...after.publication,
    data,
    updatedAt: before.publication.updatedAt,
  }).toEqual(before.publication);
  expect(after.publication.updatedAt.getTime()).toBeGreaterThan(
    before.publication.updatedAt.getTime(),
  );
  expect(after.matches).toEqual(before.matches);
  expect(after.companies).toEqual(before.companies);
  expect(JSON.stringify(after.publication.data)).not.toContain(
    "founder-private",
  );
  expect(JSON.stringify(after.publication.data)).not.toContain(note.trim());
  expect(after.issues).toHaveLength(2);
  const audit = after.issues.find((i) =>
    i.key.startsWith("source-scope-audit:"),
  )!;
  expect(JSON.parse(audit.detail)).toMatchObject({
    actorId: "founder-private",
    note: note.trim(),
    sourceRevision: "raw-source-v1",
    contentRevision: p.revision,
    token: review.token,
  });
  expect(audit.resolvedAt).not.toBeNull();
  expect(
    after.issues.find((i) => i.key === `source-scope:${p.id}`)?.resolvedAt,
  ).toBeNull();
  expect(context.queue).not.toHaveBeenCalled();
  expect(context.requireViewer).toHaveBeenCalledWith({
    admin: true,
    mutation: true,
  });
});

it("risolve con un nuovo token e storia privata preservando le valutazioni delle due ditte", async () => {
  const review = await marked();
  const before = await state();
  const result = await post({
    action: "resolve-source-scope",
    ...snapshot,
    expectedScopeToken: review.token,
    note: "Verificati i documenti originali: l’oggetto è ora chiaro.",
  });
  expect(result.status).toBe(200);
  const after = await state();
  expect(after.publication.data.sourceScopeReview).toMatchObject({
    status: "resolved",
    kind: "conflicting",
    sourceRevision: "raw-source-v1",
  });
  expect(after.publication.data.sourceScopeReview!.token).not.toBe(
    review.token,
  );
  expect(after.matches).toEqual(before.matches);
  expect(after.companies).toEqual(before.companies);
  expect(after.publication.revision).toBe(before.publication.revision);
  expect(after.publication.data.revision).toBe(
    before.publication.data.revision,
  );
  expect(after.publication.aiRevision).toBe(before.publication.aiRevision);
  expect(
    after.issues.filter((i) => i.key.startsWith("source-scope-audit:")),
  ).toHaveLength(2);
  expect(after.issues.every((i) => i.resolvedAt !== null)).toBe(true);
  expect(context.queue).not.toHaveBeenCalled();
});

it.each([
  "expectedSourceRevision",
  "expectedContentRevision",
  "expectedScopeToken",
] as const)(
  "rifiuta uno snapshot obsoleto %s senza alcuna scrittura",
  async (field) => {
    const review = await marked();
    for (const action of ["mark-source-scope", "resolve-source-scope"]) {
      const before = await state();
      const payload = {
        ...snapshot,
        expectedScopeToken: review.token,
        action,
        note: "Controllo manuale completo della fonte.",
        ...(action === "mark-source-scope" ? { kind: "ambiguous" } : {}),
        [field]:
          field === "expectedScopeToken"
            ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            : "old-revision",
      };
      expect((await post(payload)).status).toBe(409);
      expect(await state()).toEqual(before);
    }
  },
);

it("impedisce il doppio invio e consente un nuovo dubbio con il token aggiornato", async () => {
  const first = await marked();
  expect((await post(mark)).status).toBe(409);
  expect(
    (
      await post({
        ...mark,
        kind: "ambiguous",
        expectedScopeToken: first.token,
      })
    ).status,
  ).toBe(200);
  const after = await state();
  expect(after.publication.data.sourceScopeReview!.kind).toBe("ambiguous");
  expect(after.publication.data.sourceScopeReview!.token).not.toBe(first.token);
  expect(after.issues.filter((i) => i.resolvedAt === null)).toHaveLength(1);
});

it("non risolve una verifica assente", async () => {
  const before = await state();
  expect(
    (
      await post({
        action: "resolve-source-scope",
        ...snapshot,
        note: "La fonte è stata verificata.",
      })
    ).status,
  ).toBe(409);
  expect(await state()).toEqual(before);
});

it.each([
  { note: "          " },
  { note: "breve" },
  { note: "x".repeat(801) },
  { expectedScopeToken: "not-a-uuid" },
  { actorId: "client-forged" },
])("rifiuta input invalido e metadati extra: %j", async (invalid) => {
  const before = await state();
  expect((await post({ ...mark, ...invalid })).status).toBe(400);
  expect(await state()).toEqual(before);
});

it("una normale correzione conserva lo stato corrente dell’oggetto e la relativa issue aperta", async () => {
  const review = await marked();
  const result = await post({
    action: "correct",
    id: p.id,
    summary: p.summary,
    deadline: p.deadline,
    location: "Bellinzona",
    valueChf: p.valueChf,
    note: "Il luogo è confermato dal documento originale.",
  });
  expect(result.status).toBe(200);
  const after = await state();
  expect(after.publication.data.sourceScopeReview).toEqual(review);
  expect(after.publication.data.location).toBe("Bellinzona");
  expect(after.publication.data.revision).not.toBe(p.revision);
  expect(after.publication.revision).toBe(snapshot.expectedSourceRevision);
  expect(
    after.issues.find((i) => i.key === `source-scope:${p.id}`)?.resolvedAt,
  ).toBeNull();
});

it("la risoluzione generica degli avvisi non chiude la barriera né altera lo storico", async () => {
  await marked();
  const before = await state();
  for (const issue of before.issues) {
    expect(
      (
        await post({
          action: "resolve",
          id: issue.id,
          note: "Tentativo dalla risoluzione generica.",
        })
      ).status,
    ).toBe(400);
  }
  expect(await state()).toEqual(before);
});

it("blocca approvazioni positive con il solo flag tipizzato, ma conserva il rifiuto manuale esplicito", async () => {
  await marked();
  const before = await state();
  expect(before.publication.data.reviewRequired).toBe(false);
  expect(
    (await post({ action: "review", id: "match-b", approved: true })).status,
  ).toBe(400);
  expect((await state()).matches).toEqual(before.matches);
  expect(
    (await post({ action: "review", id: "match-b", approved: false })).status,
  ).toBe(200);
  const rejected = (await state()).matches.find((m) => m.id === "match-b")!;
  expect(rejected.approved).toBe(false);
  expect(rejected.reviewedAt).not.toBeNull();
});

it("controllo positivo: permette la revisione manuale di una fonte senza barriera", async () => {
  expect(
    (await post({ action: "review", id: "match-b", approved: true })).status,
  ).toBe(200);
  const match = (await state()).matches.find((m) => m.id === "match-b")!;
  expect(match.approved).toBe(true);
  expect(match.eligible).toBe(true);
});

it("il fallimento dello storico annulla anche la mutazione della fonte", async () => {
  const before = await state();
  await pg.exec(`CREATE FUNCTION fail_scope_audit() RETURNS trigger AS $$ BEGIN IF NEW.key LIKE 'source-scope-audit:%' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER fail_scope_audit BEFORE INSERT ON issues FOR EACH ROW EXECUTE FUNCTION fail_scope_audit();`);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await post(mark)).status).toBe(500);
  } finally {
    await pg.exec(
      "DROP TRIGGER fail_scope_audit ON issues; DROP FUNCTION fail_scope_audit();",
    );
    log.mockRestore();
  }
  expect(await state()).toEqual(before);
});

it("mantiene il controllo origine prima delle mutazioni", async () => {
  const before = await state();
  expect((await post(mark, "https://foreign.example.invalid")).status).toBe(
    403,
  );
  expect(await state()).toEqual(before);
});

// Reproduce a commit between an initial lookup and transaction entry on the
// local database. This tests fresh reads, not two-connection PostgreSQL locks.
function commitScopeBeforeTransaction() {
  const review = {
    status: "required" as const,
    kind: "ambiguous" as const,
    token: "44444444-4444-4444-8444-444444444444",
    sourceRevision: "raw-source-v1",
    updatedAt: new Date().toISOString(),
  };
  let inject = true;
  context.db = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction")
        return async (...args: Parameters<typeof db.transaction>) => {
          if (inject) {
            inject = false;
            const [current] = await db
              .select()
              .from(schema.publications)
              .where(eq(schema.publications.id, p.id));
            await db
              .update(schema.publications)
              .set({
                data: { ...current.data, sourceScopeReview: review },
                updatedAt: new Date(),
              })
              .where(eq(schema.publications.id, p.id));
          }
          return db.transaction(...args);
        };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return review;
}
it("la correzione conserva una segnalazione arrivata prima dell’ingresso in transazione", async () => {
  const review = commitScopeBeforeTransaction();
  try {
    expect(
      (
        await post({
          action: "correct",
          id: p.id,
          summary: p.summary,
          deadline: p.deadline,
          location: "Lugano",
          valueChf: p.valueChf,
          note: "Confermato soltanto il luogo della prestazione.",
        })
      ).status,
    ).toBe(200);
  } finally {
    context.db = db;
  }
  expect((await state()).publication.data.sourceScopeReview).toEqual(review);
});
it("l’approvazione legge una segnalazione arrivata dopo la prima ricerca del match", async () => {
  const before = await state();
  commitScopeBeforeTransaction();
  try {
    expect(
      (await post({ action: "review", id: "match-b", approved: true })).status,
    ).toBe(400);
  } finally {
    context.db = db;
  }
  expect((await state()).matches).toEqual(before.matches);
});

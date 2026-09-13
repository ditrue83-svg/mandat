import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq } from "drizzle-orm";
import { PgBoss, fromPglite } from "pg-boss";
import * as schema from "../src/db/schema";
import type { CompanyProfile } from "../src/lib/domain";
import { normalizeSimap } from "../src/sources/simap";
import { preserveSimapLots } from "../src/lib/source-lots";
import { SIMAP_ACQUISITION_VERSION } from "../src/sources/simap-documentary";
import {
  beginDocumentaryRequest,
  storeDocumentaryObservation,
} from "../src/lib/documentary-store";
import { LOT_RECONCILIATION_QUEUE } from "../src/lib/lot-reconciliation";
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
import { updateCompanyProfile, saveCompanyFeedback } from "../src/lib/company";
import {
  canonicalFeedbackKey,
  readCanonicalFeedback,
} from "../src/lib/canonical-feedback";
import { readLotProjectSuppression } from "../src/lib/lot-project-suppression";
import {
  appendLotMatchReview,
  loadLotMatchReview,
} from "../src/lib/lot-match-reviews";

// Invented local records and real local migrations/transactions/pg-boss. The
// notification markers test cancellation, not a rendered or sendable message.
const pg = new PGlite(),
  db = drizzle(pg, { schema });
const boss = new PgBoss({
  db: fromPglite(pg),
  backend: "pglite",
  schema: "pgboss",
  schedule: false,
  supervise: false,
});
const viewer = { userId: "company-state-founder", admin: true, demo: false };
const profile: CompanyProfile = {
  name: "Ditta inventata",
  activities: "Pulizia ordinaria di uffici",
  employees: 4,
  sectors: ["pulizie"],
  zones: ["Tutto il Ticino"],
  keywords: [],
  exclusions: [],
  minValue: null,
  maxValue: null,
  emailEnabled: true,
};
beforeAll(async () => {
  injected.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
  await boss.start();
  await boss.createQueue("match", { policy: "singleton" });
  await boss.createQueue(LOT_RECONCILIATION_QUEUE);
  await boss.stop();
  await db.insert(schema.user).values({
    id: viewer.userId,
    name: "Fondatore inventato",
    email: "company-state@example.invalid",
  });
  await db.insert(schema.administrators).values({ userId: viewer.userId });
}, 20000);
beforeEach(async () => {
  injected.db = db;
  await boss.deleteAllJobs("match");
});
afterAll(async () => {
  await boss.stop();
  await pg.close();
});
async function firm() {
  const id = randomUUID();
  await db
    .insert(schema.user)
    .values({ id, name: profile.name, email: `${id}@example.invalid` });
  await db
    .insert(schema.companies)
    .values({ id, ownerId: id, profile, onboardedAt: new Date() });
  return id;
}
async function publication(
  companyId: string,
  canonicalId = randomUUID(),
  adopted = false,
) {
  const projectId = randomUUID(),
    noticeId = randomUUID();
  const identity = {
    projectId,
    publicationId: noticeId,
    detailUrl: `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${noticeId}`,
  };
  const raw = {
    id: noticeId,
    type: "tender",
    "project-info": { title: { it: "Centro inventato" } },
    procurement: { orderDescription: { it: "Servizi del centro inventato" } },
    base: { id: noticeId, projectId },
    lots: [],
  };
  const entry = {
    id: projectId,
    raw: {
      id: projectId,
      publicationId: noticeId,
      publicationDate: "2026-09-01",
      projectNumber: `INVENTED-COMPANY-${projectId}`,
      pubType: "tender",
      processType: "open",
      title: { it: "Centro inventato" },
      procOfficeName: { it: "Ente inventato" },
    },
  };
  const p = normalizeSimap(entry, raw);
  await db.insert(schema.publications).values({
    id: p.id,
    canonicalId,
    externalId: p.externalId,
    source: p.source,
    title: p.title,
    status: p.status,
    visibleAt: new Date(p.visibleAt),
    revision: p.revision,
    data: p,
  });
  await db.insert(schema.matches).values({
    id: randomUUID(),
    companyId,
    publicationId: p.id,
    revision: "original-human-revision",
    score: 92,
    eligible: true,
    approved: true,
    reviewedAt: new Date("2026-09-01T08:00:00Z"),
    reviewNotes: "Giudizio originale inventato",
    reason: "Decisione storica inventata",
  });
  if (adopted) {
    const request = await beginDocumentaryRequest(identity),
      body = JSON.stringify(raw);
    const stored = await storeDocumentaryObservation(request, {
      publication: p,
      documentaryAcquisition: {
        version: SIMAP_ACQUISITION_VERSION,
        state: "accepted",
        identity,
        sourceRevision: p.revision,
        archive: preserveSimapLots(raw, identity),
        receipt: {
          url: identity.detailUrl,
          receivedAt: new Date().toISOString(),
          bodyByteLength: Buffer.byteLength(body),
          bodySha256: createHash("sha256").update(body).digest("hex"),
        },
      },
    });
    // Test setup only: no runtime adoption path is invoked by this suite.
    await db
      .update(schema.publications)
      .set({ documentarySnapshotId: stored.id })
      .where(eq(schema.publications.id, p.id));
  }
  return { p, canonicalId };
}
async function notification(
  companyId: string,
  kind: string,
  status: string,
  lot = false,
) {
  const id = randomUUID();
  await db.insert(schema.notifications).values({
    id,
    companyId,
    dedupeKey: id,
    kind,
    status,
    subject: "Inventato",
    html: "Inventato",
    textBody: "Inventato",
    items: (lot
      ? [
          {
            id: "invented-source",
            revision: "invented-revision",
            lotNotice: { marker: "cancellation-only" },
          },
        ]
      : []) as unknown as (typeof schema.notifications.$inferInsert)["items"],
  });
  return id;
}
const companyMatches = (id: string) =>
  db
    .select()
    .from(schema.matches)
    .where(eq(schema.matches.companyId, id))
    .orderBy(schema.matches.id);
async function veto(companyId: string, publicationId: string) {
  const loaded = await loadLotMatchReview(companyId, publicationId, viewer);
  return appendLotMatchReview(
    {
      companyId,
      publicationId,
      action: "veto_project",
      expectedSnapshotHash: loaded.expected.snapshotHash,
      expectedProfileHash: loaded.expected.profileHash,
      expectedStateToken: loaded.expected.stateToken,
      expectedGroupToken: loaded.expected.groupToken,
      expectedProjectBindingHash: loaded.expected.projectBindingHash,
      note: "Rifiuto inventato da conservare dopo modifica profilo.",
    },
    viewer,
  );
}

it("Profile changes retain exact adopted/canonical legacy judgments, audit and veto while cancelling only pending digest or lot changes", async () => {
  const id = await firm(),
    group = randomUUID(),
    adopted = await publication(id, group, true),
    legacy = await publication(id, group);
  await db
    .update(schema.matches)
    .set({ approved: false, eligible: false })
    .where(eq(schema.matches.publicationId, legacy.p.id));
  await pg.query(
    "UPDATE matches SET reviewed_at = reviewed_at + interval '0.000123 seconds' WHERE company_id = $1",
    [id],
  );
  await veto(id, adopted.p.id);
  const before = await companyMatches(id),
    dates = (
      await pg.query(
        "SELECT id, reviewed_at::text, updated_at::text FROM matches WHERE company_id = $1 ORDER BY id",
        [id],
      )
    ).rows;
  const audits = await db.select().from(schema.matchLotReviewEvents),
    settings = await db.select().from(schema.settings);
  const cancelled: string[] = [
    await notification(id, "digest", "pending"),
    await notification(id, "change", "pending", true),
    await notification(id, "lot-update", "pending"),
  ];
  const preserved: string[] = [
    await notification(id, "change", "pending"),
    await notification(id, "change", "sending", true),
    await notification(id, "digest", "sent"),
  ];
  const updated = { ...profile, keywords: ["vetrate"] };
  await updateCompanyProfile(id, updated);
  expect(await companyMatches(id)).toEqual(before);
  expect(
    (
      await pg.query(
        "SELECT id, reviewed_at::text, updated_at::text FROM matches WHERE company_id = $1 ORDER BY id",
        [id],
      )
    ).rows,
  ).toEqual(dates);
  expect(await db.select().from(schema.matchLotReviewEvents)).toEqual(audits);
  expect(await db.select().from(schema.settings)).toEqual(settings);
  expect(
    (await readLotProjectSuppression(db, id, group)).suppression?.active,
  ).toBe(true);
  expect(
    (
      await db
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.id, id))
    )[0].profile,
  ).toEqual(updated);
  const notices = await db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.companyId, id));
  expect(
    notices
      .filter((row) => cancelled.includes(row.id))
      .every((row) => row.status === "cancelled"),
  ).toBe(true);
  expect(
    notices
      .filter((row) => preserved.includes(row.id))
      .map((row) => row.status)
      .sort(),
  ).toEqual(["pending", "sending", "sent"].sort());
  expect(
    (
      await pg.query(
        "SELECT count(*)::int AS n FROM pgboss.job WHERE name='match'",
      )
    ).rows,
  ).toEqual([{ n: 1 }]);
});

it("A legacy veto on an unadopted copy survives profile update even before a canonical suppression setting exists", async () => {
  const id = await firm(),
    group = randomUUID();
  await publication(id, group, true);
  const legacy = await publication(id, group);
  await db
    .update(schema.matches)
    .set({ approved: false })
    .where(eq(schema.matches.publicationId, legacy.p.id));
  const before = await companyMatches(id);
  expect((await readLotProjectSuppression(db, id, group)).state).toBeNull();
  await updateCompanyProfile(id, {
    ...profile,
    activities: "Pulizia di scale e uffici",
  });
  expect(await companyMatches(id)).toEqual(before);
  expect(
    (await readLotProjectSuppression(db, id, group)).suppression?.active,
  ).toBe(true);
});

it("A profile spanning multiple canonical groups preserves adopted history and retains the separate legacy refresh behavior", async () => {
  const id = await firm();
  const adopted = await publication(id, randomUUID(), true);
  const legacy = await publication(id);
  const before = (await companyMatches(id)).find(
    (row) => row.publicationId === adopted.p.id,
  );
  await updateCompanyProfile(id, { ...profile, keywords: ["uffici"] });
  const current = await companyMatches(id);
  expect(current.find((row) => row.publicationId === adopted.p.id)).toEqual(
    before,
  );
  expect(
    current.find((row) => row.publicationId === legacy.p.id),
  ).toMatchObject({
    approved: null,
    reviewedAt: null,
    eligible: false,
    revision: "original-human-revision:profile-update",
  });
});

it("Canonical saved/dismissed cover existing and later copies while relevance stays on the chosen record", async () => {
  const id = await firm(),
    first = await publication(id),
    second = await publication(id, first.canonicalId);
  await saveCompanyFeedback(id, first.p.id, {
    saved: true,
    dismissed: true,
    relevant: false,
  });
  const stored = await db
    .select()
    .from(schema.feedback)
    .where(eq(schema.feedback.companyId, id));
  expect(stored.every((row) => row.saved && row.dismissed)).toBe(true);
  expect(stored.find((row) => row.publicationId === first.p.id)?.relevant).toBe(
    false,
  );
  expect(
    stored.find((row) => row.publicationId === second.p.id)?.relevant,
  ).toBeNull();
  const later = await publication(id, first.canonicalId);
  expect(
    await db
      .select()
      .from(schema.feedback)
      .where(eq(schema.feedback.publicationId, later.p.id)),
  ).toEqual([]);
  expect(await readCanonicalFeedback(db, id, first.canonicalId)).toEqual({
    saved: true,
    dismissed: true,
  });
  await saveCompanyFeedback(id, later.p.id, {
    saved: false,
    dismissed: false,
    relevant: true,
  });
  expect(await readCanonicalFeedback(db, id, first.canonicalId)).toEqual({
    saved: false,
    dismissed: false,
  });
  expect(
    (
      await db
        .select()
        .from(schema.feedback)
        .where(eq(schema.feedback.publicationId, first.p.id))
    )[0].relevant,
  ).toBe(false);
  expect(
    (
      await db
        .select()
        .from(schema.feedback)
        .where(eq(schema.feedback.publicationId, later.p.id))
    )[0].relevant,
  ).toBe(true);
  // An old stale true on a later copied row cannot reverse an explicit false.
  await db
    .update(schema.feedback)
    .set({ saved: true, dismissed: true })
    .where(eq(schema.feedback.publicationId, second.p.id));
  expect(await readCanonicalFeedback(db, id, first.canonicalId)).toEqual({
    saved: false,
    dismissed: false,
  });
});

it("Missing canonical state conservatively combines historical flags; unrelated companies and projects stay isolated", async () => {
  const id = await firm(),
    other = await firm(),
    first = await publication(id),
    second = await publication(id, first.canonicalId),
    separate = await publication(id);
  await db.insert(schema.feedback).values({
    id: randomUUID(),
    companyId: id,
    publicationId: first.p.id,
    saved: true,
  });
  await db.insert(schema.feedback).values({
    id: randomUUID(),
    companyId: id,
    publicationId: second.p.id,
    dismissed: true,
  });
  expect(await readCanonicalFeedback(db, id, first.canonicalId)).toEqual({
    saved: true,
    dismissed: true,
  });
  expect(await readCanonicalFeedback(db, other, first.canonicalId)).toEqual({
    saved: false,
    dismissed: false,
  });
  expect(await readCanonicalFeedback(db, id, separate.canonicalId)).toEqual({
    saved: false,
    dismissed: false,
  });
  await saveCompanyFeedback(id, first.p.id, { saved: false });
  expect(await readCanonicalFeedback(db, id, first.canonicalId)).toEqual({
    saved: false,
    dismissed: true,
  });
  await expect(
    saveCompanyFeedback(other, first.p.id, { dismissed: true }),
  ).rejects.toThrow("associata alla ditta");
  await expect(
    saveCompanyFeedback(id, first.p.id, { lotId: "forbidden" } as never),
  ).rejects.toThrow();
});

it("Feedback re-reads membership inside its transaction instead of fanning out to an old inventory", async () => {
  const id = await firm(),
    first = await publication(id);
  let later = "",
    injectedOnce = false;
  injected.db = new Proxy(db, {
    get(target, prop) {
      if (prop === "transaction")
        return async (callback: Parameters<typeof db.transaction>[0]) => {
          if (!injectedOnce) {
            injectedOnce = true;
            later = (await publication(id, first.canonicalId)).p.id;
          }
          return db.transaction(callback);
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await saveCompanyFeedback(id, first.p.id, { dismissed: true });
  injected.db = db;
  expect(
    (
      await db
        .select()
        .from(schema.feedback)
        .where(
          and(
            eq(schema.feedback.companyId, id),
            eq(schema.feedback.publicationId, later),
          ),
        )
    )[0].dismissed,
  ).toBe(true);
});

it("A failed feedback write rolls back the canonical state too; malformed or foreign stored state fails closed", async () => {
  const id = await firm(),
    first = await publication(id),
    key = canonicalFeedbackKey(id, first.canonicalId);
  await pg.exec(
    "CREATE FUNCTION fail_company_feedback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'invented failure'; END $$; CREATE TRIGGER fail_company_feedback BEFORE INSERT ON feedback FOR EACH ROW EXECUTE FUNCTION fail_company_feedback();",
  );
  try {
    await expect(
      saveCompanyFeedback(id, first.p.id, { dismissed: true }),
    ).rejects.toThrow();
  } finally {
    await pg.exec(
      "DROP TRIGGER fail_company_feedback ON feedback; DROP FUNCTION fail_company_feedback();",
    );
  }
  expect(
    await db.select().from(schema.settings).where(eq(schema.settings.key, key)),
  ).toEqual([]);
  expect(
    await db
      .select()
      .from(schema.feedback)
      .where(eq(schema.feedback.companyId, id)),
  ).toEqual([]);
  await db.insert(schema.settings).values({
    key,
    value: {
      version: "canonical-company-feedback-v1",
      companyId: "foreign",
      canonicalId: first.canonicalId,
      saved: true,
      dismissed: true,
      updatedAt: new Date().toISOString(),
    },
  });
  await expect(
    readCanonicalFeedback(db, id, first.canonicalId),
  ).rejects.toThrow("altra ditta");
});

it.each([1, 3])(
  "Profile membership retries %i stale inventories with a bounded rollback and no partial writes",
  async (conflicts) => {
    const id = await firm(),
      first = await publication(id);
    let attempts = 0;
    const before = (
      await db
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.id, id))
    )[0];
    // Controlled stale inventory only. All actual writes/rollbacks remain PGlite;
    // this is not evidence of a PostgreSQL concurrent backend interleaving.
    injected.db = new Proxy(db, {
      get(target, prop) {
        if (prop === "transaction")
          return async (callback: Parameters<typeof db.transaction>[0]) => {
            attempts++;
            return db.transaction(async (tx) => {
              if (attempts > conflicts) return callback(tx);
              let firstSelect = true;
              const wrapped = new Proxy(tx, {
                get(transaction, key) {
                  if (key === "select")
                    return (...args: unknown[]) => {
                      const query = (
                        transaction.select as (...args: unknown[]) => any
                      )(...args);
                      if (!firstSelect) return query;
                      firstSelect = false;
                      const stale = (builder: object): any =>
                        new Proxy(builder, {
                          get(q, method) {
                            if (method === "then")
                              return (resolve: (v: unknown[]) => unknown) =>
                                Promise.resolve([]).then(resolve);
                            const value = Reflect.get(q, method);
                            return typeof value === "function"
                              ? (...values: unknown[]) => {
                                  return stale(value.apply(q, values));
                                }
                              : value;
                          },
                        });
                      return stale(query);
                    };
                  const value = Reflect.get(transaction, key);
                  return typeof value === "function"
                    ? value.bind(transaction)
                    : value;
                },
              });
              return callback(wrapped);
            });
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const operation = updateCompanyProfile(id, {
      ...profile,
      keywords: ["new"],
    });
    if (conflicts === 3)
      await expect(operation).rejects.toMatchObject({ status: 409 });
    else await operation;
    injected.db = db;
    expect(attempts).toBe(conflicts === 3 ? 3 : 2);
    expect(
      (
        await db
          .select()
          .from(schema.companies)
          .where(eq(schema.companies.id, id))
      )[0],
    ).toMatchObject(
      conflicts === 3 ? before : { profile: { ...profile, keywords: ["new"] } },
    );
    expect((await companyMatches(id))[0].publicationId).toBe(first.p.id);
    expect(
      (
        await pg.query(
          "SELECT count(*)::int AS n FROM pgboss.job WHERE name='match'",
        )
      ).rows,
    ).toEqual([{ n: conflicts === 3 ? 0 : 1 }]);
  },
);

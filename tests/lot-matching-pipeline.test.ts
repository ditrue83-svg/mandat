import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { PgBoss, fromPglite } from "pg-boss";
import * as schema from "../src/db/schema";
import type { CompanyProfile } from "../src/lib/domain";
import { normalizeSimap } from "../src/sources/simap";
import {
  SIMAP_ACQUISITION_VERSION,
  type SimapAcquisitionResult,
} from "../src/sources/simap-documentary";
import { preserveSimapLots } from "../src/lib/source-lots";
import {
  beginDocumentaryRequest,
  storeDocumentaryObservation,
} from "../src/lib/documentary-store";
import { LOT_RECONCILIATION_QUEUE } from "../src/lib/lot-reconciliation";
import {
  LOT_WORKER_REVIEW_VERSION,
  matchAdoptedPublication,
} from "../src/worker/lot-matching";

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
vi.mock("@/worker/ai", async (original) => ({
  ...(await original<typeof import("../src/worker/ai")>()),
  summarize: vi.fn(),
  classify: vi.fn(),
}));
vi.mock("@/worker/notifications", () => ({ queueChangeNotices: vi.fn() }));
vi.mock("@/lib/source-reviews", async (original) => ({
  ...(await original<typeof import("../src/lib/source-reviews")>()),
  readSourceReviewContext: vi.fn(async () => null),
}));
import { summarize, classify } from "../src/worker/ai";
import { readSourceReviewContext } from "../src/lib/source-reviews";
import { enrichAndMatch, storePublication } from "../src/worker/pipeline";
import {
  appendLotSourceReview,
  loadLotSourceReview,
} from "../src/lib/lot-source-reviews";
import {
  appendLotMatchReview,
  loadLotMatchReview,
  lotMatchReviewTarget,
} from "../src/lib/lot-match-reviews";

// Invented sources and firms. Real local migrations and pg-boss producer;
// adoption below is test setup, not an application adoption procedure. PGlite
// interleavings do not prove PostgreSQL two-backend locking or semantic quality.
const pg = new PGlite(),
  db = drizzle(pg, { schema });
const boss = new PgBoss({
  db: fromPglite(pg),
  backend: "pglite",
  schema: "pgboss",
  schedule: false,
  supervise: false,
});
const viewer = { userId: "lot-worker-founder", admin: true, demo: false };
const now = new Date("2030-01-10T10:00:00.000Z");
const commonText = "Progetto inventato: rete elettrica con incarichi separati.";
const lotText = "Potatura degli alberi del parco, lotto inventato.";
const baseProfile: CompanyProfile = {
  name: "Impresa inventata",
  activities: "Potatura e cura degli alberi",
  employees: 3,
  sectors: ["giardinaggio"],
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
  await boss.createQueue(LOT_RECONCILIATION_QUEUE);
  await boss.stop();
  await db.insert(schema.user).values({
    id: viewer.userId,
    name: "Fondatore inventato",
    email: "lot-worker@example.invalid",
  });
  await db.insert(schema.administrators).values({ userId: viewer.userId });
}, 20000);
beforeEach(async () => {
  injected.db = db;
  await db.update(schema.companies).set({ disabledAt: new Date() });
  vi.mocked(summarize)
    .mockReset()
    .mockRejectedValue(new Error("Unexpected AI call"));
  vi.mocked(classify)
    .mockReset()
    .mockRejectedValue(new Error("Unexpected AI call"));
  vi.mocked(readSourceReviewContext).mockClear();
});
afterAll(async () => {
  await boss.stop();
  await pg.close();
});
async function company(
  profile = baseProfile,
  options: { disabled?: boolean; onboarded?: boolean } = {},
) {
  const id = randomUUID();
  await db
    .insert(schema.user)
    .values({ id, name: profile.name, email: `${id}@example.invalid` });
  await db.insert(schema.companies).values({
    id,
    ownerId: id,
    profile,
    onboardedAt: options.onboarded === false ? null : new Date(),
    disabledAt: options.disabled ? new Date() : null,
  });
  return id;
}
async function fixture(
  options: { adopt?: boolean; empty?: boolean; canonicalId?: string } = {},
) {
  const projectId = randomUUID(),
    noticeId = randomUUID(),
    lotId = randomUUID();
  const identity = {
    projectId,
    publicationId: noticeId,
    detailUrl: `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${noticeId}`,
  };
  const raw: any = {
    id: noticeId,
    type: "tender",
    "project-info": { title: { it: "Rete elettrica, fonte inventata" } },
    procurement: {
      orderDescription: { it: commonText },
      cpvCode: { code: "45310000" },
    },
    base: {
      id: noticeId,
      projectId,
      lotsType: options.empty ? "without" : "with",
      lots: options.empty
        ? []
        : [{ id: lotId, lotNumber: 1, title: { it: "Alberi" } }],
    },
    lots: options.empty
      ? []
      : [
          {
            id: lotId,
            lotNumber: 1,
            title: { it: "Alberi" },
            orderDescription: { it: lotText },
            cpvCode: { code: "77310000" },
            orderAddressOnlyDescription: "no",
            orderAddress: {
              countryId: "CH",
              cantonId: "TI",
              city: { it: "Lugano" },
            },
          },
        ],
  };
  const entry = {
    id: projectId,
    raw: {
      id: projectId,
      publicationId: noticeId,
      publicationDate: "2026-09-01",
      projectNumber: `INVENTED-WORKER-${projectId}`,
      pubType: "tender",
      processType: "open",
      title: { it: "Rete elettrica inventata" },
      procOfficeName: { it: "Ente inventato" },
    },
  };
  const normalized = normalizeSimap(entry, raw);
  const p = {
    ...normalized,
    canton: "ZH",
    sectors: ["impianti"] as ["impianti"],
    summary: null,
  };
  await db.insert(schema.publications).values({
    id: p.id,
    canonicalId: options.canonicalId ?? p.id,
    externalId: p.externalId,
    projectId: p.projectId,
    source: p.source,
    title: p.title,
    status: p.status,
    visibleAt: new Date(p.visibleAt),
    data: p,
    revision: p.revision,
  });
  async function observation(detail = raw, refused = false) {
    const request = await beginDocumentaryRequest(identity),
      body = JSON.stringify(detail),
      publication = normalizeSimap(entry, detail);
    const receipt = {
      url: identity.detailUrl,
      receivedAt: new Date().toISOString(),
      bodyByteLength: Buffer.byteLength(body),
      bodySha256: createHash("sha256").update(body).digest("hex"),
    };
    const result: SimapAcquisitionResult = refused
      ? {
          publication: null,
          documentaryAcquisition: {
            version: SIMAP_ACQUISITION_VERSION,
            state: "refused",
            identity,
            sourceRevision: null,
            receipt,
            refusal: { stage: "decode", code: "invalid_utf8" },
          },
        }
      : {
          publication,
          documentaryAcquisition: {
            version: SIMAP_ACQUISITION_VERSION,
            state: "accepted",
            identity,
            sourceRevision: publication.revision,
            receipt,
            archive: preserveSimapLots(detail, identity),
          },
        };
    return storeDocumentaryObservation(request, result);
  }
  const initial = await observation();
  async function adopt(id = initial.id) {
    await db
      .update(schema.publications)
      .set({ documentarySnapshotId: id })
      .where(eq(schema.publications.id, p.id));
  }
  if (options.adopt !== false) await adopt();
  return { p, raw, identity, lotId, initial, observation, adopt };
}
const rows = (id: string) =>
  db
    .select()
    .from(schema.matches)
    .where(eq(schema.matches.publicationId, id))
    .orderBy(schema.matches.companyId);
function noAI() {
  expect(summarize).not.toHaveBeenCalled();
  expect(classify).not.toHaveBeenCalled();
  expect(readSourceReviewContext).not.toHaveBeenCalled();
}
async function reviewSource(f: Awaited<ReturnType<typeof fixture>>) {
  for (const target of [
    { kind: "project" as const, publicationId: f.p.id },
    {
      kind: "lot" as const,
      publicationId: f.p.id,
      sourceProjectId: f.identity.projectId,
      lotId: f.lotId,
    },
  ]) {
    const loaded = await loadLotSourceReview(target, viewer),
      project = target.kind === "project";
    await appendLotSourceReview(
      {
        target,
        expectedObservationId: loaded.expected.observationId,
        expectedSnapshotHash: loaded.expected.snapshotHash,
        expectedShapeEpochToken: loaded.expected.shapeEpochToken,
        expectedSelectionHash: loaded.expected.selectionHash,
        expectedTargetEventId: loaded.expected.targetEventId,
        expectedProjectBarrierHash: loaded.expected.projectBarrierHash,
        action: "recorded",
        form: project ? "broad_scope" : "defined_service",
        references: [
          {
            selectionHash: loaded.expected.selectionHash!,
            rawPath: project
              ? "/procurement/orderDescription/it"
              : "/lots/0/orderDescription/it",
            startUtf16: 0,
            endUtf16: (project ? commonText : lotText).length,
          },
        ],
        note: "Revisione inventata per il test del worker.",
      },
      viewer,
    );
  }
}
async function reviewLot(
  f: Awaited<ReturnType<typeof fixture>>,
  companyId: string,
) {
  const loaded = await loadLotMatchReview(companyId, f.p.id, viewer),
    selected = lotMatchReviewTarget(loaded, f.lotId);
  return appendLotMatchReview(
    {
      companyId,
      publicationId: f.p.id,
      action: "assess_lot",
      target: selected.target,
      expectedSnapshotHash: selected.expected.snapshotHash,
      expectedShapeEpochToken: selected.expected.shapeEpochToken,
      expectedProfileHash: selected.expected.profileHash,
      expectedStateToken: selected.expected.stateToken,
      expectedGroupToken: selected.expected.groupToken,
      expectedSourceDependency: selected.expected.sourceDependency,
      expectedOperationalInputHash: selected.expected.operationalInputHash,
      expectedEvaluationSetToken: selected.expected.evaluationSetToken,
      expectedEntryHash: selected.expected.entryHash,
      result: "direct",
      reason: "Interesse potenziale per il solo lotto inventato degli alberi.",
      references: [
        {
          selectionHash: selected.context.dependency.selectionHash!,
          rawPath: "/lots/0/orderDescription/it",
          startUtf16: 0,
          endUtf16: lotText.length,
        },
      ],
      confirmedReviewReasons: selected.preliminary.reviewReasons,
      note: "Confermo gli avvisi operativi correnti per l'interesse potenziale.",
    },
    viewer,
  );
}
async function beforeTransaction(action: () => Promise<void>) {
  let once = false;
  injected.db = new Proxy(db, {
    get(target, prop) {
      if (prop === "transaction")
        return async (callback: Parameters<typeof db.transaction>[0]) => {
          if (!once) {
            once = true;
            await action();
          }
          return db.transaction(callback);
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

it("Creates one project review for active onboarded firms despite a parent-only exclusion, without AI or v1 source reader", async () => {
  const f = await fixture(),
    first = await company(),
    second = await company({ ...baseProfile, sectors: ["pulizie"] });
  await company(baseProfile, { disabled: true });
  await company(baseProfile, { onboarded: false });
  await enrichAndMatch({ publicationId: f.p.id, now });
  const matched = await rows(f.p.id);
  expect(matched.map((row) => row.companyId).sort()).toEqual(
    [first, second].sort(),
  );
  expect(
    matched.every(
      (row) =>
        row.score === 0 &&
        !row.eligible &&
        row.approved === null &&
        row.revision.startsWith(LOT_WORKER_REVIEW_VERSION),
    ),
  ).toBe(true);
  const once = structuredClone(matched);
  await enrichAndMatch({ publicationId: f.p.id, now });
  expect(await rows(f.p.id)).toEqual(once);
  noAI();
});

it("Re-reads the adopted pointer, current profiles and newly onboarded companies inside the transaction", async () => {
  const f = await fixture(),
    id = await company();
  let late = "";
  await beforeTransaction(async () => {
    await f.adopt();
    await db
      .update(schema.companies)
      .set({ profile: { ...baseProfile, exclusions: ["potatura"] } })
      .where(eq(schema.companies.id, id));
    late = await company();
  });
  await enrichAndMatch({ publicationId: f.p.id, now });
  expect((await rows(f.p.id)).map((row) => row.companyId).sort()).toEqual(
    [id, late].sort(),
  );
  injected.db = db;
  const loaded = await loadLotMatchReview(id, f.p.id, viewer);
  expect(loaded.project.lots[0].preliminary?.eligible).toBe(false);
  expect(
    (await rows(f.p.id)).find((row) => row.companyId === id)?.revision,
  ).toBe(`${LOT_WORKER_REVIEW_VERSION}:${loaded.project.projectBindingHash}`);
  noAI();
});

it("Preserves human lot decisions, immutable audit and canonical veto; a changed source masks the old positive instead of rewriting it", async () => {
  const f = await fixture(),
    id = await company();
  await matchAdoptedPublication({ publicationId: f.p.id, now });
  await reviewSource(f);
  await reviewLot(f, id);
  const loaded = await loadLotMatchReview(id, f.p.id, viewer);
  await appendLotMatchReview(
    {
      companyId: id,
      publicationId: f.p.id,
      action: "veto_project",
      expectedSnapshotHash: loaded.expected.snapshotHash,
      expectedShapeEpochToken: loaded.expected.shapeEpochToken,
      expectedProfileHash: loaded.expected.profileHash,
      expectedStateToken: loaded.expected.stateToken,
      expectedGroupToken: loaded.expected.groupToken,
      expectedProjectBindingHash: loaded.expected.projectBindingHash,
      note: "Veto progetto inventato da mantenere durante il worker.",
    },
    viewer,
  );
  const before = await rows(f.p.id),
    audit = await db.select().from(schema.matchLotReviewEvents),
    settings = await db.select().from(schema.settings);
  const changed = structuredClone(f.raw);
  changed.lots[0].orderDescription.it += " Nuova prestazione inventata.";
  await f.adopt((await f.observation(changed)).id);
  await enrichAndMatch({ publicationId: f.p.id, now });
  expect(await rows(f.p.id)).toEqual(before);
  expect(await db.select().from(schema.matchLotReviewEvents)).toEqual(audit);
  expect(await db.select().from(schema.settings)).toEqual(settings);
  const current = await loadLotMatchReview(id, f.p.id, viewer);
  expect(current.project.signalEligible).toBe(false);
  expect(current.project.suppressed).toBe(true);
  expect(current.project.lots[0].state).toBe("stale");
  noAI();
});

it("Keeps exact legacy approvals and rejections, including SQL timestamp precision, without stamping them as lot reviews", async () => {
  const f = await fixture();
  for (const approved of [true, false]) {
    const id = await company();
    await db.insert(schema.matches).values({
      id: randomUUID(),
      companyId: id,
      publicationId: f.p.id,
      revision: "historic-human-revision",
      score: 97,
      eligible: approved,
      approved,
      reviewedAt: new Date("2026-09-01T10:00:00Z"),
      reviewNotes: "Nota umana originale",
      reason: "Giudizio storico originale",
    });
  }
  await pg.exec(
    "UPDATE matches SET reviewed_at = reviewed_at + interval '0.000123 seconds' WHERE revision = 'historic-human-revision'",
  );
  const before = await pg.query(
    "SELECT id, revision, approved, reviewed_at::text, updated_at::text, review_notes, reason, score, eligible, lot_evaluations FROM matches WHERE publication_id = $1 ORDER BY id",
    [f.p.id],
  );
  await enrichAndMatch({ publicationId: f.p.id, now });
  expect(
    (
      await pg.query(
        "SELECT id, revision, approved, reviewed_at::text, updated_at::text, review_notes, reason, score, eligible, lot_evaluations FROM matches WHERE publication_id = $1 ORDER BY id",
        [f.p.id],
      )
    ).rows,
  ).toEqual(before.rows);
  expect((await rows(f.p.id)).every((row) => row.lotEvaluations === null)).toBe(
    true,
  );
  noAI();
});

it("Refused or empty-lot observations and closed adopted sources finish in review without invented lot verdicts", async () => {
  const id = await company(),
    f = await fixture();
  await f.adopt((await f.observation(f.raw, true)).id);
  await db
    .update(schema.publications)
    .set({ status: "closed", data: { ...f.p, status: "closed" } })
    .where(eq(schema.publications.id, f.p.id));
  await enrichAndMatch({ publicationId: f.p.id, now });
  const refused = await rows(f.p.id);
  expect(refused).toHaveLength(1);
  expect(refused[0].score).toBe(0);
  expect(refused[0].eligible).toBe(false);
  expect((await loadLotMatchReview(id, f.p.id, viewer)).project.state).toBe(
    "input_refused",
  );
  const empty = await fixture({ empty: true });
  await enrichAndMatch({ publicationId: empty.p.id, now });
  expect((await rows(empty.p.id))[0]).toMatchObject({
    score: 0,
    eligible: false,
  });
  const wholeProject = (await loadLotMatchReview(id, empty.p.id, viewer))
    .project;
  expect(wholeProject.shape.kind).toBe("project");
  expect(wholeProject.targets).toHaveLength(1);
  expect(wholeProject.targets[0].target).toEqual({
    kind: "project",
    publicationId: empty.p.id,
  });
  expect(wholeProject.targets[0].evaluation).toBeNull();
  expect(
    (await loadLotMatchReview(id, empty.p.id, viewer)).project.lots,
  ).toEqual([]);
  noAI();
});

it("Rolls back inserted review rows when later resolution fails, and propagates cancellation without partial rows", async () => {
  const f = await fixture();
  const second = [await company(), await company()].sort()[1];
  await pg.exec(
    `CREATE FUNCTION fail_lot_worker_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id = '${second}' THEN RAISE EXCEPTION 'invented worker failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_lot_worker_update BEFORE UPDATE ON matches FOR EACH ROW EXECUTE FUNCTION fail_lot_worker_update();`,
  );
  try {
    await expect(
      matchAdoptedPublication({ publicationId: f.p.id, now }),
    ).rejects.toThrow();
  } finally {
    await pg.exec(
      "DROP TRIGGER fail_lot_worker_update ON matches; DROP FUNCTION fail_lot_worker_update();",
    );
  }
  expect(await rows(f.p.id)).toEqual([]);
  const abort = new AbortController();
  abort.abort(new Error("invented cancellation"));
  await expect(
    matchAdoptedPublication({
      publicationId: f.p.id,
      now,
      signal: abort.signal,
    }),
  ).rejects.toThrow("invented cancellation");
  expect(await rows(f.p.id)).toEqual([]);
  noAI();
});

it("Legacy import cannot overwrite an adopted archive, and a new canonical copy does not inherit lot judgments", async () => {
  const f = await fixture(),
    id = await company();
  await matchAdoptedPublication({ publicationId: f.p.id, now });
  await reviewSource(f);
  await reviewLot(f, id);
  const before = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, f.p.id)),
    matched = await rows(f.p.id),
    audit = await db.select().from(schema.matchLotReviewEvents);
  await expect(
    storePublication({
      ...f.p,
      revision: "new-legacy-revision",
      originalText: "Replacement without archive",
    }),
  ).rejects.toThrow("aggiornamento documentario completo");
  expect(
    await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.id, f.p.id)),
  ).toEqual(before);
  expect(await rows(f.p.id)).toEqual(matched);
  const copy = {
    ...f.p,
    id: `simap-${randomUUID()}`,
    externalId: randomUUID(),
    canonicalKey: f.p.id,
    sourceUrl: "https://example.invalid/new-canonical-copy",
    sourceUrls: ["https://example.invalid/new-canonical-copy"],
    publishedAt: "2026-09-02T00:00:00.000Z",
    revision: "new-invented-copy",
    projectId: "INVENTED-NEW-2",
  };
  copy.id = `simap-${copy.externalId}`;
  await storePublication(copy);
  const copied = await rows(copy.id);
  expect(copied).toHaveLength(1);
  expect(copied[0].lotEvaluations).toBeNull();
  expect(copied[0].lotSuppression).toBeNull();
  expect(copied[0].approved).toBeNull();
  expect(copied[0].score).toBe(0);
  expect(copied[0].reason).toContain(
    "giudizi dei lotti precedenti restano storici",
  );
  expect(await rows(f.p.id)).toEqual(matched);
  expect(await db.select().from(schema.matchLotReviewEvents)).toEqual(audit);
  expect(
    (
      await db
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.id, f.p.id))
    )[0].documentarySnapshotId,
  ).toBe(f.initial.id);
  noAI();
});

it.each(["summary", "classification"] as const)(
  "Discards an already-started legacy %s when adoption commits before its write, then creates only the human review row",
  async (stage) => {
    const f = await fixture({ adopt: false });
    await company();
    const legacy = {
      ...f.p,
      canton: "TI",
      sectors: ["giardinaggio"] as ["giardinaggio"],
      summary: stage === "classification" ? "Existing summary" : null,
    };
    await db
      .update(schema.publications)
      .set({
        data: legacy,
        aiRevision: stage === "classification" ? legacy.revision : null,
      })
      .where(eq(schema.publications.id, f.p.id));
    if (stage === "summary")
      vi.mocked(summarize).mockImplementationOnce(async () => {
        await f.adopt();
        return {
          summary: "STALE AI SUMMARY",
          sectors: ["giardinaggio"],
          requirements: [],
          evidence: [],
        };
      });
    else
      vi.mocked(classify).mockImplementationOnce(async () => {
        await f.adopt();
        return {
          score: 99,
          reason: "STALE AI MATCH",
          uncertain: false,
          needsReview: false,
        };
      });
    await enrichAndMatch({ publicationId: f.p.id, now });
    const matched = await rows(f.p.id),
      [source] = await db
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.id, f.p.id));
    expect(source.data.summary).toBe(legacy.summary);
    expect(matched).toHaveLength(1);
    expect(matched[0].score).toBe(0);
    expect(matched[0].eligible).toBe(false);
    expect(matched[0].reason).not.toContain("STALE AI");
    expect(matched[0].revision).toContain(LOT_WORKER_REVIEW_VERSION);
    expect(summarize).toHaveBeenCalledTimes(stage === "summary" ? 1 : 0);
    expect(classify).toHaveBeenCalledTimes(stage === "classification" ? 1 : 0);
  },
);

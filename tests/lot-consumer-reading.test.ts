import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq } from "drizzle-orm";
import { PgBoss, fromPglite } from "pg-boss";
import * as schema from "../src/db/schema";
import type { CompanyProfile, Viewer } from "../src/lib/domain";
import { PILOT_PARTICIPATION_TERMS_VERSION } from "../src/lib/pilot-participation";
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
import type { LotSourceTarget } from "../src/lib/lot-source-context";
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
import {
  appendLotSourceReview,
  loadLotSourceReview,
  type LoadedLotSourceReview,
  type LotSourceReviewInput,
} from "../src/lib/lot-source-reviews";
import {
  appendLotMatchReview,
  loadLotMatchReview,
  lotMatchReviewTarget,
  assessmentReviewTarget,
  type LoadedLotMatchReview,
  type LotMatchReviewInput,
} from "../src/lib/lot-match-reviews";

// Fresh PGlite per test; invented source/company data, real migrations and repositories.
// No provider, SMTP, HTTP, live DB, runtime adoption or two-backend concurrency.
let pg: PGlite;
let db: ReturnType<typeof makeDb>;
let boss: PgBoss;
const makeDb = (instance: PGlite) => drizzle(instance, { schema });
import {
  listOpportunities,
  getOpportunity,
  getRadarStatus,
} from "../src/lib/queries";
import { adminSnapshot, getGate } from "../src/lib/admin";
import * as projectQuality from "../src/lib/project-quality";
import {
  loadSourceReviewContext,
  appendSourceReview,
} from "../src/lib/source-reviews";
import { fingerprint } from "../src/sources/common";
const viewer = { userId: "lot-match-founder", admin: true, demo: false };
const commonText =
  "Progetto inventato suddiviso in due lotti indipendenti per il test.";
const aText = "🌳 Potatura e cura del verde nel lotto A inventato.";
const bText = "Installazione di quadri elettrici nel lotto B inventato.";
beforeEach(async () => {
  pg = new PGlite();
  db = makeDb(pg);
  boss = new PgBoss({
    db: fromPglite(pg),
    backend: "pglite",
    schema: "pgboss",
    schedule: false,
    supervise: false,
  });
  injected.db = db;
  await pg.exec(
    "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role",
  );
  await migrate(db, { migrationsFolder: "drizzle" });
  await boss.start();
  await boss.createQueue(LOT_RECONCILIATION_QUEUE);
  await boss.stop();
  await db.insert(schema.user).values([
    {
      id: viewer.userId,
      name: "Fondatore inventato",
      email: "match-founder@example.invalid",
    },
    {
      id: "not-match-admin",
      name: "Non amministratore",
      email: "not-match-admin@example.invalid",
    },
  ]);
  await db.insert(schema.administrators).values({ userId: viewer.userId });
}, 20000);
afterEach(async () => {
  await boss.stop();
  await pg.close();
});

function sourceDraft(loaded: LoadedLotSourceReview): LotSourceReviewInput {
  const target = loaded.context.target,
    selected = loaded.context.targetContent?.selectedLot;
  const rawPath =
    target.kind === "project"
      ? "/procurement/orderDescription/it"
      : `${selected!.path}/orderDescription/it`;
  const value =
    target.kind === "project"
      ? (
          loaded.context.targetContent!.projectSections.procurement as {
            orderDescription: { it: string };
          }
        ).orderDescription.it
      : (selected!.record as { orderDescription: { it: string } })
          .orderDescription.it;
  return {
    target,
    expectedObservationId: loaded.expected.observationId,
    expectedSnapshotHash: loaded.expected.snapshotHash,
    expectedShapeEpochToken: loaded.expected.shapeEpochToken,
    expectedSelectionHash: loaded.expected.selectionHash,
    expectedTargetEventId: loaded.expected.targetEventId,
    expectedProjectBarrierHash: loaded.expected.projectBarrierHash,
    action: "recorded",
    form:
      target.kind === "project" && loaded.shapeState.shape.kind !== "project"
        ? "broad_scope"
        : "defined_service",
    references: [
      {
        selectionHash: loaded.expected.selectionHash!,
        rawPath,
        startUtf16: 0,
        endUtf16: value.length,
      },
    ],
    note: "Revisione fonte inventata per la prova locale.",
    resolveLegacyScope: false,
  };
}
async function fixture(
  options: {
    legacyVeto?: boolean;
    adopt?: boolean;
    canonicalId?: string;
    reuseCompanies?: { companyId: string; otherCompanyId: string };
    withoutLots?: boolean;
    unknownShape?: boolean;
  } = {},
) {
  const projectId = randomUUID(),
    noticeId = randomUUID(),
    aId = randomUUID(),
    bId = randomUUID();
  const companyId = options.reuseCompanies?.companyId ?? randomUUID(),
    otherCompanyId = options.reuseCompanies?.otherCompanyId ?? randomUUID();
  const identity = {
    projectId,
    publicationId: noticeId,
    detailUrl: `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${noticeId}`,
  };
  const raw = {
    id: noticeId,
    type: "tender",
    "project-info": { title: { it: "Progetto lotti inventato" } },
    procurement: { orderDescription: { it: commonText } },
    base: {
      id: noticeId,
      projectId,
      lotsType: "with",
      lots: [
        { id: aId, lotNumber: 1, title: { it: "Verde" } },
        { id: bId, lotNumber: 2, title: { it: "Impianti" } },
      ],
    },
    lots: [
      {
        id: aId,
        lotNumber: 1,
        title: { it: "Verde" },
        orderDescription: { it: aText },
        orderAddress: { countryId: "CH", cantonId: "TI", city: "Lugano" },
        cpvCode: { code: "77310000" },
      },
      {
        id: bId,
        lotNumber: 2,
        title: { it: "Impianti" },
        orderDescription: { it: bText },
        orderAddress: { countryId: "CH", cantonId: "TI", city: "Lugano" },
        cpvCode: { code: "45310000" },
      },
    ],
  };
  if (options.withoutLots || options.unknownShape) {
    raw.lots = [];
    raw.base.lots = [];
    raw.base.lotsType = options.withoutLots ? "without" : "unknown";
    raw.procurement.orderDescription.it = aText;
    Object.assign(raw.procurement, {
      orderAddress: { countryId: "CH", cantonId: "TI", city: "Lugano" },
      cpvCode: { code: "77310000" },
      partialOffers: {
        it: "CONDIZIONE_CONDIVISA: offerta per l'intero progetto.",
      },
    });
  }
  const entry = {
    id: projectId,
    raw: {
      id: projectId,
      publicationId: noticeId,
      publicationDate: "2026-09-01",
      projectNumber: "INVENTED-MATCH-LOT",
      pubType: "tender",
      processType: "open",
      title: { it: "Progetto lotti inventato" },
      procOfficeName: { it: "Ente inventato" },
    },
  };
  const p = normalizeSimap(entry, raw);
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
    aiRevision: p.revision,
  });
  const profile: CompanyProfile = {
    name: "Ditta verde inventata",
    activities: "Potatura e manutenzione ordinaria di giardini.",
    employees: 2,
    sectors: ["giardinaggio"],
    zones: ["Tutto il Ticino"],
    keywords: [],
    exclusions: [],
    minValue: null,
    maxValue: null,
    emailEnabled: true,
  };
  const otherProfile: CompanyProfile = {
    ...profile,
    name: "Ditta impianti inventata",
    activities: "Installazione di quadri elettrici e impianti.",
    sectors: ["impianti"],
  };
  for (const [id, companyProfile] of [
    [companyId, profile],
    [otherCompanyId, otherProfile],
  ] as const) {
    if (!options.reuseCompanies) {
      await db.insert(schema.user).values({
        id,
        name: companyProfile.name,
        email: `${id}@example.invalid`,
      });
      await db
        .insert(schema.companies)
        .values({ id, ownerId: id, profile: companyProfile });
    }
    await db.insert(schema.matches).values({
      id: `${id}-${p.id}`,
      companyId: id,
      publicationId: p.id,
      revision: "legacy-match-revision",
      score: 93,
      reason: "Giudizio precedente da preservare",
      eligible: true,
      approved: options.legacyVeto && id === companyId ? false : true,
      reviewedAt: new Date("2026-09-01T08:00:00Z"),
      reviewNotes: "Nota manuale precedente",
    });
  }
  async function observe(detail = raw, refused = false) {
    const request = await beginDocumentaryRequest(identity);
    const body = JSON.stringify(detail),
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
    const stored = await storeDocumentaryObservation(request, result);
    return { stored, publication };
  }
  const observation = await observe();
  const adopt = async (value = observation) => {
    // Test-only setup; the app's separate adoption path is not exercised here.
    await db
      .update(schema.publications)
      .set({
        documentarySnapshotId: value.stored.id,
        ...(value.stored.state === "accepted"
          ? { data: value.publication, revision: value.publication.revision }
          : {}),
      })
      .where(eq(schema.publications.id, p.id));
  };
  const project: LotSourceTarget = { kind: "project", publicationId: p.id };
  const a: LotSourceTarget = {
    kind: "lot",
    publicationId: p.id,
    sourceProjectId: projectId,
    lotId: aId,
  };
  const b: LotSourceTarget = { ...a, lotId: bId };
  if (options.adopt !== false) {
    await adopt();
    for (const target of options.unknownShape
      ? []
      : options.withoutLots
        ? [project]
        : [project, a, b])
      await appendLotSourceReview(
        sourceDraft(await loadLotSourceReview(target, viewer)),
        viewer,
      );
  }
  const load = (company = companyId) =>
    loadLotMatchReview(company, p.id, viewer);
  return {
    p,
    raw,
    identity,
    companyId,
    otherCompanyId,
    profile,
    otherProfile,
    aId,
    bId,
    project,
    a,
    b,
    observation,
    observe,
    adopt,
    load,
  };
}
function assessmentDraft(
  loaded: LoadedLotMatchReview,
  lotId: string,
  result: "direct" | "different" | "review" = "direct",
): LotMatchReviewInput {
  const selected = lotMatchReviewTarget(loaded, lotId),
    target = selected.context.targetContent!.selectedLot!;
  const value = (target.record as { orderDescription: { it: string } })
    .orderDescription.it;
  return {
    companyId: loaded.company.id,
    publicationId: loaded.publication.id,
    action: "assess_lot",
    target: selected.target as Extract<LotSourceTarget, { kind: "lot" }>,
    expectedSnapshotHash: selected.expected.snapshotHash,
    expectedShapeEpochToken: selected.expected.shapeEpochToken!,
    expectedProfileHash: selected.expected.profileHash,
    expectedStateToken: selected.expected.stateToken,
    expectedGroupToken: selected.expected.groupToken,
    expectedSourceDependency: selected.expected.sourceDependency,
    expectedOperationalInputHash: selected.expected.operationalInputHash,
    expectedEvaluationSetToken: selected.expected.evaluationSetToken,
    expectedEntryHash: selected.expected.entryHash,
    result,
    reason: `Interesse potenziale inventato ${result} per il lotto selezionato.`,
    references: [
      {
        selectionHash: selected.context.dependency.selectionHash!,
        rawPath: `${target.path}/orderDescription/it`,
        startUtf16: 0,
        endUtf16: value.length,
      },
    ],
    confirmedReviewReasons:
      result === "direct" ? [...selected.preliminary.reviewReasons] : [],
    note: "PRIVATE_MATCH_NOTE: verificati i limiti operativi senza attestare idoneità.",
  };
}
function projectDraft(
  loaded: LoadedLotMatchReview,
  action: "veto_project" | "reopen_project",
): LotMatchReviewInput {
  return {
    companyId: loaded.company.id,
    publicationId: loaded.publication.id,
    action,
    expectedSnapshotHash: loaded.expected.snapshotHash,
    expectedShapeEpochToken: loaded.expected.shapeEpochToken,
    expectedProfileHash: loaded.expected.profileHash,
    expectedStateToken: loaded.expected.stateToken,
    expectedGroupToken: loaded.expected.groupToken,
    expectedProjectBindingHash: loaded.expected.projectBindingHash,
    note: "Revisione esplicita inventata della soppressione del progetto.",
  };
}

function wholeProjectDraft(loaded: LoadedLotMatchReview): LotMatchReviewInput {
  const selected = assessmentReviewTarget(loaded, {
    kind: "project",
    publicationId: loaded.publication.id,
  });
  const text = (
    selected.context.targetContent!.projectSections.procurement as {
      orderDescription: { it: string };
    }
  ).orderDescription.it;
  return {
    companyId: loaded.company.id,
    publicationId: loaded.publication.id,
    action: "assess_project",
    target: selected.target as Extract<LotSourceTarget, { kind: "project" }>,
    expectedSnapshotHash: selected.expected.snapshotHash,
    expectedShapeEpochToken: selected.expected.shapeEpochToken!,
    expectedProfileHash: selected.expected.profileHash,
    expectedStateToken: selected.expected.stateToken,
    expectedGroupToken: selected.expected.groupToken,
    expectedSourceDependency: selected.expected.sourceDependency,
    expectedOperationalInputHash: selected.expected.operationalInputHash,
    expectedEvaluationSetToken: selected.expected.evaluationSetToken,
    expectedEntryHash: selected.expected.entryHash,
    result: "direct",
    reason:
      "La potatura dell'intero progetto riguarda la ditta; interesse potenziale.",
    references: [
      {
        selectionHash: selected.context.dependency.selectionHash!,
        rawPath: "/procurement/orderDescription/it",
        startUtf16: 0,
        endUtf16: text.length,
      },
    ],
    confirmedReviewReasons: [...selected.preliminary.reviewReasons],
    note: "PRIVATE_PROJECT_NOTE: avvisi verificati, nessuna attestazione di idoneità.",
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function customer(f: Fixture, other = false): Promise<Viewer> {
  const id = other ? f.otherCompanyId : f.companyId;
  const [company] = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, id));
  return {
    userId: company.ownerId,
    companyId: id,
    name: company.profile.name,
    email: `${id}@example.invalid`,
    admin: false,
    demo: false,
    invitationAcceptedAt: new Date(0).toISOString(),
    invitationAcceptanceVersion: PILOT_PARTICIPATION_TERMS_VERSION,
    profile: company.profile,
  };
}
async function clearLegacy(f: Fixture) {
  await db
    .update(schema.matches)
    .set({ approved: null, reviewedAt: null, reviewNotes: null })
    .where(eq(schema.matches.publicationId, f.p.id));
}
async function assess(
  f: Fixture,
  lotId = f.aId,
  result: "direct" | "different" | "review" = "direct",
  other = false,
) {
  return appendLotMatchReview(
    assessmentDraft(
      await f.load(other ? f.otherCompanyId : f.companyId),
      lotId,
      result,
    ),
    viewer,
  );
}
async function sourceHistory(publicationId: string) {
  return db
    .select()
    .from(schema.sourceReviewEvents)
    .where(eq(schema.sourceReviewEvents.publicationId, publicationId))
    .orderBy(schema.sourceReviewEvents.sequence);
}
async function matchRows(publicationId: string) {
  return db
    .select()
    .from(schema.matches)
    .where(eq(schema.matches.publicationId, publicationId))
    .orderBy(schema.matches.id);
}

it("the founder inventory is re-read when adoption occurs during dashboard loading", async () => {
  const f = await fixture({ adopt: false });
  const revisedProfile = {
    ...f.profile,
    name: "Ditta inventata aggiornata",
    activities: "Cura delle alberature e potatura aggiornata durante il test.",
  };
  const readQuality = projectQuality.readProjectQuality;
  let changed = false;
  // The parallel inventory has already returned when the quality reader
  // completes its additional canonical reads. Advance the source at this
  // boundary, before the dashboard consumes those earlier inventory rows.
  const gateRead = vi
    .spyOn(projectQuality, "readProjectQuality")
    .mockImplementationOnce(async (...args) => {
      const result = await readQuality(...args);
      await f.adopt();
      await db
        .update(schema.companies)
        .set({ profile: revisedProfile })
        .where(eq(schema.companies.id, f.companyId));
      changed = true;
      return result;
    });
  try {
    const snapshot = await adminSnapshot(false);
    expect(changed).toBe(true);
    const item = snapshot.matches.find(
      (row) =>
        row.publicationId === f.p.id && row.company === revisedProfile.name,
    );
    expect(item).toMatchObject({
      score: 0,
      approved: null,
      reviewed: false,
      assessment: "uncertain",
      reviewRequired: true,
      companyActivities: revisedProfile.activities,
      profileRevision: fingerprint((await customer(f)).profile),
      lotReviewUrl: `/admin/valutazioni/${f.companyId}/${f.p.id}`,
    });
    expect(item?.lotReview).not.toBeNull();
  } finally {
    gateRead.mockRestore();
  }
});

it("the founder inventory omits a publication closed while the dashboard loads", async () => {
  const f = await fixture();
  const readQuality = projectQuality.readProjectQuality;
  const gateRead = vi
    .spyOn(projectQuality, "readProjectQuality")
    .mockImplementationOnce(async (...args) => {
      const result = await readQuality(...args);
      await db
        .update(schema.publications)
        .set({ status: "cancelled", data: { ...f.p, status: "cancelled" } })
        .where(eq(schema.publications.id, f.p.id));
      return result;
    });
  try {
    expect((await adminSnapshot(false)).matches).toEqual([]);
  } finally {
    gateRead.mockRestore();
  }
});

it("an existing positive v1 review becomes a non-positive adopted/refused project without erasing its history", async () => {
  const f = await fixture({ adopt: false });
  const oldPublication = {
    ...f.p,
    sectors: ["giardinaggio" as const],
    canton: "TI",
    zone: "Luganese",
  };
  await db
    .update(schema.publications)
    .set({ data: oldPublication })
    .where(eq(schema.publications.id, f.p.id));
  const old = await loadSourceReviewContext(f.p.id, viewer);
  expect(old.snapshot.source.accepted).toBe(true);
  if (!old.snapshot.source.accepted) throw new Error("invalid invented source");
  const unit = old.snapshot.source.corpus.units[0];
  const reviewed = await appendSourceReview(
    {
      publicationId: f.p.id,
      expectedEventId: old.expected.eventId,
      expectedSourceSnapshotHash: old.expected.sourceSnapshotHash,
      expectedCorpusHash: old.expected.corpusHash,
      action: "recorded",
      form: "defined_service",
      references: [
        {
          unitId: unit.id,
          originIndex: 0,
          startUtf16: 0,
          endUtf16: unit.text.length,
        },
      ],
      note: "Revisione umana della fonte precedente inventata.",
    },
    viewer,
  );
  const who = await customer(f);
  await db
    .update(schema.matches)
    .set({
      revision: `${oldPublication.revision}:${fingerprint(who.profile)}:manual`,
      sourceReviewDependency: reviewed.context.dependency,
    })
    .where(
      and(
        eq(schema.matches.companyId, f.companyId),
        eq(schema.matches.publicationId, f.p.id),
      ),
    );
  const prior = await getOpportunity(who, f.p.id);
  expect(prior?.assessment).toBe("reviewed");
  expect(prior?.score).toBe(93);
  const history = await sourceHistory(f.p.id),
    rows = await matchRows(f.p.id);
  await f.adopt();
  const adopted = await getOpportunity(who, f.p.id);
  expect(adopted).toMatchObject({ score: 0, assessment: "uncertain" });
  expect(adopted?.lotReview?.lots.every((l) => l.result === null)).toBe(true);
  await f.adopt(await f.observe(f.raw, true));
  const refused = await getOpportunity(who, f.p.id);
  expect(refused).toMatchObject({
    score: 0,
    assessment: "uncertain",
    lotReview: { state: "input_refused", signalEligible: false },
  });
  const list = await listOpportunities(who);
  expect(list).toEqual([]);
  // A saved historical link remains usable even when its current source is
  // refused, without returning to the selected Radar results.
  await db.insert(schema.feedback).values({
    id: randomUUID(),
    companyId: f.companyId,
    publicationId: f.p.id,
    saved: true,
  });
  expect(await listOpportunities(who)).toEqual([]);
  expect(await listOpportunities(who, { includeInactive: true })).toEqual([
    expect.objectContaining({
      id: f.p.id,
      saved: true,
      assessment: "uncertain",
      score: 0,
    }),
  ]);
  expect(await getRadarStatus(who)).toEqual({
    state: "ready",
    pendingCount: 0,
  });
  expect(await sourceHistory(f.p.id)).toEqual(history);
  expect(await matchRows(f.p.id)).toEqual(rows);
  const gate = await getGate();
  expect(gate.approved).toBe(0);
  expect(gate.reviewed).toBe(0);
  expect(gate.historical.approved).toBe(2);
});

it("A direct and B review produce exactly one project, one current gate vote and no private DTO fields", async () => {
  const f = await fixture();
  await clearLegacy(f);
  await assess(f);
  await assess(f, f.bId, "review");
  const who = await customer(f),
    list = await listOpportunities(who);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({
    id: f.p.id,
    score: 100,
    assessment: "reviewed",
  });
  expect(list[0].lotReview?.lots.map((l) => l.result)).toEqual([
    "direct",
    "review",
  ]);
  expect(list[0].lotReview?.relevantLotIds).toEqual([f.aId]);
  expect(list[0].reason).toContain("lotto 1");
  expect(list[0].summary).toBeNull();
  expect(list[0].deadline).toBeNull();
  expect(list[0].valueChf).toBeNull();
  const json = JSON.stringify(await getOpportunity(who, f.p.id));
  for (const privateValue of [
    "PRIVATE_MATCH_NOTE",
    viewer.userId,
    "evidenceSnapshot",
    "actorId",
    "reviewNotes",
  ])
    expect(json).not.toContain(privateValue);
  expect(await getRadarStatus(who)).toEqual({
    state: "ready",
    pendingCount: 0,
  });
  const gate = await getGate();
  expect(gate).toMatchObject({
    reviewed: 1,
    approved: 1,
    rejected: 0,
    unresolved: 1,
    allowed: false,
  });
});

it("changing only B preserves the current A judgment, then changing the profile suspends it without rewriting either", async () => {
  const f = await fixture();
  await clearLegacy(f);
  await assess(f);
  await assess(f, f.bId, "review");
  const before = await f.load(),
    firstA = before.project.lots[0].evaluation;
  const changed = structuredClone(f.raw);
  changed.lots[1].orderDescription.it =
    "Nuovo testo solo del lotto B: quadri e cablaggi.";
  await f.adopt(await f.observe(changed));
  const who = await customer(f);
  const current = await getOpportunity(who, f.p.id);
  expect(current?.lotReview?.lots[0]).toMatchObject({
    state: "current",
    result: "direct",
  });
  expect(current?.lotReview?.lots[1]).toMatchObject({
    state: "stale",
    result: null,
  });
  expect(current?.score).toBe(100);
  expect((await f.load()).project.lots[0].evaluation).toEqual(firstA);
  expect((await getGate()).approved).toBe(1);
  const storedBefore = await matchRows(f.p.id);
  await db
    .update(schema.companies)
    .set({
      profile: {
        ...f.profile,
        activities: "Nuove attività inventate da verificare.",
      },
    })
    .where(eq(schema.companies.id, f.companyId));
  const stale = await getOpportunity(who, f.p.id); // stale viewer.profile must not win over the DB profile.
  expect(stale?.score).toBe(0);
  expect(stale?.assessment).toBe("uncertain");
  expect(stale?.lotReview?.lots[0]).toMatchObject({
    state: "stale",
    result: null,
    issue: "stale_profile",
  });
  expect(await listOpportunities(who)).toEqual([]);
  expect(await matchRows(f.p.id)).toEqual(storedBefore);
  expect(await getGate()).toMatchObject({
    approved: 0,
    reviewed: 0,
    historical: { approved: 1 },
  });
});

it.each(["cancelled", "refused", "no-match"] as const)(
  "an old legacy URL resolves the adopted %s representative without favourable fallback",
  async (state) => {
    const canonicalId = randomUUID();
    const old = await fixture({ canonicalId, adopt: false });
    const fresh = await fixture({
      canonicalId,
      reuseCompanies: {
        companyId: old.companyId,
        otherCompanyId: old.otherCompanyId,
      },
    });
    const who = await customer(old);
    // Make the legacy copy a favourable, independently current manual result.
    await db
      .update(schema.matches)
      .set({ revision: `${old.p.revision}:${fingerprint(who.profile)}:manual` })
      .where(
        and(
          eq(schema.matches.companyId, who.companyId),
          eq(schema.matches.publicationId, old.p.id),
        ),
      );
    if (state === "cancelled")
      await db
        .update(schema.publications)
        .set({ status: "cancelled", data: { ...fresh.p, status: "cancelled" } })
        .where(eq(schema.publications.id, fresh.p.id));
    if (state === "refused")
      await fresh.adopt(await fresh.observe(fresh.raw, true));
    if (state === "no-match")
      await db
        .delete(schema.matches)
        .where(eq(schema.matches.publicationId, fresh.p.id));
    const detail = await getOpportunity(who, old.p.id);
    if (state === "no-match") expect(detail).toBeNull();
    else {
      expect(detail?.id).toBe(fresh.p.id);
      expect(detail?.score).toBe(0);
      expect(detail?.lotReview?.signalEligible).toBe(false);
    }
    const list = await listOpportunities(who);
    expect(list.every((p) => p.id !== old.p.id)).toBe(true);
    expect(list).toEqual([]);
    const radarStatus = await getRadarStatus(who);
    expect(radarStatus.pendingCount).toBe(state === "no-match" ? 1 : 0);
    const gate = await getGate();
    expect(gate.approved).toBe(0);
    expect(gate.reviewed).toBe(0);
  },
);

it("company-specific verdicts and feedback stay isolated on the same project", async () => {
  const f = await fixture();
  await clearLegacy(f);
  await assess(f);
  await assess(f, f.bId, "review");
  await assess(f, f.aId, "different", true);
  await assess(f, f.bId, "different", true);
  await db.insert(schema.feedback).values({
    id: randomUUID(),
    companyId: f.companyId,
    publicationId: f.p.id,
    saved: true,
    dismissed: false,
    relevant: true,
  });
  await db.insert(schema.feedback).values({
    id: randomUUID(),
    companyId: f.otherCompanyId,
    publicationId: f.p.id,
    saved: false,
    dismissed: true,
    relevant: false,
  });
  const first = await customer(f),
    second = await customer(f, true);
  expect((await listOpportunities(first))[0]).toMatchObject({
    score: 100,
    saved: true,
    dismissed: false,
    feedback: "relevant",
  });
  // The Dashboard keeps dismissed items available under its Excluse filter.
  const excluded = await listOpportunities(second);
  expect(excluded).toHaveLength(1);
  expect(excluded[0]).toMatchObject({
    score: 0,
    assessment: "rejected",
    saved: false,
    dismissed: true,
    feedback: "irrelevant",
  });
  expect(excluded[0].lotReview?.lots.map((lot) => lot.result)).toEqual([
    "different",
    "different",
  ]);
  expect(
    await listOpportunities(first, { includeInactive: true }),
  ).toHaveLength(1);
  expect(await listOpportunities(second, { includeInactive: true })).toEqual(
    [],
  );
  expect(await getOpportunity(second, f.p.id)).toMatchObject({
    score: 0,
    saved: false,
    dismissed: true,
    feedback: "irrelevant",
  });
  const outsider = { ...first, companyId: randomUUID() };
  expect(await listOpportunities(outsider)).toEqual([]);
  expect(await getOpportunity(outsider, f.p.id)).toBeNull();
  expect(await getGate()).toMatchObject({
    reviewed: 2,
    approved: 1,
    rejected: 1,
  });
});

it("projects sector/CPV/location from the current lots, not contradictory container fields", async () => {
  const f = await fixture();
  await clearLegacy(f);
  await assess(f);
  const contaminated = {
    ...f.p,
    sectors: ["edilizia" as const],
    cpv: ["45000000"],
    canton: "ZH",
    zone: "Zurigo",
    location: "Zurigo",
    summary: "Parent AI text",
    valueChf: 999999,
    deadline: "2000-01-01T00:00:00.000Z",
  };
  await db
    .update(schema.publications)
    .set({ data: contaminated, deadline: new Date(contaminated.deadline) })
    .where(eq(schema.publications.id, f.p.id));
  const who = await customer(f),
    list = await listOpportunities(who),
    detail = await getOpportunity(who, f.p.id);
  expect(list).toHaveLength(1);
  for (const item of [list[0], detail!]) {
    expect(item.sectors).toEqual(
      expect.arrayContaining(["giardinaggio", "impianti"]),
    );
    expect(item.sectors).not.toContain("edilizia");
    expect(item.cpv).toEqual(expect.arrayContaining(["77310000", "45310000"]));
    expect(item.cpv).not.toContain("45000000");
    expect(item.canton).toBe("TI");
    expect(item.zone).toBe("Luganese");
    expect(item.location).not.toContain("Zurigo");
    expect(item.deadline).toBeNull();
    expect(item.summary).toBeNull();
    expect(item.valueChf).toBeNull();
  }
});

it("admin candidates follow per-lot operational vetoes without converting them to semantic rejections", async () => {
  const f = await fixture();
  const who = await customer(f);
  const previousMatches = await matchRows(f.p.id);
  const previousAudits = await db.select().from(schema.matchLotReviewEvents);
  async function replaceLocations(oneLotInTicino: boolean) {
    const raw = structuredClone(f.raw);
    raw.lots.forEach((lot, index) => {
      lot.orderAddress =
        oneLotInTicino && index === 1
          ? { countryId: "CH", cantonId: "TI", city: "Lugano" }
          : { countryId: "CH", cantonId: "ZH", city: "Zürich" };
    });
    await f.adopt(await f.observe(raw));
    for (const target of [f.project, f.a, f.b])
      await appendLotSourceReview(
        sourceDraft(await loadLotSourceReview(target, viewer)),
        viewer,
      );
  }

  await replaceLocations(false);
  const outside = await f.load();
  expect(outside.project.state).toBe("review");
  expect(outside.project.lots.map((lot) => lot.preliminary?.eligible)).toEqual([
    false,
    false,
  ]);
  expect(await listOpportunities(who)).toEqual([]);
  const outsideAdmin = (await adminSnapshot(false)).matches.find(
    (row) => row.id === outside.match.id,
  );
  expect(outsideAdmin).toMatchObject({
    eligible: false,
    approved: null,
    reviewed: false,
    assessment: "uncertain",
  });
  expect(outsideAdmin?.lotReviewUrl).toBeTruthy();

  // A second lot with no certain operational veto makes the project reviewable;
  // absence of activity/semantic proof is still not a positive assessment.
  await replaceLocations(true);
  expect(
    (await f.load()).project.lots.map((lot) => lot.preliminary?.eligible),
  ).toEqual([false, true]);
  const mixedAdmin = (await adminSnapshot(false)).matches.find(
    (row) => row.id === outside.match.id,
  );
  expect(mixedAdmin).toMatchObject({
    eligible: false,
    approved: null,
    reviewed: false,
    assessment: "uncertain",
  });
  expect(mixedAdmin?.lotReviewUrl).toBeTruthy();
  const current = await listOpportunities(who);
  expect(current).toEqual([]);
  expect(await matchRows(f.p.id)).toEqual(previousMatches);
  expect(await db.select().from(schema.matchLotReviewEvents)).toEqual(
    previousAudits,
  );
});

it("historical positive and negative judgments survive but cease to count as current gate votes", async () => {
  const f = await fixture();
  await clearLegacy(f);
  await assess(f);
  await assess(f, f.bId, "review");
  expect(await getGate()).toMatchObject({
    approved: 1,
    rejected: 0,
    reviewed: 1,
    historical: { approved: 1, rejected: 0 },
  });
  await appendLotMatchReview(
    projectDraft(await f.load(), "veto_project"),
    viewer,
  );
  expect(await getGate()).toMatchObject({
    approved: 0,
    rejected: 1,
    reviewed: 1,
    historical: { approved: 1, rejected: 1 },
  });
  const audits = await db
    .select()
    .from(schema.matchLotReviewEvents)
    .orderBy(schema.matchLotReviewEvents.id);
  const rows = await matchRows(f.p.id);
  await db
    .update(schema.companies)
    .set({
      profile: {
        ...f.profile,
        activities: "Profilo nuovo e non ancora revisionato.",
      },
    })
    .where(eq(schema.companies.id, f.companyId));
  expect(await getGate()).toMatchObject({
    approved: 0,
    rejected: 0,
    reviewed: 0,
    unresolved: 2,
    historical: { approved: 1, rejected: 1 },
    allowed: false,
  });
  expect(
    await db
      .select()
      .from(schema.matchLotReviewEvents)
      .orderBy(schema.matchLotReviewEvents.id),
  ).toEqual(audits);
  expect(await matchRows(f.p.id)).toEqual(rows);
  expect(await listOpportunities(await customer(f))).toEqual([]); // the veto remains active.
});

it("explicitly without lots supports a real whole-project assessment, a single Radar card and one current quality vote", async () => {
  const f = await fixture({ withoutLots: true });
  const who = await customer(f);
  const before = await getOpportunity(who, f.p.id);
  expect(before).toMatchObject({
    score: 0,
    assessment: "uncertain",
    lotReview: { shape: "project", lots: [] },
  });
  expect(before!.lotReview!.targets).toHaveLength(1);
  expect(before!.lotReview!.targets[0].target).toEqual(f.project);
  expect(await listOpportunities(who)).toEqual([]);
  const pending = (await adminSnapshot(false)).matches.find(
    (m) => m.publicationId === f.p.id && m.company === f.profile.name,
  );
  expect(pending).toMatchObject({
    approved: null,
    reviewed: false,
    eligible: false,
    lotReviewUrl: `/admin/valutazioni/${f.companyId}/${f.p.id}`,
  });
  expect(await getRadarStatus(who)).toEqual({
    state: "ready",
    pendingCount: 0,
  });
  await appendLotMatchReview(wholeProjectDraft(await f.load()), viewer);
  const cards = await listOpportunities(who);
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({
    score: 100,
    assessment: "reviewed",
    summary: null,
    lotReview: {
      shape: "project",
      lots: [],
      relevantLotIds: [],
      targets: [{ target: f.project, result: "direct" }],
    },
  });
  expect(cards[0].reason).toContain("progetto");
  expect(cards[0].sectors).toContain("giardinaggio");
  expect(JSON.stringify(cards)).not.toMatch(
    /PRIVATE_PROJECT_NOTE|actorId|evidenceSnapshot|lotId/,
  );
  const admin = await adminSnapshot(false);
  const item = admin.matches.find(
    (m) => m.publicationId === f.p.id && m.company === f.profile.name,
  );
  expect(item).toMatchObject({
    approved: true,
    reviewed: true,
    score: 100,
    summary: null,
  });
  expect(await getGate()).toMatchObject({
    reviewed: 1,
    approved: 1,
    rejected: 0,
  });
});

it("unknown shape cannot revive legacy approval; returning project after a lots transition requires new source and company reviews", async () => {
  const unknown = await fixture({ unknownShape: true });
  const uncertain = await getOpportunity(await customer(unknown), unknown.p.id);
  expect(uncertain).toMatchObject({
    score: 0,
    assessment: "uncertain",
    lotReview: { shape: "unresolved", targets: [] },
  });
  expect(await listOpportunities(await customer(unknown))).toEqual([]);
  const f = await fixture({ withoutLots: true });
  const who = await customer(f);
  await appendLotMatchReview(wholeProjectDraft(await f.load()), viewer);
  const history = await db
    .select()
    .from(schema.matchLotReviewEvents)
    .where(eq(schema.matchLotReviewEvents.publicationId, f.p.id));
  const withLots = structuredClone(f.raw);
  withLots.base.lotsType = "with";
  withLots.base.lots = [{ id: f.aId, lotNumber: 1, title: { it: "Verde" } }];
  withLots.lots = [
    {
      id: f.aId,
      lotNumber: 1,
      title: { it: "Verde" },
      orderDescription: { it: aText },
      orderAddress: { countryId: "CH", cantonId: "TI", city: "Lugano" },
      cpvCode: { code: "77310000" },
    },
  ];
  await f.adopt(await f.observe(withLots));
  const lots = await getOpportunity(who, f.p.id);
  expect(lots).toMatchObject({
    score: 0,
    assessment: "uncertain",
    lotReview: { shape: "lots" },
  });
  expect(
    lots!.lotReview!.targets.some(
      (t) => t.target.kind === "project" && t.state === "removed-or-unresolved",
    ),
  ).toBe(true);
  await f.adopt(await f.observe(f.raw));
  const returned = await getOpportunity(who, f.p.id);
  expect(returned).toMatchObject({
    score: 0,
    assessment: "uncertain",
    lotReview: { shape: "project" },
  });
  expect(
    returned!.lotReview!.targets.find((t) => t.target.kind === "project")!
      .state,
  ).not.toBe("current");
  expect(
    await db
      .select()
      .from(schema.matchLotReviewEvents)
      .where(eq(schema.matchLotReviewEvents.publicationId, f.p.id)),
  ).toEqual(history);
});

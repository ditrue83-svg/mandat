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
import {
  SIMAP_ACQUISITION_VERSION,
  type SimapAcquisitionResult,
} from "../src/sources/simap-documentary";
import { preserveSimapLots } from "../src/lib/source-lots";
import { fingerprint } from "../src/sources/common";
import { canonicalFeedbackKey } from "../src/lib/canonical-feedback";
import {
  beginDocumentaryRequest,
  storeDocumentaryObservation,
} from "../src/lib/documentary-store";
import type { LotSourceTarget } from "../src/lib/lot-source-context";
import { LOT_RECONCILIATION_QUEUE } from "../src/lib/lot-reconciliation";
import {
  adoptDocumentaryObservation,
  DOCUMENTARY_ADOPTION_CAPABILITY,
  DOCUMENTARY_ADOPTION_CONSUMERS,
  DOCUMENTARY_RELEASE_ATTESTATION_VERSION,
  type DocumentaryAdoptionActivation,
  type DocumentaryReleaseAttestation,
} from "../src/lib/documentary-adoption";
import { lotNoticeHash, validateLotNotice } from "../src/lib/lot-notice";

const injected = vi.hoisted(() => ({
  db: undefined as unknown,
  sendMail: vi.fn(async (message: { to: string }) => ({
    accepted: [message.to],
  })),
}));
vi.mock("@/db", () => ({ getDb: () => injected.db }));
vi.mock("@/lib/mail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mail")>()),
  sendMail: injected.sendMail,
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
import {
  appendLotSourceReview,
  loadLotSourceReview,
  type LoadedLotSourceReview,
  type LotSourceReviewInput,
} from "../src/lib/lot-source-reviews";
import {
  appendLotMatchReview,
  loadLotMatchReview,
  lotMatchReviewInputSchema,
  lotMatchReviewTarget,
  assessmentReviewTarget,
  type LoadedLotMatchReview,
  type LotMatchReviewInput,
} from "../src/lib/lot-match-reviews";
import {
  claimLotNotification,
  reconcileLotNotices,
} from "../src/worker/lot-notifications";
import {
  queueDigests,
  sendPending,
  queueChangeNotices,
  queueOutstandingChanges,
  reconcileDelivery,
  recoverUncertainDeliveries,
} from "../src/worker/notifications";

// Invented source and company data, real local migrations + pg-boss producer.
// No provider, real SMTP, HTTP, live DB or two-backend concurrency.
// New project fixtures exercise the real adopter only against local PGlite.
const pg = new PGlite();
const db = drizzle(pg, { schema });
const boss = new PgBoss({
  db: fromPglite(pg),
  backend: "pglite",
  schema: "pgboss",
  schedule: false,
  supervise: false,
});
const viewer = { userId: "lot-match-founder", admin: true, demo: false };
const commonText =
  "Progetto inventato suddiviso in due lotti indipendenti per il test.";
const aText = "🌳 Potatura e cura del verde nel lotto A inventato.";
const bText = "Installazione di quadri elettrici nel lotto B inventato.";
function activation(): DocumentaryAdoptionActivation {
  return {
    enabled: true,
    attestation: {
      version: DOCUMENTARY_RELEASE_ATTESTATION_VERSION,
      releaseId: "invented-no-lots-repository-release",
      verifiedAt: new Date().toISOString(),
      evidenceId: "invented-local-only-no-rollout",
      previousProcessesDrained: true,
      consumers: Object.fromEntries(
        DOCUMENTARY_ADOPTION_CONSUMERS.map((name) => [
          name,
          {
            capability: DOCUMENTARY_ADOPTION_CAPABILITY,
            buildId: "a".repeat(40),
          },
        ]),
      ) as DocumentaryReleaseAttestation["consumers"],
    },
  };
}
beforeAll(async () => {
  injected.db = db;
  vi.stubEnv("APP_URL", "https://mandat.test.invalid");
  vi.stubEnv("APP_MODE", "live");
  vi.stubEnv("FOGLIO_REUSE_CONFIRMED", "false");
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
afterAll(async () => {
  await boss.stop();
  await pg.close();
});
beforeEach(async () => {
  injected.sendMail.mockReset();
  injected.sendMail.mockImplementation(async (message: { to: string }) => ({
    accepted: [message.to],
  }));
  await db.update(schema.companies).set({ disabledAt: new Date() });
  await db.update(schema.issues).set({ resolvedAt: new Date() });
  await db
    .update(schema.notifications)
    .set({ status: "cancelled" })
    .where(eq(schema.notifications.status, "pending"));
  await db
    .insert(schema.settings)
    .values({ key: "automation_enabled", value: false })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: false } });
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
    expectedSelectionHash: loaded.expected.selectionHash,
    expectedTargetEventId: loaded.expected.targetEventId,
    expectedProjectBarrierHash: loaded.expected.projectBarrierHash,
    expectedShapeEpochToken: loaded.expected.shapeEpochToken,
    action: "recorded",
    form:
      target.kind === "project" && loaded.shapeState.shape.kind === "lots"
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
    noLots?: boolean;
    realAdoption?: boolean;
    reviewSource?: boolean;
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
    procurement: {
      orderDescription: {
        it: options.noLots
          ? "Potatura e cura del verde per il progetto inventato senza lotti."
          : commonText,
      },
      orderAddress: { countryId: "CH", cantonId: "TI", city: "Lugano" },
      cpvCode: { code: "77310000" },
    },
    dates: { processType: "open", offerDeadline: "2030-11-04T12:00:00+01:00" },
    base: {
      id: noticeId,
      projectId,
      lotsType: "with",
      processType: "open",
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
  if (options.noLots) {
    raw.lots = [];
    raw.base.lots = [];
    raw.base.lotsType = "without";
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
      await db.insert(schema.companies).values({
        id,
        ownerId: id,
        profile: companyProfile,
        onboardedAt: new Date(),
      });
      await db.insert(schema.invitations).values({
        id: randomUUID(),
        companyId: id,
        email: `${id}@example.invalid`,
        expiresAt: new Date("2035-01-01T00:00:00Z"),
        acceptedAt: new Date(),
        acceptedVersion: "test-acceptance-v1",
      });
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
    return { stored, publication, request, result };
  }
  const observation = await observe();
  const adopt = async (value = observation) => {
    if (options.realAdoption)
      return adoptDocumentaryObservation(
        value.request,
        value.result,
        activation(),
      );
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
    for (const target of options.reviewSource === false
      ? []
      : options.noLots
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
  lotId: string | null,
  result: "direct" | "different" | "review" = "direct",
): LotMatchReviewInput {
  const selected =
    lotId === null
      ? assessmentReviewTarget(loaded, {
          kind: "project",
          publicationId: loaded.publication.id,
        })
      : lotMatchReviewTarget(loaded, lotId);
  const content = selected.context.targetContent!;
  const value = (
    (selected.target.kind === "project"
      ? content.projectSections.procurement
      : content.selectedLot!.record) as { orderDescription: { it: string } }
  ).orderDescription.it;
  return lotMatchReviewInputSchema.parse({
    companyId: loaded.company.id,
    publicationId: loaded.publication.id,
    action: lotId === null ? "assess_project" : "assess_lot",
    target: selected.target,
    expectedSnapshotHash: selected.expected.snapshotHash,
    expectedProfileHash: selected.expected.profileHash,
    expectedStateToken: selected.expected.stateToken,
    expectedGroupToken: selected.expected.groupToken,
    expectedShapeEpochToken: selected.expected.shapeEpochToken!,
    expectedSourceDependency: selected.expected.sourceDependency,
    expectedOperationalInputHash: selected.expected.operationalInputHash,
    expectedEvaluationSetToken: selected.expected.evaluationSetToken,
    expectedEntryHash: selected.expected.entryHash,
    result,
    reason: `Interesse potenziale inventato ${result} per il lotto selezionato.`,
    references: [
      {
        selectionHash: selected.context.dependency.selectionHash!,
        rawPath:
          selected.target.kind === "project"
            ? "/procurement/orderDescription/it"
            : `${content.selectedLot!.path}/orderDescription/it`,
        startUtf16: 0,
        endUtf16: value.length,
      },
    ],
    confirmedReviewReasons:
      result === "direct" ? [...selected.preliminary.reviewReasons] : [],
    note: "PRIVATE_MATCH_NOTE: verificati i limiti operativi senza attestare idoneità.",
  });
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
    expectedProfileHash: loaded.expected.profileHash,
    expectedStateToken: loaded.expected.stateToken,
    expectedGroupToken: loaded.expected.groupToken,
    expectedShapeEpochToken: loaded.expected.shapeEpochToken,
    expectedProjectBindingHash: loaded.expected.projectBindingHash,
    note: "Revisione esplicita inventata della soppressione del progetto.",
  };
}
async function matchRow(companyId: string, publicationId: string) {
  return (
    await db
      .select()
      .from(schema.matches)
      .where(
        and(
          eq(schema.matches.companyId, companyId),
          eq(schema.matches.publicationId, publicationId),
        ),
      )
  )[0];
}
async function auditRows(matchId: string) {
  return db
    .select()
    .from(schema.matchLotReviewEvents)
    .where(eq(schema.matchLotReviewEvents.matchId, matchId))
    .orderBy(schema.matchLotReviewEvents.sequence);
}
async function jobs(publicationId: string) {
  return (
    await pg.query<{
      id: string;
      data: { publicationId: string; canonicalId: string; eventId: string };
    }>(
      "SELECT id,data FROM pgboss.job WHERE name=$1 AND data->>'publicationId'=$2 ORDER BY id",
      [LOT_RECONCILIATION_QUEUE, publicationId],
    )
  ).rows;
}

const digestNow = new Date("2030-01-01T10:00:00.000Z");
async function rows(companyId: string) {
  return db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.companyId, companyId))
    .orderBy(schema.notifications.createdAt, schema.notifications.id);
}
async function approve(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string | null = f.aId,
  result: "direct" | "different" | "review" = "direct",
) {
  return appendLotMatchReview(
    assessmentDraft(await f.load(), id, result),
    viewer,
  );
}
async function prepare(f: Awaited<ReturnType<typeof fixture>>) {
  await reconcileLotNotices({
    companyId: f.companyId,
    now: digestNow,
    includeFirstDigest: true,
  });
  return rows(f.companyId);
}
async function freshSources() {
  await db.insert(schema.sourceRuns).values({
    id: randomUUID(),
    source: "simap",
    status: "success",
    finishedAt: digestNow,
  });
}
async function markSent(id: string) {
  await db
    .update(schema.notifications)
    .set({ status: "sent", sentAt: new Date() })
    .where(eq(schema.notifications.id, id));
}

it("initial adoption without evaluations or messages avoids global source locks; a later review still creates the digest", async () => {
  const f = await fixture();
  const transaction = vi.spyOn(db, "transaction");
  try {
    expect(await prepare(f)).toHaveLength(0);
    expect(transaction).not.toHaveBeenCalled();
  } finally {
    transaction.mockRestore();
  }
  await approve(f);
  expect(await prepare(f)).toHaveLength(1);
});

it("notification history is reconciled even when no company evaluation remains", async () => {
  const f = await fixture();
  await approve(f);
  const [pending] = await prepare(f);
  await db.update(schema.matches).set({ lotEvaluations: null })
    .where(eq(schema.matches.companyId, f.companyId));
  await reconcileLotNotices({ companyId: f.companyId, now: digestNow });
  expect((await rows(f.companyId)).find(n => n.id === pending.id)?.status)
    .toBe("cancelled");
});

it("adopted lots enter the real digest despite legacy eligible=false, and a legacy positive alone cannot enter", async () => {
  const f = await fixture();
  await freshSources();
  await queueDigests(digestNow);
  expect(await rows(f.companyId)).toHaveLength(0);
  await approve(f);
  await db
    .update(schema.matches)
    .set({ eligible: false, score: 0 })
    .where(eq(schema.matches.id, `${f.companyId}-${f.p.id}`));
  await queueDigests(digestNow);
  const [notice] = await rows(f.companyId);
  expect(notice.kind).toBe("digest");
  expect(notice.items).toHaveLength(1);
  expect(
    notice.items[0].lotNotice?.scope.map((s) =>
      s.target.kind === "lot" ? s.target.lotId : null,
    ),
  ).toEqual([f.aId]);
  expect(notice.textBody).toContain("Interesse potenziale");
  expect(notice.textBody).toContain("Lotto 1");
  expect(notice.textBody).not.toContain("PRIVATE_MATCH_NOTE");
  expect(notice.textBody).not.toContain("lot-match-founder");
  expect(notice.items[0].lotNotice?.renderSnapshot.publicationId).toBe(f.p.id);
  expect(notice.items[0].lotNotice?.scope[0].immutableEvidenceSnapshotId).toBe(
    f.observation.stored.id,
  );
  expect(
    notice.items[0].lotNotice?.scope[0].render.operational.deadline,
  ).toBeNull();
  await sendPending();
  expect(injected.sendMail).toHaveBeenCalledTimes(1);
  expect((await rows(f.companyId))[0].status).toBe("sent");
});

it("one company/day digest combines v1 and lot items and each project occurs only once", async () => {
  const f = await fixture();
  await approve(f);
  const id = `legacy-${randomUUID()}`,
    p = {
      ...f.p,
      id,
      externalId: id,
      projectId: undefined,
      canonicalKey: id,
      revision: "legacy-fixture-v1",
      deadline: "2035-01-01T10:00:00Z",
      originalText: "Potatura del verde: servizi inventati",
      reviewRequired: false,
      reviewReasons: [],
    };
  await db.insert(schema.publications).values({
    id,
    canonicalId: id,
    source: "simap",
    externalId: id,
    title: "Progetto legacy inventato",
    status: "open",
    visibleAt: new Date("2026-09-01T08:00:00Z"),
    data: p,
    revision: p.revision,
    aiRevision: p.revision,
  });
  await db.insert(schema.matches).values({
    id: randomUUID(),
    companyId: f.companyId,
    publicationId: id,
    revision: `${p.revision}:${fingerprint((await f.load()).company.profile)}:ready:fixture:true`,
    score: 90,
    reason: "Approvazione legacy inventata",
    eligible: true,
    approved: true,
    reviewedAt: new Date(),
  });
  await freshSources();
  await queueDigests(digestNow);
  await queueDigests(digestNow);
  const noticeRows = await rows(f.companyId);
  expect(noticeRows).toHaveLength(1);
  expect(noticeRows[0].items).toHaveLength(2);
  expect(noticeRows[0].items.filter((i) => !!i.lotNotice)).toHaveLength(1);
  expect(new Set(noticeRows[0].items.map((i) => i.id)).size).toBe(2);
  expect(noticeRows[0].textBody).toContain("Lotto 1");
  expect(noticeRows[0].textBody).toContain("Pertinenza revisionata");
  expect(noticeRows[0].textBody).not.toContain("Approvazione legacy inventata");
  // Rebuilding a stale lot item retains the still-current legacy project.
  await approve(f, f.bId);
  await queueDigests(digestNow);
  const rebuilt = (await rows(f.companyId))[0];
  expect(rebuilt.id).toBe(noticeRows[0].id);
  expect(rebuilt.items).toHaveLength(2);
  expect(rebuilt.items.find((i) => i.lotNotice)?.lotNotice?.scope).toHaveLength(
    2,
  );
  expect(await claimLotNotification(rebuilt.id, digestNow)).not.toBeNull();
});

it("sent A then a new approval of B in the same notice produces one B update, independent of review actor/time", async () => {
  const f = await fixture();
  await approve(f);
  const [first] = await prepare(f);
  await markSent(first.id);
  await approve(f, f.bId);
  await reconcileLotNotices({ companyId: f.companyId, now: digestNow });
  let noticeRows = await rows(f.companyId);
  expect(noticeRows).toHaveLength(2);
  const change = noticeRows.find((r) => r.kind === "change")!;
  expect(
    change.items[0].lotNotice?.scope.map((s) =>
      s.target.kind === "lot" ? s.target.lotId : null,
    ),
  ).toEqual([f.bId]);
  expect(change.dedupeKey).toMatch(/^lot-change-v1:/);
  await approve(f, f.bId);
  await reconcileLotNotices({ companyId: f.companyId, now: digestNow });
  noticeRows = await rows(f.companyId);
  expect(noticeRows).toHaveLength(2);
  expect(noticeRows.find((r) => r.kind === "change")!.id).toBe(change.id);
  await markSent(change.id);
  await approve(f, f.bId);
  await queueOutstandingChanges(f.companyId);
  expect(await rows(f.companyId)).toHaveLength(2);
});

it("pending, sending, uncertain and failed communications reserve B and do not authorize another copy", async () => {
  const f = await fixture();
  await approve(f);
  const [first] = await prepare(f);
  await markSent(first.id);
  await approve(f, f.bId);
  await reconcileLotNotices({ companyId: f.companyId, now: digestNow });
  const change = (await rows(f.companyId)).find((r) => r.kind === "change")!;
  for (const status of ["pending", "sending", "uncertain", "failed"]) {
    await db
      .update(schema.notifications)
      .set({ status })
      .where(eq(schema.notifications.id, change.id));
    await approve(f, f.bId);
    await reconcileLotNotices({ companyId: f.companyId, now: digestNow });
    expect(await rows(f.companyId)).toHaveLength(2);
    expect(
      (await rows(f.companyId)).find((r) => r.id === change.id)!.status,
    ).toBe(status);
  }
});

it("changing only B does not notify a recipient of A; changing A uses archived notice evidence without publicationVersions", async () => {
  const f = await fixture();
  await approve(f);
  const [first] = await prepare(f);
  await markSent(first.id);
  const bChanged = structuredClone(f.raw);
  bChanged.lots[1].orderDescription.it += " Solo B cambia.";
  await f.adopt(await f.observe(bChanged));
  await queueOutstandingChanges(f.companyId);
  expect(await rows(f.companyId)).toHaveLength(1);
  const aChanged = structuredClone(bChanged);
  aChanged.lots[0].orderDescription.it += " A ora include nuovi lavori.";
  await f.adopt(await f.observe(aChanged));
  await queueOutstandingChanges(f.companyId);
  const change = (await rows(f.companyId)).find((r) => r.kind === "change")!;
  expect(change.items[0].lotNotice?.scope[0].kind).toBe("changed");
  expect(change.textBody).toContain("La precedente valutazione non ne attesta");
  expect(await claimLotNotification(change.id, digestNow)).not.toBeNull();
  await markSent(change.id);
  const next = structuredClone(aChanged);
  next.lots[0].orderDescription.it += " Un’altra modifica di A.";
  await f.adopt(await f.observe(next));
  await queueOutstandingChanges(f.companyId);
  expect(
    (await rows(f.companyId)).filter((r) => r.kind === "change"),
  ).toHaveLength(2);
  expect(
    await db
      .select()
      .from(schema.publicationVersions)
      .where(eq(schema.publicationVersions.publicationId, f.p.id)),
  ).toHaveLength(0);
});

it("shared cancellation is an explicit source update, while a refused observation yields no invented update", async () => {
  const f = await fixture();
  await approve(f);
  const [first] = await prepare(f);
  await markSent(first.id);
  const cancelled = { ...f.p, status: "cancelled" as const };
  await db
    .update(schema.publications)
    .set({ status: "cancelled", data: cancelled })
    .where(eq(schema.publications.id, f.p.id));
  await db.insert(schema.issues).values({
    id: randomUUID(),
    key: `unrelated-${randomUUID()}`,
    title: "Criticità estranea",
    detail: "Inventata per verificare la rettifica",
    severity: "critical",
  });
  await queueChangeNotices(f.p, cancelled, f.companyId);
  const change = (await rows(f.companyId)).find((r) => r.kind === "change")!;
  expect(change.textBody).toContain("Stato della pubblicazione: annullato");
  expect(change.items[0].lotNotice?.scope[0].kind).toBe("changed");
  expect(await claimLotNotification(change.id, digestNow)).not.toBeNull();
  await db
    .update(schema.notifications)
    .set({ status: "pending" })
    .where(eq(schema.notifications.id, change.id));
  await f.adopt(await f.observe(f.raw, true));
  expect(await claimLotNotification(change.id)).toBeNull();
  await queueOutstandingChanges(f.companyId);
  expect(
    (await rows(f.companyId)).filter((r) => r.status === "pending"),
  ).toHaveLength(0);
});

it("communicated transitions X → Y → X are distinct despite reversed UUID order, while X → X and a stale predecessor cannot send", async () => {
  const f = await fixture();
  await approve(f);
  const [preparedX] = await prepare(f);
  const xId = "ffffffff-ffff-4fff-afff-fffffffffff1";
  await db
    .update(schema.notifications)
    .set({
      id: xId,
      status: "sent",
      sentAt: new Date("2030-01-01T10:00:00Z"),
      createdAt: new Date("2030-01-01T09:59:59Z"),
    })
    .where(eq(schema.notifications.id, preparedX.id));
  const originalX = preparedX.items[0].lotNotice!.scope[0];
  const rawY = structuredClone(f.raw);
  rawY.lots[0].orderDescription.it +=
    " Testo Y: nuova attività documentaria inventata.";
  await f.adopt(await f.observe(rawY));
  await queueOutstandingChanges(f.companyId);
  const y = (await rows(f.companyId)).find((row) => row.kind === "change")!;
  expect(y.items[0].lotNotice!.scope[0].transition.predecessor).toBe(
    originalX.transition.hash,
  );
  expect(await claimLotNotification(y.id, digestNow)).not.toBeNull();
  const yId = "00000000-0000-4000-a000-000000000001";
  await db
    .update(schema.notifications)
    .set({
      id: yId,
      status: "sent",
      sentAt: new Date("2030-01-01T10:10:00Z"),
      createdAt: new Date("2030-01-01T09:00:00Z"),
    })
    .where(eq(schema.notifications.id, y.id));
  // Same source/profile/render as the successful Y, but this delayed copy still
  // claims X as predecessor. Only the delivery-chain check makes it stale.
  const staleId = randomUUID();
  await db.insert(schema.notifications).values({
    ...y,
    id: staleId,
    dedupeKey: `stale-predecessor:${staleId}`,
    status: "pending",
    sentAt: null,
  });
  expect(await claimLotNotification(staleId, digestNow)).toBeNull();
  expect(
    (await rows(f.companyId)).find((row) => row.id === staleId)?.status,
  ).toBe("cancelled");
  await f.adopt(await f.observe(f.raw));
  await queueOutstandingChanges(f.companyId);
  const returnedX = (await rows(f.companyId)).find(
    (row) => row.status === "pending",
  )!;
  expect(returnedX).toBeDefined();
  const returnedScope = returnedX.items[0].lotNotice!.scope[0];
  expect(returnedScope.factHash).toBe(originalX.factHash);
  expect(returnedScope.transition.hash).not.toBe(originalX.transition.hash);
  expect(returnedScope.transition.predecessor).toBe(
    y.items[0].lotNotice!.scope[0].transition.hash,
  );
  expect(returnedX.dedupeKey).not.toBe(y.dedupeKey);
  expect(await claimLotNotification(returnedX.id, digestNow)).not.toBeNull();
  await db
    .update(schema.notifications)
    .set({ status: "sent", sentAt: new Date("2030-01-01T10:20:00Z") })
    .where(eq(schema.notifications.id, returnedX.id));
  await queueOutstandingChanges(f.companyId);
  await approve(f);
  await queueOutstandingChanges(f.companyId);
  expect(
    (await rows(f.companyId)).filter((row) => row.status === "pending"),
  ).toHaveLength(0);
  expect(
    (await rows(f.companyId)).filter((row) => row.status === "sent"),
  ).toHaveLength(3);
});

it("an unresolved delivery reserves the target even after its documentary facts change again", async () => {
  const f = await fixture();
  await approve(f);
  const [x] = await prepare(f);
  await markSent(x.id);
  const y = structuredClone(f.raw);
  y.lots[0].orderDescription.it += " Variante Y inventata.";
  await f.adopt(await f.observe(y));
  await queueOutstandingChanges(f.companyId);
  const update = (await rows(f.companyId)).find(
    (row) => row.kind === "change",
  )!;
  await db
    .update(schema.notifications)
    .set({ status: "uncertain" })
    .where(eq(schema.notifications.id, update.id));
  const z = structuredClone(y);
  z.lots[0].orderDescription.it += " Successiva variante Z inventata.";
  await f.adopt(await f.observe(z));
  await queueOutstandingChanges(f.companyId);
  expect(await rows(f.companyId)).toHaveLength(2);
  expect(
    (await rows(f.companyId)).filter((row) => row.status === "pending"),
  ).toHaveLength(0);
});

it("notification novelty follows displayed original facts, while hidden metadata only invalidates the assessment binding", async () => {
  const f = await fixture();
  await approve(f);
  const [first] = await prepare(f);
  await markSent(first.id);
  const metadata = {
    ...structuredClone(f.raw),
    internalUninterpretedMetadata: { counter: 2 },
  };
  await f.adopt(await f.observe(metadata));
  expect((await f.load()).project.signalEligible).toBe(false);
  await queueOutstandingChanges(f.companyId);
  expect(await rows(f.companyId)).toHaveLength(1);
  const shared = structuredClone(metadata);
  shared.procurement.orderDescription.it =
    "Descrizione condivisa rettificata, inventata e mostrata nell’avviso.";
  await f.adopt(await f.observe(shared));
  await queueOutstandingChanges(f.companyId);
  const change = (await rows(f.companyId)).find((r) => r.kind === "change")!;
  expect(change.textBody).toContain(shared.procurement.orderDescription.it);
  expect(
    change.items[0].lotNotice?.scope[0].render.sharedTexts.some(
      (s) =>
        s.rawPath === "/procurement/orderDescription/it" &&
        s.value === shared.procurement.orderDescription.it,
    ),
  ).toBe(true);
  expect(change.items[0].lotNotice?.scope[0].kind).toBe("changed");
  expect(await claimLotNotification(change.id, digestNow)).not.toBeNull();
});

it("a removed reported lot remains an explicit source update without exposing an identifier or inventing cancellation", async () => {
  const f = await fixture();
  await approve(f);
  const [first] = await prepare(f);
  await markSent(first.id);
  const next = structuredClone(f.raw);
  next.base.lots = next.base.lots.slice(1);
  next.lots = next.lots.slice(1);
  await f.adopt(await f.observe(next));
  await queueOutstandingChanges(f.companyId);
  const change = (await rows(f.companyId)).find((r) => r.kind === "change")!;
  expect(change.items[0].lotNotice?.scope[0].kind).toBe("removed");
  expect(change.textBody).toContain("Lotto precedentemente segnalato");
  expect(change.textBody).toContain("senza dedurne un annullamento");
  expect(change.textBody).not.toContain(f.aId);
  expect(await claimLotNotification(change.id, digestNow)).not.toBeNull();
});

it("claim rereads current profile, manual veto, canonical dismissal and automation and cannot silently substitute B for A", async () => {
  const f = await fixture();
  await approve(f);
  const [first] = await prepare(f);
  await approve(f, f.aId, "different");
  await approve(f, f.bId);
  expect(await claimLotNotification(first.id, digestNow)).toBeNull();
  const cancelled = (await rows(f.companyId))[0];
  expect(cancelled.status).toBe("cancelled");
  expect(
    cancelled.items[0].lotNotice?.scope.map((s) =>
      s.target.kind === "lot" ? s.target.lotId : null,
    ),
  ).toEqual([f.aId]);
  const [second] = await prepare(f);
  await db
    .update(schema.companies)
    .set({
      profile: {
        ...f.profile,
        activities: "Attività cambiate dopo la preparazione",
      },
    })
    .where(eq(schema.companies.id, f.companyId));
  expect(await claimLotNotification(second.id, digestNow)).toBeNull();
  await db
    .update(schema.companies)
    .set({ profile: f.profile })
    .where(eq(schema.companies.id, f.companyId));
  const [third] = await prepare(f);
  await appendLotMatchReview(
    projectDraft(await f.load(), "veto_project"),
    viewer,
  );
  expect(await claimLotNotification(third.id, digestNow)).toBeNull();
  await appendLotMatchReview(
    projectDraft(await f.load(), "reopen_project"),
    viewer,
  );
  const [fourth] = await prepare(f);
  const copy = await fixture({
    canonicalId: f.p.id,
    reuseCompanies: f,
    adopt: false,
  });
  await db.insert(schema.feedback).values({
    id: randomUUID(),
    companyId: f.companyId,
    publicationId: copy.p.id,
    dismissed: true,
    saved: false,
  });
  expect(await claimLotNotification(fourth.id, digestNow)).toBeNull();
  // A deliberate canonical reopening prevails over old true flags on copies.
  await db.insert(schema.settings).values({
    key: canonicalFeedbackKey(f.companyId, f.p.id),
    value: {
      version: "canonical-company-feedback-v1",
      companyId: f.companyId,
      canonicalId: f.p.id,
      saved: false,
      dismissed: false,
      updatedAt: new Date().toISOString(),
    },
  });
  const [fifth] = await prepare(f);
  await db
    .update(schema.settings)
    .set({ value: true })
    .where(eq(schema.settings.key, "automation_enabled"));
  expect(await claimLotNotification(fifth.id, digestNow)).toBeNull();
});

it("adopted representative without a match prevents fallback to a positive legacy copy at preparation and claim", async () => {
  const f = await fixture();
  await approve(f);
  const [first] = await prepare(f);
  const copy = await fixture({ canonicalId: f.p.id, reuseCompanies: f });
  await db
    .delete(schema.matches)
    .where(
      and(
        eq(schema.matches.companyId, f.companyId),
        eq(schema.matches.publicationId, copy.p.id),
      ),
    );
  await db
    .update(schema.publications)
    .set({ updatedAt: new Date("2031-01-01T00:00:00Z") })
    .where(eq(schema.publications.id, copy.p.id));
  expect(await claimLotNotification(first.id, digestNow)).toBeNull();
  await prepare(f);
  expect(
    (await rows(f.companyId)).filter((r) => r.status === "pending"),
  ).toHaveLength(0);
});

it("missing historical archive is explicit and stops claim instead of replacing it with the current archive", async () => {
  const f = await fixture();
  await approve(f);
  const [first] = await prepare(f);
  const items = structuredClone(first.items);
  items[0].lotNotice!.scope[0].immutableEvidenceSnapshotId = randomUUID();
  await db
    .update(schema.notifications)
    .set({ items })
    .where(eq(schema.notifications.id, first.id));
  expect(await claimLotNotification(first.id, digestNow)).toBeNull();
  const found = await db
    .select()
    .from(schema.issues)
    .where(
      eq(schema.issues.key, `lot-notice-history:${f.companyId}:${f.p.id}`),
    );
  expect(found).toHaveLength(1);
  expect(found[0].severity).toBe("critical");
});

it("a committed review/job survives interruption before reconciliation and an outbox SQL failure rolls back preparation", async () => {
  const f = await fixture(),
    beforeJobs = await jobs(f.p.id);
  const approved = await approve(f);
  expect(await rows(f.companyId)).toHaveLength(0);
  const queued = await jobs(f.p.id);
  expect(queued).toHaveLength(beforeJobs.length + 1);
  expect(
    queued.some((job) => job.data.eventId === approved.history.at(-1)!.id),
  ).toBe(true);
  await pg.exec(
    "ALTER TABLE notifications ADD CONSTRAINT test_reject_lot_digest CHECK (kind <> 'digest') NOT VALID",
  );
  let failure: unknown;
  try {
    await prepare(f);
  } catch (error) {
    failure = error;
  } finally {
    await pg.exec(
      "ALTER TABLE notifications DROP CONSTRAINT test_reject_lot_digest",
    );
  }
  const causes: { constraint?: string; cause?: unknown }[] = [];
  for (
    let error = failure;
    error && typeof error === "object";
    error = (error as { cause?: unknown }).cause
  )
    causes.push(error);
  expect(causes.some((e) => e.constraint === "test_reject_lot_digest")).toBe(
    true,
  );
  expect(await rows(f.companyId)).toHaveLength(0);
  expect((await f.load()).state.evaluations).toEqual(
    approved.state.evaluations,
  );
  const recovered = await prepare(f);
  expect(recovered).toHaveLength(1);
  await prepare(f);
  expect(await rows(f.companyId)).toHaveLength(1);
});

it("SMTP uncertainty is reserved, never blindly retried, and explicit reconciliation keeps the same message identity", async () => {
  const f = await fixture();
  await approve(f);
  const [first] = await prepare(f);
  injected.sendMail.mockRejectedValueOnce(
    Object.assign(new Error("Connection lost after DATA"), {
      code: "ESOCKET",
      command: "DATA",
    }),
  );
  await sendPending();
  expect((await rows(f.companyId))[0].status).toBe("uncertain");
  expect(injected.sendMail).toHaveBeenCalledTimes(1);
  await sendPending();
  expect(injected.sendMail).toHaveBeenCalledTimes(1);
  await reconcileDelivery(
    first.id,
    "retry",
    "Registro SMTP verificato: nessuna accettazione",
    viewer.userId,
  );
  await sendPending();
  expect(injected.sendMail).toHaveBeenCalledTimes(2);
  expect((await rows(f.companyId))[0].status).toBe("sent");
  expect(injected.sendMail.mock.calls[0][0]).toMatchObject({
    messageId: `<${first.id}@mandat.test.invalid>`,
  });
  expect(injected.sendMail.mock.calls[1][0]).toMatchObject({
    messageId: `<${first.id}@mandat.test.invalid>`,
  });
  await db
    .update(schema.notifications)
    .set({ status: "sending" })
    .where(eq(schema.notifications.id, first.id));
  await recoverUncertainDeliveries();
  expect((await rows(f.companyId))[0].status).toBe("uncertain");
  await sendPending();
  expect(injected.sendMail).toHaveBeenCalledTimes(2);
});

function lotShape(f: Awaited<ReturnType<typeof fixture>>) {
  const raw = structuredClone(f.raw);
  raw.base.lotsType = "with";
  raw.base.lots = [{ id: f.aId, lotNumber: 1, title: { it: "Verde" } }];
  raw.lots = [
    {
      id: f.aId,
      lotNumber: 1,
      title: { it: "Verde" },
      orderDescription: { it: aText },
      orderAddress: { countryId: "CH", cantonId: "TI", city: "Lugano" },
      cpvCode: { code: "77310000" },
    },
  ];
  return raw;
}
async function reviewCurrentProject(f: Awaited<ReturnType<typeof fixture>>) {
  await appendLotSourceReview(
    sourceDraft(await loadLotSourceReview(f.project, viewer)),
    viewer,
  );
}

it("an explicitly lot-free project reaches digest and claim through sendPending with only mocked SMTP", async () => {
  const f = await fixture({ noLots: true, realAdoption: true });
  await freshSources();
  await queueDigests(digestNow);
  expect(await rows(f.companyId)).toHaveLength(0);
  await approve(f, null);
  await queueDigests(digestNow);
  const [notice] = await rows(f.companyId);
  expect(notice.kind).toBe("digest");
  expect(notice.items).toHaveLength(1);
  expect(notice.items[0].lotNotice?.version).toBe("lot-notice-v2");
  expect(notice.items[0].lotNotice?.scope.map((s) => s.target)).toEqual([
    f.project,
  ]);
  expect(notice.items[0].lotNotice?.scope[0].render.lotId).toBeNull();
  expect(notice.items[0].lotNotice?.scope[0].render.operational.deadline).toBe(
    "2030-11-04T11:00:00.000Z",
  );
  expect(notice.textBody).not.toContain("Lotto 0");
  expect(notice.textBody).not.toContain("PRIVATE_MATCH_NOTE");
  expect(notice.textBody).not.toContain(viewer.userId);
  await sendPending();
  expect(injected.sendMail).toHaveBeenCalledTimes(1);
  expect((await rows(f.companyId))[0].status).toBe("sent");
  await queueDigests(digestNow);
  await sendPending();
  expect(injected.sendMail).toHaveBeenCalledTimes(1);
});

it("project different/review/source doubt prevent first alerts and a new source doubt invalidates a pending positive claim", async () => {
  const f = await fixture({ noLots: true, realAdoption: true });
  await approve(f, null, "different");
  expect(await prepare(f)).toHaveLength(0);
  await approve(f, null, "review");
  expect(await prepare(f)).toHaveLength(0);
  await approve(f, null);
  const [pending] = await prepare(f);
  const source = await loadLotSourceReview(f.project, viewer);
  await appendLotSourceReview(
    { ...sourceDraft(source), action: "opened", form: null, references: [] },
    viewer,
  );
  expect(await claimLotNotification(pending.id, digestNow)).toBeNull();
  expect(
    (await rows(f.companyId)).find((r) => r.id === pending.id)?.status,
  ).toBe("cancelled");
  await sendPending();
  expect(injected.sendMail).not.toHaveBeenCalled();
});

it("a pending project positive is cancelled on adoption of lots and cannot become an update before any communication", async () => {
  const f = await fixture({ noLots: true, realAdoption: true });
  await approve(f, null);
  const [pending] = await prepare(f);
  await f.adopt(await f.observe(lotShape(f)));
  expect((await f.load()).project.signalEligible).toBe(false);
  expect(await claimLotNotification(pending.id, digestNow)).toBeNull();
  await reconcileLotNotices({
    companyId: f.companyId,
    now: digestNow,
    includeFirstDigest: true,
  });
  expect(
    (await rows(f.companyId)).filter((r) => r.status === "pending"),
  ).toHaveLength(0);
  expect(
    (await rows(f.companyId)).filter((r) => r.kind === "change"),
  ).toHaveLength(0);
});

it("sent project to lots to project gives one structure update per communicated transition and a distinct new positive only after review", async () => {
  const f = await fixture({ noLots: true, realAdoption: true });
  await approve(f, null);
  const [first] = await prepare(f);
  await markSent(first.id);
  await f.adopt(await f.observe(lotShape(f)));
  await reconcileLotNotices({ companyId: f.companyId, now: digestNow });
  const firstChange = (await rows(f.companyId)).find(
    (r) => r.kind === "change",
  )!;
  expect(firstChange.items[0].lotNotice?.scope).toHaveLength(1);
  expect(firstChange.items[0].lotNotice?.scope[0].kind).toBe(
    "structure_changed",
  );
  expect(firstChange.items[0].lotNotice?.scope[0].target).toEqual(f.project);
  expect(firstChange.textBody).not.toContain("annullato");
  expect(firstChange.items[0].lotNotice?.scope[0].evaluationId).toBeNull();
  await reconcileLotNotices({ companyId: f.companyId, now: digestNow });
  expect(
    (await rows(f.companyId)).filter((r) => r.kind === "change"),
  ).toHaveLength(1);
  expect(await claimLotNotification(firstChange.id, digestNow)).not.toBeNull();
  await markSent(firstChange.id);
  await f.adopt(await f.observe(f.raw));
  expect((await f.load()).project.signalEligible).toBe(false);
  await reconcileLotNotices({ companyId: f.companyId, now: digestNow });
  const returnChange = (await rows(f.companyId)).find(
    (r) => r.kind === "change" && r.id !== firstChange.id,
  )!;
  expect(returnChange.items[0].lotNotice?.scope[0].kind).toBe(
    "structure_changed",
  );
  expect(returnChange.items[0].lotNotice?.scope[0].evaluationId).toBeNull();
  expect(await claimLotNotification(returnChange.id, digestNow)).not.toBeNull();
  await markSent(returnChange.id);
  await reviewCurrentProject(f);
  await approve(f, null);
  await reconcileLotNotices({ companyId: f.companyId, now: digestNow });
  const positive = (await rows(f.companyId)).filter(
    (r) => r.status === "pending",
  );
  expect(positive).toHaveLength(1);
  expect(positive[0].items[0].lotNotice?.scope[0].kind).toBe("positive");
  await markSent(positive[0].id);
  await approve(f, null);
  await reconcileLotNotices({ companyId: f.companyId, now: digestNow });
  expect(
    (await rows(f.companyId)).filter((r) => r.status === "pending"),
  ).toHaveLength(0);
});

it("an uncommunicated shape roundtrip and fresh approval do not resend identical project facts for epoch alone", async () => {
  const f = await fixture({ noLots: true, realAdoption: true });
  await approve(f, null);
  const before = await f.load();
  const [first] = await prepare(f);
  await markSent(first.id);
  await f.adopt(await f.observe(lotShape(f)));
  await f.adopt(await f.observe(f.raw));
  expect((await f.load()).shapeState.epochToken).not.toBe(
    before.shapeState.epochToken,
  );
  expect((await f.load()).project.signalEligible).toBe(false);
  await reviewCurrentProject(f);
  await approve(f, null);
  await reconcileLotNotices({ companyId: f.companyId, now: digestNow });
  expect(await rows(f.companyId)).toHaveLength(1);
});

it("an invented stored v1 lot-change notice retains its original hash and is not rewritten by current reconciliation", async () => {
  const f = await fixture();
  await approve(f);
  const [first] = await prepare(f);
  await markSent(first.id);
  const changed = structuredClone(f.raw);
  changed.lots[0].orderDescription.it +=
    " Modifica della prestazione inventata.";
  await f.adopt(await f.observe(changed));
  await reconcileLotNotices({ companyId: f.companyId, now: digestNow });
  const update = (await rows(f.companyId)).find((r) => r.kind === "change")!;
  const legacy = structuredClone(update.items[0].lotNotice!);
  legacy.version = "lot-notice-v1";
  delete legacy.binding.shapeEpochToken;
  legacy.noveltyHash = lotNoticeHash({
    version: "lot-notice-novelty-v1",
    targets: legacy.scope.map((s) => ({
      target: s.target,
      kind: s.kind === "positive" ? "positive" : "source_change",
      factHash: s.factHash,
      transitionHash: s.transition.hash,
    })),
  });
  // The unchanged lot-only change scope has no v2 assessment dependency; the
  // original v1 envelope/novelty algorithm is an explicit invented fixture.
  expect(
    legacy.scope.every(
      (s) => s.target.kind === "lot" && s.assessmentDependency === null,
    ),
  ).toBe(true);
  const before = JSON.stringify(legacy),
    hash = lotNoticeHash(legacy);
  expect(validateLotNotice(legacy)).toEqual(legacy);
  await db
    .update(schema.notifications)
    .set({
      items: [{ ...update.items[0], lotNotice: legacy }],
      status: "sent",
      sentAt: new Date(),
      dedupeKey: `lot-change-v1:${f.companyId}:${f.p.id}:${legacy.noveltyHash}`,
    })
    .where(eq(schema.notifications.id, update.id));
  await reconcileLotNotices({ companyId: f.companyId, now: digestNow });
  const restored = (await rows(f.companyId)).find((r) => r.id === update.id)!
    .items[0].lotNotice!;
  expect(JSON.stringify(restored)).toBe(before);
  expect(lotNoticeHash(validateLotNotice(restored))).toBe(hash);
  expect(await rows(f.companyId)).toHaveLength(2);
});

it("a sent project source-change notice can be followed by one newly approved positive in the same current revision", async () => {
  const f = await fixture({ noLots: true, realAdoption: true });
  await approve(f, null);
  const [first] = await prepare(f);
  await markSent(first.id);
  const changed = structuredClone(f.raw);
  changed.procurement.orderDescription.it +=
    " Aggiunta esplicita della cura delle aiuole.";
  await f.adopt(await f.observe(changed));
  await reconcileLotNotices({ companyId: f.companyId, now: digestNow });
  const change = (await rows(f.companyId)).find((r) => r.kind === "change")!;
  expect(change.items[0].lotNotice?.scope[0].kind).toBe("changed");
  await markSent(change.id);
  const revision = (await f.load()).publication.revision;
  await reviewCurrentProject(f);
  await approve(f, null);
  expect((await f.load()).publication.revision).toBe(revision);
  await reconcileLotNotices({ companyId: f.companyId, now: digestNow });
  const [positive] = (await rows(f.companyId)).filter(
    (r) => r.status === "pending",
  );
  expect(positive.items[0].lotNotice?.scope[0].kind).toBe("positive");
  expect(positive.items[0].lotNotice?.scope[0].factHash).toBe(
    change.items[0].lotNotice?.scope[0].factHash,
  );
  await markSent(positive.id);
  await approve(f, null);
  await reconcileLotNotices({ companyId: f.companyId, now: digestNow });
  expect(
    (await rows(f.companyId)).filter((r) => r.status === "pending"),
  ).toHaveLength(0);
  expect(await rows(f.companyId)).toHaveLength(3);
});

it("changing project keywords and sectors with identical source facts creates no source-change alert or duplicate after rereview", async () => {
  const f = await fixture({ noLots: true, realAdoption: true });
  await approve(f, null);
  const [first] = await prepare(f);
  await markSent(first.id);
  const before = await f.load();
  const profile = {
    ...before.company.profile,
    keywords: ["potatura"],
    sectors: ["giardinaggio", "manutenzioni"] as CompanyProfile["sectors"],
  };
  await db
    .update(schema.companies)
    .set({ profile })
    .where(eq(schema.companies.id, f.companyId));
  const changed = await f.load();
  expect(changed.expected.profileHash).not.toBe(before.expected.profileHash);
  expect(changed.publication.revision).toBe(before.publication.revision);
  expect(changed.project.signalEligible).toBe(false);
  await reconcileLotNotices({ companyId: f.companyId, now: digestNow });
  expect(await rows(f.companyId)).toHaveLength(1);
  await approve(f, null);
  await reconcileLotNotices({ companyId: f.companyId, now: digestNow });
  expect(await rows(f.companyId)).toHaveLength(1);
});

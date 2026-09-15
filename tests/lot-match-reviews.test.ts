import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
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
  lotMatchReviewInputSchema,
  lotMatchReviewTarget,
  assessmentReviewTarget,
  decodeLotMatchReviewRecord,
  type LoadedLotMatchReview,
  type LotMatchReviewInput,
} from "../src/lib/lot-match-reviews";

// Invented source and company data, real local migrations + pg-boss producer.
// No provider, SMTP, HTTP, live DB, runtime adoption or two-backend concurrency.
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
    return { stored, publication, request, result };
  }
  const observation = await observe();
  const adopt = async (value = observation) => {
    if (options.realAdoption) {
      // New shape/epoch regressions exercise the real transactional adopter.
      // The request was captured before the result; no caller constructs epoch.
      return adoptDocumentaryObservation(
        value.request,
        value.result,
        activation(),
      );
    }
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

it("requires a current DB administrator, derives the actor from the viewer, and isolates company/source identity", async () => {
  const f = await fixture(),
    loaded = await f.load(),
    draft = assessmentDraft(loaded, f.aId);
  for (const denied of [
    { ...viewer, demo: true },
    { ...viewer, admin: false },
    { ...viewer, userId: "not-match-admin" },
  ]) {
    await expect(
      loadLotMatchReview(f.companyId, f.p.id, denied),
    ).rejects.toMatchObject({ status: 403 });
    await expect(appendLotMatchReview(draft, denied)).rejects.toMatchObject({
      status: 403,
    });
  }
  expect(
    lotMatchReviewInputSchema.safeParse({ ...draft, actorId: "fake-admin" })
      .success,
  ).toBe(false);
  await expect(
    appendLotMatchReview({ ...draft, origin: "validated-comparator" }, viewer),
  ).rejects.toThrow();
  await db
    .delete(schema.administrators)
    .where(eq(schema.administrators.userId, viewer.userId));
  try {
    await expect(appendLotMatchReview(draft, viewer)).rejects.toMatchObject({
      status: 403,
    });
  } finally {
    await db.insert(schema.administrators).values({ userId: viewer.userId });
  }
  await expect(
    appendLotMatchReview({ ...draft, companyId: f.otherCompanyId }, viewer),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    loadLotMatchReview("missing-company", f.p.id, viewer),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    appendLotMatchReview(
      {
        ...draft,
        target: {
          ...(draft as any).target,
          publicationId: "other-publication",
        },
      },
      viewer,
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect(await auditRows(loaded.match.id)).toHaveLength(0);
  const saved = await appendLotMatchReview(draft, viewer);
  expect(saved.history[0].actorId).toBe(viewer.userId);
  expect(saved.state.evaluations?.entries[0].humanReview.actorId).toBe(
    viewer.userId,
  );
  expect((await f.load(f.otherCompanyId)).state.evaluations).toBeNull();
});

it("persists direct A plus review B as one partial project and immutable before/after audit, preserving legacy fields", async () => {
  const f = await fixture(),
    initial = await f.load(),
    beforeJobs = await jobs(f.p.id);
  const savedA = await appendLotMatchReview(
    assessmentDraft(initial, f.aId),
    viewer,
  );
  const firstAudit = await auditRows(initial.match.id);
  const savedB = await appendLotMatchReview(
    assessmentDraft(savedA, f.bId, "review"),
    viewer,
  );
  expect(savedB.project.quality).toBe("approved");
  expect(savedB.project.relevantLotIds).toEqual([f.aId]);
  expect(savedB.project.lots.map((l) => l.evaluation?.result)).toEqual([
    "direct",
    "review",
  ]);
  expect(savedB.project.signalEligible).toBe(true);
  const row = await matchRow(f.companyId, f.p.id);
  for (const field of [
    "score",
    "reason",
    "eligible",
    "approved",
    "reviewedAt",
    "reviewNotes",
    "revision",
  ] as const)
    expect(row[field]).toEqual(initial.match[field]);
  const audit = await auditRows(initial.match.id);
  expect(audit).toHaveLength(2);
  expect(audit[0]).toEqual(firstAudit[0]);
  expect(audit[0].event.before.evaluations).toBeNull();
  expect(audit[1].event.before).toEqual(audit[0].event.after);
  expect(audit[0].event.after.evaluations?.entries).toHaveLength(1);
  expect(audit[1].event.after.evaluations?.entries).toHaveLength(2);
  expect(audit[0].event.evidenceSnapshot.observationId).toBe(
    f.observation.stored.id,
  );
  expect(audit[0].event.nextToken).toBe(audit[1].event.previousToken);
  const queued = await jobs(f.p.id);
  expect(queued).toHaveLength(beforeJobs.length + 2);
  for (const event of audit)
    expect(
      queued.some(
        (job) =>
          job.data.eventId === event.id && job.data.canonicalId === f.p.id,
      ),
    ).toBe(true);
});

it("whole-match, entry, source, profile and operational CAS reject stale commands without replacing another lot", async () => {
  const f = await fixture(),
    initial = await f.load(),
    old = assessmentDraft(initial, f.aId);
  for (const patch of [
    { expectedStateToken: "0".repeat(64) },
    { expectedSnapshotHash: "0".repeat(64) },
    { expectedProfileHash: "0".repeat(64) },
    { expectedOperationalInputHash: "0".repeat(64) },
    { expectedEntryHash: "0".repeat(64) },
    { expectedEvaluationSetToken: "0".repeat(64) },
  ])
    await expect(
      appendLotMatchReview({ ...old, ...patch }, viewer),
    ).rejects.toMatchObject({ status: 409 });
  const savedB = await appendLotMatchReview(
    assessmentDraft(initial, f.bId, "review"),
    viewer,
  );
  await expect(appendLotMatchReview(old, viewer)).rejects.toMatchObject({
    status: 409,
  });
  expect((await f.load()).state.evaluations).toEqual(savedB.state.evaluations);
  const current = assessmentDraft(savedB, f.aId);
  await db
    .update(schema.companies)
    .set({
      profile: {
        ...f.profile,
        activities: "Altre attività inventate nel profilo",
      },
    })
    .where(eq(schema.companies.id, f.companyId));
  await expect(appendLotMatchReview(current, viewer)).rejects.toMatchObject({
    status: 409,
  });
  const changed = await f.load();
  expect(changed.state.evaluations).toEqual(savedB.state.evaluations);
  expect(
    changed.project.lots.find((l) => l.target.lotId === f.bId)?.issue,
  ).toBe("stale_profile");
  const sourceOld = assessmentDraft(changed, f.aId);
  await f.adopt(await f.observe());
  await expect(appendLotMatchReview(sourceOld, viewer)).rejects.toMatchObject({
    status: 409,
  });
});

it("legacy project veto survives new direct and reopening creates no approval; actual feedback rows remain unchanged", async () => {
  const f = await fixture({ legacyVeto: true });
  await db.insert(schema.feedback).values({
    id: randomUUID(),
    companyId: f.companyId,
    publicationId: f.p.id,
    saved: true,
    dismissed: true,
    relevant: false,
  });
  const feedbackBefore = await db
    .select()
    .from(schema.feedback)
    .where(eq(schema.feedback.companyId, f.companyId));
  const initial = await f.load();
  expect(initial.project.suppressed).toBe(true);
  const reopenedEmpty = await appendLotMatchReview(
    projectDraft(initial, "reopen_project"),
    viewer,
  );
  expect(reopenedEmpty.state.evaluations).toBeNull();
  expect(reopenedEmpty.project.quality).toBe("unresolved");
  const vetoed = await appendLotMatchReview(
    projectDraft(reopenedEmpty, "veto_project"),
    viewer,
  );
  const positive = await appendLotMatchReview(
    assessmentDraft(vetoed, f.aId),
    viewer,
  );
  expect(positive.project.signalEligible).toBe(false);
  expect(positive.project.suppressed).toBe(true);
  expect(positive.state.evaluations?.entries[0].result).toBe("direct");
  const reopened = await appendLotMatchReview(
    projectDraft(positive, "reopen_project"),
    viewer,
  );
  expect(reopened.project.quality).toBe("approved");
  expect(reopened.project.dismissed).toBe(true);
  expect(reopened.project.signalEligible).toBe(false);
  expect(
    await db
      .select()
      .from(schema.feedback)
      .where(eq(schema.feedback.companyId, f.companyId)),
  ).toEqual(feedbackBefore);
  expect((await matchRow(f.companyId, f.p.id)).approved).toBe(false);
  const legacyOnly = await fixture({ legacyVeto: true });
  const legacyPositive = await appendLotMatchReview(
    assessmentDraft(await legacyOnly.load(), legacyOnly.aId),
    viewer,
  );
  expect(legacyPositive.project.suppressed).toBe(true);
  expect(legacyPositive.project.quality).toBe("unresolved");
});

it("explicit project veto and reopening are separate audited actions with current scope CAS", async () => {
  const f = await fixture();
  const positive = await appendLotMatchReview(
    assessmentDraft(await f.load(), f.aId),
    viewer,
  );
  const vetoDraft = projectDraft(positive, "veto_project");
  await expect(
    appendLotMatchReview(
      { ...vetoDraft, expectedProjectBindingHash: "0".repeat(64) },
      viewer,
    ),
  ).rejects.toMatchObject({ status: 409 });
  const vetoed = await appendLotMatchReview(vetoDraft, viewer);
  expect(vetoed.project.quality).toBe("rejected");
  expect(vetoed.project.signalEligible).toBe(false);
  expect(vetoed.state.evaluations).toEqual(positive.state.evaluations);
  const reopened = await appendLotMatchReview(
    projectDraft(vetoed, "reopen_project"),
    viewer,
  );
  expect(reopened.project.quality).toBe("approved");
  expect(reopened.project.signalEligible).toBe(true);
  expect(reopened.state.evaluations).toEqual(positive.state.evaluations);
  expect(reopened.history.map((e) => e.action)).toEqual([
    "assess_lot",
    "veto_project",
    "reopen_project",
  ]);
  expect(reopened.history[2].groupBefore.state?.suppression.active).toBe(true);
  expect(reopened.history[2].groupAfter?.suppression.active).toBe(false);
  await expect(
    appendLotMatchReview(projectDraft(reopened, "reopen_project"), viewer),
  ).rejects.toMatchObject({ status: 409 });
});

it("canonical copies share suppression, a new identical false verdict invalidates reopening, and future copies inherit the active veto", async () => {
  const original = await fixture({ legacyVeto: true });
  const copy = await fixture({
    canonicalId: original.p.id,
    reuseCompanies: original,
  });
  const copied = await copy.load();
  expect(copied.project.suppressed).toBe(true);
  const positive = await appendLotMatchReview(
    assessmentDraft(copied, copy.aId),
    viewer,
  );
  expect(positive.project.signalEligible).toBe(false);
  expect(positive.state.evaluations?.entries[0].result).toBe("direct");
  const staleReopening = projectDraft(positive, "reopen_project");
  const originalMatch = await matchRow(original.companyId, original.p.id);
  await pg.query(
    "UPDATE matches SET reviewed_at='2026-09-01T08:00:00.000001Z' WHERE id=$1",
    [originalMatch.id],
  );
  // The JS timestamp loses this microsecond; the group CAS must bind SQL text.
  expect(
    (await matchRow(original.companyId, original.p.id)).reviewedAt,
  ).toEqual(originalMatch.reviewedAt);
  await expect(
    appendLotMatchReview(staleReopening, viewer),
  ).rejects.toMatchObject({ status: 409 });
  const fresh = await copy.load();
  expect(fresh.expected.groupToken).not.toBe(positive.expected.groupToken);
  const reopened = await appendLotMatchReview(
    projectDraft(fresh, "reopen_project"),
    viewer,
  );
  expect(reopened.project.signalEligible).toBe(true);
  expect((await original.load()).project.suppressed).toBe(false);
  expect((await original.load()).state.evaluations).toBeNull();
  expect((await matchRow(original.companyId, original.p.id)).approved).toBe(
    false,
  );

  const vetoed = await appendLotMatchReview(
    projectDraft(await copy.load(), "veto_project"),
    viewer,
  );
  expect(vetoed.project.suppressed).toBe(true);
  expect((await original.load()).project.suppressed).toBe(true);
  const later = await fixture({
    canonicalId: original.p.id,
    reuseCompanies: original,
  });
  expect((await later.load()).project.suppressed).toBe(true);
  expect((await later.load()).state.evaluations).toBeNull();
  const laterPositive = await appendLotMatchReview(
    assessmentDraft(await later.load(), later.aId),
    viewer,
  );
  expect(laterPositive.project.signalEligible).toBe(false);
  expect((await later.load(original.otherCompanyId)).project.suppressed).toBe(
    false,
  );
  const audit = await auditRows(positive.match.id);
  expect(audit.map((row) => row.event.action)).toEqual([
    "assess_lot",
    "reopen_project",
    "veto_project",
  ]);
  expect(audit[1].event.before.evaluations).toEqual(
    audit[1].event.after.evaluations,
  );
});

it("canonical membership changes invalidate a previously prepared group command", async () => {
  const original = await fixture();
  const initial = await original.load(),
    prepared = projectDraft(initial, "veto_project");
  await fixture({ canonicalId: original.p.id, reuseCompanies: original });
  await expect(appendLotMatchReview(prepared, viewer)).rejects.toMatchObject({
    status: 409,
  });
  expect((await original.load()).expected.groupToken).not.toBe(
    initial.expected.groupToken,
  );
  expect(await auditRows(initial.match.id)).toHaveLength(0);
});

it("loads the actual historical evidence from match audit so A remains current after only B changes", async () => {
  const f = await fixture();
  const evidenceObservation = await f.observe();
  await f.adopt(evidenceObservation);
  let positive = await appendLotMatchReview(
    assessmentDraft(await f.load(), f.aId),
    viewer,
  );
  positive = await appendLotMatchReview(
    assessmentDraft(positive, f.bId, "review"),
    viewer,
  );
  expect(
    positive.input.history.every(
      (e) =>
        !("observationId" in e.snapshot) ||
        e.snapshot.observationId !== evidenceObservation.stored.id,
    ),
  ).toBe(true);
  const auditBefore = await auditRows(positive.match.id),
    entriesBefore = positive.state.evaluations;
  const changed = structuredClone(f.raw);
  changed.lots[1].orderDescription.it += " Cambia solo B.";
  const next = await f.observe(changed);
  await f.adopt(next);
  const loaded = await f.load();
  expect(loaded.project.lots.map((l) => l.state)).toEqual(["current", "stale"]);
  expect(loaded.project.relevantLotIds).toEqual([f.aId]);
  expect(loaded.project.signalEligible).toBe(true);
  expect(loaded.state.evaluations).toEqual(entriesBefore);
  expect(await auditRows(positive.match.id)).toEqual(auditBefore);
  expect(
    loaded.input.evidenceSnapshots?.some(
      (s) => s.observationId === evidenceObservation.stored.id,
    ),
  ).toBe(true);
});

it("adopted refused input and opened shared review block positives while preserving existing entries", async () => {
  const f = await fixture();
  const positive = await appendLotMatchReview(
    assessmentDraft(await f.load(), f.aId),
    viewer,
  );
  const stale = assessmentDraft(positive, f.aId);
  const source = await loadLotSourceReview(f.project, viewer);
  await appendLotSourceReview(
    { ...sourceDraft(source), action: "opened", form: null, references: [] },
    viewer,
  );
  const opened = await f.load();
  expect(opened.project.signalEligible).toBe(false);
  expect(opened.project.quality).toBe("unresolved");
  await expect(appendLotMatchReview(stale, viewer)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    appendLotMatchReview(assessmentDraft(opened, f.aId), viewer),
  ).rejects.toMatchObject({ status: 400 });
  await f.adopt(await f.observe(f.raw, true));
  const refused = await f.load();
  expect(refused.project.state).toBe("input_refused");
  expect(refused.project.signalEligible).toBe(false);
  expect(refused.state.evaluations).toEqual(positive.state.evaluations);
  await expect(appendLotMatchReview(stale, viewer)).rejects.toMatchObject({
    status: 409,
  });
  const shadow = await fixture({ adopt: false });
  await expect(shadow.load()).rejects.toMatchObject({ status: 409 });
});

it("a real SQL pg-boss failure rolls back match, audit and jobs; the same draft then commits once", async () => {
  const f = await fixture(),
    initial = await f.load(),
    draft = assessmentDraft(initial, f.aId);
  const before = {
    match: await matchRow(f.companyId, f.p.id),
    audit: await auditRows(initial.match.id),
    jobs: await jobs(f.p.id),
  };
  await pg.exec(
    "ALTER TABLE pgboss.job ADD CONSTRAINT test_reject_match_reconciliation CHECK (name <> 'lot-notice-reconcile') NOT VALID",
  );
  let failure: unknown;
  try {
    await appendLotMatchReview(draft, viewer);
  } catch (error) {
    failure = error;
  } finally {
    await pg.exec(
      "ALTER TABLE pgboss.job DROP CONSTRAINT test_reject_match_reconciliation",
    );
  }
  const causes: { constraint?: string; cause?: unknown }[] = [];
  for (
    let error = failure;
    error && typeof error === "object";
    error = (error as { cause?: unknown }).cause
  )
    causes.push(error);
  expect(
    causes.some((e) => e.constraint === "test_reject_match_reconciliation"),
  ).toBe(true);
  expect(await matchRow(f.companyId, f.p.id)).toEqual(before.match);
  expect(await auditRows(initial.match.id)).toEqual(before.audit);
  expect(await jobs(f.p.id)).toEqual(before.jobs);
  const saved = await appendLotMatchReview(draft, viewer);
  expect(saved.history).toHaveLength(1);
  expect(await jobs(f.p.id)).toHaveLength(before.jobs.length + 1);
  await expect(appendLotMatchReview(draft, viewer)).rejects.toMatchObject({
    status: 409,
  });
});

it("SQL audit is append-only, checks owner and JSON identity, and all 24 public tables retain RLS/client revocations", async () => {
  const f = await fixture(),
    saved = await appendLotMatchReview(
      assessmentDraft(await f.load(), f.aId),
      viewer,
    );
  const [row] = await auditRows(saved.match.id);
  await expect(
    pg.query("UPDATE match_lot_review_events SET event=event WHERE id=$1", [
      row.id,
    ]),
  ).rejects.toThrow(/append-only/);
  await expect(
    pg.query("DELETE FROM match_lot_review_events WHERE id=$1", [row.id]),
  ).rejects.toThrow(/append-only/);
  await expect(pg.exec("TRUNCATE match_lot_review_events")).rejects.toThrow(
    /append-only/,
  );
  const foreignId = randomUUID();
  await expect(
    db.insert(schema.matchLotReviewEvents).values({
      ...row,
      id: foreignId,
      sequence: 2,
      companyId: f.otherCompanyId,
      event: {
        ...row.event,
        id: foreignId,
        sequence: 2,
        companyId: f.otherCompanyId,
      },
    }),
  ).rejects.toThrow();
  const badId = randomUUID();
  await expect(
    db.insert(schema.matchLotReviewEvents).values({
      ...row,
      id: badId,
      sequence: 2,
      event: { ...row.event, id: "json-id-does-not-match", sequence: 2 },
    }),
  ).rejects.toThrow();
  expect(await auditRows(saved.match.id)).toEqual([row]);
  const rls = await pg.query<{ count: number; protected: number }>(
    "SELECT count(*)::int AS count, count(*) FILTER (WHERE relrowsecurity)::int AS protected FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace WHERE n.nspname='public' AND relkind='r'",
  );
  expect(rls.rows[0]).toEqual({ count: 24, protected: 24 });
  for (const role of ["anon", "authenticated", "service_role"]) {
    const privileges = await pg.query<{
      select: boolean;
      insert: boolean;
      update: boolean;
      delete: boolean;
      execute: boolean;
    }>(
      "SELECT has_table_privilege($1,'public.match_lot_review_events','SELECT') AS select, has_table_privilege($1,'public.match_lot_review_events','INSERT') AS insert, has_table_privilege($1,'public.match_lot_review_events','UPDATE') AS update, has_table_privilege($1,'public.match_lot_review_events','DELETE') AS delete, has_function_privilege($1,'public.check_match_lot_review_owner()','EXECUTE') AS execute",
      [role],
    );
    expect(privileges.rows[0]).toEqual({
      select: false,
      insert: false,
      update: false,
      delete: false,
      execute: false,
    });
  }
  await pg.exec(
    "GRANT SELECT ON public.match_lot_review_events TO anon; SET ROLE anon",
  );
  try {
    expect(
      (await pg.query("SELECT * FROM public.match_lot_review_events")).rows,
    ).toEqual([]);
  } finally {
    await pg.exec(
      "RESET ROLE; REVOKE SELECT ON public.match_lot_review_events FROM anon",
    );
  }
});

it("adopts an explicitly lot-free source and records a real project assessment with one atomic audit and job", async () => {
  const f = await fixture({ noLots: true, realAdoption: true });
  const loaded = await f.load();
  expect(loaded.shapeState.shape.kind).toBe("project");
  expect(loaded.shapeState.epochToken).toMatch(/^[a-f0-9]{64}$/);
  expect(loaded.project.lots).toHaveLength(0);
  expect(loaded.project.targets).toHaveLength(1);
  const before = await matchRow(f.companyId, f.p.id);
  const jobsBefore = await jobs(f.p.id);
  const result = await appendLotMatchReview(
    assessmentDraft(loaded, null),
    viewer,
  );
  expect(result.project.quality).toBe("approved");
  expect(result.project.signalEligible).toBe(true);
  expect(result.project.projectAssessment?.target).toEqual(f.project);
  expect(result.project.lots).toHaveLength(0);
  expect(result.project.relevantTargets).toHaveLength(1);
  const rows = await auditRows(loaded.match.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].event).toMatchObject({
    version: "human-lot-match-review-v2",
    action: "assess_project",
    shapeEpochToken: loaded.shapeState.epochToken,
    actorId: viewer.userId,
  });
  expect(decodeLotMatchReviewRecord(rows[0].event)).toEqual(rows[0].event);
  expect((await jobs(f.p.id)).length).toBe(jobsBefore.length + 1);
  const after = await matchRow(f.companyId, f.p.id);
  for (const field of [
    "approved",
    "reviewedAt",
    "reviewNotes",
    "score",
    "eligible",
    "revision",
  ] as const)
    expect(after[field]).toEqual(before[field]);
  expect((await f.load(f.otherCompanyId)).project.quality).toBe("unresolved");
  const different = await appendLotMatchReview(
    assessmentDraft(await f.load(f.otherCompanyId), null, "different"),
    viewer,
  );
  expect(different.project.quality).toBe("rejected");
  expect(different.project.signalEligible).toBe(false);
});

it("a project source needs its own current defined review and cannot bypass shape or epoch through API JSON", async () => {
  const f = await fixture({
    noLots: true,
    realAdoption: true,
    reviewSource: false,
  });
  await expect(
    appendLotMatchReview(assessmentDraft(await f.load(), null), viewer),
  ).rejects.toMatchObject({ status: 400 });
  const source = await loadLotSourceReview(f.project, viewer);
  await appendLotSourceReview(
    { ...sourceDraft(source), form: "broad_scope" },
    viewer,
  );
  await expect(
    appendLotMatchReview(assessmentDraft(await f.load(), null), viewer),
  ).rejects.toMatchObject({ status: 400 });
  await appendLotSourceReview(
    sourceDraft(await loadLotSourceReview(f.project, viewer)),
    viewer,
  );
  const loaded = await f.load(),
    draft = assessmentDraft(loaded, null);
  expect(
    lotMatchReviewInputSchema.safeParse({ ...draft, actorId: "browser-actor" })
      .success,
  ).toBe(false);
  const missing = { ...draft } as Record<string, unknown>;
  delete missing.expectedShapeEpochToken;
  expect(lotMatchReviewInputSchema.safeParse(missing).success).toBe(false);
  await expect(
    appendLotMatchReview(
      { ...draft, expectedShapeEpochToken: "0".repeat(64) },
      viewer,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    lotMatchReviewInputSchema.safeParse({ ...draft, action: "assess_lot" })
      .success,
  ).toBe(false);
  const lots = await fixture({ realAdoption: true });
  const lotsLoaded = await lots.load();
  expect(() => assessmentReviewTarget(lotsLoaded, lots.project)).toThrow();
  await expect(
    appendLotMatchReview(
      {
        ...draft,
        companyId: lots.companyId,
        publicationId: lots.p.id,
        target: lots.project,
        expectedSnapshotHash: lotsLoaded.expected.snapshotHash,
        expectedProfileHash: lotsLoaded.expected.profileHash,
        expectedStateToken: lotsLoaded.expected.stateToken,
        expectedGroupToken: lotsLoaded.expected.groupToken,
        expectedShapeEpochToken: lotsLoaded.expected.shapeEpochToken,
      },
      viewer,
    ),
  ).rejects.toMatchObject({ status: 400 });
});

it("persisted project to lots to identical project adoption cannot resurrect source review or company judgment", async () => {
  const f = await fixture({ noLots: true, realAdoption: true });
  const initial = await appendLotMatchReview(
    assessmentDraft(await f.load(), null),
    viewer,
  );
  const oldEpoch = initial.shapeState.epochToken;
  const initialSet = initial.state.evaluations;
  const sourceBefore = await loadLotSourceReview(f.project, viewer);
  const lots = structuredClone(f.raw);
  lots.base.lotsType = "with";
  lots.base.lots = [{ id: f.aId, lotNumber: 1, title: { it: "Verde" } }];
  lots.lots = [
    {
      id: f.aId,
      lotNumber: 1,
      title: { it: "Verde" },
      orderDescription: { it: aText },
      orderAddress: { countryId: "CH", cantonId: "TI", city: "Lugano" },
      cpvCode: { code: "77310000" },
    },
  ];
  await f.adopt(await f.observe(lots));
  const middle = await f.load();
  expect(middle.shapeState.shape.kind).toBe("lots");
  expect(middle.project.signalEligible).toBe(false);
  await f.adopt(await f.observe(f.raw));
  const returned = await f.load();
  expect(returned.shapeState.shape.kind).toBe("project");
  expect(returned.shapeState.epochToken).not.toBe(oldEpoch);
  expect(returned.state.evaluations).toEqual(initialSet);
  expect(returned.project.signalEligible).toBe(false);
  expect(returned.project.quality).toBe("unresolved");
  const sourceReturned = await loadLotSourceReview(f.project, viewer);
  expect(sourceReturned.context.state).not.toBe("manual_source");
  await expect(
    appendLotSourceReview(
      {
        ...sourceDraft(sourceReturned),
        expectedShapeEpochToken: sourceBefore.expected.shapeEpochToken,
      },
      viewer,
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    appendLotMatchReview(assessmentDraft(returned, null), viewer),
  ).rejects.toMatchObject({ status: 400 });
  await appendLotSourceReview(sourceDraft(sourceReturned), viewer);
  const newDraft = assessmentDraft(await f.load(), null);
  await expect(
    appendLotMatchReview(
      { ...newDraft, expectedShapeEpochToken: oldEpoch },
      viewer,
    ),
  ).rejects.toMatchObject({ status: 409 });
  const rereviewed = await appendLotMatchReview(newDraft, viewer);
  expect(rereviewed.project.signalEligible).toBe(true);
  expect(rereviewed.history).toHaveLength(2);
});

it("shadow and same-shape adoption preserve the epoch but unresolved and refused interrupt it", async () => {
  const f = await fixture({ noLots: true, realAdoption: true });
  const initial = await f.load();
  const shadowRaw = structuredClone(f.raw);
  shadowRaw.base.lotsType = "unspecified";
  const shadow = await f.observe(shadowRaw);
  expect((await f.load()).shapeState.epochToken).toBe(
    initial.shapeState.epochToken,
  );
  await f.adopt(shadow);
  const unknown = await f.load();
  expect(unknown.shapeState.shape.kind).toBe("unresolved");
  expect(unknown.project.signalEligible).toBe(false);
  expect(() => assessmentReviewTarget(unknown, f.project)).toThrow();
  await f.adopt(await f.observe(f.raw, true));
  const refused = await f.load();
  expect(refused.shapeState.shape.kind).toBe("unresolved");
  expect(refused.project.signalEligible).toBe(false);
  await f.adopt(await f.observe(f.raw));
  const current = await f.load();
  const textChange = structuredClone(f.raw);
  textChange.procurement.orderDescription.it += " Nuovo dettaglio inventato.";
  await f.adopt(await f.observe(textChange));
  expect((await f.load()).shapeState.epochToken).toBe(
    current.shapeState.epochToken,
  );
});

it("a failed project reconciliation job rolls back its judgment and audit, and audit tampering is rejected", async () => {
  const f = await fixture({ noLots: true, realAdoption: true });
  const loaded = await f.load(),
    draft = assessmentDraft(loaded, null);
  const before = {
    match: await matchRow(f.companyId, f.p.id),
    audit: await auditRows(loaded.match.id),
    jobs: await jobs(f.p.id),
  };
  await pg.exec(
    "ALTER TABLE pgboss.job ADD CONSTRAINT test_reject_project_reconciliation CHECK (name <> 'lot-notice-reconcile') NOT VALID",
  );
  try {
    await expect(appendLotMatchReview(draft, viewer)).rejects.toThrow();
  } finally {
    await pg.exec(
      "ALTER TABLE pgboss.job DROP CONSTRAINT test_reject_project_reconciliation",
    );
  }
  expect({
    match: await matchRow(f.companyId, f.p.id),
    audit: await auditRows(loaded.match.id),
    jobs: await jobs(f.p.id),
  }).toEqual(before);
  const saved = await appendLotMatchReview(draft, viewer),
    event = saved.history[0];
  expect(() =>
    decodeLotMatchReviewRecord({ ...event, nextToken: "f".repeat(64) }),
  ).toThrow();
  expect(() => decodeLotMatchReviewRecord({ ...event, extra: true })).toThrow();
  expect(() =>
    decodeLotMatchReviewRecord({
      ...event,
      groupBefore: { ...event.groupBefore, legacy: [] },
    }),
  ).toThrow();
  await expect(appendLotMatchReview(draft, viewer)).rejects.toMatchObject({
    status: 409,
  });
});

it("reads an original v1 project-veto reopening followed by a v2 project judgment without rewriting the stored v1 record", async () => {
  const f = await fixture({
    noLots: true,
    realAdoption: true,
    legacyVeto: true,
  });
  const loaded = await f.load();
  expect(loaded.project.suppressed).toBe(true);
  const eventId = randomUUID(),
    at = new Date().toISOString();
  const groupAfter = {
    version: "canonical-lot-suppression-v1" as const,
    companyId: f.companyId,
    canonicalId: f.p.id,
    eventId,
    suppression: {
      active: false,
      reason: "Esclusione storica ritirata dal fondatore.",
      rejection: null,
    },
  };
  // Invented legacy-format fixture. Its source/parent chain and state tokens
  // come from actual persisted rows; v1 had no shapeEpochToken to fabricate.
  const event = {
    version: "human-lot-match-review-v1" as const,
    id: eventId,
    matchId: loaded.match.id,
    companyId: f.companyId,
    publicationId: f.p.id,
    sequence: 1,
    action: "reopen_project" as const,
    actorId: viewer.userId,
    at,
    note: "Riconsiderazione storica inventata del progetto.",
    sourceSnapshotHash: loaded.expected.snapshotHash,
    evidenceSnapshot: loaded.input.snapshot,
    profileHash: loaded.expected.profileHash,
    groupBefore: loaded.group.before,
    groupAfter,
    before: loaded.state,
    after: loaded.state,
    previousToken: loaded.expected.stateToken,
    nextToken: loaded.expected.stateToken,
  };
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.settings)
      .values({ key: loaded.group.key, value: groupAfter });
    await tx.insert(schema.matchLotReviewEvents).values({
      id: eventId,
      matchId: loaded.match.id,
      companyId: f.companyId,
      publicationId: f.p.id,
      sequence: 1,
      event,
    });
  });
  const restored = await f.load();
  expect(restored.history[0]).toEqual(event);
  expect(restored.project.suppressed).toBe(false);
  expect(restored.project.signalEligible).toBe(false);
  const saved = await appendLotMatchReview(
    assessmentDraft(restored, null),
    viewer,
  );
  expect(saved.project.signalEligible).toBe(true);
  expect(saved.history.map((e) => e.version)).toEqual([
    "human-lot-match-review-v1",
    "human-lot-match-review-v2",
  ]);
  expect(saved.history[1].previousToken).toBe(event.nextToken);
  expect((await auditRows(loaded.match.id))[0].event).toEqual(event);
  expect(() =>
    decodeLotMatchReviewRecord({
      ...event,
      shapeEpochToken: loaded.expected.shapeEpochToken,
    }),
  ).toThrow();
});

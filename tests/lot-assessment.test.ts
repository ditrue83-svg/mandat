import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test } from "vitest";
import type {
  CompanyProfile,
  Publication,
  SourceScopeReview,
} from "../src/lib/domain";
import {
  preserveSimapLots,
  restoreSimapDetail,
  type Identity,
} from "../src/lib/source-lots";
import { normalizeSimap } from "../src/sources/simap";
import { SIMAP_ACQUISITION_VERSION } from "../src/sources/simap-documentary";
import {
  createDocumentaryRequest,
  stableDocumentaryJson,
} from "../src/lib/documentary-observation";
import {
  resolveAssessmentShapeHistory,
  resolveAssessmentSourceContext,
  type DocumentarySnapshotRow,
} from "../src/lib/assessment-shape";
import {
  ReviewConflict,
  type HumanSourceForm,
} from "../src/lib/source-review-context";
import {
  captureLotSourceSnapshot,
  createLotSourceReviewRecord,
  resolveLotSourceContext,
  type LotSourceSnapshot,
  type LotSourceTarget,
  type MixedSourceReviewRecord,
} from "../src/lib/lot-source-context";
import {
  createHumanTargetAssessment as createAssessment,
  preliminaryAssessmentMatch,
  sameAssessmentTarget,
  lotAssessmentProfileHash,
  lotEvaluationSetToken,
  projectLotAssessmentDto,
  resolveProjectLotAssessment as resolveAssessment,
  validateLotEvaluationSet,
  type HumanTargetAssessmentCommand,
  type AssessmentTarget,
  type LotAssessmentInput,
  type LotAssessmentResult,
  type LotAssessmentTarget,
  type LotEvaluation,
  type LotEvaluationSet,
} from "../src/lib/lot-assessment";

// These identities, texts, profiles and human judgments are invented. Tests
// establish binding/projection behavior, not whether a real firm is suitable.
const projectId = "10000000-0000-4000-8000-000000000001";
const sourcePublicationId = "20000000-0000-4000-8000-000000000002";
const aId = "30000000-0000-4000-8000-000000000003";
const bId = "40000000-0000-4000-8000-000000000004";
const publicationId = `simap-${projectId}`;
const identity: Identity = {
  projectId,
  publicationId: sourcePublicationId,
  detailUrl: `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${sourcePublicationId}`,
};
const a: LotAssessmentTarget = {
  kind: "lot",
  publicationId,
  sourceProjectId: projectId,
  lotId: aId,
};
const b: LotAssessmentTarget = { ...a, lotId: bId };
const project: LotSourceTarget = { kind: "project", publicationId };
const commonText = "Gara inventata composta da due lotti distinti.";
const aText = "🌳 Potatura e manutenzione del verde del lotto A.";
const bText = "Installazione dei quadri elettrici nel lotto B.";
const now = new Date("2030-01-02T10:00:00.000Z");
function raw() {
  return {
    id: sourcePublicationId,
    type: "tender",
    procurement: { orderDescription: { it: commonText } },
    base: {
      id: sourcePublicationId,
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
}
const observationRows = new Map<string, DocumentarySnapshotRow>();
beforeEach(() => observationRows.clear());
const observationIdFor = (label: string) => {
  if (
    /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(
      label,
    )
  )
    return label;
  const digest = createHash("sha256").update(label).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};
function registerSnapshot(snap: LotSourceSnapshot, parent = "observation-1") {
  if (observationRows.has(snap.observationId)) return snap;
  const acq = snap.acquisition;
  if (acq.state !== "accepted")
    throw new Error("Refused fixture requires its original receipt row");
  const identity = acq.archive.identity,
    detail = restoreSimapDetail(acq.archive);
  const publication = normalizeSimap(
    {
      id: identity.projectId,
      raw: {
        id: identity.projectId,
        publicationId: identity.publicationId,
        projectNumber: "INVENTED-ASSESSMENT-HISTORY",
        publicationDate: "2030-01-01",
        pubType: "tender",
        processType: "open",
        title: { it: "Progetto inventato" },
        procOfficeName: { it: "Ente inventato" },
      },
    },
    detail,
  );
  const body = Buffer.from(JSON.stringify(detail)),
    at = "2030-01-01T00:00:00.000Z";
  observationRows.set(snap.observationId, {
    id: snap.observationId,
    publicationId: snap.publicationId,
    sourceProjectId: identity.projectId,
    sourcePublicationId: identity.publicationId,
    state: "accepted",
    createdAt: new Date(at),
    request: createDocumentaryRequest({
      id: snap.observationId,
      identity,
      startedAt: at,
      observedPublication:
        snap.observationId === observationIdFor("observation-1")
          ? null
          : {
              revision: "editorial-revision-retained",
              documentarySnapshotId: observationIdFor(parent),
            },
    }),
    acquisition: {
      version: SIMAP_ACQUISITION_VERSION,
      state: "accepted",
      identity,
      sourceRevision: publication.revision,
      archive: acq.archive,
      receipt: {
        url: identity.detailUrl,
        receivedAt: at,
        bodyByteLength: body.length,
        bodySha256: createHash("sha256").update(body).digest("hex"),
      },
    },
  });
  return snap;
}
function snapshot(
  detail = raw(),
  observationId = "observation-1",
  sourceScopeReview: SourceScopeReview | null = null,
  parent = "observation-1",
) {
  return registerSnapshot(
    captureLotSourceSnapshot({
      publicationId,
      observationId: observationIdFor(observationId),
      acquisition: {
        state: "accepted",
        archive: preserveSimapLots(detail, identity),
      },
      sourceScopeReview,
    }),
    parent,
  );
}
function withShape<T extends Omit<LotAssessmentInput, "shapeState">>(i: T) {
  return {
    ...i,
    shapeState: resolveAssessmentShapeHistory({
      publicationId: i.snapshot.publicationId,
      currentObservationId: i.snapshot.observationId,
      observations: [...observationRows.values()],
    }),
  };
}
function resolveProjectLotAssessment(
  i: Parameters<typeof resolveAssessment>[0],
) {
  return resolveAssessment(withShape(i));
}
function createHumanLotAssessment(
  c: HumanTargetAssessmentCommand,
  i: LotAssessmentInput,
  m: Parameters<typeof createAssessment>[2],
) {
  return createAssessment(c, withShape(i), m);
}
let sequence = 0;
function metadata() {
  return {
    id: `assessment-${++sequence}`,
    actorId: "private-actor",
    at: now.toISOString(),
    note: "PRIVATE_NOTE: revisione umana degli avvisi, senza attestazione di idoneità.",
  };
}
function sourceRecord(
  snap: LotSourceSnapshot,
  target: LotSourceTarget,
  history: readonly MixedSourceReviewRecord[],
  form: HumanSourceForm = "defined_service",
) {
  const context = resolveLotSourceContext(snap, target, history);
  const original =
    target.kind === "project"
      ? commonText
      : target.lotId === aId
        ? aText
        : bText;
  return createLotSourceReviewRecord(
    {
      target,
      expectedSnapshotHash: snap.snapshotHash,
      expectedSelectionHash: context.dependency.selectionHash,
      expectedTargetEventId: context.dependency.reviewEventId,
      expectedProjectBarrierHash: context.projectBarrier.barrierHash,
      action: "recorded",
      form,
      references: [
        {
          selectionHash: context.dependency.selectionHash!,
          rawPath:
            target.kind === "project"
              ? "/procurement/orderDescription/it"
              : target.lotId === aId
                ? "/lots/0/orderDescription/it"
                : "/lots/1/orderDescription/it",
          startUtf16: 0,
          endUtf16: original.length,
        },
      ],
      actorId: "source-reviewer",
      note: "Esame inventato della sola fonte.",
    },
    snap,
    history,
    {
      id: `source-event-${++sequence}`,
      sourceRevision: "source-revision",
      contentRevision: "content-revision",
      createdAt: now.toISOString(),
    },
  );
}
function input(
  options: { aForm?: HumanSourceForm; bForm?: HumanSourceForm } = {},
): LotAssessmentInput {
  const snap = snapshot();
  const p = sourceRecord(snap, project, [], "broad_scope");
  const ar = sourceRecord(snap, a, [p], options.aForm);
  const br = sourceRecord(snap, b, [p, ar], options.bForm);
  const profile: CompanyProfile = {
    name: "Ditta inventata",
    activities: "Potatura e cura ordinaria del verde.",
    employees: 2,
    sectors: ["giardinaggio"],
    zones: ["Tutto il Ticino"],
    keywords: [],
    exclusions: [],
    minValue: null,
    maxValue: null,
    emailEnabled: true,
  };
  const publication: Publication = {
    id: publicationId,
    source: "simap",
    externalId: projectId,
    projectId,
    title: "Progetto inventato",
    buyer: "Ente inventato",
    location: "Lugano",
    canton: "TI",
    zone: "Luganese",
    publishedAt: "2030-01-01T08:00:00.000Z",
    updatedAt: "2030-01-01T08:00:00.000Z",
    visibleAt: "2030-01-01T07:00:00.000Z",
    deadline: "2030-02-01T12:00:00.000Z",
    valueChf: 100000,
    procedure: "open",
    status: "open",
    sectors: ["giardinaggio", "impianti"],
    cpv: ["77310000", "45310000"],
    sourceUrl: identity.detailUrl,
    sourceUrls: [identity.detailUrl],
    originalText: commonText,
    summary: null,
    requirements: [],
    evidence: [],
    documents: [],
    reviewRequired: false,
    reviewReasons: [],
    revision: "global-revision-1",
  };
  return withShape({
    companyId: "company-invented",
    publication,
    profile,
    snapshot: snap,
    history: [p, ar, br],
    evaluationSet: null,
    now,
  });
}
function command(
  i: LotAssessmentInput,
  target: AssessmentTarget = a,
  result: LotAssessmentResult = "direct",
): HumanTargetAssessmentCommand {
  i = withShape(i);
  const context = resolveAssessmentSourceContext(
    i.snapshot,
    target,
    i.history,
    i.shapeState,
  );
  const preliminary = preliminaryAssessmentMatch({
    publication: i.publication,
    profile: i.profile,
    context,
    now: i.now,
  });
  return {
    target,
    expectedShapeEpochToken: i.shapeState.epochToken!,
    expectedSnapshotHash: i.snapshot.snapshotHash,
    expectedSourceDependency: context.dependency,
    expectedProfileHash: lotAssessmentProfileHash(i.profile),
    expectedOperationalInputHash: preliminary.operationalInputHash,
    expectedEvaluationSetToken: lotEvaluationSetToken(
      i.evaluationSet,
      i.companyId,
      i.publication.id,
    ),
    expectedEntryHash:
      i.evaluationSet?.entries.find((e) =>
        sameAssessmentTarget(e.target, target),
      )?.entryHash ?? null,
    result,
    reason: `${target.kind === "project" ? "Intero progetto" : target.lotId === aId ? "Lotto A" : "Lotto B"}: giudizio umano inventato ${result}.`,
    references: [
      {
        selectionHash: context.dependency.selectionHash!,
        rawPath:
          target.kind === "project"
            ? "/procurement/orderDescription/it"
            : target.lotId === aId
              ? "/lots/0/orderDescription/it"
              : "/lots/1/orderDescription/it",
        startUtf16: 0,
        endUtf16:
          target.kind === "project"
            ? commonText.length
            : target.lotId === aId
              ? aText.length
              : bText.length,
      },
    ],
    origin: "human",
    confirmedReviewReasons:
      result === "direct" ? preliminary.reviewReasons : [],
  };
}
function assess(
  i: LotAssessmentInput,
  target: AssessmentTarget = a,
  result: LotAssessmentResult = "direct",
) {
  const created = createHumanLotAssessment(
    command(i, target, result),
    i,
    metadata(),
  );
  return { ...i, evaluationSet: created.evaluationSet };
}
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
function signed(e: LotEvaluation, modify: (body: any) => void): LotEvaluation {
  const { entryHash: _, ...body } = structuredClone(e);
  modify(body);
  return {
    ...body,
    entryHash: createHash("sha256").update(stable(body)).digest("hex"),
  } as LotEvaluation;
}
function withEntry(
  i: LotAssessmentInput,
  entry: LotEvaluation,
): LotAssessmentInput {
  return {
    ...i,
    evaluationSet: validateLotEvaluationSet(
      { ...i.evaluationSet!, entries: [entry] },
      i.companyId,
      i.publication.id,
    ),
  };
}

test("One project card preserves partial scope, operational unknowns and private human metadata", () => {
  let i = assess(input());
  i = assess(i, b, "review");
  const result = resolveProjectLotAssessment(i);
  assert.equal(result.state, "relevant");
  assert.equal(result.signalEligible, true);
  assert.equal(result.quality, "approved");
  assert.deepEqual(result.relevantLotIds, [aId]);
  assert.equal(result.qualityEventIds.length, 1);
  assert.deepEqual(
    result.lots.map((l) => l.evaluation?.result),
    ["direct", "review"],
  );
  assert.equal(result.allDifferent, false);
  assert.match(result.reason, /Interesse potenziale.*lotto 1.*non attesta/);
  assert.equal(result.lots[0].preliminary?.operational.deadline, null);
  assert.equal(result.lots[0].preliminary?.operational.valueChf, null);
  assert.ok(result.lots[0].preliminary!.reviewReasons.length > 0);
  const dto = projectLotAssessmentDto(result);
  assert.ok(!JSON.stringify(dto).includes("PRIVATE_NOTE"));
  assert.ok(!JSON.stringify(dto).includes("private-actor"));
  assert.ok(!JSON.stringify(dto).includes("humanReview"));
  assert.equal(dto.lots[0].operational?.deadline, null);
  assert.ok(Object.isFrozen(i.evaluationSet?.entries[0].evidence[0]));
  const serialized = JSON.parse(JSON.stringify(i.evaluationSet));
  assert.equal(
    lotEvaluationSetToken(serialized, i.companyId, publicationId),
    lotEvaluationSetToken(i.evaluationSet, i.companyId, publicationId),
  );
});

test("Human direct requires exact current operational confirmation, nonempty note and no automatic origin", () => {
  const i = input(),
    c = command(i),
    m = metadata();
  assert.throws(
    () => createHumanLotAssessment({ ...c, confirmedReviewReasons: [] }, i, m),
    ReviewConflict,
  );
  assert.throws(
    () =>
      createHumanLotAssessment(
        {
          ...c,
          confirmedReviewReasons: [...c.confirmedReviewReasons, "Extra"],
        },
        i,
        m,
      ),
    ReviewConflict,
  );
  assert.throws(() => createHumanLotAssessment(c, i, { ...m, note: " " }));
  assert.throws(() =>
    createHumanLotAssessment(
      { ...c, origin: "validated-comparator" } as any,
      i,
      m,
    ),
  );
  const direct = createHumanLotAssessment(c, i, m);
  const automatic = signed(direct.entry, (entry) => {
    entry.origin = "validated-comparator";
  });
  assert.throws(() =>
    validateLotEvaluationSet(
      { ...direct.evaluationSet, entries: [automatic] },
      i.companyId,
      publicationId,
    ),
  );
  assert.equal(direct.entry.origin, "human");
  assert.deepEqual(
    direct.entry.humanReview.confirmedReviewReasons,
    c.confirmedReviewReasons,
  );
});

test("A shared exclusion stays unresolved until the reviewer confirms its application to the lot", () => {
  const initial = input();
  const detail = raw();
  detail.procurement.orderDescription.it =
    "Lotto A: cura del verde. Lotto B: installazione quadri elettrici.";
  const snap = snapshot(detail, "shared-exclusion-observation");
  const parent = sourceRecord(snap, project, [], "broad_scope");
  const selected = sourceRecord(snap, a, [parent]);
  const i = withShape({
    ...initial,
    snapshot: snap,
    history: [parent, selected],
    profile: { ...initial.profile, exclusions: ["quadri elettrici"] },
  });
  const result = resolveProjectLotAssessment(i);
  assert.equal(result.signalEligible, false);
  assert.equal(result.lots[0].preliminary?.eligible, true);
  assert.equal(result.lots[0].state, "missing");
  const c = command(i);
  const sharedWarning = c.confirmedReviewReasons.find((reason) =>
    /contesto del progetto.*esclus.*lotto selezionato/.test(reason),
  );
  assert.ok(sharedWarning);
  assert.throws(
    () =>
      createHumanLotAssessment(
        {
          ...c,
          confirmedReviewReasons: c.confirmedReviewReasons.filter(
            (reason) => reason !== sharedWarning,
          ),
        },
        i,
        metadata(),
      ),
    ReviewConflict,
  );
});

test("A negative lot never rejects an unassessed project; all current human negatives yield one rejection", () => {
  const one = assess(input(), a, "different");
  const partial = resolveProjectLotAssessment(one);
  assert.equal(partial.quality, "unresolved");
  assert.equal(partial.allDifferent, false);
  assert.equal(partial.lots[1].state, "missing");
  const full = resolveProjectLotAssessment(assess(one, b, "different"));
  assert.equal(full.state, "different");
  assert.equal(full.quality, "rejected");
  assert.equal(full.allDifferent, true);
  assert.equal(full.qualityEventIds.length, 2);
  assert.equal(full.signalEligible, false);
  assert.equal(resolveProjectLotAssessment(input()).quality, "unresolved");
});

test("Whole-set and entry CAS reject concurrent writes, target changes, profile/source/operational changes", () => {
  const i = input(),
    stale = command(i),
    m = metadata();
  const updated = assess(i, b, "review");
  assert.throws(
    () => createHumanLotAssessment(stale, updated, m),
    ReviewConflict,
  );
  const current = command(updated);
  assert.throws(
    () => createHumanLotAssessment({ ...current, target: b }, updated, m),
    ReviewConflict,
  );
  assert.throws(
    () =>
      createHumanLotAssessment(
        { ...current, expectedEntryHash: "a".repeat(64) },
        updated,
        m,
      ),
    ReviewConflict,
  );
  assert.throws(
    () =>
      createHumanLotAssessment(
        current,
        {
          ...updated,
          profile: {
            ...updated.profile,
            activities: "Nuovo servizio inventato",
          },
        },
        m,
      ),
    ReviewConflict,
  );
  assert.throws(
    () =>
      createHumanLotAssessment(
        current,
        {
          ...updated,
          publication: { ...updated.publication, status: "closed" },
        },
        m,
      ),
    ReviewConflict,
  );
  const observed = {
    ...updated,
    snapshot: snapshot(raw(), "observation-same-new"),
  };
  assert.throws(
    () => createHumanLotAssessment(current, observed, m),
    ReviewConflict,
  );
  const committed = createHumanLotAssessment(current, updated, m);
  assert.deepEqual(
    committed.evaluationSet.entries.map((e) =>
      e.target.kind === "lot" ? e.target.lotId : "project",
    ),
    [bId, aId],
  );
  assert.equal(committed.previousEntry, null);
  const replacing = { ...updated, evaluationSet: committed.evaluationSet };
  const replacement = createHumanLotAssessment(
    command(replacing, a, "review"),
    replacing,
    metadata(),
  );
  assert.equal(replacement.previousEntry?.entryHash, committed.entry.entryHash);
  assert.equal(replacement.evaluationSet.entries.length, 2);
});

test("Editing only B preserves A and its original evidence while invalidating B; identical observation does not stamp a new review", () => {
  let i = assess(input());
  i = assess(i, b, "review");
  const original = i.evaluationSet!.entries.find(
    (e) => e.target.kind === "lot" && e.target.lotId === aId,
  )!;
  const changed = raw();
  changed.lots[1].orderDescription.it += " Ulteriore corpo esclusivo B.";
  const result = resolveProjectLotAssessment({
    ...i,
    snapshot: snapshot(changed, "observation-2"),
    publication: { ...i.publication, revision: "global-revision-2" },
  });
  assert.deepEqual(
    result.lots.map((l) => l.state),
    ["current", "stale"],
  );
  assert.equal(result.lots[1].issue, "stale_source");
  assert.equal(result.lots[0].evaluation?.entryHash, original.entryHash);
  assert.equal(
    result.lots[0].evaluation?.immutableEvidenceSnapshotId,
    observationIdFor("observation-1"),
  );
  assert.equal(result.signalEligible, true);
  const repeated = resolveProjectLotAssessment({
    ...i,
    snapshot: snapshot(raw(), "observation-3"),
  });
  assert.deepEqual(
    repeated.lots.map((l) => l.state),
    ["current", "current"],
  );
  assert.equal(repeated.lots[0].evaluation?.id, original.id);
});

test("Historical evidence must be present under the exact immutable ID, with exact quotes and scope", () => {
  const initial = input();
  const evidenceSnapshot = snapshot(raw(), "evidence-only-observation");
  const i = assess({ ...initial, snapshot: evidenceSnapshot });
  const changed = raw();
  changed.lots[1].orderDescription.it += " changed B";
  const next = {
    ...i,
    snapshot: snapshot(
      changed,
      "observation-next",
      null,
      "evidence-only-observation",
    ),
  };
  const absent = resolveProjectLotAssessment(next);
  assert.equal(absent.lots[0].issue, "evidence_snapshot_missing");
  assert.equal(absent.signalEligible, false);
  const present = resolveProjectLotAssessment({
    ...next,
    evidenceSnapshots: [evidenceSnapshot],
  });
  assert.equal(present.lots[0].state, "current");
  const tampered = signed(i.evaluationSet!.entries[0], (entry) => {
    entry.evidence[0].quote = "Invented replacement quote";
  });
  assert.equal(
    resolveProjectLotAssessment({
      ...withEntry(next, tampered),
      evidenceSnapshots: [evidenceSnapshot],
    }).lots[0].issue,
    "evidence_mismatch",
  );
  const foreignRef = signed(i.evaluationSet!.entries[0], (entry) => {
    entry.evidence[0].rawPath = "/lots/1/orderDescription/it";
  });
  assert.equal(
    resolveProjectLotAssessment({
      ...withEntry(next, foreignRef),
      evidenceSnapshots: [evidenceSnapshot],
    }).lots[0].issue,
    "evidence_mismatch",
  );
  assert.throws(
    () =>
      resolveProjectLotAssessment({
        ...next,
        evidenceSnapshots: [
          snapshot(changed, "evidence-only-observation"),
          evidenceSnapshot,
        ],
      }),
    /Reused immutable/,
  );
});

test("One immutable acquisition can retain required and resolved editorial snapshots without reviving an old assessment", () => {
  const i = assess(input());
  const required: SourceScopeReview = {
    status: "required",
    kind: "ambiguous",
    token: "editorial-review-required",
    sourceRevision: "source-revision",
    updatedAt: now.toISOString(),
  };
  const requiredSnapshot = snapshot(raw(), "observation-1", required);
  const requiredRecord = sourceRecord(
    requiredSnapshot,
    project,
    i.history,
    "broad_scope",
  );
  const requiredHistory = [...i.history, requiredRecord];
  const blocked = resolveProjectLotAssessment({
    ...i,
    snapshot: requiredSnapshot,
    history: requiredHistory,
    publication: { ...i.publication, sourceScopeReview: required },
  });
  assert.equal(blocked.signalEligible, false);
  assert.equal(blocked.lots[0].state, "stale");

  const resolved: SourceScopeReview = {
    ...required,
    status: "resolved",
    token: "editorial-review-resolved",
  };
  const resolvedSnapshot = snapshot(raw(), "observation-1", resolved);
  assert.notEqual(requiredSnapshot.snapshotHash, resolvedSnapshot.snapshotHash);
  assert.deepEqual(requiredSnapshot.acquisition, resolvedSnapshot.acquisition);
  const projectReview = sourceRecord(
    resolvedSnapshot,
    project,
    requiredHistory,
    "broad_scope",
  );
  const lotReview = sourceRecord(resolvedSnapshot, a, [
    ...requiredHistory,
    projectReview,
  ]);
  const reviewed = {
    ...i,
    snapshot: resolvedSnapshot,
    history: [...requiredHistory, projectReview, lotReview],
    publication: { ...i.publication, sourceScopeReview: resolved },
    evidenceSnapshots: [requiredSnapshot],
  };
  const old = resolveProjectLotAssessment(reviewed);
  assert.equal(old.lots[0].issue, "stale_source");
  assert.equal(old.signalEligible, false);
  const renewed = resolveProjectLotAssessment(assess(reviewed));
  assert.equal(renewed.lots[0].state, "current");
  assert.equal(renewed.signalEligible, true);
  assert.equal(
    renewed.lots[0].evaluation?.immutableEvidenceSnapshotId,
    observationIdFor("observation-1"),
  );

  const changedArchive = raw();
  changedArchive.lots[1].orderDescription.it += " Another acquisition body.";
  assert.throws(
    () =>
      resolveProjectLotAssessment({
        ...reviewed,
        evidenceSnapshots: [
          requiredSnapshot,
          snapshot(changedArchive, "observation-1", resolved),
        ],
      }),
    /Reused immutable evidence snapshot id/,
  );
  const tampered = structuredClone(requiredSnapshot) as any;
  tampered.sourceScopeReview.token = "not-bound-by-snapshot-hash";
  assert.throws(
    () =>
      resolveProjectLotAssessment({
        ...reviewed,
        evidenceSnapshots: [tampered],
      }),
    /Altered lot evidence snapshot/,
  );
});

test("Shared content, provenance, index, profile and operational changes cannot retain a positive", () => {
  const i = assess(input());
  const shared = raw();
  shared.procurement.orderDescription.it += " Nuove condizioni condivise.";
  assert.equal(
    resolveProjectLotAssessment({
      ...i,
      snapshot: snapshot(shared, "obs-shared"),
    }).lots[0].state,
    "stale",
  );
  const indexed = raw();
  indexed.base.lots.reverse();
  indexed.lots.reverse();
  assert.equal(
    resolveProjectLotAssessment({
      ...i,
      snapshot: snapshot(indexed, "obs-index"),
    }).lots[1].state,
    "stale",
  );
  const nextIdentity = {
    ...identity,
    publicationId: "90000000-0000-4000-8000-000000000009",
    detailUrl: identity.detailUrl.replace(
      sourcePublicationId,
      "90000000-0000-4000-8000-000000000009",
    ),
  };
  const changed = raw();
  changed.id = nextIdentity.publicationId;
  changed.base.id = nextIdentity.publicationId;
  const provenance = registerSnapshot(
    captureLotSourceSnapshot({
      publicationId,
      observationId: observationIdFor("obs-provenance"),
      acquisition: {
        state: "accepted",
        archive: preserveSimapLots(changed, nextIdentity),
      },
      sourceScopeReview: null,
    }),
  );
  assert.equal(
    resolveProjectLotAssessment({ ...i, snapshot: provenance }).lots[0].state,
    "stale",
  );
  assert.equal(
    resolveProjectLotAssessment({
      ...i,
      profile: { ...i.profile, activities: "Altre attività inventate" },
    }).lots[0].issue,
    "stale_profile",
  );
  const closed = resolveProjectLotAssessment({
    ...i,
    publication: { ...i.publication, status: "closed" },
  });
  assert.equal(closed.signalEligible, false);
  assert.equal(closed.lots[0].issue, "stale_operational_input");
  assert.equal(closed.quality, "unresolved");
  const version = signed(i.evaluationSet!.entries[0], (entry) => {
    entry.dependency.comparisonVersion = "old-human-comparison";
  });
  assert.equal(
    resolveProjectLotAssessment(withEntry(i, version)).lots[0].issue,
    "stale_version",
  );
  for (const previous of [
    "lot-operational-prefilter-v1",
    "lot-operational-prefilter-v2",
  ]) {
    const oldFilter = signed(i.evaluationSet!.entries[0], (entry) => {
      entry.dependency.prefilterVersion = previous;
    });
    const withOldFilter = withEntry(i, oldFilter);
    const preserved = JSON.stringify(withOldFilter.evaluationSet);
    const updated = resolveProjectLotAssessment(withOldFilter);
    assert.equal(updated.lots[0].issue, "stale_version");
    assert.equal(updated.signalEligible, false);
    assert.equal(JSON.stringify(withOldFilter.evaluationSet), preserved);
  }
});

test("Project source barriers, broad or unclear lots, and operational vetoes cannot be bypassed by direct", () => {
  for (const form of ["broad_scope", "unclear", "conflicting"] as const) {
    const i = input({ aForm: form });
    assert.throws(
      () => createHumanLotAssessment(command(i), i, metadata()),
      /defined current target/,
    );
    assert.throws(
      () => createHumanLotAssessment(command(i, a, "different"), i, metadata()),
      /defined current target/,
    );
    assert.equal(
      resolveProjectLotAssessment(assess(i, a, "review")).quality,
      "unresolved",
    );
  }
  const i = assess(input());
  const sourceScopeReview: SourceScopeReview = {
    status: "required",
    kind: "ambiguous",
    token: "pending-source-check",
    sourceRevision: "revision",
    updatedAt: now.toISOString(),
  };
  const blocked = {
    ...i,
    snapshot: snapshot(raw(), "blocked-observation", sourceScopeReview),
    publication: { ...i.publication, sourceScopeReview },
  };
  assert.equal(resolveProjectLotAssessment(blocked).signalEligible, false);
  assert.equal(
    resolveProjectLotAssessment(blocked).projectBarrier.state,
    "blocked",
  );
  const blockedBinding =
    resolveProjectLotAssessment(blocked).projectBindingHash;
  const blockedRejection = resolveProjectLotAssessment({
    ...blocked,
    suppression: {
      active: true,
      reason: "Veto progetto anche con fonte aperta",
      rejection: {
        bindingHash: blockedBinding,
        eventId: "blocked-project-rejection",
        at: now.toISOString(),
      },
    },
  });
  assert.equal(blockedRejection.quality, "unresolved");
  assert.equal(blockedRejection.signalEligible, false);
  assert.throws(
    () => createHumanLotAssessment(command(blocked), blocked, metadata()),
    /defined current target/,
  );
  const cancelled = {
    ...input(),
    publication: { ...i.publication, status: "cancelled" as const },
  };
  assert.throws(
    () => createHumanLotAssessment(command(cancelled), cancelled, metadata()),
    /operational exclusion/,
  );
  const excluded = {
    ...input(),
    profile: { ...i.profile, exclusions: ["potatura"] },
  };
  assert.throws(
    () => createHumanLotAssessment(command(excluded), excluded, metadata()),
    /operational exclusion/,
  );
  const beforePublication = resolveProjectLotAssessment({
    ...i,
    now: new Date("2029-12-31T10:00:00.000Z"),
  });
  assert.equal(beforePublication.signalEligible, false);
});

test("Project veto and client dismissal suppress delivery without replacing human judgments or quality", () => {
  const i = assess(input()),
    base = resolveProjectLotAssessment(i);
  const legacy = resolveProjectLotAssessment({
    ...i,
    suppression: { active: true, reason: "Rifiuto storico progetto" },
  });
  assert.equal(legacy.signalEligible, false);
  assert.equal(legacy.quality, "unresolved");
  assert.equal(legacy.lots[0].evaluation?.result, "direct");
  const suppressed = resolveProjectLotAssessment({
    ...i,
    suppression: {
      active: true,
      reason: "Rifiuto umano dell’intero progetto",
      rejection: {
        bindingHash: base.projectBindingHash,
        eventId: "project-rejection-1",
        at: now.toISOString(),
      },
    },
  });
  assert.equal(suppressed.quality, "rejected");
  assert.deepEqual(suppressed.qualityEventIds, ["project-rejection-1"]);
  const renewed = assess(i, b, "direct");
  const stillSuppressed = resolveProjectLotAssessment({
    ...renewed,
    suppression: {
      active: true,
      reason: "Veto ancora attivo",
      rejection: {
        bindingHash: base.projectBindingHash,
        eventId: "project-rejection-1",
        at: now.toISOString(),
      },
    },
  });
  assert.equal(stillSuppressed.signalEligible, false);
  assert.equal(stillSuppressed.quality, "unresolved");
  const reopened = resolveProjectLotAssessment({
    ...renewed,
    suppression: { active: false, reason: "Riconsiderato" },
  });
  assert.equal(reopened.quality, "approved");
  assert.equal(reopened.qualityEventIds.length, 2);
  const dismissed = resolveProjectLotAssessment({
    ...i,
    feedback: { dismissed: true, saved: true, relevant: false },
  });
  assert.equal(dismissed.signalEligible, false);
  assert.equal(dismissed.quality, "approved");
  assert.equal(dismissed.saved, true);
  assert.equal(dismissed.lots[0].evaluation?.result, "direct");
});

test("Removed UUIDs remain historical and are never transferred to a replacement with the same number/title", () => {
  const i = assess(input());
  const changed = raw(),
    cId = "50000000-0000-4000-8000-000000000005";
  changed.base.lots[0].id = cId;
  changed.lots[0].id = cId;
  const result = resolveProjectLotAssessment({
    ...i,
    snapshot: snapshot(changed, "replacement-observation"),
    feedback: { saved: true },
  });
  assert.equal(result.lots[0].target.lotId, cId);
  assert.equal(result.lots[0].state, "missing");
  const old = result.lots.find((l) => l.target.lotId === aId)!;
  assert.equal(old.state, "removed-or-unresolved");
  assert.equal(old.evaluation?.result, "direct");
  assert.equal(result.saved, true);
  assert.equal(result.signalEligible, false);
  assert.equal(result.allDifferent, false);
  assert.equal(
    projectLotAssessmentDto(result).lots.find((l) => l.lotId === aId)?.result,
    null,
  );
});

test("Refused, absent, null and empty lot observations stay unresolved without legacy positives or fake cancellations", () => {
  const i = assess(input());
  const receipt = {
    url: identity.detailUrl,
    receivedAt: "2030-01-01T00:00:00.000Z",
    bodyByteLength: 1,
    bodySha256: createHash("sha256").update(Uint8Array.of(0xff)).digest("hex"),
  };
  const refusedId = observationIdFor("refused-observation");
  observationRows.set(refusedId, {
    id: refusedId,
    publicationId,
    sourceProjectId: projectId,
    sourcePublicationId,
    state: "refused",
    createdAt: new Date(receipt.receivedAt),
    request: createDocumentaryRequest({
      id: refusedId,
      identity,
      startedAt: receipt.receivedAt,
      observedPublication: {
        revision: "editorial-retained",
        documentarySnapshotId: i.snapshot.observationId,
      },
    }),
    acquisition: {
      version: SIMAP_ACQUISITION_VERSION,
      identity,
      receipt,
      state: "refused",
      sourceRevision: null,
      refusal: { stage: "decode", code: "invalid_utf8" },
    },
  });
  const refused = captureLotSourceSnapshot({
    publicationId,
    observationId: refusedId,
    acquisition: {
      state: "refused",
      identity,
      reason: "decode:invalid_utf8",
      receiptHash: createHash("sha256")
        .update(stableDocumentaryJson(receipt))
        .digest("hex"),
    },
    sourceScopeReview: null,
  });
  const result = resolveProjectLotAssessment({ ...i, snapshot: refused });
  assert.equal(result.state, "input_refused");
  assert.equal(result.quality, "unresolved");
  assert.equal(result.signalEligible, false);
  assert.equal(result.lots[0].state, "removed-or-unresolved");
  const refusedRejection = resolveProjectLotAssessment({
    ...i,
    snapshot: refused,
    suppression: {
      active: true,
      reason: "Veto conservato senza voto fonte",
      rejection: {
        bindingHash: result.projectBindingHash,
        eventId: "refused-project-rejection",
        at: now.toISOString(),
      },
    },
  });
  assert.equal(refusedRejection.quality, "unresolved");
  assert.equal(refusedRejection.suppressed, true);
  assert.equal(
    resolveProjectLotAssessment({
      ...i,
      snapshot: refused,
      evaluationSet: null,
    }).quality,
    "unresolved",
  );
  for (const variant of ["absent", "null", "empty"]) {
    const value: any = raw();
    delete value.base.lotsType;
    if (variant === "absent") {
      delete value.lots;
      delete value.base.lots;
    }
    if (variant === "null") {
      value.lots = null;
      value.base.lots = null;
    }
    if (variant === "empty") {
      value.lots = [];
      value.base.lots = [];
    }
    const observation = snapshot(value, `obs-${variant}`);
    const unresolved = resolveProjectLotAssessment({
      ...i,
      snapshot: observation,
    });
    assert.equal(unresolved.quality, "unresolved");
    assert.equal(unresolved.allDifferent, false);
    assert.equal(unresolved.lots[0].state, "removed-or-unresolved");
  }
});

test("References require the selected lot, exact UTF16 boundaries and current selection; no client quote is trusted", () => {
  const i = input(),
    c = command(i);
  assert.throws(
    () =>
      createHumanLotAssessment(
        {
          ...c,
          references: [
            { ...c.references[0], rawPath: "/lots/1/orderDescription/it" },
          ],
        },
        i,
        metadata(),
      ),
    /another source target/,
  );
  assert.throws(
    () =>
      createHumanLotAssessment(
        { ...c, references: [{ ...c.references[0], endUtf16: 1 }] },
        i,
        metadata(),
      ),
    /splits Unicode/,
  );
  assert.throws(
    () =>
      createHumanLotAssessment(
        {
          ...c,
          references: [{ ...c.references[0], selectionHash: "b".repeat(64) }],
        },
        i,
        metadata(),
      ),
    /Stale/,
  );
  assert.throws(
    () =>
      createHumanLotAssessment(
        {
          ...c,
          references: [
            {
              ...c.references[0],
              rawPath: "/procurement/orderDescription/it",
              endUtf16: commonText.length,
            },
          ],
        },
        i,
        metadata(),
      ),
    /from the selected target/,
  );
  assert.throws(() =>
    createHumanLotAssessment(
      {
        ...c,
        references: [{ ...c.references[0], quote: "Client invented" }],
      } as any,
      i,
      metadata(),
    ),
  );
});

test("Identity, entry checksums and malformed JSON are fail-closed; object key order does not alter hashes", () => {
  const i = assess(input()),
    set = i.evaluationSet!;
  assert.throws(
    () => validateLotEvaluationSet(set, "another-company", publicationId),
    /another company/,
  );
  assert.throws(
    () =>
      validateLotEvaluationSet(
        { ...set, entries: [set.entries[0], set.entries[0]] },
        i.companyId,
        publicationId,
      ),
    /Duplicate/,
  );
  const changed = structuredClone(set);
  (changed.entries[0] as any).reason = "Rewritten human judgment";
  assert.throws(
    () => validateLotEvaluationSet(changed, i.companyId, publicationId),
    /Altered/,
  );
  const forgedTarget = signed(set.entries[0], (e) => {
    e.target.sourceProjectId = bId;
    e.dependency.source.target.sourceProjectId = bId;
  });
  assert.throws(
    () =>
      validateLotEvaluationSet(
        { ...set, entries: [forgedTarget] },
        i.companyId,
        publicationId,
      ),
    /target mismatch/,
  );
  const reordered = Object.fromEntries(
    Object.entries(structuredClone(set)).reverse(),
  );
  assert.equal(
    lotEvaluationSetToken(
      reordered as LotEvaluationSet,
      i.companyId,
      publicationId,
    ),
    lotEvaluationSetToken(set, i.companyId, publicationId),
  );
  let invoked = false;
  const getter: any = { ...set };
  Object.defineProperty(getter, "entries", {
    enumerable: true,
    get() {
      invoked = true;
      return [];
    },
  });
  assert.throws(
    () => validateLotEvaluationSet(getter, i.companyId, publicationId),
    /accessors/,
  );
  assert.equal(invoked, false);
  for (const invalid of ["\0", "\ud800"])
    assert.throws(
      () =>
        lotAssessmentProfileHash({
          ...i.profile,
          activities: `Bad value ${invalid}`,
        }),
      /Invalid lot assessment text/,
    );
  assert.throws(
    () => resolveProjectLotAssessment({ ...i, companyId: "other-company" }),
    /another company/,
  );
  assert.throws(
    () =>
      resolveProjectLotAssessment({
        ...i,
        publication: { ...i.publication, externalId: bId },
      }),
    /identity mismatch/,
  );
});

function withoutLots() {
  const detail = raw();
  detail.base.lotsType = "without";
  detail.base.lots = [];
  detail.lots = [];
  detail.procurement.orderDescription.it =
    "Cura dei giardini: potatura e manutenzione del parco inventato, affidamento senza lotti.";
  Object.assign(detail.base, { processType: "open" });
  Object.assign(detail, {
    dates: { processType: "open", offerDeadline: "2030-02-01T13:00:00+01:00" },
  });
  Object.assign(detail.procurement, {
    cpvCode: { code: "77310000" },
    orderAddress: { countryId: "CH", cantonId: "TI", city: "Lugano" },
  });
  return detail;
}
function projectInput(): LotAssessmentInput {
  const initial = input();
  const current = snapshot(withoutLots(), "project-first");
  const reviewed = sourceRecord(
    current,
    project,
    initial.history,
    "defined_service",
  );
  return withShape({
    ...initial,
    snapshot: current,
    history: [...initial.history, reviewed],
  });
}

test("An explicitly without project has a current project judgment and operational confirmation, without fake lots", () => {
  const i = projectInput(),
    pending = resolveProjectLotAssessment(i);
  assert.equal(pending.shape.kind, "project");
  assert.equal(pending.targets.length, 1);
  assert.equal(pending.lots.length, 0);
  assert.equal(pending.targets[0].target.kind, "project");
  assert.equal(pending.signalEligible, false);
  const c = command(i, project);
  assert.ok(c.confirmedReviewReasons.some((x) => x.includes("Importo")));
  assert.throws(
    () =>
      createHumanLotAssessment(
        { ...c, confirmedReviewReasons: [] },
        i,
        metadata(),
      ),
    ReviewConflict,
  );
  const positive = assess(i, project),
    result = resolveProjectLotAssessment(positive);
  assert.equal(result.quality, "approved");
  assert.equal(result.signalEligible, true);
  assert.deepEqual(result.relevantLotIds, []);
  assert.deepEqual(result.relevantTargets, [project]);
  assert.equal(result.projectAssessment?.state, "current");
  assert.equal(
    result.projectAssessment?.preliminary?.operational.deadline,
    "2030-02-01T12:00:00.000Z",
  );
  assert.match(result.reason, /progetto/i);
  const dto = projectLotAssessmentDto(result);
  assert.ok(!JSON.stringify(dto).includes("PRIVATE_NOTE"));
  assert.ok(!JSON.stringify(dto).includes("private-actor"));
  const rejected = resolveProjectLotAssessment(assess(i, project, "different"));
  assert.equal(rejected.allDifferent, true);
  assert.equal(rejected.quality, "rejected");
  assert.equal(rejected.signalEligible, false);
  assert.throws(
    () =>
      createAssessment(
        c,
        { ...i, shapeState: structuredClone(i.shapeState) },
        metadata(),
      ),
    /Unverified/,
  );
  const originalLotInput = input();
  assert.throws(
    () =>
      createHumanLotAssessment(
        command(originalLotInput, project),
        originalLotInput,
        metadata(),
      ),
    /absent.*structure/,
  );
});

test("Project→lots→identical project does not revive old company or source certainty, and preserves canonical suppression", () => {
  const i = assess(projectInput(), project),
    originalEntry = stable(i.evaluationSet!.entries[0]);
  const lots = snapshot(raw(), "lots-middle", null, "project-first");
  const middle = { ...i, snapshot: lots, evidenceSnapshots: [i.snapshot] };
  const m = resolveProjectLotAssessment(middle);
  assert.equal(m.shape.kind, "lots");
  assert.equal(m.signalEligible, false);
  assert.equal(
    m.targets.find((t) => t.target.kind === "project")?.state,
    "removed-or-unresolved",
  );
  const back = snapshot(withoutLots(), "project-back", null, "lots-middle");
  const returned = { ...i, snapshot: back, evidenceSnapshots: [i.snapshot] };
  const old = resolveProjectLotAssessment(returned);
  assert.equal(old.projectAssessment?.issue, "stale_structure");
  assert.equal(old.projectBarrier.state, "blocked");
  assert.equal(old.quality, "unresolved");
  assert.equal(old.signalEligible, false);
  assert.equal(stable(i.evaluationSet!.entries[0]), originalEntry);
  assert.throws(
    () =>
      createHumanLotAssessment(
        command(returned, project),
        returned,
        metadata(),
      ),
    /defined current target/,
  );
  const freshSource = sourceRecord(back, project, i.history);
  const refreshed = { ...returned, history: [...i.history, freshSource] };
  const fresh = assess(refreshed, project);
  assert.equal(resolveProjectLotAssessment(fresh).quality, "approved");
  const suppressed = resolveProjectLotAssessment({
    ...fresh,
    suppression: {
      active: true,
      reason: "Veto progetto conservato attraverso il cambio struttura",
    },
    feedback: { saved: true, dismissed: true },
  });
  assert.equal(suppressed.signalEligible, false);
  assert.equal(suppressed.saved, true);
  assert.equal(suppressed.projectAssessment?.evaluation?.result, "direct");
});

test("A genuine v1 fixture stays byte-identical through decoding and a mixed v2 write, but cannot survive an intervening shape", () => {
  const i = assess(input());
  // Construct the invented legacy fixture once under its original algorithm;
  // the decoder/consumer must never rewrite its body or checksum afterwards.
  const entry = signed(i.evaluationSet!.entries[0], (body) => {
    delete body.dependency.shapeEpochToken;
    body.dependency.version = "lot-evaluation-dependency-v1";
    body.dependency.comparisonVersion = "human-lot-assessment-v1";
  });
  const fixture = {
    version: "lot-evaluations-v1",
    companyId: i.companyId,
    publicationId,
    entries: [entry],
  };
  const bytes = stable(fixture),
    entryBytes = stable(entry);
  const decoded = validateLotEvaluationSet(fixture, i.companyId, publicationId);
  assert.equal(stable(decoded), bytes);
  const legacy = { ...i, evaluationSet: decoded };
  assert.equal(resolveProjectLotAssessment(legacy).lots[0].state, "current");
  const mixed = assess(legacy, b, "review");
  assert.equal(mixed.evaluationSet.version, "lot-evaluations-v2");
  assert.equal(
    stable(
      mixed.evaluationSet.entries.find((e) =>
        sameAssessmentTarget(e.target, a),
      ),
    ),
    entryBytes,
  );
  assert.equal(stable(fixture), bytes);
  snapshot(withoutLots(), "v1-project-middle");
  const back = snapshot(raw(), "v1-lots-back", null, "v1-project-middle");
  const stale = resolveProjectLotAssessment({ ...legacy, snapshot: back });
  assert.equal(stale.lots[0].issue, "stale_structure");
  assert.equal(stale.signalEligible, false);
  assert.equal(stable(decoded), bytes);
});

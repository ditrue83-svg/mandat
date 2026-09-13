import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import type {
  CompanyProfile,
  Publication,
  SourceScopeReview,
} from "../src/lib/domain";
import { preserveSimapLots, type Identity } from "../src/lib/source-lots";
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
import { preliminaryLotMatch } from "../src/lib/lot-matching";
import {
  createHumanLotAssessment,
  lotAssessmentProfileHash,
  lotEvaluationSetToken,
  projectLotAssessmentDto,
  resolveProjectLotAssessment,
  validateLotEvaluationSet,
  type HumanLotAssessmentCommand,
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
function snapshot(
  detail = raw(),
  observationId = "observation-1",
  sourceScopeReview: SourceScopeReview | null = null,
) {
  return captureLotSourceSnapshot({
    publicationId,
    observationId,
    acquisition: {
      state: "accepted",
      archive: preserveSimapLots(detail, identity),
    },
    sourceScopeReview,
  });
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
  return {
    companyId: "company-invented",
    publication,
    profile,
    snapshot: snap,
    history: [p, ar, br],
    evaluationSet: null,
    now,
  };
}
function command(
  i: LotAssessmentInput,
  target = a,
  result: LotAssessmentResult = "direct",
): HumanLotAssessmentCommand {
  const context = resolveLotSourceContext(i.snapshot, target, i.history);
  const preliminary = preliminaryLotMatch({
    publication: i.publication,
    profile: i.profile,
    context,
    now: i.now,
  });
  return {
    target,
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
      i.evaluationSet?.entries.find((e) => e.target.lotId === target.lotId)
        ?.entryHash ?? null,
    result,
    reason: `${target.lotId === aId ? "Lotto A" : "Lotto B"}: giudizio umano inventato ${result}.`,
    references: [
      {
        selectionHash: context.dependency.selectionHash!,
        rawPath:
          target.lotId === aId
            ? "/lots/0/orderDescription/it"
            : "/lots/1/orderDescription/it",
        startUtf16: 0,
        endUtf16: target.lotId === aId ? aText.length : bText.length,
      },
    ],
    origin: "human",
    confirmedReviewReasons:
      result === "direct" ? preliminary.reviewReasons : [],
  };
}
function assess(
  i: LotAssessmentInput,
  target = a,
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
  return { ...i, evaluationSet: { ...i.evaluationSet!, entries: [entry] } };
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
    committed.evaluationSet.entries.map((e) => e.target.lotId),
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
    (e) => e.target.lotId === aId,
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
    "observation-1",
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
  const next = { ...i, snapshot: snapshot(changed, "observation-next") };
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
    "observation-1",
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
  const provenance = captureLotSourceSnapshot({
    publicationId,
    observationId: "obs-provenance",
    acquisition: {
      state: "accepted",
      archive: preserveSimapLots(changed, nextIdentity),
    },
    sourceScopeReview: null,
  });
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
});

test("Project source barriers, broad or unclear lots, and operational vetoes cannot be bypassed by direct", () => {
  for (const form of ["broad_scope", "unclear", "conflicting"] as const) {
    const i = input({ aForm: form });
    assert.throws(
      () => createHumanLotAssessment(command(i), i, metadata()),
      /defined lot/,
    );
    assert.throws(
      () => createHumanLotAssessment(command(i, a, "different"), i, metadata()),
      /defined lot/,
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
    /defined lot/,
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
  const refused = captureLotSourceSnapshot({
    publicationId,
    observationId: "refused-observation",
    acquisition: {
      state: "refused",
      identity,
      reason: "invalid_utf8",
      receiptHash: "e".repeat(64),
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
    /from that lot/,
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

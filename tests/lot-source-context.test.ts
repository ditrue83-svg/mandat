import assert from "node:assert/strict";
import { test } from "vitest";
import type { SourceScopeReview } from "../src/lib/domain";
import { preserveSimapLots, type Identity } from "../src/lib/source-lots";
import {
  captureSourceSnapshot,
  createSourceReviewRecord,
  ReviewConflict,
  type HumanSourceForm,
} from "../src/lib/source-review-context";
import {
  captureLotSourceSnapshot,
  createLotSourceReviewRecord,
  isLotSourceDependencyCurrent,
  LOT_SOURCE_CONTEXT_VERSION,
  resolveLotSourceContext,
  verifyLotSourceHistory,
  type LotSourceSnapshot,
  type LotSourceReviewCommand,
  type LotSourceTarget,
  type MixedSourceReviewRecord,
} from "../src/lib/lot-source-context";

// All text, identities, forms and human judgments in these tests are invented.
const projectId = "1a000000-0000-4000-8000-000000000001";
const sourcePublicationId = "20000000-0000-4000-8000-000000000002";
const lotA = "3a000000-0000-4000-8000-000000000003";
const lotB = "4b000000-0000-4000-8000-000000000004";
const publicationId = `simap-${projectId}`;
const identity: Identity = {
  projectId,
  publicationId: sourcePublicationId,
  detailUrl: `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${sourcePublicationId}`,
};
const projectTarget: LotSourceTarget = { kind: "project", publicationId };
const aTarget: LotSourceTarget = {
  kind: "lot",
  publicationId,
  sourceProjectId: projectId,
  lotId: lotA,
};
const bTarget: LotSourceTarget = {
  kind: "lot",
  publicationId,
  sourceProjectId: projectId,
  lotId: lotB,
};
const aText = "🌳 Potatura e cura del verde inventato; e\u0301 / é.";
const bText = "SOLO_LOTTO_B: installazione dei quadri inventati.";
const commonText =
  "Gestione del complesso inventato, con prestazioni suddivise in lotti.";

function detail() {
  return {
    id: sourcePublicationId,
    "project-info": {
      title: { it: "Progetto inventato", fr: "Projet fictif" },
    },
    procurement: {
      orderDescription: { it: commonText },
      future: { "a/b~c": ["z", "a"] },
    },
    base: {
      id: sourcePublicationId,
      projectId,
      lotsType: "with",
      lots: [
        { id: lotA, lotNumber: 1, title: { it: "Verde del lotto A" } },
        { id: lotB, lotNumber: 2, title: { it: "Impianti del lotto B" } },
      ],
    },
    lots: [
      {
        id: lotA,
        lotNumber: 1,
        title: { it: "Verde del lotto A" },
        orderDescription: { it: aText },
        terms: { note: "Nota del lotto A" },
      },
      {
        id: lotB,
        lotNumber: 2,
        title: { it: "Impianti del lotto B" },
        orderDescription: { it: bText },
        terms: { note: "SOLO_LOTTO_B: condizione" },
      },
    ],
  };
}

function snapshot(
  raw = detail(),
  observationId = "observation-1",
  sourceScopeReview: SourceScopeReview | null = null,
) {
  return captureLotSourceSnapshot({
    publicationId,
    observationId,
    acquisition: {
      state: "accepted",
      archive: preserveSimapLots(raw, identity),
    },
    sourceScopeReview,
  });
}

let eventSequence = 0;
function metadata() {
  return {
    id: `invented-event-${++eventSequence}`,
    sourceRevision: "source-revision",
    contentRevision: "content-revision",
    createdAt: "2030-01-01T12:00:00.000Z",
  };
}

function command(
  current: LotSourceSnapshot,
  target: LotSourceTarget,
  history: readonly MixedSourceReviewRecord[] = [],
  form: HumanSourceForm = "defined_service",
): LotSourceReviewCommand {
  const context = resolveLotSourceContext(current, target, history);
  const rawPath =
    target.kind === "project"
      ? "/procurement/orderDescription/it"
      : target.lotId === lotA
        ? "/lots/0/orderDescription/it"
        : "/lots/1/orderDescription/it";
  const original =
    target.kind === "project"
      ? commonText
      : target.lotId === lotA
        ? aText
        : bText;
  return {
    target,
    expectedSnapshotHash: current.snapshotHash,
    expectedSelectionHash: context.dependency.selectionHash,
    expectedTargetEventId: context.dependency.reviewEventId,
    expectedProjectBarrierHash: context.projectBarrier.barrierHash,
    action: "recorded",
    form,
    references: [
      {
        selectionHash: context.dependency.selectionHash!,
        rawPath,
        startUtf16: 0,
        endUtf16: original.length,
      },
    ],
    actorId: "invented-human",
    note: "Giudizio inventato per verificare il protocollo, non l'idoneità della ditta.",
  };
}

function record(
  current: LotSourceSnapshot,
  target: LotSourceTarget,
  history: readonly MixedSourceReviewRecord[] = [],
  form: HumanSourceForm = "defined_service",
) {
  return createLotSourceReviewRecord(
    command(current, target, history, form),
    current,
    history,
    metadata(),
  );
}

function reviewed(current = snapshot()) {
  const project = record(current, projectTarget, [], "broad_scope");
  const a = record(current, aTarget, [project]);
  const b = record(current, bTarget, [project, a]);
  return {
    current,
    project,
    a,
    b,
    history: [project, a, b] as MixedSourceReviewRecord[],
  };
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverseKeys(item)]),
    );
  return value;
}

test("Snapshots bind the application publication to the archived source project, including refused acquisitions", () => {
  const acquisition = {
    state: "accepted" as const,
    archive: preserveSimapLots(detail(), identity),
  };
  const source = {
    publicationId,
    observationId: "observation-1",
    acquisition,
    sourceScopeReview: null,
  };
  const current = captureLotSourceSnapshot(source);
  assert.equal(current.version, LOT_SOURCE_CONTEXT_VERSION);
  assert.ok(Object.isFrozen(current));
  assert.ok(Object.isFrozen(current.acquisition));
  assert.deepEqual(current.acquisition, acquisition);
  source.observationId = "caller-changed";
  assert.equal(current.observationId, "observation-1");
  const mutableInput = JSON.parse(JSON.stringify(source));
  const copied = captureLotSourceSnapshot(mutableInput);
  mutableInput.acquisition.archive.lotField.lots[0].orderDescription.it =
    "Changed caller archive";
  assert.equal(
    (
      resolveLotSourceContext(copied, aTarget, []).targetContent?.selectedLot
        ?.record as { orderDescription: { it: string } }
    ).orderDescription.it,
    aText,
  );
  assert.throws(() =>
    captureLotSourceSnapshot({
      ...source,
      publicationId: `simap-${lotB}`,
    }),
  );
  assert.throws(() =>
    captureLotSourceSnapshot({
      ...source,
      publicationId: `simap-${lotB}`,
      acquisition: {
        state: "refused",
        identity,
        reason: "invalid_utf8",
        receiptHash: "a".repeat(64),
      },
    }),
  );
  assert.throws(() =>
    resolveLotSourceContext(
      current,
      { ...aTarget, publicationId: "foreign" },
      [],
    ),
  );
  assert.throws(() =>
    resolveLotSourceContext(
      current,
      { kind: "lot", publicationId, sourceProjectId: lotB, lotId: lotA },
      [],
    ),
  );
});

test("A broad project review clears its barrier and a subsequent defined lot review receives only its own target content", () => {
  const current = snapshot();
  const before = resolveLotSourceContext(current, aTarget, []);
  assert.equal(before.state, "review_required");
  assert.equal(before.projectBarrier.state, "blocked");
  const project = record(current, projectTarget, [], "broad_scope");
  const projectContext = resolveLotSourceContext(current, projectTarget, [
    project,
  ]);
  assert.equal(projectContext.state, "manual_source");
  assert.equal(projectContext.form, "broad_scope");
  assert.equal(projectContext.projectBarrier.state, "clear");
  assert.equal(projectContext.targetContent?.selectedLot, null);
  assert.ok(
    !JSON.stringify(projectContext.targetContent).includes("SOLO_LOTTO_B"),
  );
  const a = record(current, aTarget, [project]);
  const context = resolveLotSourceContext(current, aTarget, [project, a]);
  assert.equal(context.state, "manual_source");
  assert.equal(context.form, "defined_service");
  assert.equal(context.review?.event.id, a.event.id);
  assert.equal(context.targetContent?.selectedLot?.path, "/lots/0");
  assert.ok(!JSON.stringify(context.targetContent).includes("SOLO_LOTTO_B"));
  assert.equal(a.event.evidence[0].quote, aText);
  assert.deepEqual(a.event.evidence[0].origin, {
    scope: "selected_lot",
    url: identity.detailUrl,
    language: "it",
    page: null,
    representation: "verbatim_raw_string_may_contain_html",
  });
  assert.equal("score" in context, false);
  assert.equal("approved" in context, false);
});

test("Latest review is tracked separately for A and B despite one shared append-only event chain", () => {
  const { current, history, a, b } = reviewed();
  const aBefore = resolveLotSourceContext(current, aTarget, history);
  const bBefore = resolveLotSourceContext(current, bTarget, history);
  assert.equal(aBefore.review?.event.id, a.event.id);
  assert.equal(bBefore.review?.event.id, b.event.id);
  const openedA = createLotSourceReviewRecord(
    {
      ...command(current, aTarget, history),
      action: "opened",
      form: null,
      references: [],
    },
    current,
    history,
    metadata(),
  );
  const later = [...history, openedA];
  assert.equal(openedA.event.previousEventId, b.event.id);
  assert.equal(openedA.event.sequence, 4);
  assert.equal(
    resolveLotSourceContext(current, aTarget, later).reason,
    "explicit_open",
  );
  assert.equal(
    resolveLotSourceContext(current, bTarget, later).state,
    "manual_source",
  );
  assert.equal(
    isLotSourceDependencyCurrent(aBefore.dependency, current, later),
    false,
  );
  assert.equal(
    isLotSourceDependencyCurrent(bBefore.dependency, current, later),
    true,
  );
});

test("Changing only B preserves A; shared fields, membership and selected provenance invalidate affected dependencies", () => {
  const { current, history } = reviewed();
  const a = resolveLotSourceContext(current, aTarget, history);
  const b = resolveLotSourceContext(current, bTarget, history);
  const changedB = detail();
  changedB.lots[1].orderDescription.it += " Rettifica B.";
  const bSnapshot = snapshot(changedB, "observation-b-update");
  assert.equal(
    isLotSourceDependencyCurrent(a.dependency, bSnapshot, history),
    true,
  );
  assert.equal(
    isLotSourceDependencyCurrent(b.dependency, bSnapshot, history),
    false,
  );
  assert.equal(
    resolveLotSourceContext(bSnapshot, aTarget, history).state,
    "manual_source",
  );
  assert.equal(
    resolveLotSourceContext(bSnapshot, bTarget, history).reason,
    "source_changed",
  );
  const shared = detail();
  shared.procurement.orderDescription.it += " Condizione comune aggiornata.";
  const sharedSnapshot = snapshot(shared, "shared-update");
  assert.equal(
    isLotSourceDependencyCurrent(a.dependency, sharedSnapshot, history),
    false,
  );
  assert.equal(
    isLotSourceDependencyCurrent(b.dependency, sharedSnapshot, history),
    false,
  );
  assert.equal(
    resolveLotSourceContext(sharedSnapshot, aTarget, history).projectBarrier
      .reason,
    "source_changed",
  );
  const membership = detail();
  membership.lots.pop();
  membership.base.lots.pop();
  assert.equal(
    isLotSourceDependencyCurrent(
      a.dependency,
      snapshot(membership, "membership-update"),
      history,
    ),
    false,
  );
  const provenance = detail();
  provenance.base.lots.reverse();
  const provenanceSnapshot = snapshot(provenance, "provenance-update");
  assert.equal(
    isLotSourceDependencyCurrent(a.dependency, provenanceSnapshot, history),
    false,
  );
  assert.equal(
    resolveLotSourceContext(provenanceSnapshot, aTarget, history).projectBarrier
      .state,
    "clear",
  );
  assert.equal(
    resolveLotSourceContext(provenanceSnapshot, aTarget, history).reason,
    "source_changed",
  );
});

test("A new observation ID over identical accepted data preserves review dependencies without restamping history", () => {
  const { current, history, a } = reviewed();
  const before = resolveLotSourceContext(current, aTarget, history);
  const next = snapshot(detail(), "new-observation-same-content");
  assert.notEqual(next.snapshotHash, current.snapshotHash);
  const after = resolveLotSourceContext(next, aTarget, history);
  assert.deepEqual(after.dependency, before.dependency);
  assert.equal(after.review?.event.id, a.event.id);
  const historicalSnapshot = after.review?.snapshot;
  if (historicalSnapshot?.version !== LOT_SOURCE_CONTEXT_VERSION)
    throw new Error("Expected v2 review snapshot");
  assert.equal(historicalSnapshot.observationId, current.observationId);
  assert.equal(after.state, "manual_source");
  assert.equal(
    isLotSourceDependencyCurrent(before.dependency, next, history),
    true,
  );
  assert.throws(
    () =>
      createLotSourceReviewRecord(
        command(current, aTarget, history),
        next,
        history,
        metadata(),
      ),
    ReviewConflict,
  );
});

test("References reject another lot, stale selections, duplicates, invalid paths and split UTF-16 characters", () => {
  const current = snapshot();
  const history = [record(current, projectTarget, [], "broad_scope")];
  const cmd = command(current, aTarget, history);
  const base = cmd.references[0];
  const invalidReferences = [
    [
      {
        ...base,
        rawPath: "/lots/1/orderDescription/it",
        endUtf16: bText.length,
      },
    ],
    [{ ...base, rawPath: "/base/lots/1/title/it", endUtf16: 5 }],
    [{ ...base, selectionHash: "0".repeat(64) }],
    [{ ...base, startUtf16: 1, endUtf16: 2 }],
    [{ ...base, rawPath: "/missing/path" }],
    [{ ...base, endUtf16: aText.length + 1 }],
    [base, base],
  ];
  for (const references of invalidReferences)
    assert.throws(() =>
      createLotSourceReviewRecord(
        { ...cmd, references },
        current,
        history,
        metadata(),
      ),
    );
  const projectCommand = command(
    current,
    projectTarget,
    history,
    "broad_scope",
  );
  assert.throws(() =>
    createLotSourceReviewRecord(
      {
        ...projectCommand,
        references: [
          { ...base, selectionHash: projectCommand.expectedSelectionHash! },
        ],
      },
      current,
      history,
      metadata(),
    ),
  );
  const emoji = createLotSourceReviewRecord(
    { ...cmd, references: [{ ...base, startUtf16: 0, endUtf16: 2 }] },
    current,
    history,
    metadata(),
  );
  assert.equal(emoji.event.evidence[0].quote, "🌳");
});

test("CAS binds snapshot, target review and project barrier without treating another lot's review as the target's latest", () => {
  const current = snapshot();
  const project = record(current, projectTarget, [], "broad_scope");
  const history = [project];
  const cmd = command(current, aTarget, history);
  for (const patch of [
    { expectedSnapshotHash: "0".repeat(64) },
    { expectedSelectionHash: "0".repeat(64) },
    { expectedTargetEventId: "foreign-event" },
    { expectedProjectBarrierHash: "0".repeat(64) },
  ])
    assert.throws(
      () =>
        createLotSourceReviewRecord(
          { ...cmd, ...patch },
          current,
          history,
          metadata(),
        ),
      ReviewConflict,
    );
  const b = record(current, bTarget, history);
  const validA = createLotSourceReviewRecord(
    cmd,
    current,
    [...history, b],
    metadata(),
  );
  assert.equal(validA.event.previousEventId, b.event.id);
  assert.throws(
    () =>
      createLotSourceReviewRecord(
        cmd,
        current,
        [...history, b, validA],
        metadata(),
      ),
    ReviewConflict,
  );
  const projectAgain = record(current, projectTarget, history, "broad_scope");
  assert.throws(
    () =>
      createLotSourceReviewRecord(
        cmd,
        current,
        [...history, projectAgain],
        metadata(),
      ),
    ReviewConflict,
  );
  const changed = detail();
  changed.lots[1].orderDescription.it += "Changed B";
  assert.throws(
    () =>
      createLotSourceReviewRecord(
        cmd,
        snapshot(changed, "after-B"),
        history,
        metadata(),
      ),
    ReviewConflict,
  );
});

test("A required legacy source barrier blocks lots and cannot be resolved by recording a lot or another project form", () => {
  const { history } = reviewed();
  const flag: SourceScopeReview = {
    status: "required",
    kind: "ambiguous",
    token: "legacy-required-token",
    sourceRevision: "source-revision",
    updatedAt: "2030-01-01T12:00:00.000Z",
  };
  const current = snapshot(detail(), "observation-flagged", flag);
  const blocked = resolveLotSourceContext(current, aTarget, history);
  assert.equal(blocked.state, "review_required");
  assert.equal(blocked.projectBarrier.reason, "legacy_required");
  const lotReview = record(current, aTarget, history);
  const afterLot = [...history, lotReview];
  assert.equal(
    resolveLotSourceContext(current, aTarget, afterLot).state,
    "review_required",
  );
  assert.equal(
    resolveLotSourceContext(current, aTarget, afterLot).projectBarrier.reason,
    "legacy_required",
  );
  const projectReview = record(current, projectTarget, afterLot, "broad_scope");
  assert.equal(
    resolveLotSourceContext(current, aTarget, [...afterLot, projectReview])
      .projectBarrier.state,
    "blocked",
  );
  assert.deepEqual(current.sourceScopeReview, flag);
});

test("Refused acquisitions and missing lots have explicit input-refused states and cannot receive source forms", () => {
  const { history } = reviewed();
  const current = captureLotSourceSnapshot({
    publicationId,
    observationId: "refused-observation",
    sourceScopeReview: null,
    acquisition: {
      state: "refused",
      identity,
      reason: "invalid_utf8",
      receiptHash: "a".repeat(64),
    },
  });
  for (const target of [projectTarget, aTarget]) {
    const context = resolveLotSourceContext(current, target, history);
    assert.equal(context.state, "input_refused");
    assert.equal(context.reason, "invalid_utf8");
    assert.equal(context.targetContent, null);
    assert.ok(context.dependency.inputRefusalHash);
    assert.throws(() => record(current, target, history));
    const opened = createLotSourceReviewRecord(
      {
        ...command(current, target, history),
        action: "opened",
        form: null,
        references: [],
      },
      current,
      history,
      metadata(),
    );
    assert.equal(
      resolveLotSourceContext(current, target, [...history, opened]).state,
      "input_refused",
    );
  }
  const withoutB = detail();
  withoutB.lots.pop();
  withoutB.base.lots.pop();
  const missing = snapshot(withoutB, "removed-B");
  const missingContext = resolveLotSourceContext(missing, bTarget, history);
  assert.equal(missingContext.state, "input_refused");
  assert.equal(missingContext.reason, "lot_missing_or_removed");
  assert.equal(missingContext.targetContent, null);
  assert.throws(() => record(missing, bTarget, history));
});

test("A valid v1 prefix remains unchanged but cannot clear the v2 project barrier or appear after a v2 event", () => {
  const legacyText = "Testo documentario precedente inventato.";
  const old = captureSourceSnapshot(publicationId, {
    sourceUrl: identity.detailUrl,
    originalText: legacyText,
  });
  if (!old.source.accepted) throw new Error("Legacy fixture rejected");
  const unit = old.source.corpus.units[0];
  const legacy = createSourceReviewRecord(
    {
      publicationId,
      expectedEventId: null,
      expectedSourceSnapshotHash: old.sourceSnapshotHash,
      expectedCorpusHash: old.source.corpus.inputHash,
      action: "recorded",
      form: "broad_scope",
      actorId: "old-human",
      note: "Revisione precedente inventata, da conservare invariata.",
      references: [
        {
          unitId: unit.id,
          originIndex: 0,
          startUtf16: 0,
          endUtf16: legacyText.length,
        },
      ],
    },
    old,
    [],
    metadata(),
  );
  const originalPayload = JSON.parse(JSON.stringify(legacy));
  const current = snapshot();
  assert.equal(
    resolveLotSourceContext(current, aTarget, [legacy]).projectBarrier.reason,
    "source_changed",
  );
  const project = record(current, projectTarget, [legacy], "broad_scope");
  assert.equal(project.event.sequence, 2);
  assert.equal(project.event.previousEventId, legacy.event.id);
  assert.equal(project.event.previousEventHash, legacy.event.eventHash);
  const checked = verifyLotSourceHistory(publicationId, [legacy, project]);
  assert.deepEqual(JSON.parse(JSON.stringify(checked[0])), originalPayload);
  assert.equal(checked[0].event.eventHash, legacy.event.eventHash);
  assert.equal(
    resolveLotSourceContext(current, aTarget, checked).projectBarrier.state,
    "clear",
  );
  assert.throws(() =>
    verifyLotSourceHistory(publicationId, [legacy, project, legacy]),
  );
  assert.throws(() => verifyLotSourceHistory("other-publication", [legacy]));
});

test("History and snapshots reject tampering and event reordering but tolerate JSON object key reordering", () => {
  const { current, project, a, b, history } = reviewed();
  assert.deepEqual(
    verifyLotSourceHistory(
      publicationId,
      reverseKeys(history) as MixedSourceReviewRecord[],
    ),
    verifyLotSourceHistory(publicationId, history),
  );
  assert.deepEqual(
    resolveLotSourceContext(
      reverseKeys(current) as LotSourceSnapshot,
      aTarget,
      history,
    ).dependency,
    resolveLotSourceContext(current, aTarget, history).dependency,
  );
  assert.throws(() => verifyLotSourceHistory(publicationId, [project, b, a]));
  assert.throws(() => verifyLotSourceHistory(publicationId, [...history, a]));
  const altered = JSON.parse(JSON.stringify(history));
  altered[1].event.evidence[0].quote = "Citazione sostituita";
  assert.throws(() => verifyLotSourceHistory(publicationId, altered));
  const changedSnapshot = JSON.parse(JSON.stringify(current));
  changedSnapshot.observationId = "unhashed-replacement";
  assert.throws(() =>
    resolveLotSourceContext(changedSnapshot, aTarget, history),
  );
  const changedArchive = JSON.parse(JSON.stringify(current));
  changedArchive.acquisition.archive.lotField.lots[0].orderDescription.it =
    "Altered archive";
  assert.throws(() =>
    resolveLotSourceContext(changedArchive, aTarget, history),
  );
  const dependency = {
    ...resolveLotSourceContext(current, aTarget, history).dependency,
    selectionHash: "0".repeat(64),
  };
  assert.equal(
    isLotSourceDependencyCurrent(dependency, current, history),
    false,
  );
});

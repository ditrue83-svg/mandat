import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { normalizeSimap } from "../src/sources/simap";
import { SIMAP_ACQUISITION_VERSION } from "../src/sources/simap-documentary";
import {
  createDocumentaryRequest,
  stableDocumentaryJson,
} from "../src/lib/documentary-observation";
import { preserveSimapLots } from "../src/lib/source-lots";
import {
  captureLotSourceSnapshot,
  createLotSourceReviewRecord,
  resolveLotSourceContext,
  type LotSourceSnapshot,
  type MixedSourceReviewRecord,
} from "../src/lib/lot-source-context";
import {
  deriveAssessmentShape,
  resolveAssessmentShapeHistory,
  assertAssessmentShapeHistory,
  isObservationInCurrentAssessmentEpoch,
  resolveAssessmentSourceContext,
  type DocumentarySnapshotRow,
} from "../src/lib/assessment-shape";

// Real request/normalizer/archive validators, invented bodies and receipts.
// These pure tests do not prove HTTP authenticity or database persistence.
const projectId = "ab100000-0000-4000-8000-000000000001";
const sourcePublicationId = "ab100000-0000-4000-8000-000000000002";
const lotId = "ab100000-0000-4000-8000-000000000003";
const publicationId = `simap-${projectId}`;
const identity = {
  projectId,
  publicationId: sourcePublicationId,
  detailUrl: `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${sourcePublicationId}`,
};
const target = { kind: "project" as const, publicationId };
const id = (n: number) =>
  `ab200000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function detail(shape: "project" | "lots" | "unknown" = "project") {
  return {
    id: sourcePublicationId,
    type: "tender",
    "project-info": { title: { it: "Manutenzione del parco inventato" } },
    procurement: {
      orderDescription: { it: "Potatura degli alberi nel parco inventato." },
    },
    dates: { offerDeadline: "2030-12-01T12:00:00+01:00" },
    base: {
      id: sourcePublicationId,
      projectId,
      lotsType:
        shape === "project" ? "without" : shape === "lots" ? "with" : null,
    } as Record<string, unknown>,
    ...(shape === "lots"
      ? {
          lots: [
            {
              id: lotId,
              lotNumber: 1,
              title: { it: "Lotto inventato" },
              orderDescription: { it: "Potatura degli alberi." },
            },
          ],
        }
      : {}),
  };
}
function observation(
  n: number,
  raw = detail(),
  parent: string | null = null,
): DocumentarySnapshotRow {
  const publication = normalizeSimap(
    {
      id: projectId,
      raw: {
        id: projectId,
        publicationId: sourcePublicationId,
        publicationDate: "2030-01-01",
        projectNumber: "INVENTED-SHAPE-1",
        pubType: "tender",
        processType: "open",
        title: { it: "Parco inventato" },
        procOfficeName: { it: "Ente inventato" },
      },
    },
    raw,
  );
  const bytes = Buffer.from(JSON.stringify(raw));
  return {
    id: id(n),
    publicationId,
    sourceProjectId: projectId,
    sourcePublicationId,
    state: "accepted",
    createdAt: new Date("2030-01-01T00:00:01Z"),
    request: createDocumentaryRequest({
      id: id(n),
      identity,
      startedAt: "2030-01-01T00:00:00.000Z",
      observedPublication:
        parent === null
          ? null
          : {
              revision: "editorial-correction-retained",
              documentarySnapshotId: parent,
            },
    }),
    acquisition: {
      version: SIMAP_ACQUISITION_VERSION,
      state: "accepted",
      identity,
      sourceRevision: publication.revision,
      archive: preserveSimapLots(raw, identity),
      receipt: {
        url: identity.detailUrl,
        receivedAt: "2030-01-01T00:00:01.000Z",
        bodyByteLength: bytes.length,
        bodySha256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
  };
}
function snapshot(row: DocumentarySnapshotRow) {
  const a = row.acquisition;
  return captureLotSourceSnapshot({
    publicationId,
    observationId: row.id,
    sourceScopeReview: null,
    acquisition:
      a.state === "accepted"
        ? { state: "accepted", archive: a.archive }
        : {
            state: "refused",
            identity: a.identity,
            reason: `${a.refusal.stage}:${a.refusal.code}`,
            receiptHash: createHash("sha256")
              .update(stableDocumentaryJson(a.receipt))
              .digest("hex"),
          },
  });
}
function proof(rows: DocumentarySnapshotRow[], current = rows.at(-1)!.id) {
  return resolveAssessmentShapeHistory({
    publicationId,
    currentObservationId: current,
    observations: rows,
  });
}
function sourceReview(
  current: LotSourceSnapshot,
  history: readonly MixedSourceReviewRecord[] = [],
) {
  const context = resolveLotSourceContext(current, target, history);
  return createLotSourceReviewRecord(
    {
      target,
      expectedSnapshotHash: current.snapshotHash,
      expectedSelectionHash: context.dependency.selectionHash,
      expectedTargetEventId: context.dependency.reviewEventId,
      expectedProjectBarrierHash: context.projectBarrier.barrierHash,
      action: "recorded",
      form: "defined_service",
      references: [
        {
          selectionHash: context.dependency.selectionHash!,
          rawPath: "/procurement/orderDescription/it",
          startUtf16: 0,
          endUtf16: 7,
        },
      ],
      actorId: "invented-reviewer",
      note: "Giudizio inventato per verificare esclusivamente il protocollo.",
    },
    current,
    history,
    {
      id: `source-event-${history.length}`,
      sourceRevision: "source",
      contentRevision: "editorial",
      createdAt: "2030-01-01T01:00:00.000Z",
    },
  );
}

test("Only an explicit coherent without marker yields a project target; absence and contradictions stay unresolved", () => {
  for (const empty of [undefined, null, []]) {
    const raw = detail();
    if (empty !== undefined) {
      raw.base.lots = empty;
      Object.assign(raw, { lots: empty });
    }
    const shape = deriveAssessmentShape(snapshot(observation(1, raw)));
    assert.equal(shape.kind, "project");
    assert.deepEqual(shape.targets, [target]);
    assert.equal(shape.evidence[0].rawPath, "/base/lotsType");
    assert.equal(shape.evidence[0].value, "without");
  }
  for (const marker of [null, undefined, "unknown", "WITHOUT"]) {
    const raw = detail();
    if (marker === undefined) delete raw.base.lotsType;
    else raw.base.lotsType = marker;
    assert.equal(
      deriveAssessmentShape(snapshot(observation(1, raw))).kind,
      "unresolved",
    );
  }
  const contradictory = detail("lots");
  contradictory.base.lotsType = "without";
  assert.equal(
    deriveAssessmentShape(snapshot(observation(1, contradictory))).kind,
    "unresolved",
  );
  const withoutMarker = detail("lots");
  delete withoutMarker.base.lotsType;
  assert.equal(
    deriveAssessmentShape(snapshot(observation(1, withoutMarker))).kind,
    "lots",
  );
  assert.throws(
    () =>
      observation(1, {
        ...detail(),
        base: { ...detail().base, lotsType: "with" },
      }),
    /missing_lot_details/,
  );
});

test("Persisted parent pointers determine epoch, ignoring row order, clocks, editorials and unrelated shadow branches", () => {
  const a = observation(1),
    changed = detail();
  changed.procurement.orderDescription.it += " 🌳";
  const b = observation(2, changed, a.id),
    shadow = observation(3, detail("lots"), a.id);
  shadow.createdAt = new Date("2040-01-01");
  const history = proof([shadow, b, a], b.id),
    first = proof([a]);
  assert.equal(history.error, null);
  assert.equal(history.epochToken, first.epochToken);
  assert.equal(history.epochObservationId, a.id);
  assert.deepEqual(
    history.ancestry.map((x) => x.observationId),
    [a.id, b.id],
  );
  assert.equal(isObservationInCurrentAssessmentEpoch(history, a.id), true);
  assert.equal(
    isObservationInCurrentAssessmentEpoch(history, shadow.id),
    false,
  );
  assert.ok(Object.isFrozen(history.ancestry[0]));
});

test("A→lots→A and A→unknown/refused→A start new epochs even when A bytes and dates return exactly", () => {
  const a = observation(1);
  for (const mode of ["lots", "unknown", "refused"] as const) {
    let b = observation(2, detail(mode === "refused" ? "project" : mode), a.id);
    if (mode === "refused")
      b = {
        ...b,
        state: "refused",
        acquisition: {
          version: SIMAP_ACQUISITION_VERSION,
          state: "refused",
          identity,
          sourceRevision: null,
          refusal: { stage: "decode", code: "invalid_utf8" },
          receipt: b.acquisition.receipt,
        },
      };
    const c = observation(3, detail(), b.id),
      p = proof([c, a, b], c.id);
    assert.equal(p.shape.kind, "project");
    assert.equal(p.epochObservationId, c.id);
    assert.notEqual(p.epochToken, proof([a]).epochToken);
    assert.equal(isObservationInCurrentAssessmentEpoch(p, a.id), false);
    assert.equal(isObservationInCurrentAssessmentEpoch(p, c.id), true);
    const middle = proof([a, b], b.id);
    if (mode !== "lots") {
      assert.equal(middle.epochToken, null);
      assert.equal(isObservationInCurrentAssessmentEpoch(middle, b.id), false);
      if (mode === "refused") {
        const refused = snapshot(b);
        assert.equal(
          resolveAssessmentSourceContext(refused, target, [], middle).state,
          "input_refused",
        );
        if (refused.acquisition.state === "refused") {
          // Source v2 binds the whole receipt, not only the response body.
          assert.notEqual(
            refused.acquisition.receiptHash,
            b.acquisition.receipt.bodySha256,
          );
          const altered = captureLotSourceSnapshot({
            publicationId,
            observationId: b.id,
            sourceScopeReview: null,
            acquisition: {
              ...refused.acquisition,
              receiptHash: b.acquisition.receipt.bodySha256,
            },
          });
          assert.throws(
            () => resolveAssessmentSourceContext(altered, target, [], middle),
            /differs/,
          );
        }
      }
    }
  }
});

test("Missing/cyclic/ambiguous/corrupt or foreign ancestors cannot form a proof of current certainty", () => {
  const a = observation(1),
    b = observation(2, detail(), a.id);
  assert.equal(proof([b]).error, "missing_ancestor_observation");
  assert.equal(proof([a, a]).error, "ambiguous_ancestor_observation");
  const cycleA = observation(1, detail(), b.id);
  assert.equal(proof([cycleA, b]).error, "cyclic_observation_history");
  const foreign = { ...a, publicationId: "simap-other" };
  assert.equal(proof([foreign, b]).error, "invalid_ancestor_observation");
  const corrupt = { ...a, request: { ...a.request, token: "0".repeat(64) } };
  assert.equal(proof([corrupt, b]).error, "invalid_ancestor_observation");
  const originalShadow = observation(3);
  const shadow = {
    ...originalShadow,
    request: { ...originalShadow.request, token: "0".repeat(64) },
  };
  assert.equal(proof([shadow, a], a.id).error, null);
  assert.equal(
    resolveAssessmentShapeHistory({
      publicationId,
      currentObservationId: null,
      observations: [],
    }).epochToken,
    null,
  );
});

test("A history proof cannot be manufactured/serialized/rebound or mutate after checking", () => {
  const a = observation(1),
    p = proof([a]);
  assertAssessmentShapeHistory(p, publicationId, a.id);
  assert.throws(
    () => assertAssessmentShapeHistory(structuredClone(p), publicationId, a.id),
    /Unverified/,
  );
  assert.throws(
    () => assertAssessmentShapeHistory(p, "simap-other", a.id),
    /mismatched/,
  );
  assert.throws(
    () => assertAssessmentShapeHistory(p, publicationId, id(9)),
    /mismatched/,
  );
  assert.throws(() => {
    (p.ancestry as unknown[]).push({});
  }, TypeError);
  const s = structuredClone(snapshot(a));
  assert.equal(s.acquisition.state, "accepted");
  if (s.acquisition.state === "accepted")
    (
      s.acquisition.archive.projectSections as Record<string, unknown>
    ).metadata = "altered";
  assert.throws(() => deriveAssessmentShape(s));
});

test("Source guard preserves the global chain/hash but blocks an old review after returning to its original bytes", () => {
  const a = observation(1),
    b = observation(2, detail("lots"), a.id),
    c = observation(3, detail(), b.id);
  const old = sourceReview(snapshot(a)),
    current = snapshot(c),
    shape = proof([a, b, c]);
  const legacyContext = resolveLotSourceContext(current, target, [old]);
  assert.equal(legacyContext.state, "manual_source");
  const guarded = resolveAssessmentSourceContext(current, target, [old], shape);
  assert.equal(guarded.state, "review_required");
  assert.equal(guarded.projectBarrier.state, "blocked");
  assert.deepEqual(guarded.dependency, legacyContext.dependency);
  assert.equal(guarded.review?.event.id, old.event.id);
  const fresh = sourceReview(current, [old]);
  assert.equal(
    resolveAssessmentSourceContext(current, target, [old, fresh], shape).state,
    "manual_source",
  );
  const other = observation(3, detail("unknown"), b.id);
  assert.throws(
    () => resolveAssessmentSourceContext(snapshot(other), target, [], shape),
    /differs/,
  );
  const missing = proof([c]);
  assert.equal(
    resolveAssessmentSourceContext(current, target, [old], missing).state,
    "review_required",
  );
});

import { createHash } from "node:crypto";
import { decodeDocumentarySnapshotRow } from "./documentary-store";
import { stableDocumentaryJson } from "./documentary-observation";
import {
  captureLotSourceSnapshot,
  resolveLotSourceContext,
  LOT_SOURCE_CONTEXT_VERSION,
  type LotSourceContext,
  type LotSourceSnapshot,
  type LotSourceTarget,
  type MixedSourceReviewRecord,
} from "./lot-source-context";
import type { DeepReadonly } from "./source-input";

export const ASSESSMENT_SHAPE_VERSION = "assessment-shape-v1";
export const ASSESSMENT_SHAPE_EPOCH_VERSION = "assessment-shape-epoch-v1";
export const MAX_ASSESSMENT_OBSERVATIONS = 10_000;
export type DocumentarySnapshotRow = Parameters<
  typeof decodeDocumentarySnapshotRow
>[0];
export type AssessmentShapeKind = "project" | "lots" | "unresolved";
export type AssessmentShape = DeepReadonly<{
  version: typeof ASSESSMENT_SHAPE_VERSION;
  kind: AssessmentShapeKind;
  targets: LotSourceTarget[];
  evidence: {
    rawPath: string;
    url: string;
    presence: "present" | "absent";
    value: unknown;
  }[];
  reasons: string[];
}>;
export type AssessmentAncestryEntry = DeepReadonly<{
  observationId: string;
  parentObservationId: string | null;
  shapeKind: AssessmentShapeKind;
  epochToken: string;
  archiveHash: string | null;
  receiptHash: string;
  refusalReason: string | null;
  identityHash: string;
}>;
export type AssessmentShapeHistory = DeepReadonly<{
  version: typeof ASSESSMENT_SHAPE_EPOCH_VERSION;
  publicationId: string;
  currentObservationId: string | null;
  shape: AssessmentShape;
  epochToken: string | null;
  epochObservationId: string | null;
  ancestry: AssessmentAncestryEntry[];
  error: string | null;
}>;

const verified = new WeakSet<object>();
const hash = (v: unknown) =>
  createHash("sha256").update(stableDocumentaryJson(v)).digest("hex");
function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
function unresolved(reason: string): AssessmentShape {
  return freeze({
    version: ASSESSMENT_SHAPE_VERSION,
    kind: "unresolved",
    targets: [],
    evidence: [],
    reasons: [reason],
  });
}

// Shape is a documentary property, not a human/AI service classification. The
// project source context already retains the entire verified parent record.
export function deriveAssessmentShape(
  snapshot: LotSourceSnapshot,
): AssessmentShape {
  const { version, snapshotHash, ...body } = snapshot;
  const checked = captureLotSourceSnapshot(body);
  if (
    version !== LOT_SOURCE_CONTEXT_VERSION ||
    snapshotHash !== checked.snapshotHash
  )
    throw new Error("Altered assessment shape snapshot");
  if (checked.acquisition.state === "refused")
    return unresolved("documentary_input_refused");
  const archive = checked.acquisition.archive;
  const base = record(archive.projectSections.base);
  const marker = base.lotsType;
  const evidence: AssessmentShape["evidence"] = [
    ["/base/lotsType", base, "lotsType"],
    ["/lots", archive.lotField, "lots"],
    ["/base/lots", archive.baseLotField, "lots"],
  ].map(([rawPath, owner, key]) => {
    const o = owner as Record<string, unknown>;
    const present = Object.hasOwn(o, key as string);
    return {
      rawPath: rawPath as string,
      url: archive.identity.detailUrl,
      presence: present ? ("present" as const) : ("absent" as const),
      value: present ? o[key as string] : null,
    };
  });
  let kind: AssessmentShapeKind = "unresolved";
  let reason = "lot_structure_not_declared";
  if (archive.directory.length) {
    if (marker === "with" || marker === undefined || marker === null)
      kind = "lots";
    else reason = "lot_structure_discordant";
  } else if (marker === "without") {
    const consistent = [archive.lotField, archive.baseLotField].every((o) => {
      const list = o.lots;
      return (
        list === undefined ||
        list === null ||
        (Array.isArray(list) && list.length === 0)
      );
    });
    if (consistent) kind = "project";
    else reason = "lot_structure_discordant";
  } else if (marker !== undefined && marker !== null)
    reason = "lot_structure_unknown_or_discordant";
  const targets: LotSourceTarget[] =
    kind === "project"
      ? [{ kind: "project", publicationId: checked.publicationId }]
      : kind === "lots"
        ? archive.directory.map((lot) => ({
            kind: "lot",
            publicationId: checked.publicationId,
            sourceProjectId: archive.identity.projectId.toLowerCase(),
            lotId: lot.id.toLowerCase(),
          }))
        : [];
  return freeze({
    version: ASSESSMENT_SHAPE_VERSION,
    kind,
    targets,
    evidence,
    reasons: kind === "unresolved" ? [reason] : [],
  });
}

// The caller loads actual rows from the immutable deposit. Only ancestors of
// the current pointer count; input ordering, timestamps, shadow rows and jobs
// cannot supply or reset an epoch. This helper performs no database operation.
export function resolveAssessmentShapeHistory({
  publicationId,
  currentObservationId,
  observations,
}: {
  publicationId: string;
  currentObservationId: string | null;
  observations: readonly DocumentarySnapshotRow[];
}): AssessmentShapeHistory {
  function finish(value: Omit<AssessmentShapeHistory, "version">) {
    const result = freeze({
      version:
        ASSESSMENT_SHAPE_EPOCH_VERSION as typeof ASSESSMENT_SHAPE_EPOCH_VERSION,
      ...value,
    });
    verified.add(result);
    return result;
  }
  function fail(error: string): AssessmentShapeHistory {
    return finish({
      publicationId,
      currentObservationId,
      shape: unresolved(error),
      epochToken: null,
      epochObservationId: null,
      ancestry: [],
      error,
    });
  }
  if (!currentObservationId) return fail("missing_current_observation");
  if (
    !Array.isArray(observations) ||
    observations.length > MAX_ASSESSMENT_OBSERVATIONS
  )
    return fail("observation_history_limit");
  const rows = new Map<string, DocumentarySnapshotRow[]>();
  for (const row of observations) {
    // An unrelated shadow row is not evidence about this ancestry.
    if (row && typeof row.id === "string")
      rows.set(row.id, [...(rows.get(row.id) ?? []), row]);
  }
  const visited = new Set<string>();
  const chain: {
    id: string;
    parent: string | null;
    shape: AssessmentShape;
    archiveHash: string | null;
    receiptHash: string;
    refusalReason: string | null;
    identityHash: string;
  }[] = [];
  let pointer: string | null = currentObservationId;
  while (pointer !== null) {
    if (visited.has(pointer)) return fail("cyclic_observation_history");
    visited.add(pointer);
    const candidates = rows.get(pointer);
    if (!candidates?.length) return fail("missing_ancestor_observation");
    if (candidates.length !== 1) return fail("ambiguous_ancestor_observation");
    try {
      const row = decodeDocumentarySnapshotRow(candidates[0], publicationId);
      if (publicationId !== `simap-${row.request.identity.projectId}`)
        return fail("observation_publication_identity_mismatch");
      const acquisition = row.acquisition;
      const snapshot = captureLotSourceSnapshot({
        publicationId,
        observationId: row.id,
        sourceScopeReview: null,
        acquisition:
          acquisition.state === "accepted"
            ? { state: "accepted", archive: acquisition.archive }
            : {
                state: "refused",
                identity: acquisition.identity,
                reason: `${acquisition.refusal.stage}:${acquisition.refusal.code}`,
                receiptHash: hash(acquisition.receipt),
              },
      });
      // observed revision may include legitimate editorial corrections. The
      // stored pointer, not equality with the parent's raw revision, links it.
      const parent =
        row.request.observedPublication?.documentarySnapshotId ?? null;
      chain.push({
        id: row.id,
        parent,
        shape: deriveAssessmentShape(snapshot),
        archiveHash:
          acquisition.state === "accepted"
            ? acquisition.archive.archiveHash
            : null,
        receiptHash: hash(acquisition.receipt),
        refusalReason:
          acquisition.state === "refused"
            ? `${acquisition.refusal.stage}:${acquisition.refusal.code}`
            : null,
        identityHash: hash(acquisition.identity),
      });
      pointer = parent;
    } catch {
      return fail("invalid_ancestor_observation");
    }
  }
  const ancestry: AssessmentAncestryEntry[] = [];
  let previousKind: AssessmentShapeKind | null = null;
  let epochObservationId = "";
  for (const node of [...chain].reverse()) {
    if (node.shape.kind !== previousKind) epochObservationId = node.id;
    previousKind = node.shape.kind;
    ancestry.push({
      observationId: node.id,
      parentObservationId: node.parent,
      shapeKind: node.shape.kind,
      epochToken: hash({
        version: ASSESSMENT_SHAPE_EPOCH_VERSION,
        publicationId,
        kind: node.shape.kind,
        epochObservationId,
      }),
      archiveHash: node.archiveHash,
      receiptHash: node.receiptHash,
      refusalReason: node.refusalReason,
      identityHash: node.identityHash,
    });
  }
  const shape = chain[0].shape;
  return finish({
    publicationId,
    currentObservationId,
    shape,
    epochToken:
      shape.kind === "unresolved" ? null : ancestry.at(-1)!.epochToken,
    epochObservationId: shape.kind === "unresolved" ? null : epochObservationId,
    ancestry,
    error: null,
  });
}

// A proof stays server-local. JSON roundtrips or callers constructing a result
// without the verified persisted-pointer walk cannot authorize a consumer.
export function assertAssessmentShapeHistory(
  value: AssessmentShapeHistory,
  publicationId: string,
  currentObservationId: string | null,
): void {
  if (
    !verified.has(value) ||
    value.publicationId !== publicationId ||
    value.currentObservationId !== currentObservationId
  )
    throw new Error("Unverified or mismatched assessment shape history");
}
export function isObservationInCurrentAssessmentEpoch(
  history: AssessmentShapeHistory,
  observationId: string,
): boolean {
  assertAssessmentShapeHistory(
    history,
    history.publicationId,
    history.currentObservationId,
  );
  return (
    history.error === null &&
    history.epochToken !== null &&
    history.ancestry.some(
      (entry) =>
        entry.observationId === observationId &&
        entry.epochToken === history.epochToken,
    )
  );
}

export function resolveAssessmentSourceContext(
  snapshot: LotSourceSnapshot,
  target: LotSourceTarget,
  sourceHistory: readonly MixedSourceReviewRecord[],
  shapeState: AssessmentShapeHistory,
): LotSourceContext {
  assertAssessmentShapeHistory(
    shapeState,
    snapshot.publicationId,
    snapshot.observationId,
  );
  const context = resolveLotSourceContext(snapshot, target, sourceHistory);
  const current = shapeState.ancestry.at(-1);
  if (
    current &&
    (snapshot.acquisition.state === "accepted"
      ? current.archiveHash !== snapshot.acquisition.archive.archiveHash
      : current.archiveHash !== null ||
        current.receiptHash !== snapshot.acquisition.receiptHash ||
        current.refusalReason !== snapshot.acquisition.reason ||
        current.identityHash !== hash(snapshot.acquisition.identity))
  )
    throw new Error("Assessment snapshot differs from persisted observation");
  const reviewCurrent = (id: string | null) => {
    const review = sourceHistory.find((entry) => entry.event.id === id);
    return (
      !!review &&
      "observationId" in review.snapshot &&
      isObservationInCurrentAssessmentEpoch(
        shapeState,
        review.snapshot.observationId,
      )
    );
  };
  const staleBarrier =
    shapeState.shape.kind === "unresolved" ||
    (context.projectBarrier.state === "clear" &&
      !reviewCurrent(context.projectBarrier.reviewEventId));
  const staleTarget =
    context.state === "manual_source" &&
    !reviewCurrent(context.dependency.reviewEventId);
  if (!staleBarrier && !staleTarget) return context;
  // Preserve the core's hashes and full event chain for source append CAS.
  // Epoch is a separate expectation; these are only current-policy projections.
  return freeze({
    ...context,
    state:
      context.state === "input_refused" ? "input_refused" : "review_required",
    reason:
      shapeState.shape.kind === "unresolved"
        ? "assessment_structure_unresolved"
        : "assessment_structure_changed",
    form: null,
    projectBarrier: staleBarrier
      ? {
          ...context.projectBarrier,
          state: "blocked",
          reason: "source_changed",
          form: null,
        }
      : context.projectBarrier,
  });
}

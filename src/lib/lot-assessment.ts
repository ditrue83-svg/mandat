import { createHash } from "node:crypto";
import { assessmentLocation } from "./assessment-location";
import {
  resolveAutomaticComparison,
  type ResolvedAutomaticComparison,
} from "./automatic-comparison";
import { z } from "zod";
import type { CompanyProfile, Publication } from "./domain";
import {
  preliminaryLotMatch,
  PREFILTER_VERSION,
  type PreliminaryLotMatch,
} from "./lot-matching";
import {
  captureLotSourceSnapshot,
  LOT_SOURCE_CONTEXT_VERSION,
  resolveLotSourceReferences,
  type LotDocumentaryReference,
  type LotResolvedReference,
  type LotSourceContext,
  type LotSourceDependency,
  type LotSourceSnapshot,
  type LotSourceTarget,
  type MixedSourceReviewRecord,
} from "./lot-source-context";
import type { DeepReadonly } from "./source-input";
import { ReviewConflict } from "./source-review-context";
import { profileSchema } from "./validation";
import {
  assertAssessmentShapeHistory,
  isObservationInCurrentAssessmentEpoch,
  resolveAssessmentSourceContext,
  type AssessmentShape,
  type AssessmentShapeHistory,
} from "./assessment-shape";
import {
  preliminaryProjectMatch,
  PROJECT_PREFILTER_VERSION,
} from "./project-matching";

export const LEGACY_LOT_EVALUATIONS_VERSION = "lot-evaluations-v1";
export const LEGACY_LOT_EVALUATION_DEPENDENCY_VERSION =
  "lot-evaluation-dependency-v1";
export const LEGACY_LOT_COMPARISON_VERSION = "human-lot-assessment-v1";
export const LOT_EVALUATIONS_VERSION = "lot-evaluations-v2";
export const LOT_EVALUATION_DEPENDENCY_VERSION = "lot-evaluation-dependency-v2";
export const LOT_COMPARISON_VERSION = "human-target-assessment-v2";
export type LotAssessmentTarget = Extract<LotSourceTarget, { kind: "lot" }>;
export type AssessmentTarget = LotSourceTarget;
export type LotAssessmentResult = "direct" | "different" | "review";
type DependencyFields = {
  source: LotSourceDependency;
  profileHash: string;
  comparisonVersion: string;
  prefilterVersion: string;
  operationalInputHash: string;
};
export type LegacyLotEvaluationDependency = DeepReadonly<
  DependencyFields & {
    version: typeof LEGACY_LOT_EVALUATION_DEPENDENCY_VERSION;
  }
>;
export type TargetEvaluationDependency = DeepReadonly<
  DependencyFields & {
    version: typeof LOT_EVALUATION_DEPENDENCY_VERSION;
    shapeEpochToken: string;
  }
>;
export type LotEvaluationDependency =
  LegacyLotEvaluationDependency | TargetEvaluationDependency;
type EvaluationFields<
  T extends AssessmentTarget,
  D extends LotEvaluationDependency,
> = {
  id: string;
  target: T;
  immutableEvidenceSnapshotId: string;
  dependency: D;
  result: LotAssessmentResult;
  reason: string;
  evidence: readonly LotResolvedReference[];
  origin: "human";
  humanReview: {
    actorId: string;
    at: string;
    note: string;
    confirmedReviewReasons: readonly string[];
  };
  entryHash: string;
};
export type LegacyLotEvaluation = DeepReadonly<
  EvaluationFields<LotAssessmentTarget, LegacyLotEvaluationDependency>
>;
export type TargetEvaluation = DeepReadonly<
  EvaluationFields<AssessmentTarget, TargetEvaluationDependency>
>;
export type LotEvaluation = LegacyLotEvaluation | TargetEvaluation;
type EvaluationSetFields = {
  companyId: string;
  publicationId: string;
};
export type LotEvaluationSet = DeepReadonly<
  EvaluationSetFields &
    (
      | {
          version: typeof LEGACY_LOT_EVALUATIONS_VERSION;
          entries: readonly LegacyLotEvaluation[];
        }
      | {
          version: typeof LOT_EVALUATIONS_VERSION;
          entries: readonly LotEvaluation[];
        }
    )
>;

export function assessmentTargetKey(target: AssessmentTarget): string {
  return target.kind === "project"
    ? `project:${target.publicationId}`
    : `lot:${target.publicationId}:${target.sourceProjectId}:${target.lotId}`;
}
export function sameAssessmentTarget(
  a: AssessmentTarget,
  b: AssessmentTarget,
): boolean {
  return assessmentTargetKey(a) === assessmentTargetKey(b);
}

// Checksums bind data for server CAS; they do not authenticate the author. The
// repository must authorize the actor and lock/re-read inputs before calling us.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
// Do not run accessors or accept JSONB-unsafe strings on the private audit path.
function copy(value: unknown): unknown {
  let nodes = 0,
    bytes = 0;
  const parents = new Set<object>();
  function visit(v: unknown, depth: number): unknown {
    if (++nodes > 100000 || depth > 64)
      throw new Error("Lot assessment input limit");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      bytes += Buffer.byteLength(v);
      if (!v.isWellFormed() || v.includes("\0") || bytes > 4_000_000)
        throw new Error("Invalid lot assessment text");
      return v;
    }
    if (!v || typeof v !== "object" || parents.has(v))
      throw new Error("Invalid lot assessment JSON");
    const array = Array.isArray(v);
    if (
      ![array ? Array.prototype : Object.prototype, null].includes(
        Object.getPrototypeOf(v),
      )
    )
      throw new Error("Invalid lot assessment prototype");
    parents.add(v);
    const entries: [string, unknown][] = [];
    for (const key of Reflect.ownKeys(v)) {
      if (array && key === "length") continue;
      if (
        typeof key !== "string" ||
        (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= v.length))
      )
        throw new Error("Invalid lot assessment property");
      visit(key, depth + 1);
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable)
        throw new Error("Lot assessment accessors are unsupported");
      entries.push([key, visit(descriptor.value, depth + 1)]);
    }
    parents.delete(v);
    if (array) {
      if (entries.length !== v.length)
        throw new Error("Sparse lot assessment array");
      return entries.map(([, item]) => item);
    }
    return Object.fromEntries(entries);
  }
  return visit(value, 0);
}
const text = (max = 200) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !!s.trim());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().regex(/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/);
const time = z
  .string()
  .refine(
    (s) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s,
  );
const lotTargetSchema = z.strictObject({
  kind: z.literal("lot"),
  publicationId: text(),
  sourceProjectId: uuid,
  lotId: uuid,
});
const projectTargetSchema = z.strictObject({
  kind: z.literal("project"),
  publicationId: text(),
});
const targetSchema = z.discriminatedUnion("kind", [
  projectTargetSchema,
  lotTargetSchema,
]);
const sourceDependencySchema = z.strictObject({
  version: z.literal(LOT_SOURCE_CONTEXT_VERSION),
  publicationId: text(),
  target: targetSchema,
  sharedHash: digest.nullable(),
  selectionHash: digest.nullable(),
  inputRefusalHash: digest.nullable(),
  reviewEventId: text().nullable(),
  reviewEventHash: digest.nullable(),
  projectBarrierHash: digest,
});
const dependencySchema = z.strictObject({
  version: z.literal(LOT_EVALUATION_DEPENDENCY_VERSION),
  shapeEpochToken: digest,
  source: sourceDependencySchema,
  profileHash: digest,
  comparisonVersion: text(),
  prefilterVersion: text(),
  operationalInputHash: digest,
});
const legacyDependencySchema = dependencySchema
  .omit({ shapeEpochToken: true })
  .extend({
    version: z.literal(LEGACY_LOT_EVALUATION_DEPENDENCY_VERSION),
    source: sourceDependencySchema.extend({ target: lotTargetSchema }),
  });
const referenceSchema = z.strictObject({
  selectionHash: digest,
  rawPath: text(4096),
  startUtf16: z.number().int().min(0),
  endUtf16: z.number().int().positive(),
});
const evidenceSchema = referenceSchema.extend({
  quote: text(18000),
  origin: z.strictObject({
    scope: z.enum(["project_context", "selected_lot"]),
    url: text(4096),
    language: z.enum(["it", "de", "fr", "en"]).nullable(),
    page: z.null(),
    representation: z.literal("verbatim_raw_string_may_contain_html"),
  }),
});
const reviewReasonsSchema = z.array(text(1000)).max(128);
const entrySchema = z.strictObject({
  id: text(),
  target: targetSchema,
  immutableEvidenceSnapshotId: text(),
  dependency: dependencySchema,
  result: z.enum(["direct", "different", "review"]),
  reason: text(4000),
  evidence: z.array(evidenceSchema).min(1).max(128),
  origin: z.literal("human"),
  humanReview: z.strictObject({
    actorId: text(),
    at: time,
    note: text(4000),
    confirmedReviewReasons: reviewReasonsSchema,
  }),
  entryHash: digest,
});
const legacyEntrySchema = entrySchema.extend({
  target: lotTargetSchema,
  dependency: legacyDependencySchema,
});
const currentSetSchema = z.strictObject({
  version: z.literal(LOT_EVALUATIONS_VERSION),
  companyId: text(),
  publicationId: text(),
  entries: z.array(z.union([legacyEntrySchema, entrySchema])).max(1000),
});
const setSchema = z.discriminatedUnion("version", [
  currentSetSchema,
  currentSetSchema.extend({
    version: z.literal(LEGACY_LOT_EVALUATIONS_VERSION),
    entries: z.array(legacyEntrySchema).max(1000),
  }),
]);

export function lotAssessmentProfileHash(profile: CompanyProfile): string {
  const clean = copy(profile);
  profileSchema.strict().parse(clean);
  return hash(clean);
}
export function validateLotEvaluationSet(
  value: unknown,
  companyId: string,
  publicationId: string,
): LotEvaluationSet {
  text().parse(companyId);
  text().parse(publicationId);
  const set = setSchema.parse(copy(value));
  if (set.companyId !== companyId || set.publicationId !== publicationId)
    throw new Error("Lot evaluations belong to another company or publication");
  const targets = new Set<string>(),
    ids = new Set<string>();
  for (const entry of set.entries) {
    const { entryHash, ...body } = entry;
    if (entryHash !== hash(body)) throw new Error("Altered lot evaluation");
    if (
      entry.target.publicationId !== publicationId ||
      (entry.target.kind === "lot" &&
        publicationId !== `simap-${entry.target.sourceProjectId}`) ||
      entry.dependency.source.publicationId !== publicationId ||
      stable(entry.target) !== stable(entry.dependency.source.target)
    )
      throw new Error("Lot evaluation target mismatch");
    const targetKey = assessmentTargetKey(entry.target);
    if (targets.has(targetKey) || ids.has(entry.id))
      throw new Error("Duplicate lot evaluation target or id");
    if (
      entry.evidence.some(
        (e) => e.selectionHash !== entry.dependency.source.selectionHash,
      )
    )
      throw new Error("Lot evaluation evidence selection mismatch");
    if (
      new Set(entry.humanReview.confirmedReviewReasons).size !==
      entry.humanReview.confirmedReviewReasons.length
    )
      throw new Error("Repeated operational confirmation");
    targets.add(targetKey);
    ids.add(entry.id);
  }
  return freeze(set);
}
export function lotEvaluationSetToken(
  value: LotEvaluationSet | null,
  companyId: string,
  publicationId: string,
): string {
  text().parse(companyId);
  text().parse(publicationId);
  return hash({
    companyId,
    publicationId,
    evaluationSet:
      value === null
        ? null
        : validateLotEvaluationSet(value, companyId, publicationId),
  });
}
export type LotAssessmentInput = {
  companyId: string;
  publication: Publication;
  profile: CompanyProfile;
  snapshot: LotSourceSnapshot;
  history: readonly MixedSourceReviewRecord[];
  shapeState: AssessmentShapeHistory;
  evaluationSet: LotEvaluationSet | null;
  automaticComparisons?: readonly unknown[];
  evidenceSnapshots?: readonly LotSourceSnapshot[];
  now?: Date;
};
export type HumanTargetAssessmentCommand = {
  target: AssessmentTarget;
  expectedShapeEpochToken: string;
  expectedSnapshotHash: string;
  expectedSourceDependency: LotSourceDependency;
  expectedProfileHash: string;
  expectedOperationalInputHash: string;
  expectedEvaluationSetToken: string;
  expectedEntryHash: string | null;
  result: LotAssessmentResult;
  reason: string;
  references: readonly LotDocumentaryReference[];
  origin: "human";
  confirmedReviewReasons: readonly string[];
};
export type HumanLotAssessmentCommand = Omit<
  HumanTargetAssessmentCommand,
  "target" | "expectedShapeEpochToken"
> & {
  target: LotAssessmentTarget;
  expectedShapeEpochToken?: string;
};
export type HumanLotAssessmentMetadata = {
  id: string;
  actorId: string;
  at: string;
  note: string;
};
const commandSchema = z.strictObject({
  target: targetSchema,
  expectedShapeEpochToken: digest,
  expectedSnapshotHash: digest,
  expectedSourceDependency: sourceDependencySchema,
  expectedProfileHash: digest,
  expectedOperationalInputHash: digest,
  expectedEvaluationSetToken: digest,
  expectedEntryHash: digest.nullable(),
  result: z.enum(["direct", "different", "review"]),
  reason: text(4000),
  references: z.array(referenceSchema).min(1).max(128),
  origin: z.literal("human"),
  confirmedReviewReasons: reviewReasonsSchema,
});
const metadataSchema = z.strictObject({
  id: text(),
  actorId: text(),
  at: time,
  note: text(4000),
});
function checkedInput(input: LotAssessmentInput) {
  text().parse(input.companyId);
  if (
    input.snapshot.publicationId !== input.publication.id ||
    input.publication.source !== "simap" ||
    input.publication.id !== `simap-${input.publication.externalId}`
  )
    throw new Error("Lot assessment publication identity mismatch");
  // This also checks the immutable archive, the complete event chain, and the
  // snapshot's binding to the source project before any projection is possible.
  assertAssessmentShapeHistory(
    input.shapeState,
    input.publication.id,
    input.snapshot.observationId,
  );
  const project = resolveAssessmentSourceContext(
    input.snapshot,
    { kind: "project", publicationId: input.publication.id },
    input.history,
    input.shapeState,
  );
  if (
    stable(input.snapshot.sourceScopeReview) !==
    stable(input.publication.sourceScopeReview ?? null)
  )
    throw new Error("Lot assessment source barrier mismatch");
  const profileHash = lotAssessmentProfileHash(input.profile);
  const set =
    input.evaluationSet === null
      ? null
      : validateLotEvaluationSet(
          input.evaluationSet,
          input.companyId,
          input.publication.id,
        );
  return {
    project,
    profileHash,
    set,
    setToken: lotEvaluationSetToken(set, input.companyId, input.publication.id),
  };
}
export type PreliminaryTargetMatch =
  PreliminaryLotMatch | ReturnType<typeof preliminaryProjectMatch>;
export function preliminaryAssessmentMatch(input: {
  publication: Publication;
  profile: CompanyProfile;
  context: LotSourceContext;
  now?: Date;
}): PreliminaryTargetMatch {
  return input.context.target.kind === "project"
    ? preliminaryProjectMatch(input)
    : preliminaryLotMatch(input);
}
function targetPrefilterVersion(target: AssessmentTarget) {
  return target.kind === "project"
    ? PROJECT_PREFILTER_VERSION
    : PREFILTER_VERSION;
}
function sourceAllowsCertainty(context: LotSourceContext): boolean {
  return (
    context.state === "manual_source" &&
    context.form === "defined_service" &&
    context.projectBarrier.state === "clear"
  );
}
export function createHumanTargetAssessment(
  commandInput: HumanTargetAssessmentCommand,
  input: LotAssessmentInput,
  metadataInput: HumanLotAssessmentMetadata,
): {
  entry: LotEvaluation;
  evaluationSet: LotEvaluationSet;
  previousEntry: LotEvaluation | null;
} {
  const command = commandSchema.parse(copy(commandInput));
  const metadata = metadataSchema.parse(copy(metadataInput));
  const checked = checkedInput(input);
  if (
    !input.shapeState.epochToken ||
    !input.shapeState.shape.targets.some((target) =>
      sameAssessmentTarget(target, command.target),
    )
  )
    throw new Error(
      "Cannot assess a target absent from the verified current structure",
    );
  const context = resolveAssessmentSourceContext(
    input.snapshot,
    command.target,
    input.history,
    input.shapeState,
  );
  const preliminary = preliminaryAssessmentMatch({
    publication: input.publication,
    profile: input.profile,
    context,
    now: input.now,
  });
  const previousEntry =
    checked.set?.entries.find((e) =>
      sameAssessmentTarget(e.target, command.target),
    ) ?? null;
  if (
    command.expectedSnapshotHash !== input.snapshot.snapshotHash ||
    command.expectedShapeEpochToken !== input.shapeState.epochToken ||
    stable(command.expectedSourceDependency) !== stable(context.dependency) ||
    command.expectedProfileHash !== checked.profileHash ||
    command.expectedOperationalInputHash !== preliminary.operationalInputHash ||
    command.expectedEvaluationSetToken !== checked.setToken ||
    command.expectedEntryHash !== (previousEntry?.entryHash ?? null)
  )
    throw new ReviewConflict(
      "The lot, source, profile, operational filter or evaluation set changed",
    );
  if (
    !context.targetContent ||
    (command.target.kind === "lot" && !context.targetContent.selectedLot) ||
    context.dependency.selectionHash === null
  )
    throw new Error("Cannot assess a missing or refused target input");
  if (command.result !== "review" && !sourceAllowsCertainty(context))
    throw new Error(
      "A certain assessment requires a defined current target and a clear project source",
    );
  if (command.result === "direct" && !preliminary.eligible)
    throw new Error(
      "A direct assessment cannot bypass an operational exclusion",
    );
  if (
    command.result === "direct" &&
    stable(command.confirmedReviewReasons) !== stable(preliminary.reviewReasons)
  )
    throw new ReviewConflict(
      "Confirm exactly the current operational review reasons",
    );
  if (
    command.result !== "direct" &&
    command.confirmedReviewReasons.length &&
    stable(command.confirmedReviewReasons) !== stable(preliminary.reviewReasons)
  )
    throw new ReviewConflict("Operational review reasons changed");
  if (checked.set?.entries.some((e) => e.id === metadata.id))
    throw new Error("Repeated lot evaluation id");
  const evidence = resolveLotSourceReferences(
    input.snapshot,
    command.target,
    input.history,
    command.references,
  );
  if (
    command.result !== "review" &&
    !evidence.some(
      (e) =>
        e.origin.scope ===
        (command.target.kind === "lot" ? "selected_lot" : "project_context"),
    )
  )
    throw new Error(
      "A certain assessment needs evidence from the selected target",
    );
  const body: Omit<TargetEvaluation, "entryHash"> = {
    id: metadata.id,
    target: command.target,
    immutableEvidenceSnapshotId: input.snapshot.observationId,
    dependency: {
      version: LOT_EVALUATION_DEPENDENCY_VERSION,
      shapeEpochToken: input.shapeState.epochToken,
      source: context.dependency,
      profileHash: checked.profileHash,
      comparisonVersion: LOT_COMPARISON_VERSION,
      prefilterVersion: targetPrefilterVersion(command.target),
      operationalInputHash: preliminary.operationalInputHash,
    },
    result: command.result,
    reason: command.reason,
    evidence,
    origin: "human" as const,
    humanReview: {
      actorId: metadata.actorId,
      at: metadata.at,
      note: metadata.note,
      confirmedReviewReasons: command.confirmedReviewReasons,
    },
  };
  const entry = freeze({ ...body, entryHash: hash(body) });
  const evaluationSet = validateLotEvaluationSet(
    {
      version: LOT_EVALUATIONS_VERSION,
      companyId: input.companyId,
      publicationId: input.publication.id,
      entries: [
        ...(checked.set?.entries.filter(
          (e) => !sameAssessmentTarget(e.target, command.target),
        ) ?? []),
        entry,
      ],
    },
    input.companyId,
    input.publication.id,
  );
  return freeze({ entry, evaluationSet, previousEntry });
}

// Compatibility for internal lot callers. The snapshot expectation still binds
// the draft; the server-verified history is mandatory and never fabricated here.
export function createHumanLotAssessment(
  command: HumanLotAssessmentCommand,
  input: LotAssessmentInput,
  metadata: HumanLotAssessmentMetadata,
) {
  assertAssessmentShapeHistory(
    input.shapeState,
    input.publication.id,
    input.snapshot.observationId,
  );
  if (!input.shapeState.epochToken)
    throw new Error("Unresolved assessment structure");
  return createHumanTargetAssessment(
    {
      ...command,
      expectedShapeEpochToken:
        command.expectedShapeEpochToken ?? input.shapeState.epochToken,
    },
    input,
    metadata,
  );
}

function snapshotIndex(
  input: LotAssessmentInput,
): Map<string, LotSourceSnapshot> {
  const map = new Map<string, LotSourceSnapshot>();
  const candidates = [
    input.snapshot,
    ...(input.evidenceSnapshots ?? []),
    ...input.history.flatMap((r) =>
      r.snapshot.version === LOT_SOURCE_CONTEXT_VERSION
        ? [r.snapshot as LotSourceSnapshot]
        : [],
    ),
  ];
  for (const candidateInput of candidates) {
    const candidate = copy(candidateInput) as LotSourceSnapshot;
    const { version, snapshotHash, ...body } = candidate;
    const verified = captureLotSourceSnapshot(body);
    if (
      version !== LOT_SOURCE_CONTEXT_VERSION ||
      snapshotHash !== verified.snapshotHash ||
      stable(candidate) !== stable(verified)
    )
      throw new Error("Altered lot evidence snapshot");
    if (verified.publicationId !== input.publication.id)
      throw new Error("Evidence snapshot belongs to another publication");
    const previous = map.get(verified.observationId);
    // observationId identifies the immutable acquisition. Editorial scope
    // reviews can legitimately change on that same archive; every full snapshot
    // is still verified above, and current review dependencies are checked by
    // the resolver separately. References depend on acquisition content only.
    if (
      previous &&
      stable(previous.acquisition) !== stable(verified.acquisition)
    )
      throw new Error("Reused immutable evidence snapshot id");
    if (!previous) map.set(verified.observationId, verified);
  }
  return map;
}
function references(
  evidence: readonly LotResolvedReference[],
): LotDocumentaryReference[] {
  return evidence.map(({ selectionHash, rawPath, startUtf16, endUtf16 }) => ({
    selectionHash,
    rawPath,
    startUtf16,
    endUtf16,
  }));
}
function evidenceIssue(
  entry: LotEvaluation,
  snapshots: Map<string, LotSourceSnapshot>,
  history: readonly MixedSourceReviewRecord[],
): string | null {
  const snapshot = snapshots.get(entry.immutableEvidenceSnapshotId);
  if (!snapshot) return "evidence_snapshot_missing";
  try {
    const resolved = resolveLotSourceReferences(
      snapshot,
      entry.target,
      history,
      references(entry.evidence),
    );
    if (
      stable(resolved) !== stable(entry.evidence) ||
      (entry.result !== "review" &&
        !resolved.some(
          (e) =>
            e.origin.scope ===
            (entry.target.kind === "lot" ? "selected_lot" : "project_context"),
        ))
    )
      return "evidence_mismatch";
  } catch {
    return "evidence_mismatch";
  }
  return null;
}
export type ResolvedTargetAssessment = DeepReadonly<{
  target: AssessmentTarget;
  number: number | null;
  state: "current" | "stale" | "missing" | "removed-or-unresolved";
  issue: string | null;
  evaluation: LotEvaluation | null;
  automatic?: ResolvedAutomaticComparison | null;
  context: LotSourceContext | null;
  preliminary: PreliminaryTargetMatch | null;
  signalEligible: boolean;
}>;
export type ResolvedLotAssessment = ResolvedTargetAssessment & {
  readonly target: LotAssessmentTarget;
};
export type ProjectLotSuppression = {
  active: boolean;
  reason: string;
  rejection?: { bindingHash: string; eventId: string; at: string } | null;
};
export type ProjectLotFeedback = {
  saved?: boolean;
  dismissed?: boolean;
  relevant?: boolean | null;
};
export type ProjectLotAssessment = DeepReadonly<{
  companyId: string;
  publicationId: string;
  projectBindingHash: string;
  state: "relevant" | "different" | "review" | "suppressed" | "input_refused";
  reason: string;
  projectBarrier: LotSourceContext["projectBarrier"];
  shape: AssessmentShape;
  shapeEpochToken: string | null;
  targets: readonly ResolvedTargetAssessment[];
  lots: readonly ResolvedLotAssessment[];
  projectAssessment: ResolvedTargetAssessment | null;
  relevantTargets: readonly AssessmentTarget[];
  relevantLotIds: readonly string[];
  allDifferent: boolean;
  signalEligible: boolean;
  quality: "approved" | "rejected" | "unresolved";
  qualityEventIds: readonly string[];
  saved: boolean;
  dismissed: boolean;
  suppressed: boolean;
}>;
const suppressionSchema = z.strictObject({
  active: z.boolean(),
  reason: text(4000),
  rejection: z
    .strictObject({ bindingHash: digest, eventId: text(), at: time })
    .nullable()
    .optional(),
});
const feedbackSchema = z.strictObject({
  saved: z.boolean().optional(),
  dismissed: z.boolean().optional(),
  relevant: z.boolean().nullable().optional(),
});

// No legacy approved/score input exists here. This resolver is selected only by
// the server's adopted documentary pointer, including a refused observation.
export function resolveProjectLotAssessment(
  input: LotAssessmentInput & {
    suppression?: ProjectLotSuppression | null;
    feedback?: ProjectLotFeedback;
  },
): ProjectLotAssessment {
  const checked = checkedInput(input);
  const suppression =
    input.suppression == null
      ? null
      : suppressionSchema.parse(copy(input.suppression));
  const feedback = feedbackSchema.parse(copy(input.feedback ?? {}));
  const snapshots = snapshotIndex(input);
  const directory = checked.project.targetContent?.directory ?? [];
  const targets: ResolvedTargetAssessment[] =
    input.shapeState.shape.targets.map((target) => {
      const number =
        target.kind === "lot"
          ? (directory.find((item) => item.id === target.lotId)?.number ?? null)
          : null;
      const context = resolveAssessmentSourceContext(
        input.snapshot,
        target,
        input.history,
        input.shapeState,
      );
      const preliminary = preliminaryAssessmentMatch({
        publication: input.publication,
        profile: input.profile,
        context,
        now: input.now,
      });
      const evaluation =
        checked.set?.entries.find((e) =>
          sameAssessmentTarget(e.target, target),
        ) ?? null;
      let issue: string | null = null;
      if (evaluation) {
        const dep = evaluation.dependency;
        issue = evidenceIssue(evaluation, snapshots, input.history);
        if (
          !issue &&
          (!isObservationInCurrentAssessmentEpoch(
            input.shapeState,
            evaluation.immutableEvidenceSnapshotId,
          ) ||
            (dep.version === LOT_EVALUATION_DEPENDENCY_VERSION &&
              dep.shapeEpochToken !== input.shapeState.epochToken))
        )
          issue = "stale_structure";
        if (!issue && stable(dep.source) !== stable(context.dependency))
          issue = "stale_source";
        if (!issue && dep.profileHash !== checked.profileHash)
          issue = "stale_profile";
        if (
          !issue &&
          (dep.comparisonVersion !==
            (dep.version === LEGACY_LOT_EVALUATION_DEPENDENCY_VERSION
              ? LEGACY_LOT_COMPARISON_VERSION
              : LOT_COMPARISON_VERSION) ||
            dep.prefilterVersion !== targetPrefilterVersion(target))
        )
          issue = "stale_version";
        if (
          !issue &&
          dep.operationalInputHash !== preliminary.operationalInputHash
        )
          issue = "stale_operational_input";
        if (
          !issue &&
          evaluation.result !== "review" &&
          !sourceAllowsCertainty(context)
        )
          issue = "source_review_required";
        if (
          !issue &&
          evaluation.result === "direct" &&
          stable(evaluation.humanReview.confirmedReviewReasons) !==
            stable(preliminary.reviewReasons)
        )
          issue = "operational_review_unconfirmed";
      }
      // A recorded human judgment, even stale, always requires a human to
      // reconsider it. AI never silently replaces that decision.
      const automatic = evaluation
        ? { comparison: null, issue: null }
        : resolveAutomaticComparison(
            { ...input, target, preliminary },
            input.automaticComparisons ?? [],
          );
      const state = evaluation
        ? issue
          ? ("stale" as const)
          : ("current" as const)
        : automatic.comparison
          ? ("current" as const)
          : ("missing" as const);
      return {
        target,
        number,
        state,
        issue: evaluation
          ? issue
          : (automatic.issue ??
            (automatic.comparison ? null : "assessment_missing")),
        evaluation,
        automatic: automatic.comparison,
        context,
        preliminary,
        signalEligible:
          state === "current" &&
          preliminary.eligible &&
          ((evaluation?.result === "direct" &&
            sourceAllowsCertainty(context)) ||
            automatic.comparison?.result === "direct"),
      };
    });
  const present = new Set(
    targets.map((item) => assessmentTargetKey(item.target)),
  );
  for (const evaluation of checked.set?.entries ?? []) {
    if (!present.has(assessmentTargetKey(evaluation.target)))
      targets.push({
        target: evaluation.target,
        number: null,
        state: "removed-or-unresolved",
        issue:
          evaluation.target.kind === "project"
            ? "project_target_missing_or_unresolved"
            : "lot_missing_or_unresolved",
        evaluation,
        context: null,
        preliminary: null,
        signalEligible: false,
      });
  }
  const currentTargets = targets.filter(
    (lot) => lot.state !== "removed-or-unresolved",
  );
  const clear = checked.project.projectBarrier.state === "clear";
  const manualAllDifferent =
    clear &&
    currentTargets.length > 0 &&
    currentTargets.every(
      (lot) =>
        lot.state === "current" &&
        lot.evaluation?.result === "different" &&
        lot.context &&
        sourceAllowsCertainty(lot.context),
    );
  const allDifferent =
    currentTargets.length > 0 &&
    currentTargets.every(
      (item) =>
        item.state === "current" &&
        ((item.evaluation?.result === "different" &&
          !!item.context &&
          sourceAllowsCertainty(item.context)) ||
          item.automatic?.result === "different"),
    );
  const relevant = currentTargets.filter((item) => item.signalEligible);
  const manualRelevant = relevant.filter((item) => !!item.evaluation);
  const automaticBindings = currentTargets.flatMap((item) =>
    item.automatic ? [item.automatic.hash] : [],
  );
  // Whole-project rejection is deliberately bound to the whole current set.
  // Unlike per-lot freshness, a concurrent change in B can invalidate this veto's
  // quality vote. The active veto still suppresses delivery until reconsidered.
  const projectBindingHash = hash({
    companyId: input.companyId,
    publicationId: input.publication.id,
    profileHash: checked.profileHash,
    project: checked.project.dependency,
    evaluationSetToken: checked.setToken,
    ...(automaticBindings.length ? { automaticBindings } : {}),
    targets: currentTargets.map((lot) => ({
      target: lot.target,
      source: lot.context?.dependency,
      operationalInputHash: lot.preliminary?.operationalInputHash,
    })),
    shapeEpochToken: input.shapeState.epochToken,
    comparisonVersion: LOT_COMPARISON_VERSION,
    prefilterVersions: {
      lot: PREFILTER_VERSION,
      project: PROJECT_PREFILTER_VERSION,
    },
  });
  const rejected =
    clear &&
    currentTargets.length > 0 &&
    currentTargets.every((lot) => lot.context?.state !== "input_refused") &&
    !!suppression?.active &&
    suppression.rejection?.bindingHash === projectBindingHash;
  const suppressed = !!suppression?.active;
  const quality = suppressed
    ? rejected
      ? ("rejected" as const)
      : ("unresolved" as const)
    : manualRelevant.length
      ? ("approved" as const)
      : manualAllDifferent
        ? ("rejected" as const)
        : ("unresolved" as const);
  const signalEligible =
    relevant.length > 0 && !suppressed && !feedback.dismissed;
  const state =
    suppressed || feedback.dismissed
      ? ("suppressed" as const)
      : checked.project.state === "input_refused"
        ? ("input_refused" as const)
        : relevant.length
          ? ("relevant" as const)
          : allDifferent
            ? ("different" as const)
            : ("review" as const);
  const reason = suppressed
    ? suppression!.reason
    : feedback.dismissed
      ? "Progetto non segnalato perché segnato come non interessante."
      : state === "input_refused"
        ? "Fonte corrente non utilizzabile: i giudizi precedenti restano storici."
        : relevant.length
          ? relevant.some((item) => item.target.kind === "project")
            ? "Interesse potenziale per il progetto intero; non attesta l’idoneità a partecipare."
            : `Interesse potenziale per ${relevant.map((lot) => `il lotto ${lot.number ?? (lot.target.kind === "lot" ? lot.target.lotId : "")}`).join(", ")}; non attesta l’idoneità a partecipare. Gli altri lotti mantengono la propria valutazione.`
          : allDifferent
            ? input.shapeState.shape.kind === "project"
              ? "Il progetto è stato giudicato diverso dalle attività dichiarate dalla ditta."
              : "Tutti i lotti correnti noti sono stati giudicati diversi dalle attività della ditta."
            : input.shapeState.shape.kind === "unresolved"
              ? "La struttura della pubblicazione richiede verifica: non è ancora disponibile un target aziendale valutabile."
              : "La pertinenza del progetto richiede ancora una valutazione del target o della fonte.";
  const lots = targets.filter(
    (item): item is ResolvedLotAssessment => item.target.kind === "lot",
  );
  return freeze({
    companyId: input.companyId,
    publicationId: input.publication.id,
    projectBindingHash,
    state,
    reason,
    projectBarrier: checked.project.projectBarrier,
    shape: input.shapeState.shape,
    shapeEpochToken: input.shapeState.epochToken,
    targets,
    lots,
    projectAssessment:
      currentTargets.find((item) => item.target.kind === "project") ?? null,
    relevantTargets: relevant.map((item) => item.target),
    relevantLotIds: relevant.flatMap((item) =>
      item.target.kind === "lot" ? [item.target.lotId] : [],
    ),
    allDifferent,
    signalEligible,
    quality,
    qualityEventIds:
      quality === "approved"
        ? manualRelevant.map((lot) => lot.evaluation!.id)
        : quality === "rejected"
          ? rejected
            ? [suppression!.rejection!.eventId]
            : currentTargets.map((lot) => lot.evaluation!.id)
          : [],
    saved: !!feedback.saved,
    dismissed: !!feedback.dismissed,
    suppressed,
  });
}

// Product boundary: deliberately omit actors, private notes, archive bodies and
// past reasons that could appear current. Historical judgments stay server-side.
export function projectLotAssessmentDto(value: ProjectLotAssessment) {
  const targets = value.targets.map((item) => ({
    target: { ...item.target },
    number: item.number,
    state: item.state,
    issue: item.issue,
    origin:
      item.state === "current"
        ? item.evaluation
          ? ("human" as const)
          : item.automatic
            ? ("ai" as const)
            : null
        : null,
    result:
      item.state === "current"
        ? (item.evaluation?.result ?? item.automatic?.result ?? null)
        : null,
    reason:
      item.state === "current"
        ? (item.evaluation?.reason ?? item.automatic?.reason ?? null)
        : null,
    evidence:
      item.state === "current"
        ? item.evaluation
          ? item.evaluation.evidence.map((proof) => ({
              quote: proof.quote,
              url: proof.origin.url,
              page: proof.origin.page,
            }))
          : (item.automatic?.evidence ?? []).map((proof) => ({
              quote: proof.text,
              url: proof.url,
              page: null,
            }))
        : [],
    companyEvidence:
      item.state === "current"
        ? (item.automatic?.companyEvidence ?? []).map((proof) => proof.text)
        : [],
    reviewReasons: [
      ...(item.automatic?.reviewReasons ??
        item.preliminary?.reviewReasons ??
        []),
    ],
    operational: item.preliminary
      ? {
          ...item.preliminary.operational,
          location: assessmentLocation(item.preliminary, item.target.kind),
          cpv: [...item.preliminary.operational.cpv],
        }
      : null,
  }));
  return {
    publicationId: value.publicationId,
    state: value.state,
    reason: value.reason,
    signalEligible: value.signalEligible,
    saved: value.saved,
    dismissed: value.dismissed,
    shape: value.shape.kind,
    shapeReasons: [...value.shape.reasons],
    relevantTargets: value.relevantTargets.map((target) => ({ ...target })),
    relevantLotIds: [...value.relevantLotIds],
    targets,
    // Compatibility projection contains only actual source lots.
    lots: targets.flatMap(({ target, ...item }) =>
      target.kind === "lot" ? [{ ...item, lotId: target.lotId }] : [],
    ),
  };
}

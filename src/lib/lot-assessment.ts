import { createHash } from "node:crypto";
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
  resolveLotSourceContext,
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

export const LOT_EVALUATIONS_VERSION = "lot-evaluations-v1";
export const LOT_EVALUATION_DEPENDENCY_VERSION = "lot-evaluation-dependency-v1";
export const LOT_COMPARISON_VERSION = "human-lot-assessment-v1";
export type LotAssessmentTarget = Extract<LotSourceTarget, { kind: "lot" }>;
export type LotAssessmentResult = "direct" | "different" | "review";
export type LotEvaluationDependency = DeepReadonly<{
  version: typeof LOT_EVALUATION_DEPENDENCY_VERSION;
  source: LotSourceDependency;
  profileHash: string;
  comparisonVersion: string;
  prefilterVersion: string;
  operationalInputHash: string;
}>;
export type LotEvaluation = DeepReadonly<{
  id: string;
  target: LotAssessmentTarget;
  immutableEvidenceSnapshotId: string;
  dependency: LotEvaluationDependency;
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
}>;
export type LotEvaluationSet = DeepReadonly<{
  version: typeof LOT_EVALUATIONS_VERSION;
  companyId: string;
  publicationId: string;
  entries: readonly LotEvaluation[];
}>;

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
const targetSchema = z.strictObject({
  kind: z.literal("lot"),
  publicationId: text(),
  sourceProjectId: uuid,
  lotId: uuid,
});
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
  source: sourceDependencySchema,
  profileHash: digest,
  comparisonVersion: text(),
  prefilterVersion: text(),
  operationalInputHash: digest,
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
const setSchema = z.strictObject({
  version: z.literal(LOT_EVALUATIONS_VERSION),
  companyId: text(),
  publicationId: text(),
  entries: z.array(entrySchema).max(1000),
});

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
      publicationId !== `simap-${entry.target.sourceProjectId}` ||
      entry.dependency.source.publicationId !== publicationId ||
      stable(entry.target) !== stable(entry.dependency.source.target)
    )
      throw new Error("Lot evaluation target mismatch");
    if (targets.has(entry.target.lotId) || ids.has(entry.id))
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
    targets.add(entry.target.lotId);
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
  evaluationSet: LotEvaluationSet | null;
  evidenceSnapshots?: readonly LotSourceSnapshot[];
  now?: Date;
};
export type HumanLotAssessmentCommand = {
  target: LotAssessmentTarget;
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
export type HumanLotAssessmentMetadata = {
  id: string;
  actorId: string;
  at: string;
  note: string;
};
const commandSchema = z.strictObject({
  target: targetSchema,
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
  const project = resolveLotSourceContext(
    input.snapshot,
    { kind: "project", publicationId: input.publication.id },
    input.history,
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
function sourceAllowsCertainty(context: LotSourceContext): boolean {
  return (
    context.state === "manual_source" &&
    context.form === "defined_service" &&
    context.projectBarrier.state === "clear"
  );
}
export function createHumanLotAssessment(
  commandInput: HumanLotAssessmentCommand,
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
  const context = resolveLotSourceContext(
    input.snapshot,
    command.target,
    input.history,
  );
  const preliminary = preliminaryLotMatch({
    publication: input.publication,
    profile: input.profile,
    context,
    now: input.now,
  });
  const previousEntry =
    checked.set?.entries.find((e) => e.target.lotId === command.target.lotId) ??
    null;
  if (
    command.expectedSnapshotHash !== input.snapshot.snapshotHash ||
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
    !context.targetContent?.selectedLot ||
    context.dependency.selectionHash === null
  )
    throw new Error("Cannot assess a missing or refused lot input");
  if (command.result !== "review" && !sourceAllowsCertainty(context))
    throw new Error(
      "A certain assessment requires a defined lot and a clear project source",
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
    !evidence.some((e) => e.origin.scope === "selected_lot")
  )
    throw new Error("A certain lot assessment needs evidence from that lot");
  const body: Omit<LotEvaluation, "entryHash"> = {
    id: metadata.id,
    target: command.target,
    immutableEvidenceSnapshotId: input.snapshot.observationId,
    dependency: {
      version: LOT_EVALUATION_DEPENDENCY_VERSION,
      source: context.dependency,
      profileHash: checked.profileHash,
      comparisonVersion: LOT_COMPARISON_VERSION,
      prefilterVersion: PREFILTER_VERSION,
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
          (e) => e.target.lotId !== command.target.lotId,
        ) ?? []),
        entry,
      ],
    },
    input.companyId,
    input.publication.id,
  );
  return freeze({ entry, evaluationSet, previousEntry });
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
        !resolved.some((e) => e.origin.scope === "selected_lot"))
    )
      return "evidence_mismatch";
  } catch {
    return "evidence_mismatch";
  }
  return null;
}
export type ResolvedLotAssessment = DeepReadonly<{
  target: LotAssessmentTarget;
  number: number | null;
  state: "current" | "stale" | "missing" | "removed-or-unresolved";
  issue: string | null;
  evaluation: LotEvaluation | null;
  context: LotSourceContext | null;
  preliminary: PreliminaryLotMatch | null;
  signalEligible: boolean;
}>;
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
  lots: readonly ResolvedLotAssessment[];
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
  const lots: ResolvedLotAssessment[] = directory.map((item) => {
    const target: LotAssessmentTarget = {
      kind: "lot",
      publicationId: input.publication.id,
      sourceProjectId: input.publication.externalId.toLowerCase(),
      lotId: item.id.toLowerCase(),
    };
    const context = resolveLotSourceContext(
      input.snapshot,
      target,
      input.history,
    );
    const preliminary = preliminaryLotMatch({
      publication: input.publication,
      profile: input.profile,
      context,
      now: input.now,
    });
    const evaluation =
      checked.set?.entries.find((e) => e.target.lotId === target.lotId) ?? null;
    let issue: string | null = null;
    if (evaluation) {
      const dep = evaluation.dependency;
      issue = evidenceIssue(evaluation, snapshots, input.history);
      if (!issue && stable(dep.source) !== stable(context.dependency))
        issue = "stale_source";
      if (!issue && dep.profileHash !== checked.profileHash)
        issue = "stale_profile";
      if (
        !issue &&
        (dep.comparisonVersion !== LOT_COMPARISON_VERSION ||
          dep.prefilterVersion !== PREFILTER_VERSION)
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
    const state = evaluation
      ? issue
        ? ("stale" as const)
        : ("current" as const)
      : ("missing" as const);
    return {
      target,
      number: item.number,
      state,
      issue: evaluation ? issue : "assessment_missing",
      evaluation,
      context,
      preliminary,
      signalEligible:
        state === "current" &&
        evaluation?.result === "direct" &&
        preliminary.eligible &&
        sourceAllowsCertainty(context),
    };
  });
  const present = new Set(lots.map((lot) => lot.target.lotId));
  for (const evaluation of checked.set?.entries ?? []) {
    if (!present.has(evaluation.target.lotId))
      lots.push({
        target: evaluation.target,
        number: null,
        state: "removed-or-unresolved",
        issue: "lot_missing_or_unresolved",
        evaluation,
        context: null,
        preliminary: null,
        signalEligible: false,
      });
  }
  const currentLots = lots.filter(
    (lot) => lot.state !== "removed-or-unresolved",
  );
  const clear = checked.project.projectBarrier.state === "clear";
  const allDifferent =
    clear &&
    currentLots.length > 0 &&
    currentLots.every(
      (lot) =>
        lot.state === "current" &&
        lot.evaluation?.result === "different" &&
        lot.context &&
        sourceAllowsCertainty(lot.context),
    );
  const relevant = currentLots.filter((lot) => lot.signalEligible);
  // Whole-project rejection is deliberately bound to the whole current set.
  // Unlike per-lot freshness, a concurrent change in B can invalidate this veto's
  // quality vote. The active veto still suppresses delivery until reconsidered.
  const projectBindingHash = hash({
    companyId: input.companyId,
    publicationId: input.publication.id,
    profileHash: checked.profileHash,
    project: checked.project.dependency,
    evaluationSetToken: checked.setToken,
    lots: currentLots.map((lot) => ({
      target: lot.target,
      source: lot.context?.dependency,
      operationalInputHash: lot.preliminary?.operationalInputHash,
    })),
    comparisonVersion: LOT_COMPARISON_VERSION,
    prefilterVersion: PREFILTER_VERSION,
  });
  const rejected =
    clear &&
    currentLots.length > 0 &&
    currentLots.every((lot) => lot.context?.state !== "input_refused") &&
    !!suppression?.active &&
    suppression.rejection?.bindingHash === projectBindingHash;
  const suppressed = !!suppression?.active;
  const quality = suppressed
    ? rejected
      ? ("rejected" as const)
      : ("unresolved" as const)
    : relevant.length
      ? ("approved" as const)
      : allDifferent
        ? ("rejected" as const)
        : ("unresolved" as const);
  const signalEligible =
    relevant.length > 0 && clear && !suppressed && !feedback.dismissed;
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
          ? `Interesse potenziale per ${relevant.map((lot) => `il lotto ${lot.number ?? lot.target.lotId}`).join(", ")}; non attesta l’idoneità a partecipare. Gli altri lotti mantengono la propria valutazione.`
          : allDifferent
            ? "Tutti i lotti correnti noti sono stati giudicati diversi dalle attività della ditta."
            : "La pertinenza del progetto richiede ancora una valutazione dei lotti o della fonte.";
  return freeze({
    companyId: input.companyId,
    publicationId: input.publication.id,
    projectBindingHash,
    state,
    reason,
    projectBarrier: checked.project.projectBarrier,
    lots,
    relevantLotIds: relevant.map((lot) => lot.target.lotId),
    allDifferent,
    signalEligible,
    quality,
    qualityEventIds:
      quality === "approved"
        ? relevant.map((lot) => lot.evaluation!.id)
        : quality === "rejected"
          ? rejected
            ? [suppression!.rejection!.eventId]
            : currentLots.map((lot) => lot.evaluation!.id)
          : [],
    saved: !!feedback.saved,
    dismissed: !!feedback.dismissed,
    suppressed,
  });
}

// Product boundary: deliberately omit actors, private notes, archive bodies and
// past reasons that could appear current. Historical judgments stay server-side.
export function projectLotAssessmentDto(value: ProjectLotAssessment) {
  return {
    publicationId: value.publicationId,
    state: value.state,
    reason: value.reason,
    signalEligible: value.signalEligible,
    saved: value.saved,
    dismissed: value.dismissed,
    relevantLotIds: [...value.relevantLotIds],
    lots: value.lots.map((lot) => ({
      lotId: lot.target.lotId,
      number: lot.number,
      state: lot.state,
      issue: lot.issue,
      result: lot.state === "current" ? (lot.evaluation?.result ?? null) : null,
      reason: lot.state === "current" ? (lot.evaluation?.reason ?? null) : null,
      evidence:
        lot.state === "current"
          ? (lot.evaluation?.evidence ?? []).map((item) => ({
              quote: item.quote,
              url: item.origin.url,
              page: item.origin.page,
            }))
          : [],
      reviewReasons: [...(lot.preliminary?.reviewReasons ?? [])],
      operational: lot.preliminary
        ? {
            ...lot.preliminary.operational,
            cpv: [...lot.preliminary.operational.cpv],
          }
        : null,
    })),
  };
}

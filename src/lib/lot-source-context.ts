import { createHash } from "node:crypto";
import type { SourceScopeReview } from "./domain";
import type { DeepReadonly, SourceLanguage } from "./source-input";
import {
  buildLotComparisonCorpus,
  LotInputError,
  restoreSimapDetail,
  SOURCE_LOT_VERSION,
  type Identity,
  type LotArchive,
  type LotComparison,
} from "./source-lots";
import {
  CONTEXT_VERSION as LEGACY_VERSION,
  resolveSourceContext,
  ReviewConflict,
  type HumanSourceForm,
  type ReviewRecord,
} from "./source-review-context";

export const LOT_SOURCE_CONTEXT_VERSION = "human-lot-source-context-v2";
export type LotSourceTarget =
  | { kind: "project"; publicationId: string }
  | {
      kind: "lot";
      publicationId: string;
      sourceProjectId: string;
      lotId: string;
    };
export type LotSourceAcquisition =
  | { state: "accepted"; archive: LotArchive }
  | {
      state: "refused";
      identity: Identity;
      reason: string;
      receiptHash: string;
    };
export type LotSourceSnapshotInput = {
  publicationId: string;
  observationId: string;
  acquisition: LotSourceAcquisition;
  sourceScopeReview: SourceScopeReview | null;
};
// The historical snapshot retains the verified archive. Only targetContent in
// the resolved context is a target input; never pass the whole snapshot as a
// company's comparison. A repository can rehydrate this from its immutable ID.
export type LotSourceSnapshot = DeepReadonly<
  LotSourceSnapshotInput & {
    version: typeof LOT_SOURCE_CONTEXT_VERSION;
    snapshotHash: string;
  }
>;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function copy(value: unknown): Json {
  let count = 0,
    bytes = 0;
  const parents = new Set<object>();
  function visit(v: unknown, depth: number): Json {
    if (++count > 60000 || depth > 64) throw new Error("Source context limit");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      bytes += Buffer.byteLength(v);
      if (!v.isWellFormed() || v.includes("\0") || bytes > 2_100_000)
        throw new Error("Invalid or oversized source context text");
      return v;
    }
    if (!v || typeof v !== "object" || parents.has(v))
      throw new Error("Invalid source context JSON");
    const arr = Array.isArray(v);
    if (
      ![arr ? Array.prototype : Object.prototype, null].includes(
        Object.getPrototypeOf(v),
      )
    )
      throw new Error("Invalid source context prototype");
    parents.add(v);
    const entries: [string, Json][] = [];
    for (const key of Reflect.ownKeys(v)) {
      if (arr && key === "length") continue;
      if (
        typeof key !== "string" ||
        (arr && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= v.length))
      )
        throw new Error("Invalid source context property");
      visit(key, depth + 1);
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!("value" in d) || !d.enumerable)
        throw new Error("Source context accessors are unsupported");
      entries.push([key, visit(d.value, depth + 1)]);
    }
    parents.delete(v);
    if (arr) {
      if (entries.length !== v.length)
        throw new Error("Sparse source context array");
      return entries.map(([, item]) => item);
    }
    return Object.fromEntries(
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }
  return visit(value, 0);
}
function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
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
const hash = (v: unknown) =>
  createHash("sha256").update(stable(v)).digest("hex");
function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Expected source context object");
  return v as Record<string, unknown>;
}
function keys(v: object, expected: string[]) {
  if (Object.keys(v).sort().join() !== [...expected].sort().join())
    throw new Error("Unexpected source context fields");
}
function text(v: unknown, name: string, max = 200): asserts v is string {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new Error(`Invalid ${name}`);
}
function digest(v: unknown) {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))
    throw new Error("Invalid hash");
}
function uuid(v: unknown): asserts v is string {
  if (
    typeof v !== "string" ||
    !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(v)
  )
    throw new Error("Invalid UUID");
}
function timestamp(v: unknown): asserts v is string {
  if (
    typeof v !== "string" ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString() !== v
  )
    throw new Error("Invalid timestamp");
}
function validateIdentity(value: unknown): Identity {
  const identity = obj(value);
  keys(identity, ["projectId", "publicationId", "detailUrl"]);
  uuid(identity.projectId);
  uuid(identity.publicationId);
  if (
    identity.detailUrl !==
    `https://www.simap.ch/api/publications/v1/project/${identity.projectId}/publication-details/${identity.publicationId}`
  )
    throw new Error("Invalid source URL");
  return identity as Identity;
}
function scopeReview(value: SourceScopeReview | null) {
  if (value === null) return;
  keys(obj(value), ["status", "kind", "token", "sourceRevision", "updatedAt"]);
  if (
    !["required", "resolved"].includes(value.status) ||
    !["ambiguous", "conflicting"].includes(value.kind)
  )
    throw new Error("Invalid legacy source barrier");
  text(value.token, "source scope token");
  text(value.sourceRevision, "source revision");
  timestamp(value.updatedAt);
}
export function captureLotSourceSnapshot(
  input: LotSourceSnapshotInput,
): LotSourceSnapshot {
  const clean = copy(input) as unknown as LotSourceSnapshotInput;
  keys(obj(clean), [
    "publicationId",
    "observationId",
    "acquisition",
    "sourceScopeReview",
  ]);
  text(clean.publicationId, "publication id");
  text(clean.observationId, "observation id");
  scopeReview(clean.sourceScopeReview);
  const acquisition = obj(clean.acquisition);
  if (acquisition.state === "accepted") {
    keys(acquisition, ["state", "archive"]);
    restoreSimapDetail(acquisition.archive as LotArchive); // verifies every archived field/hash/index
  } else if (acquisition.state === "refused") {
    keys(acquisition, ["state", "identity", "reason", "receiptHash"]);
    validateIdentity(acquisition.identity);
    text(acquisition.reason, "refusal reason", 500);
    digest(acquisition.receiptHash);
  } else throw new Error("Invalid acquisition state");
  const sourceIdentity =
    clean.acquisition.state === "accepted"
      ? clean.acquisition.archive.identity
      : clean.acquisition.identity;
  if (clean.publicationId !== `simap-${sourceIdentity.projectId}`)
    throw new Error("Snapshot belongs to another publication");
  const body = {
    version: LOT_SOURCE_CONTEXT_VERSION as typeof LOT_SOURCE_CONTEXT_VERSION,
    ...clean,
  };
  return freeze({ ...body, snapshotHash: hash(body) });
}
function verifySnapshot(input: LotSourceSnapshot): LotSourceSnapshot {
  const clean = copy(input) as unknown as LotSourceSnapshot;
  const { version, snapshotHash, ...body } = clean;
  const rebuilt = captureLotSourceSnapshot(body);
  if (
    version !== LOT_SOURCE_CONTEXT_VERSION ||
    snapshotHash !== rebuilt.snapshotHash ||
    stable(rebuilt) !== stable(clean)
  )
    throw new Error("Altered lot source snapshot");
  return rebuilt;
}
function identityOf(snapshot: LotSourceSnapshot) {
  return snapshot.acquisition.state === "accepted"
    ? snapshot.acquisition.archive.identity
    : snapshot.acquisition.identity;
}
function targetOf(
  input: LotSourceTarget,
  snapshot: LotSourceSnapshot,
): LotSourceTarget {
  const target = copy(input) as unknown as LotSourceTarget;
  if (target.kind === "project") keys(target, ["kind", "publicationId"]);
  else if (target.kind === "lot") {
    keys(target, ["kind", "publicationId", "sourceProjectId", "lotId"]);
    uuid(target.sourceProjectId);
    uuid(target.lotId);
    target.sourceProjectId = target.sourceProjectId.toLowerCase();
    target.lotId = target.lotId.toLowerCase();
    if (target.sourceProjectId !== identityOf(snapshot).projectId.toLowerCase())
      throw new Error("Target belongs to another source project");
  } else throw new Error("Invalid source target");
  if (target.publicationId !== snapshot.publicationId)
    throw new Error("Target belongs to another publication");
  return freeze(target);
}
const targetKey = (target: LotSourceTarget) =>
  target.kind === "project"
    ? "project"
    : `lot:${target.sourceProjectId}:${target.lotId}`;
export type LotTargetContent = DeepReadonly<{
  identity: Identity;
  projectSections: Record<string, unknown>;
  directory: { id: string; number: number }[];
  selectedLot: null | {
    path: string;
    basePath: string | null;
    record: unknown;
    header: unknown;
  };
  comparison: LotComparison | null;
}>;
type TargetInput = {
  sharedHash: string | null;
  selectionHash: string | null;
  refusal: string | null;
  content: LotTargetContent | null;
};
function rawAt(root: unknown, path: string): unknown {
  if (!path.startsWith("/") || /~(?![01])/u.test(path))
    throw new Error("Invalid original path");
  return path
    .slice(1)
    .split("/")
    .reduce<unknown>((current, piece) => {
      const key = piece.replaceAll("~1", "/").replaceAll("~0", "~");
      if (
        !current ||
        typeof current !== "object" ||
        !Object.hasOwn(current, key)
      )
        throw new Error("Original path not found");
      return (current as Record<string, unknown>)[key];
    }, root);
}
function targetInput(
  snapshot: LotSourceSnapshot,
  target: LotSourceTarget,
): TargetInput {
  if (snapshot.acquisition.state === "refused")
    return {
      sharedHash: null,
      selectionHash: null,
      refusal: snapshot.acquisition.reason,
      content: null,
    };
  const archive = snapshot.acquisition.archive;
  const directory = archive.directory.map(({ id, number }) => ({ id, number }));
  const shared = {
    identity: archive.identity,
    projectSections: archive.projectSections,
    directory,
  };
  const sharedHash = hash({
    version: LOT_SOURCE_CONTEXT_VERSION as typeof LOT_SOURCE_CONTEXT_VERSION,
    format: SOURCE_LOT_VERSION,
    ...shared,
  });
  if (target.kind === "project")
    return {
      sharedHash,
      selectionHash: hash({
        version:
          LOT_SOURCE_CONTEXT_VERSION as typeof LOT_SOURCE_CONTEXT_VERSION,
        target,
        sharedHash,
      }),
      refusal: null,
      content: freeze({ ...shared, selectedLot: null, comparison: null }),
    };
  const selected = archive.directory.find(
    (item) => item.id.toLowerCase() === target.lotId,
  );
  if (!selected)
    return {
      sharedHash,
      selectionHash: null,
      refusal: "lot_missing_or_removed",
      content: null,
    };
  try {
    const comparison = buildLotComparisonCorpus(archive, selected.id, {
      complete: true,
    });
    const raw = restoreSimapDetail(archive);
    return {
      sharedHash,
      selectionHash: hash({
        version:
          LOT_SOURCE_CONTEXT_VERSION as typeof LOT_SOURCE_CONTEXT_VERSION,
        target,
        selection: comparison.selectionHash,
      }),
      refusal: null,
      content: freeze({
        ...shared,
        selectedLot: {
          path: selected.path,
          basePath: selected.basePath,
          record: rawAt(raw, selected.path),
          header: selected.basePath ? rawAt(raw, selected.basePath) : null,
        },
        comparison,
      }),
    };
  } catch (error) {
    if (!(error instanceof LotInputError)) throw error;
    return {
      sharedHash,
      selectionHash: null,
      refusal: error.code,
      content: null,
    };
  }
}
export type LotDocumentaryReference = {
  selectionHash: string;
  rawPath: string;
  startUtf16: number;
  endUtf16: number;
};
export type LotResolvedReference = DeepReadonly<
  LotDocumentaryReference & {
    quote: string;
    origin: {
      scope: "project_context" | "selected_lot";
      url: string;
      language: SourceLanguage;
      page: null;
      representation: "verbatim_raw_string_may_contain_html";
    };
  }
>;
function referencesFor(
  references: readonly LotDocumentaryReference[],
  snapshot: LotSourceSnapshot,
  target: LotSourceTarget,
  input: TargetInput,
): readonly LotResolvedReference[] {
  if (
    snapshot.acquisition.state !== "accepted" ||
    !input.content ||
    !input.selectionHash
  )
    throw new Error("Refused target cannot receive a source form");
  if (
    !Array.isArray(references) ||
    !references.length ||
    references.length > 128
  )
    throw new Error("A recorded source review needs references");
  const raw = restoreSimapDetail(snapshot.acquisition.archive),
    seen = new Set<string>();
  let quoted = 0;
  return references.map((ref) => {
    keys(obj(ref), ["selectionHash", "rawPath", "startUtf16", "endUtf16"]);
    text(ref.rawPath, "original path", 4096);
    if (ref.selectionHash !== input.selectionHash || seen.has(stable(ref)))
      throw new Error("Stale or repeated source reference");
    seen.add(stable(ref));
    const within = (path: string) =>
      ref.rawPath === path || ref.rawPath.startsWith(path + "/");
    const isLot = within("/lots") || within("/base/lots");
    if (
      isLot &&
      (target.kind !== "lot" ||
        !input.content?.selectedLot ||
        !(
          within(input.content.selectedLot.path) ||
          (input.content.selectedLot.basePath &&
            within(input.content.selectedLot.basePath))
        ))
    )
      throw new Error("Reference belongs to another source target");
    const original = rawAt(raw, ref.rawPath);
    if (
      typeof original !== "string" ||
      ![ref.startUtf16, ref.endUtf16].every(Number.isSafeInteger) ||
      ref.startUtf16 < 0 ||
      ref.endUtf16 > original.length ||
      ref.endUtf16 <= ref.startUtf16
    )
      throw new Error("Reference outside original text");
    for (const boundary of [ref.startUtf16, ref.endUtf16])
      if (
        boundary > 0 &&
        boundary < original.length &&
        /[\uD800-\uDBFF]/u.test(original[boundary - 1]) &&
        /[\uDC00-\uDFFF]/u.test(original[boundary])
      )
        throw new Error("Reference splits Unicode character");
    const quote = original.slice(ref.startUtf16, ref.endUtf16);
    quoted += quote.length;
    if (!quote.trim() || quoted > 18000)
      throw new Error("Empty or oversized quoted evidence");
    const mapping =
      input.content?.comparison &&
      [
        ...input.content.comparison.project.sourceMappings,
        ...input.content.comparison.lot.sourceMappings,
      ].find((item) => item.rawPath === ref.rawPath);
    // Language only comes from a known documentary mapping, or a known parent
    // translation field. Unknown metadata remains explicitly unlabelled.
    const parentLanguage =
      /^\/(?:project-info|procurement|base)\/(?:title|orderDescription)\/(it|de|fr|en)$/.exec(
        ref.rawPath,
      )?.[1] as SourceLanguage | undefined;
    return freeze({
      ...ref,
      quote,
      origin: {
        scope: isLot ? ("selected_lot" as const) : ("project_context" as const),
        url:
          snapshot.acquisition.state === "accepted"
            ? snapshot.acquisition.archive.identity.detailUrl
            : "",
        language: mapping ? mapping.language : (parentLanguage ?? null),
        page: null,
        representation: "verbatim_raw_string_may_contain_html" as const,
      },
    });
  });
}
export type LotSourceReviewCommand = {
  target: LotSourceTarget;
  expectedSnapshotHash: string;
  expectedSelectionHash: string | null;
  expectedTargetEventId: string | null;
  expectedProjectBarrierHash: string;
  action: "opened" | "recorded";
  form: HumanSourceForm | null;
  references: readonly LotDocumentaryReference[];
  actorId: string;
  note: string;
};
export type LotSourceEventMetadata = {
  id: string;
  sourceRevision: string;
  contentRevision: string;
  createdAt: string;
};
export type LotSourceReviewEvent = DeepReadonly<
  LotSourceEventMetadata & {
    version: typeof LOT_SOURCE_CONTEXT_VERSION;
    publicationId: string;
    target: LotSourceTarget;
    sequence: number;
    previousEventId: string | null;
    previousEventHash: string | null;
    snapshotHash: string;
    sharedHash: string | null;
    selectionHash: string | null;
    projectBarrierHash: string;
    legacyScopeHash: string;
    action: "opened" | "recorded";
    form: HumanSourceForm | null;
    references: readonly LotDocumentaryReference[];
    evidence: readonly LotResolvedReference[];
    actorId: string;
    note: string;
    eventHash: string;
  }
>;
export type LotSourceReviewRecord = DeepReadonly<{
  event: LotSourceReviewEvent;
  snapshot: LotSourceSnapshot;
}>;
export type MixedSourceReviewRecord = ReviewRecord | LotSourceReviewRecord;
const projectTarget = (snapshot: LotSourceSnapshot): LotSourceTarget => ({
  kind: "project",
  publicationId: snapshot.publicationId,
});
function latestFor(
  history: readonly MixedSourceReviewRecord[],
  target: LotSourceTarget,
) {
  return history.findLast((record) =>
    record.event.version === LEGACY_VERSION
      ? target.kind === "project"
      : targetKey(record.event.target) === targetKey(target),
  );
}
export type LotProjectBarrier = DeepReadonly<{
  state: "clear" | "blocked";
  reason:
    | "reviewed"
    | "legacy_required"
    | "input_refused"
    | "not_reviewed"
    | "explicit_open"
    | "source_changed"
    | "human_unresolved";
  form: "defined_service" | "broad_scope" | null;
  reviewEventId: string | null;
  reviewEventHash: string | null;
  sharedHash: string | null;
  legacyScopeHash: string;
  barrierHash: string;
}>;
function projectBarrier(
  snapshot: LotSourceSnapshot,
  history: readonly MixedSourceReviewRecord[],
): LotProjectBarrier {
  const input = targetInput(snapshot, projectTarget(snapshot)),
    latest = latestFor(history, projectTarget(snapshot));
  let reason: LotProjectBarrier["reason"] = "not_reviewed",
    form: LotProjectBarrier["form"] = null;
  if (snapshot.sourceScopeReview?.status === "required")
    reason = "legacy_required";
  else if (input.refusal) reason = "input_refused";
  else if (latest?.event.action === "opened") reason = "explicit_open";
  else if (latest) {
    if (
      latest.event.version === LEGACY_VERSION ||
      latest.event.selectionHash !== input.selectionHash ||
      latest.event.legacyScopeHash !== hash(snapshot.sourceScopeReview)
    )
      reason = "source_changed";
    else if (
      latest.event.form === "defined_service" ||
      latest.event.form === "broad_scope"
    ) {
      reason = "reviewed";
      form = latest.event.form;
    } else reason = "human_unresolved";
  }
  const body = {
    state: reason === "reviewed" ? ("clear" as const) : ("blocked" as const),
    reason,
    form,
    reviewEventId: latest?.event.id ?? null,
    reviewEventHash: latest?.event.eventHash ?? null,
    sharedHash: input.sharedHash,
    legacyScopeHash: hash(snapshot.sourceScopeReview),
  };
  return freeze({
    ...body,
    barrierHash: hash({
      version: LOT_SOURCE_CONTEXT_VERSION as typeof LOT_SOURCE_CONTEXT_VERSION,
      ...body,
      refusal: input.refusal
        ? { reason: input.refusal, observationId: snapshot.observationId }
        : null,
    }),
  });
}
export type LotSourceDependency = DeepReadonly<{
  version: typeof LOT_SOURCE_CONTEXT_VERSION;
  publicationId: string;
  target: LotSourceTarget;
  sharedHash: string | null;
  selectionHash: string | null;
  inputRefusalHash: string | null;
  reviewEventId: string | null;
  reviewEventHash: string | null;
  projectBarrierHash: string;
}>;
export type LotSourceContext = DeepReadonly<{
  target: LotSourceTarget;
  state: "manual_source" | "review_required" | "input_refused";
  reason: string;
  form: HumanSourceForm | null;
  targetContent: LotTargetContent | null;
  projectBarrier: LotProjectBarrier;
  dependency: LotSourceDependency;
  review: MixedSourceReviewRecord | null;
}>;
function resolveChecked(
  snapshot: LotSourceSnapshot,
  target: LotSourceTarget,
  history: readonly MixedSourceReviewRecord[],
): LotSourceContext {
  const input = targetInput(snapshot, target),
    latest = latestFor(history, target),
    barrier = projectBarrier(snapshot, history);
  let state: LotSourceContext["state"] = "review_required",
    reason = "not_reviewed",
    form: HumanSourceForm | null = null;
  if (input.refusal) {
    state = "input_refused";
    reason = input.refusal;
  } else if (barrier.state === "blocked" && target.kind === "lot")
    reason = "project_" + barrier.reason;
  else if (latest?.event.action === "opened") reason = "explicit_open";
  else if (latest) {
    if (
      latest.event.version === LEGACY_VERSION ||
      latest.event.selectionHash !== input.selectionHash ||
      latest.event.legacyScopeHash !== hash(snapshot.sourceScopeReview) ||
      (target.kind === "lot" &&
        latest.event.projectBarrierHash !== barrier.barrierHash)
    )
      reason = "source_changed";
    else if (snapshot.sourceScopeReview?.status === "required")
      reason = "legacy_required";
    else if (
      latest.event.form === "defined_service" ||
      latest.event.form === "broad_scope"
    ) {
      state = "manual_source";
      reason = "human_recorded";
      form = latest.event.form;
    } else {
      reason = "human_unresolved";
      form = latest.event.form;
    }
  }
  const dependency = {
    version: LOT_SOURCE_CONTEXT_VERSION as typeof LOT_SOURCE_CONTEXT_VERSION,
    publicationId: snapshot.publicationId,
    target,
    sharedHash: input.sharedHash,
    selectionHash: input.selectionHash,
    inputRefusalHash: input.refusal
      ? hash({
          snapshotHash: snapshot.snapshotHash,
          target,
          reason: input.refusal,
        })
      : null,
    reviewEventId: latest?.event.id ?? null,
    reviewEventHash: latest?.event.eventHash ?? null,
    projectBarrierHash: barrier.barrierHash,
  };
  return freeze({
    target,
    state,
    reason,
    form,
    targetContent: input.content,
    projectBarrier: barrier,
    dependency,
    review: latest ?? null,
  });
}
const forms: HumanSourceForm[] = [
  "defined_service",
  "broad_scope",
  "unclear",
  "conflicting",
];
function makeRecord(
  command: Pick<
    LotSourceReviewCommand,
    "target" | "action" | "form" | "references" | "actorId" | "note"
  >,
  snapshot: LotSourceSnapshot,
  history: readonly MixedSourceReviewRecord[],
  metadata: LotSourceEventMetadata,
): LotSourceReviewRecord {
  const target = targetOf(command.target, snapshot),
    input = targetInput(snapshot, target);
  text(metadata.id, "event id");
  text(metadata.sourceRevision, "source revision");
  text(metadata.contentRevision, "content revision");
  timestamp(metadata.createdAt);
  text(command.actorId, "actor id");
  text(command.note, "review note", 800);
  if (command.note.trim().length < 10)
    throw new Error("Source review note too short");
  if (!Array.isArray(command.references))
    throw new Error("References must be an array");
  if (command.action === "opened") {
    if (command.form !== null || command.references.length)
      throw new Error("Opened review cannot assign a form or evidence");
  } else if (
    command.action !== "recorded" ||
    !forms.includes(command.form as HumanSourceForm)
  )
    throw new Error("Invalid human source form");
  const evidence =
    command.action === "recorded"
      ? referencesFor(command.references, snapshot, target, input)
      : [];
  const previous = history.at(-1)?.event;
  const body = {
    version: LOT_SOURCE_CONTEXT_VERSION as typeof LOT_SOURCE_CONTEXT_VERSION,
    ...metadata,
    publicationId: snapshot.publicationId,
    target,
    sequence: (previous?.sequence ?? 0) + 1,
    previousEventId: previous?.id ?? null,
    previousEventHash: previous?.eventHash ?? null,
    snapshotHash: snapshot.snapshotHash,
    sharedHash: input.sharedHash,
    selectionHash: input.selectionHash,
    projectBarrierHash: projectBarrier(snapshot, history).barrierHash,
    legacyScopeHash: hash(snapshot.sourceScopeReview),
    action: command.action,
    form: command.form,
    references: command.references,
    evidence,
    actorId: command.actorId,
    note: command.note,
  };
  return freeze(
    copy({ event: { ...body, eventHash: hash(body) }, snapshot }),
  ) as unknown as LotSourceReviewRecord;
}
// Legacy validation is deliberately a prefix, not filtered target rows. An old
// writer cannot append v1 after the deployment has started the v2 sequence.
export function verifyLotSourceHistory(
  publicationId: string,
  input: readonly MixedSourceReviewRecord[],
): readonly MixedSourceReviewRecord[] {
  if (!Array.isArray(input)) throw new Error("History must be an array");
  const history = input.map(
    (record) => copy(record) as unknown as MixedSourceReviewRecord,
  );
  let prefix = 0;
  while (history[prefix]?.event.version === LEGACY_VERSION) prefix++;
  if (prefix) {
    const legacy = history.slice(0, prefix) as ReviewRecord[];
    resolveSourceContext(legacy.at(-1)!.snapshot, legacy);
  }
  const checked = history.slice(0, prefix),
    ids = new Set(checked.map((record) => record.event.id));
  if (checked.some((record) => record.event.publicationId !== publicationId))
    throw new Error("Foreign legacy history");
  for (const record of history.slice(prefix)) {
    if (record.event.version !== LOT_SOURCE_CONTEXT_VERSION)
      throw new Error("Unsupported or late legacy review version");
    const snapshot = verifySnapshot(record.snapshot as LotSourceSnapshot);
    if (snapshot.publicationId !== publicationId || ids.has(record.event.id))
      throw new Error("Foreign or repeated source event");
    const event = record.event as LotSourceReviewEvent;
    const rebuilt = makeRecord(event, snapshot, checked, {
      id: event.id,
      sourceRevision: event.sourceRevision,
      contentRevision: event.contentRevision,
      createdAt: event.createdAt,
    });
    if (stable(record) !== stable(rebuilt))
      throw new Error("Altered or reordered lot source history");
    checked.push(rebuilt);
    ids.add(event.id);
  }
  return freeze(checked);
}
export function resolveLotSourceContext(
  current: LotSourceSnapshot,
  requestedTarget: LotSourceTarget,
  history: readonly MixedSourceReviewRecord[],
): LotSourceContext {
  const snapshot = verifySnapshot(current),
    checked = verifyLotSourceHistory(snapshot.publicationId, history),
    target = targetOf(requestedTarget, snapshot);
  return resolveChecked(snapshot, target, checked);
}
// Resolve evidence against its actual archive, with the same target and history
// checks as source review. This does not create or approve a source event.
export function resolveLotSourceReferences(
  current: LotSourceSnapshot,
  requestedTarget: LotSourceTarget,
  history: readonly MixedSourceReviewRecord[],
  references: readonly LotDocumentaryReference[],
): readonly LotResolvedReference[] {
  const snapshot = verifySnapshot(current);
  verifyLotSourceHistory(snapshot.publicationId, history);
  const target = targetOf(requestedTarget, snapshot);
  const clean = copy(references) as unknown as LotDocumentaryReference[];
  return freeze(
    referencesFor(clean, snapshot, target, targetInput(snapshot, target)),
  );
}
export function createLotSourceReviewRecord(
  commandInput: LotSourceReviewCommand,
  current: LotSourceSnapshot,
  history: readonly MixedSourceReviewRecord[],
  metadataInput: LotSourceEventMetadata,
): LotSourceReviewRecord {
  const command = copy(commandInput) as unknown as LotSourceReviewCommand,
    metadata = copy(metadataInput) as unknown as LotSourceEventMetadata;
  keys(command, [
    "target",
    "expectedSnapshotHash",
    "expectedSelectionHash",
    "expectedTargetEventId",
    "expectedProjectBarrierHash",
    "action",
    "form",
    "references",
    "actorId",
    "note",
  ]);
  keys(metadata, ["id", "sourceRevision", "contentRevision", "createdAt"]);
  const snapshot = verifySnapshot(current),
    checked = verifyLotSourceHistory(snapshot.publicationId, history),
    target = targetOf(command.target, snapshot),
    context = resolveChecked(snapshot, target, checked);
  if (
    command.expectedSnapshotHash !== snapshot.snapshotHash ||
    command.expectedSelectionHash !== context.dependency.selectionHash ||
    command.expectedTargetEventId !== context.dependency.reviewEventId ||
    command.expectedProjectBarrierHash !== context.projectBarrier.barrierHash
  )
    throw new ReviewConflict(
      "The source snapshot, target review or project barrier changed",
    );
  if (checked.some((record) => record.event.id === metadata.id))
    throw new Error("Repeated review event id");
  return makeRecord({ ...command, target }, snapshot, checked, metadata);
}
export function isLotSourceDependencyCurrent(
  dependency: LotSourceDependency,
  current: LotSourceSnapshot,
  history: readonly MixedSourceReviewRecord[],
): boolean {
  const clean = copy(dependency) as unknown as LotSourceDependency;
  return (
    stable(clean) ===
    stable(resolveLotSourceContext(current, clean.target, history).dependency)
  );
}

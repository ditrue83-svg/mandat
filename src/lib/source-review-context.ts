import { createHash } from "node:crypto";
import {
  buildMatchingSourceCorpus,
  type DeepReadonly,
  type SourceInputResult,
  type SourceOrigin,
} from "./source-input";

export const CONTEXT_VERSION = "human-source-review-context-v1";
const documentaryFields = [
  "sourceUrl",
  "originalText",
  "originalTitles",
  "originalDescriptions",
  "documentPages",
  "documents",
] as const;
export type HumanSourceForm =
  "defined_service" | "broad_scope" | "unclear" | "conflicting";
const forms: readonly HumanSourceForm[] = [
  "defined_service",
  "broad_scope",
  "unclear",
  "conflicting",
];
type Json = null | string | boolean | number | Json[] | { [key: string]: Json };
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function json(value: unknown, parents = new Set<object>()): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || parents.has(value))
    throw new Error("Only finite acyclic JSON data is supported");
  const array = Array.isArray(value);
  if (
    Object.getPrototypeOf(value) !==
      (array ? Array.prototype : Object.prototype) &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error("Unexpected input prototype");
  parents.add(value);
  const out: Record<string, Json> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    if (typeof key !== "string" || (array && !/^(0|[1-9]\d*)$/.test(key)))
      throw new Error("Unexpected JSON property");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor) || !descriptor.enumerable)
      throw new Error(
        "Accessors or hidden documentary fields are not supported",
      );
    out[key] = json(descriptor.value, parents);
  }
  parents.delete(value);
  if (array) {
    if (Object.keys(out).length !== value.length)
      throw new Error("Sparse JSON array");
    return Array.from({ length: value.length }, (_, i) => out[String(i)]);
  }
  return out;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => `${JSON.stringify(key)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) =>
  createHash("sha256").update(stable(value)).digest("hex");
function string(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Invalid ${label}`);
  return value;
}
function projection(input: unknown): Record<string, Json> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new Error("Documentary input must be a plain object");
  const result: Record<string, Json> = {};
  for (const key of documentaryFields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor) continue;
    if (!("value" in descriptor) || !descriptor.enumerable)
      throw new Error(
        "Documentary accessors or hidden fields are not supported",
      );
    result[key] = json(descriptor.value);
  }
  return result;
}
export type SourceSnapshot = DeepReadonly<{
  version: typeof CONTEXT_VERSION;
  publicationId: string;
  sourceSnapshotHash: string;
  documentaryInput: Record<string, unknown>;
  source: SourceInputResult;
}>;
export function captureSourceSnapshot(
  publicationId: string,
  input: unknown,
): SourceSnapshot {
  string(publicationId, "publication id");
  const documentaryInput = projection(input);
  const source = buildMatchingSourceCorpus(documentaryInput);
  return freeze({
    version: CONTEXT_VERSION,
    publicationId,
    sourceSnapshotHash: hash({
      version: CONTEXT_VERSION,
      publicationId,
      documentaryInput,
    }),
    documentaryInput,
    source,
  });
}
function verifySnapshot(snapshot: SourceSnapshot): SourceSnapshot {
  const clean = json(snapshot) as unknown as SourceSnapshot;
  const rebuilt = captureSourceSnapshot(
    clean.publicationId,
    clean.documentaryInput,
  );
  if (stable(clean) !== stable(rebuilt))
    throw new Error("Altered source snapshot");
  return rebuilt;
}
const corpusHash = (snapshot: SourceSnapshot) =>
  snapshot.source.accepted ? snapshot.source.corpus.inputHash : null;

export type DocumentaryReference = {
  unitId: string;
  originIndex: number;
  startUtf16: number;
  endUtf16: number;
};
export type ResolvedReference = DeepReadonly<
  DocumentaryReference & { quote: string; origin: SourceOrigin }
>;
function resolveReferences(
  references: readonly DocumentaryReference[],
  snapshot: SourceSnapshot,
): readonly ResolvedReference[] {
  if (!snapshot.source.accepted)
    throw new Error(
      "Cannot record a source form without a verified complete corpus",
    );
  if (!references.length || references.length > 128)
    throw new Error("A recorded source review needs original references");
  const seen = new Set<string>();
  return references.map((ref) => {
    if (
      Object.keys(ref).sort().join() !==
      "endUtf16,originIndex,startUtf16,unitId"
    )
      throw new Error("Unexpected reference fields");
    if (seen.has(stable(ref))) throw new Error("Duplicate reference");
    seen.add(stable(ref));
    const unit = snapshot.source.accepted
      ? snapshot.source.corpus.units.find((unit) => unit.id === ref.unitId)
      : undefined;
    if (
      !unit ||
      !Number.isInteger(ref.originIndex) ||
      ref.originIndex < 0 ||
      ref.originIndex >= unit.origins.length ||
      !Number.isInteger(ref.startUtf16) ||
      !Number.isInteger(ref.endUtf16) ||
      ref.startUtf16 < 0 ||
      ref.endUtf16 > unit.text.length ||
      ref.endUtf16 <= ref.startUtf16
    )
      throw new Error("Reference is outside this complete corpus");
    const boundary = (offset: number) =>
      offset === 0 ||
      offset === unit.text.length ||
      !(
        /[\uD800-\uDBFF]/u.test(unit.text[offset - 1]) &&
        /[\uDC00-\uDFFF]/u.test(unit.text[offset])
      );
    if (!boundary(ref.startUtf16) || !boundary(ref.endUtf16))
      throw new Error("Reference splits a UTF-16 character");
    const quote = unit.text.slice(ref.startUtf16, ref.endUtf16);
    if (!quote.trim()) throw new Error("Empty original quote");
    return freeze({ ...ref, quote, origin: unit.origins[ref.originIndex] });
  });
}
export type ReviewCommand = {
  publicationId: string;
  expectedEventId: string | null;
  expectedSourceSnapshotHash: string;
  expectedCorpusHash: string | null;
  action: "opened" | "recorded";
  form: HumanSourceForm | null;
  references: readonly DocumentaryReference[];
  actorId: string;
  note: string;
};
export type SourceReviewEvent = DeepReadonly<{
  version: typeof CONTEXT_VERSION;
  id: string;
  publicationId: string;
  sequence: number;
  previousEventId: string | null;
  sourceSnapshotHash: string;
  corpusHash: string | null;
  sourceRevision: string;
  contentRevision: string;
  action: ReviewCommand["action"];
  form: HumanSourceForm | null;
  references: readonly DocumentaryReference[];
  evidence: readonly ResolvedReference[];
  actorId: string;
  note: string;
  createdAt: string;
  eventHash: string;
}>;
export type ReviewRecord = DeepReadonly<{
  event: SourceReviewEvent;
  snapshot: SourceSnapshot;
}>;
type EventMetadata = {
  id: string;
  sourceRevision: string;
  contentRevision: string;
  createdAt: string;
};
function makeRecord(
  command: Pick<
    ReviewCommand,
    "action" | "form" | "references" | "actorId" | "note"
  >,
  snapshot: SourceSnapshot,
  previous: SourceReviewEvent | undefined,
  metadata: EventMetadata,
): ReviewRecord {
  string(metadata.id, "event id");
  string(metadata.sourceRevision, "source revision");
  string(metadata.contentRevision, "content revision");
  if (
    !Number.isFinite(Date.parse(metadata.createdAt)) ||
    new Date(metadata.createdAt).toISOString() !== metadata.createdAt
  )
    throw new Error("Invalid review timestamp");
  string(command.actorId, "actor id");
  string(command.note, "review note", 10000);
  const references = json(
    command.references,
  ) as unknown as DocumentaryReference[];
  if (!Array.isArray(references))
    throw new Error("References must be an array");
  if (command.action === "opened") {
    if (command.form !== null || references.length)
      throw new Error("An opened review cannot assign a source form");
  } else if (command.action === "recorded") {
    if (!forms.includes(command.form as HumanSourceForm))
      throw new Error("Invalid human source form");
  } else throw new Error("Invalid human review action");
  const evidence =
    command.action === "recorded"
      ? resolveReferences(references, snapshot)
      : [];
  const body = {
    version: CONTEXT_VERSION,
    id: metadata.id,
    sourceRevision: metadata.sourceRevision,
    contentRevision: metadata.contentRevision,
    createdAt: metadata.createdAt,
    publicationId: snapshot.publicationId,
    sequence: (previous?.sequence ?? 0) + 1,
    previousEventId: previous?.id ?? null,
    sourceSnapshotHash: snapshot.sourceSnapshotHash,
    corpusHash: corpusHash(snapshot),
    action: command.action,
    form: command.form,
    references,
    evidence,
    actorId: command.actorId,
    note: command.note,
  } as const;
  return freeze({ event: { ...body, eventHash: hash(body) }, snapshot });
}
function verifyHistory(
  publicationId: string,
  history: readonly ReviewRecord[],
): readonly ReviewRecord[] {
  if (!Array.isArray(history))
    throw new Error("Review history must be an array");
  const checked: ReviewRecord[] = [],
    ids = new Set<string>();
  for (const record of history) {
    const clean = json(record) as unknown as ReviewRecord;
    const snapshot = verifySnapshot(clean.snapshot),
      event = clean.event;
    if (
      snapshot.publicationId !== publicationId ||
      event.publicationId !== publicationId ||
      ids.has(event.id)
    )
      throw new Error("Review belongs to another source or repeats an event");
    const rebuilt = makeRecord(event, snapshot, checked.at(-1)?.event, event);
    if (stable(clean) !== stable(rebuilt))
      throw new Error("Altered or reordered review history");
    checked.push(rebuilt);
    ids.add(event.id);
  }
  return freeze(checked);
}

export type SourceDependency = DeepReadonly<{
  version: typeof CONTEXT_VERSION;
  publicationId: string;
  sourceSnapshotHash: string;
  corpusHash: string | null;
  reviewEventId: string | null;
  reviewEventHash: string | null;
}>;
export type SourceContext = DeepReadonly<
  {
    dependency: SourceDependency;
  } & (
    | { state: "pending" }
    | { state: "input_refused"; reason: string }
    | {
        state: "review_required";
        reason: "explicit_open" | "source_changed" | "human_unresolved";
        review: ReviewRecord;
      }
    | {
        state: "manual_source";
        form: "defined_service" | "broad_scope";
        review: ReviewRecord;
      }
  )
>;

export function resolveSourceContext(
  current: SourceSnapshot,
  history: readonly ReviewRecord[],
): SourceContext {
  const snapshot = verifySnapshot(current),
    records = verifyHistory(snapshot.publicationId, history),
    latest = records.at(-1);
  const dependency: SourceDependency = freeze({
    version: CONTEXT_VERSION,
    publicationId: snapshot.publicationId,
    sourceSnapshotHash: snapshot.sourceSnapshotHash,
    corpusHash: corpusHash(snapshot),
    reviewEventId: latest?.event.id ?? null,
    reviewEventHash: latest?.event.eventHash ?? null,
  });
  if (latest?.event.action === "opened")
    return freeze({
      dependency,
      state: "review_required",
      reason: "explicit_open",
      review: latest,
    });
  if (!snapshot.source.accepted)
    return freeze({
      dependency,
      state: "input_refused",
      reason: snapshot.source.reason,
    });
  if (!latest) return freeze({ dependency, state: "pending" });
  if (
    latest.event.sourceSnapshotHash !== snapshot.sourceSnapshotHash ||
    latest.event.corpusHash !== corpusHash(snapshot)
  )
    return freeze({
      dependency,
      state: "review_required",
      reason: "source_changed",
      review: latest,
    });
  if (
    latest.event.form === "defined_service" ||
    latest.event.form === "broad_scope"
  )
    return freeze({
      dependency,
      state: "manual_source",
      form: latest.event.form,
      review: latest,
    });
  return freeze({
    dependency,
    state: "review_required",
    reason: "human_unresolved",
    review: latest,
  });
}
export function isSourceDependencyCurrent(
  dependency: SourceDependency,
  snapshot: SourceSnapshot,
  history: readonly ReviewRecord[],
): boolean {
  return (
    stable(json(dependency)) ===
    stable(resolveSourceContext(snapshot, history).dependency)
  );
}

export class ReviewConflict extends Error {}
export function createSourceReviewRecord(
  commandInput: ReviewCommand,
  current: SourceSnapshot,
  history: readonly ReviewRecord[],
  metadata: EventMetadata,
): ReviewRecord {
  const command = freeze(json(commandInput)) as unknown as ReviewCommand;
  const snapshot = verifySnapshot(current);
  const checked = verifyHistory(snapshot.publicationId, history);
  const previous = checked.at(-1)?.event;
  if (
    command.publicationId !== snapshot.publicationId ||
    (previous?.id ?? null) !== command.expectedEventId ||
    snapshot.sourceSnapshotHash !== command.expectedSourceSnapshotHash ||
    corpusHash(snapshot) !== command.expectedCorpusHash
  )
    throw new ReviewConflict(
      "The source corpus or previous review event changed",
    );
  if (checked.some((record) => record.event.id === metadata.id))
    throw new Error("Review event id must be unique");
  return makeRecord(command, snapshot, previous, metadata);
}

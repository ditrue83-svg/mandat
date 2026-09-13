import { createHash } from "node:crypto";
import {
  buildMatchingSourceCorpus,
  SOURCE_INPUT_VERSION,
  type DeepReadonly,
  type SourceInputResult,
  type SourceLanguage,
} from "./source-input";

// Persisted formats bind to explicit algorithm versions, never source files on
// disk: these functions also run in compiled Next.js and worker bundles.
// Bump the version when canonicalization, source mapping or hash semantics change.
export const SOURCE_LOT_VERSION = "simap-lot-documentary-v1";
const binding = Object.freeze({
  formatVersion: SOURCE_LOT_VERSION,
  sourceInputVersion: SOURCE_INPUT_VERSION,
});

export const SOURCE_LOT_LIMITS = Object.freeze({
  maxLots: 64,
  maxArchiveBytes: 2_000_000,
  maxNodes: 25000,
  maxDepth: 32,
  maxComparisonUtf16: 18000,
  maxComparisonLeaves: 1024,
});
type Json = null | string | number | boolean | Json[] | { [key: string]: Json };
type Obj = Record<string, Json>;
export class LotInputError extends Error {
  constructor(
    public code: string,
    public field: string,
  ) {
    super(`${code}: ${field}`);
  }
}
const bad = (code: string, path: string): never => {
  throw new LotInputError(code, path);
};
function copyJson(value: unknown): Json {
  let nodes = 0,
    bytes = 0;
  const parents = new Set<object>();
  function visit(v: unknown, path: string, depth: number): Json {
    if (++nodes > SOURCE_LOT_LIMITS.maxNodes || depth > SOURCE_LOT_LIMITS.maxDepth)
      return bad("archive_limit", path);
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return bad("invalid_json", path);
      return v;
    }
    if (typeof v === "string") {
      bytes += Buffer.byteLength(v, "utf8");
      if (bytes > SOURCE_LOT_LIMITS.maxArchiveBytes) return bad("archive_limit", path);
      if (!v.isWellFormed()) return bad("invalid_unicode", path);
      // PostgreSQL JSONB cannot store U+0000, even though JSON.parse accepts it.
      if (v.includes("\u0000")) return bad("unsupported_jsonb_text", path);
      return v;
    }
    if (!v || typeof v !== "object" || parents.has(v))
      return bad("invalid_json", path);
    const arr = Array.isArray(v);
    if (
      !(arr ? [Array.prototype, null] : [Object.prototype, null]).includes(
        Object.getPrototypeOf(v),
      )
    )
      return bad("invalid_json", path);
    parents.add(v);
    const entries: [string, Json][] = [];
    for (const k of Reflect.ownKeys(v)) {
      if (arr && k === "length") continue;
      if (
        typeof k !== "string" ||
        (arr && (!/^(0|[1-9]\d*)$/.test(k) || Number(k) >= v.length))
      )
        return bad("invalid_json", path);
      // Keep the error path itself valid for the database and logging layer.
      if (!k.isWellFormed())
        return bad("invalid_unicode", path + "/[property-name]");
      if (k.includes("\u0000"))
        return bad("unsupported_jsonb_text", path + "/[property-name]");
      const d = Object.getOwnPropertyDescriptor(v, k)!;
      if (!("value" in d) || !d.enumerable)
        return bad("invalid_json", path + "/" + k);
      bytes += Buffer.byteLength(k, "utf8");
      if (bytes > SOURCE_LOT_LIMITS.maxArchiveBytes) return bad("archive_limit", path);
      entries.push([
        k,
        visit(d.value, path + "/" + escapePointer(k), depth + 1),
      ]);
    }
    parents.delete(v);
    if (arr) {
      if (entries.length !== v.length) return bad("sparse_array", path);
      return entries.map(([, x]) => x);
    }
    // JSON object key order carries no source meaning. Canonicalize only
    // object properties, preserving every key/string and all array positions.
    // Corpus traversal and provenance indexes are then stable after JSONB-like
    // property reordering as well as JSON serialization.
    return Object.fromEntries(
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }
  return visit(value, "", 0);
}
function escapePointer(k: string) {
  return k.replaceAll("~", "~0").replaceAll("/", "~1");
}
function stable(v: unknown): string {
  return Array.isArray(v)
    ? "[" + v.map(stable).join(",") + "]"
    : v && typeof v === "object"
      ? "{" +
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => JSON.stringify(k) + ":" + stable(x))
          .join(",") +
        "}"
      : JSON.stringify(v);
}
const hash = (v: unknown) =>
  createHash("sha256").update(stable(v)).digest("hex");
function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
function object(v: Json | undefined, path: string): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v))
    return bad("expected_object", path);
  return v;
}
function uuid(v: unknown, path: string): string {
  if (
    typeof v !== "string" ||
    !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(v)
  )
    return bad("invalid_identity", path);
  return v;
}
const has = (o: Obj, k: string) => Object.hasOwn(o, k);
const pick = (o: Obj, keys: readonly string[]): Obj =>
  Object.fromEntries(keys.filter((k) => has(o, k)).map((k) => [k, o[k]]));
const omit = (o: Obj, keys: readonly string[]): Obj =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
export type Identity = {
  projectId: string;
  publicationId: string;
  detailUrl: string;
};
export type LotArchive = DeepReadonly<{
  version: typeof SOURCE_LOT_VERSION;
  identity: Identity;
  presence: "absent" | "null" | "empty" | "present";
  projectSections: Record<string, unknown>;
  lotField: Record<string, unknown>;
  baseLotField: Record<string, unknown>;
  directory: {
    id: string;
    number: number;
    path: string;
    basePath: string | null;
  }[];
  archiveHash: string;
}>;
function checkIndex(
  value: Json | undefined,
  path: string,
): { id: string; number: number; path: string }[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return bad("ambiguous_lot_list", path);
  if (value.length > SOURCE_LOT_LIMITS.maxLots) return bad("lot_limit", path);
  const ids = new Set<string>(),
    numbers = new Set<number>();
  return value.map((item, i) => {
    const p = path + "/" + i;
    const o = object(item, p);
    const id = uuid(o.id, p + "/id");
    const number = o.lotNumber;
    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number < 1
    )
      return bad("invalid_lot_number", p + "/lotNumber");
    const uuidIdentity = id.toLowerCase();
    if (ids.has(uuidIdentity) || numbers.has(number))
      return bad("duplicate_lot_identity", p);
    ids.add(uuidIdentity);
    numbers.add(number);
    return { id, number, path: p };
  });
}
export function preserveSimapLots(
  detail: unknown,
  expected: Identity,
): LotArchive {
  const identityValues = object(copyJson(expected), "expected");
  if (
    Object.keys(identityValues).sort().join(",") !==
    "detailUrl,projectId,publicationId"
  )
    return bad("invalid_identity_fields", "expected");
  expected = identityValues as unknown as Identity;
  const d = object(copyJson(detail), "");
  const base = has(d, "base") ? object(d.base, "/base") : {};
  uuid(expected.projectId, "expected/projectId");
  uuid(expected.publicationId, "expected/publicationId");
  const exactUrl = `https://www.simap.ch/api/publications/v1/project/${expected.projectId}/publication-details/${expected.publicationId}`;
  if (expected.detailUrl !== exactUrl)
    return bad("wrong_source_url", "expected/detailUrl");
  if (
    d.id !== expected.publicationId ||
    (has(base, "id") && base.id !== expected.publicationId) ||
    (has(base, "projectId") && base.projectId !== expected.projectId)
  )
    return bad("identity_mismatch", "/id");
  const directory = checkIndex(d.lots, "/lots");
  const baseDirectory = checkIndex(base.lots, "/base/lots");
  if (
    (baseDirectory.length && !directory.length) ||
    (base.lotsType === "with" && !directory.length)
  )
    return bad("missing_lot_details", "/lots");
  if (
    baseDirectory.length &&
    stable(baseDirectory.map((x) => [x.id.toLowerCase(), x.number]).sort()) !==
      stable(directory.map((x) => [x.id.toLowerCase(), x.number]).sort())
  )
    return bad("conflicting_lot_index", "/base/lots");
  // An explicitly empty base list beside detailed lots also disagrees. Absence
  // is retained as absence; it is not silently replaced by the detailed list.
  if (Array.isArray(base.lots) && !base.lots.length && directory.length)
    return bad("conflicting_lot_index", "/base/lots");
  const presence = !has(d, "lots")
    ? "absent"
    : d.lots === null
      ? "null"
      : directory.length
        ? "present"
        : "empty";
  const body = {
    version: SOURCE_LOT_VERSION,
    identity: { ...expected },
    presence,
    // Keep every supplied parent field, including unknown/future sections. Only
    // the two complete lot lists are stored separately; nothing is synthesized.
    projectSections: {
      ...omit(d, ["lots", "base"]),
      ...(has(d, "base") ? { base: omit(base, ["lots"]) } : {}),
    },
    lotField: pick(d, ["lots"]),
    baseLotField: pick(base, ["lots"]),
    directory: directory.map((x) => ({
      ...x,
      basePath:
        baseDirectory.find((b) => b.id.toLowerCase() === x.id.toLowerCase())
          ?.path ?? null,
    })),
  };
  const archive = { ...body, archiveHash: hash(body) };
  // The copy guard bounds allocation; this is the actual serialized archive
  // limit, including escaping, punctuation, identity, directory and hash.
  if (
    Buffer.byteLength(JSON.stringify(archive), "utf8") > SOURCE_LOT_LIMITS.maxArchiveBytes
  )
    return bad("archive_serialized_limit", "archive");
  // The wrapper/directory also consume nodes and depth. Apply exactly the
  // reader's structural guards before returning an accepted archive, so our
  // output cannot immediately fail verifyArchive only because of its shape.
  return freeze(copyJson(archive)) as unknown as LotArchive;
}
function verifyArchive(archive: LotArchive): LotArchive {
  const a = object(copyJson(archive), "archive");
  const { archiveHash, ...body } = a;
  if (archiveHash !== hash(body) || a.version !== SOURCE_LOT_VERSION)
    return bad("altered_archive", "archive");
  const identity = a.identity as unknown as Identity;
  const sections = object(a.projectSections, "archive/projectSections");
  const originalBase = object(sections.base ?? {}, "archive/base");
  const rebuilt = preserveSimapLots(
    {
      ...sections,
      ...object(a.lotField, "archive/lotField"),
      ...(Object.hasOwn(sections, "base") ||
      Object.keys(object(a.baseLotField, "archive/baseLotField")).length
        ? {
            base: {
              ...originalBase,
              ...object(a.baseLotField, "archive/baseLotField"),
            },
          }
        : {}),
    },
    identity,
  );
  if (stable(rebuilt) !== stable(a)) return bad("altered_archive", "archive");
  return rebuilt;
}
export function restoreLotFields(archive: LotArchive): {
  detail: Obj;
  base: Obj;
} {
  const a = verifyArchive(archive);
  return copyJson({ detail: a.lotField, base: a.baseLotField }) as {
    detail: Obj;
    base: Obj;
  };
}
export function restoreSimapDetail(archive: LotArchive): Obj {
  const a = verifyArchive(archive);
  const sections = a.projectSections as Obj;
  return copyJson({
    ...sections,
    ...a.lotField,
    ...(Object.hasOwn(sections, "base") || Object.keys(a.baseLotField).length
      ? { base: { ...object(sections.base ?? {}, "/base"), ...a.baseLotField } }
      : {}),
  }) as Obj;
}
function pointer(v: any, path: string): any {
  return path
    .split("/")
    .slice(1)
    .reduce((o, k) => o[k.replaceAll("~1", "/").replaceAll("~0", "~")], v);
}
const langs = new Set(["it", "de", "fr", "en"]);
type TextEntry = {
  text: string;
  language: SourceLanguage;
  url: string;
  rawPath: string;
  channel: "title" | "description";
};
type FieldEntry = {
  path: string;
  value: unknown;
  url: string;
  language: SourceLanguage;
  page: null;
  channel: "uninterpreted_metadata" | "classification";
};
export type ScopeCorpus = DeepReadonly<{
  scope: "project_context" | "selected_lot";
  corpus: SourceInputResult;
  sourceMappings: {
    unitId: string;
    originIndex: number;
    rawPath: string;
    url: string;
    language: SourceLanguage;
    page: null;
    representation: "verbatim_raw_string_may_contain_html";
  }[];
  fields: FieldEntry[];
  scopeHash: string;
}>;
function translations(
  v: Json | undefined,
  path: string,
  url: string,
  channel: TextEntry["channel"],
): TextEntry[] {
  if (v === undefined || v === null) return [];
  if (typeof v === "string")
    return [{ text: v, language: null, url, rawPath: path, channel }];
  const o = object(v, path);
  return Object.entries(o).flatMap(([language, text]) => {
    if (!langs.has(language))
      return bad("unsupported_text_language", path + "/" + language);
    if (text === null) return [];
    if (typeof text !== "string")
      return bad("ambiguous_translated_text", path + "/" + language);
    return [
      {
        text,
        language: language as SourceLanguage,
        url,
        rawPath: path + "/" + language,
        channel,
      },
    ];
  });
}
const classificationKeys = new Set([
  "cpvCode",
  "additionalCpvCodes",
  "bkpCodes",
  "ebkphCodes",
  "ebkptCodes",
  "npkCodes",
  "oagCodes",
  "cpcCode",
  "projectSubType",
  "orderType",
  "supplyType",
  "constructionType",
  "constructionCategory",
]);
function fieldsOf(
  o: Obj,
  path: string,
  url: string,
  excluded: readonly string[],
  classifyKnownKeys = true,
): FieldEntry[] {
  const out: FieldEntry[] = [];
  function leaves(
    v: Json,
    p: string,
    channel: FieldEntry["channel"],
    language: SourceLanguage = null,
  ) {
    if (v && typeof v === "object" && Object.keys(v).length) {
      for (const [k, x] of Object.entries(v))
        leaves(
          x,
          p + "/" + escapePointer(k),
          channel,
          channel === "classification" && p.endsWith("/label") && langs.has(k)
            ? (k as SourceLanguage)
            : language,
        );
    } else out.push({ path: p, value: v, url, language, page: null, channel });
  }
  for (const [k, v] of Object.entries(o)) {
    if (!excluded.includes(k))
      leaves(
        v,
        path + "/" + escapePointer(k),
        classifyKnownKeys && classificationKeys.has(k)
          ? "classification"
          : "uninterpreted_metadata",
      );
  }
  return out;
}
function makeScope(
  scope: ScopeCorpus["scope"],
  texts: TextEntry[],
  fields: FieldEntry[],
  url: string,
  rawForHash: unknown,
): ScopeCorpus {
  const title = texts.filter((x) => x.channel === "title"),
    desc = texts.filter((x) => x.channel === "description");
  const adapted = {
    sourceUrl: url,
    originalText: "",
    originalTitles: title.map((x) => ({
      text: x.text,
      language: x.language,
      url,
      path: x.rawPath,
    })),
    originalDescriptions: desc.map((x) => ({
      text: x.text,
      language: x.language,
      url,
    })),
    documentPages: [],
    documents: [],
  };
  const corpus = buildMatchingSourceCorpus(adapted);
  if (!corpus.accepted && corpus.reason !== "no_readable_text")
    return bad("corpus_" + corpus.reason, scope + "/" + corpus.field);
  const mapping = corpus.accepted
    ? corpus.corpus.units.flatMap((u) =>
        u.origins.flatMap((o, originIndex) => {
          if (o.collection === "originalText") return [];
          const ix = Number(o.recordPointer.split("/")[2]);
          const item = (o.collection === "originalTitles" ? title : desc)[ix];
          if (!item) return bad("mapping_failure", o.recordPointer);
          return [
            {
              unitId: u.id,
              originIndex,
              rawPath: item.rawPath,
              url: item.url,
              language: item.language,
              page: null as null,
              representation: "verbatim_raw_string_may_contain_html" as const,
            },
          ];
        }),
      )
    : [];
  return freeze({
    scope,
    corpus,
    sourceMappings: mapping,
    fields,
    scopeHash: hash({
      version: SOURCE_LOT_VERSION,
      binding,
      scope,
      rawForHash,
      sourceMappings: mapping,
      fields,
    }),
  });
}
function comparisonSize(values: unknown[]) {
  let size = 0,
    leaves = 0;
  function walk(v: unknown) {
    if (v && typeof v === "object" && Object.keys(v).length) {
      Object.values(v).forEach(walk);
    } else {
      leaves++;
      if (typeof v === "string") size += v.length;
    }
  }
  values.forEach(walk);
  if (size > SOURCE_LOT_LIMITS.maxComparisonUtf16 || leaves > SOURCE_LOT_LIMITS.maxComparisonLeaves)
    return bad("comparison_limit", "selectedContext");
  return { inputUtf16: size, inputLeaves: leaves };
}
export type LotComparison = DeepReadonly<{
  version: typeof SOURCE_LOT_VERSION;
  binding: typeof binding;
  target: {
    projectId: string;
    publicationId: string;
    lotId: string;
    lotNumber: number;
  };
  archiveHash: string;
  selectionHash: string;
  directory: { id: string; number: number }[];
  project: ScopeCorpus;
  lot: ScopeCorpus;
  counts: { inputUtf16: number; inputLeaves: number };
  coverage: "provided_project_records_and_selected_lot_only";
  interpretation: "documentary_only_no_awardability_or_service_attribution_inferred";
}>;
export function buildLotComparisonCorpus(
  archive: LotArchive,
  lotId: string,
): LotComparison {
  const a = verifyArchive(archive);
  const item = a.directory.find((x) => x.id === lotId);
  if (!item) return bad("lot_selection_required_or_unknown", "lotId");
  const root = { lots: a.lotField.lots, base: { lots: a.baseLotField.lots } };
  const lot = pointer(root, item.path) as Obj;
  const header = item.basePath ? (pointer(root, item.basePath) as Obj) : null;
  const sections = a.projectSections as Obj;
  const url = a.identity.detailUrl;
  const counts = comparisonSize([sections, lot, header]);
  const projectTexts: TextEntry[] = [],
    projectFields: FieldEntry[] = [];
  const documentarySections = new Set(["project-info", "procurement", "base"]);
  for (const [section, value] of Object.entries(sections)) {
    const sectionPath = "/" + escapePointer(section);
    if (
      documentarySections.has(section) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const o = value as Obj;
      projectTexts.push(
        ...translations(o.title, sectionPath + "/title", url, "title"),
        ...translations(
          o.orderDescription,
          sectionPath + "/orderDescription",
          url,
          "description",
        ),
      );
      projectFields.push(
        ...fieldsOf(o, sectionPath, url, ["title", "orderDescription"]),
      );
    } else {
      // Unknown sections can contain a field named title/orderDescription, or
      // repeat a CPV. Their role is unknown: preserve as literal metadata and
      // never promote those names to a documentary service channel.
      projectFields.push(...fieldsOf({ [section]: value }, "", url, [], false));
    }
  }
  const lotTexts = [
    ...translations(lot.title, item.path + "/title", url, "title"),
    ...translations(
      lot.orderDescription,
      item.path + "/orderDescription",
      url,
      "description",
    ),
    ...(header
      ? translations(header.title, item.basePath + "/title", url, "title")
      : []),
  ];
  const lotFields = [
    ...fieldsOf(lot, item.path, url, [
      "title",
      "orderDescription",
      "id",
      "lotNumber",
    ]),
    ...(header
      ? fieldsOf(header, item.basePath!, url, ["title", "id", "lotNumber"])
      : []),
  ];
  const project = makeScope(
    "project_context",
    projectTexts,
    projectFields,
    url,
    sections,
  );
  const selected = makeScope("selected_lot", lotTexts, lotFields, url, {
    identity: item,
    lot,
    header,
  });
  if (!selected.corpus.accepted) return bad("no_readable_lot_text", "lotId");
  const directory = a.directory.map((x) => ({ id: x.id, number: x.number }));
  const target = {
    projectId: a.identity.projectId,
    publicationId: a.identity.publicationId,
    lotId: item.id,
    lotNumber: item.number,
  };
  // Other-lot bodies stay in the archival snapshot, never in this comparison.
  // Membership changes invalidate every selection; an unrelated lot text edit
  // changes archiveHash but not this selected-content dependency.
  const selectionHash = hash({
    version: SOURCE_LOT_VERSION,
    binding,
    target,
    directory,
    projectHash: project.scopeHash,
    lotHash: selected.scopeHash,
  });
  return freeze({
    version: SOURCE_LOT_VERSION,
    binding,
    target,
    archiveHash: a.archiveHash,
    selectionHash,
    directory,
    project,
    lot: selected,
    counts,
    coverage: "provided_project_records_and_selected_lot_only",
    interpretation:
      "documentary_only_no_awardability_or_service_attribution_inferred",
  });
}
export function resolveLotTextReference(
  archive: LotArchive,
  lotId: string,
  ref: {
    selectionHash: string;
    scope: "project" | "lot";
    unitId: string;
    originIndex: number;
    startUtf16: number;
    endUtf16: number;
  },
) {
  const comparison = buildLotComparisonCorpus(archive, lotId);
  if (comparison.selectionHash !== ref.selectionHash)
    return bad("stale_selection", "selectionHash");
  const s = comparison[ref.scope];
  if (!s || !s.corpus.accepted) return bad("unavailable_text", ref.scope);
  const u = s.corpus.corpus.units.find((x) => x.id === ref.unitId);
  const origin = s.sourceMappings.find(
    (x) => x.unitId === ref.unitId && x.originIndex === ref.originIndex,
  );
  if (
    !u ||
    !origin ||
    ![ref.startUtf16, ref.endUtf16].every(Number.isSafeInteger) ||
    ref.startUtf16 < 0 ||
    ref.endUtf16 <= ref.startUtf16 ||
    ref.endUtf16 > u.text.length
  )
    return bad("invalid_reference", ref.scope);
  for (const n of [ref.startUtf16, ref.endUtf16])
    if (
      n > 0 &&
      n < u.text.length &&
      /[\uD800-\uDBFF]/u.test(u.text[n - 1]) &&
      /[\uDC00-\uDFFF]/u.test(u.text[n])
    )
      return bad("split_unicode_reference", ref.scope);
  return freeze({
    ...origin,
    startUtf16: ref.startUtf16,
    endUtf16: ref.endUtf16,
    quote: u.text.slice(ref.startUtf16, ref.endUtf16),
    scope: s.scope,
  });
}

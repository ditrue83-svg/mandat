import { createHash } from "node:crypto";

// Documentary-input component. No model request or semantic decision.
export const SOURCE_INPUT_VERSION = "complete-matching-source-v1";
export const MAX_SOURCE_UTF16 = 18_000;
export const MAX_SOURCE_UNITS = 128;
export const MAX_DOCUMENT_LINKS = 128;
const MAX_URL_LENGTH = 2048;
const MAX_PATH_LENGTH = 512;
const MAX_LINK_TITLE_LENGTH = 500;

export type SourceKind =
  "legacy_mixed" | "title" | "description" | "document_page";
export type SourceLanguage = "it" | "de" | "fr" | "en" | null;
export type SourceCollection =
  "originalText" | "originalTitles" | "originalDescriptions" | "documentPages";
export type SourceOrigin = {
  kind: SourceKind;
  collection: SourceCollection;
  recordPointer: string;
  sourceFieldPath: string | null;
  language: SourceLanguage;
  url: string;
  page: number | null;
  startUtf16: number;
  endUtf16: number;
};
export type SourceUnit = {
  id: string;
  text: string;
  origins: SourceOrigin[];
};
type CollectionCoverage = {
  state: "absent" | "empty" | "present";
  entryCount: number;
};
export type DocumentLink = {
  recordPointer: string;
  title: string;
  url: string;
  requiresLogin: boolean;
  availability: "text_available" | "restricted_link" | "not_verified";
  textUnits: { unitId: string; page: number }[];
};
export type SourceCorpus = {
  version: typeof SOURCE_INPUT_VERSION;
  inputHash: string;
  limits: {
    maxSourceUtf16: number;
    maxSourceUnits: number;
    maxDocumentLinks: number;
  };
  units: SourceUnit[];
  coverage: {
    // Only records stored in this input are described. No completeness claim
    // about the public notice, translations, PDF file or tender documents.
    scope: "stored_records_only";
    originalText: { state: "empty" | "present" };
    originalTitles: CollectionCoverage;
    originalDescriptions: CollectionCoverage;
    documentPages: CollectionCoverage;
    documents: CollectionCoverage;
    documentLinks: DocumentLink[];
  };
  counts: {
    inputUnits: number;
    uniqueUnits: number;
    inputUtf16: number;
    uniqueUtf16: number;
  };
};
export type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;
export type SourceRefusalCode =
  | "invalid_input"
  | "invalid_provenance"
  | "source_limit"
  | "unit_limit"
  | "document_link_limit"
  | "no_readable_text";
export type SourceInputResult =
  | { accepted: true; corpus: DeepReadonly<SourceCorpus> }
  | {
      accepted: false;
      localOnly: true;
      reason: SourceRefusalCode;
      field: string;
    };

class Refusal extends Error {
  constructor(
    public readonly code: SourceRefusalCode,
    public readonly field: string,
  ) {
    super(code);
  }
}
const refuse = (code: SourceRefusalCode, field: string): never => {
  throw new Refusal(code, field);
};
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => compare(a, b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const sha = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
function freeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
function record(
  value: unknown,
  field: string,
  allowed?: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return refuse("invalid_input", field);
  if (
    allowed &&
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !allowed.includes(key),
    )
  )
    return refuse("invalid_input", field);
  return value as Record<string, unknown>;
}
function own(
  value: object,
  key: string,
  field: string,
  optional = false,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    if (optional) return undefined;
    return refuse("invalid_input", field);
  }
  if (!("value" in descriptor) || !descriptor.enumerable)
    return refuse("invalid_input", field);
  if (descriptor.value === undefined) return refuse("invalid_input", field);
  return descriptor.value;
}
function wellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function textValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !wellFormed(value))
    return refuse("invalid_input", field);
  return value;
}
function provenanceString(
  value: unknown,
  field: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    !wellFormed(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    return refuse("invalid_provenance", field);
  return value;
}
function urlValue(value: unknown, field: string): string {
  const text = provenanceString(value, field, MAX_URL_LENGTH);
  if (text !== text.trim()) return refuse("invalid_provenance", field);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return refuse("invalid_provenance", field);
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  )
    return refuse("invalid_provenance", field);
  return text;
}
function languageValue(value: unknown, field: string): SourceLanguage {
  if (value !== null && !["it", "de", "fr", "en"].includes(value as string))
    return refuse("invalid_provenance", field);
  return value as SourceLanguage;
}
function arrayField(
  root: object,
  key: string,
  maximum: number,
  limitCode: SourceRefusalCode,
) {
  const value = own(root, key, `/${key}`, true);
  if (value === undefined)
    return {
      values: [] as unknown[],
      coverage: { state: "absent", entryCount: 0 } as CollectionCoverage,
    };
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return refuse("invalid_input", `/${key}`);
  if (value.length > maximum) return refuse(limitCode, `/${key}`);
  if (Reflect.ownKeys(value).length !== value.length + 1)
    return refuse("invalid_input", `/${key}`);
  const values = Array.from({ length: value.length }, (_, index) =>
    own(value, String(index), `/${key}/${index}`),
  );
  return {
    values,
    coverage: {
      state: values.length ? "present" : "empty",
      entryCount: values.length,
    } as CollectionCoverage,
  };
}
function hashOrigin(origin: SourceOrigin) {
  // Bind the exact stored snapshot, including indices. A cache artifact must
  // never point to a different array item after source records are reordered.
  return origin;
}
function hashLink(link: DocumentLink) {
  return link;
}

export function buildMatchingSourceCorpus(
  input: unknown,
): DeepReadonly<SourceInputResult> {
  try {
    const root = record(input, "/");
    // Deliberately project only documentary fields. Ignored fields, including
    // getters for AI summaries or profiles, are never accessed or serialized.
    const sourceUrl = urlValue(
      own(root, "sourceUrl", "/sourceUrl"),
      "/sourceUrl",
    );
    const originalText = textValue(
      own(root, "originalText", "/originalText"),
      "/originalText",
    );
    const titles = arrayField(
      root,
      "originalTitles",
      MAX_SOURCE_UNITS,
      "unit_limit",
    );
    const descriptions = arrayField(
      root,
      "originalDescriptions",
      MAX_SOURCE_UNITS,
      "unit_limit",
    );
    const pages = arrayField(
      root,
      "documentPages",
      MAX_SOURCE_UNITS,
      "unit_limit",
    );
    const links = arrayField(
      root,
      "documents",
      MAX_DOCUMENT_LINKS,
      "document_link_limit",
    );
    const inputUnits =
      1 +
      titles.values.length +
      descriptions.values.length +
      pages.values.length;
    if (inputUnits > MAX_SOURCE_UNITS) return refuse("unit_limit", "/");
    let inputUtf16 = 0;
    const unitMap = new Map<string, SourceUnit>();
    const add = (
      text: string,
      origin: Omit<SourceOrigin, "startUtf16" | "endUtf16">,
    ) => {
      inputUtf16 += text.length;
      if (inputUtf16 > MAX_SOURCE_UTF16)
        return refuse("source_limit", origin.recordPointer);
      let unit = unitMap.get(text);
      if (!unit) {
        unit = { id: `u-${sha(text)}`, text, origins: [] };
        unitMap.set(text, unit);
      }
      unit.origins.push({ ...origin, startUtf16: 0, endUtf16: text.length });
    };
    add(originalText, {
      kind: "legacy_mixed",
      collection: "originalText",
      recordPointer: "/originalText",
      sourceFieldPath: null,
      language: null,
      url: sourceUrl,
      page: null,
    });
    const translated = (
      entries: unknown[],
      collection: "originalTitles" | "originalDescriptions",
    ) =>
      entries.forEach((entry, index) => {
        const pointer = `/${collection}/${index}`;
        const fields =
          collection === "originalTitles"
            ? ["text", "language", "url", "path"]
            : ["text", "language", "url"];
        const item = record(entry, pointer, fields);
        add(
          textValue(own(item, "text", `${pointer}/text`), `${pointer}/text`),
          {
            kind: collection === "originalTitles" ? "title" : "description",
            collection,
            recordPointer: `${pointer}/text`,
            sourceFieldPath:
              collection === "originalTitles"
                ? provenanceString(
                    own(item, "path", `${pointer}/path`),
                    `${pointer}/path`,
                    MAX_PATH_LENGTH,
                  )
                : null,
            language: languageValue(
              own(item, "language", `${pointer}/language`),
              `${pointer}/language`,
            ),
            url: urlValue(own(item, "url", `${pointer}/url`), `${pointer}/url`),
            page: null,
          },
        );
      });
    translated(titles.values, "originalTitles");
    translated(descriptions.values, "originalDescriptions");
    pages.values.forEach((entry, index) => {
      const pointer = `/documentPages/${index}`;
      const item = record(entry, pointer, ["text", "url", "page"]);
      const page = own(item, "page", `${pointer}/page`);
      if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1)
        return refuse("invalid_provenance", `${pointer}/page`);
      add(textValue(own(item, "text", `${pointer}/text`), `${pointer}/text`), {
        kind: "document_page",
        collection: "documentPages",
        recordPointer: `${pointer}/text`,
        sourceFieldPath: null,
        language: null,
        url: urlValue(own(item, "url", `${pointer}/url`), `${pointer}/url`),
        page,
      });
    });
    const units = [...unitMap.values()].sort((a, b) => compare(a.id, b.id));
    if (!units.some((unit) => unit.text.trim()))
      return refuse("no_readable_text", "/");
    for (const unit of units)
      unit.origins.sort(
        (a, b) =>
          compare(stable(hashOrigin(a)), stable(hashOrigin(b))) ||
          compare(a.recordPointer, b.recordPointer),
      );
    const documentLinks: DocumentLink[] = links.values.map((entry, index) => {
      const pointer = `/documents/${index}`;
      const item = record(entry, pointer, ["title", "url", "requiresLogin"]);
      const title = provenanceString(
        own(item, "title", `${pointer}/title`),
        `${pointer}/title`,
        MAX_LINK_TITLE_LENGTH,
      );
      const url = urlValue(
        own(item, "url", `${pointer}/url`),
        `${pointer}/url`,
      );
      const requiresLogin = own(
        item,
        "requiresLogin",
        `${pointer}/requiresLogin`,
      );
      if (typeof requiresLogin !== "boolean")
        return refuse("invalid_provenance", `${pointer}/requiresLogin`);
      const available = units.flatMap((unit) =>
        unit.origins
          .filter(
            (origin) =>
              origin.kind === "document_page" &&
              origin.url === url &&
              unit.text.trim(),
          )
          .map((origin) => ({ unitId: unit.id, page: origin.page! })),
      );
      const textUnits = [
        ...new Map(available.map((ref) => [stable(ref), ref])).values(),
      ].sort((a, b) => a.page - b.page || compare(a.unitId, b.unitId));
      return {
        recordPointer: pointer,
        title,
        url,
        requiresLogin,
        availability: textUnits.length
          ? "text_available"
          : requiresLogin
            ? "restricted_link"
            : "not_verified",
        textUnits,
      };
    });
    documentLinks.sort(
      (a, b) =>
        compare(stable(hashLink(a)), stable(hashLink(b))) ||
        compare(a.recordPointer, b.recordPointer),
    );
    const withoutHash: Omit<SourceCorpus, "inputHash"> = {
      version: SOURCE_INPUT_VERSION,
      limits: {
        maxSourceUtf16: MAX_SOURCE_UTF16,
        maxSourceUnits: MAX_SOURCE_UNITS,
        maxDocumentLinks: MAX_DOCUMENT_LINKS,
      },
      units,
      coverage: {
        scope: "stored_records_only",
        originalText: { state: originalText.length ? "present" : "empty" },
        originalTitles: titles.coverage,
        originalDescriptions: descriptions.coverage,
        documentPages: pages.coverage,
        documents: links.coverage,
        documentLinks,
      },
      counts: {
        inputUnits,
        uniqueUnits: units.length,
        inputUtf16,
        uniqueUtf16: units.reduce((sum, unit) => sum + unit.text.length, 0),
      },
    };
    const hashMaterial = {
      ...withoutHash,
      units: units.map((unit) => ({
        ...unit,
        origins: unit.origins.map(hashOrigin),
      })),
      coverage: {
        ...withoutHash.coverage,
        documentLinks: documentLinks.map(hashLink),
      },
    };
    return freeze({
      accepted: true,
      corpus: { ...withoutHash, inputHash: sha(stable(hashMaterial)) },
    });
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return freeze({
      accepted: false,
      localOnly: true,
      reason: error.code,
      field: error.field,
    });
  }
}

import { z } from "zod";
import { SECTORS, type Publication } from "./domain";
import type { Identity } from "./source-lots";

// The adapter result is an internal, server-produced value, not an HTTP body
// accepted from an administrator. Validate its normalized shape and detach all
// descendants before awaiting locks. This does not authenticate the HTTP header
// or reconstruct wire bytes from the canonical archive.
function copySafeJson(input: unknown): unknown {
  const parents = new Set<object>();
  let nodes = 0;
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > 200_000 || depth > 64)
      throw new Error("Pubblicazione normalizzata oltre i limiti JSON.");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      if (!value.isWellFormed() || value.includes("\u0000"))
        throw new Error("Testo normalizzato non compatibile con JSONB.");
      return value;
    }
    if (!value || typeof value !== "object" || parents.has(value))
      throw new Error("Pubblicazione normalizzata non JSON.");
    const array = Array.isArray(value);
    if (
      !(array ? [Array.prototype, null] : [Object.prototype, null]).includes(
        Object.getPrototypeOf(value),
      )
    )
      throw new Error("Prototipo normalizzato non JSON.");
    parents.add(value);
    const entries: [string, unknown][] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === "length") continue;
      if (
        typeof key !== "string" ||
        !key.isWellFormed() ||
        key.includes("\u0000") ||
        (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))
      )
        throw new Error("Chiave normalizzata non JSONB.");
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable)
        throw new Error("Proprietà normalizzata non JSON.");
      entries.push([key, visit(descriptor.value, depth + 1)]);
    }
    parents.delete(value);
    if (array) {
      if (entries.length !== value.length)
        throw new Error("Array normalizzato incompleto.");
      return entries.map(([, child]) => child);
    }
    return Object.fromEntries(entries);
  }
  const result = visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 12_000_000)
    throw new Error("Pubblicazione normalizzata oltre i limiti JSON.");
  return result;
}
const text = z.string();
const date = z.iso.datetime({ offset: true });
const language = z.enum(["it", "de", "fr", "en"]);
const original = z
  .object({ language: language.nullable(), text, url: z.url() })
  .strict();
const normalizedSchema = z
  .object({
    id: text.min(1),
    source: z.literal("simap"),
    externalId: z.uuid(),
    projectId: z.uuid(),
    title: text.min(1),
    buyer: text.min(1),
    location: text.min(1),
    canton: text,
    zone: text.nullable(),
    publishedAt: date,
    updatedAt: date,
    visibleAt: date,
    deadline: date.nullable(),
    valueChf: z.number().finite().nullable(),
    procedure: text.nullable(),
    status: z.enum(["open", "cancelled", "awarded", "closed"]),
    sectors: z.array(z.enum(SECTORS.map((sector) => sector.id))),
    cpv: z.array(text),
    sourceUrl: z.url(),
    sourceUrls: z.array(z.url()).length(1),
    originalText: text,
    originalDescriptions: z.array(original).optional(),
    originalTitles: z.array(original.extend({ path: text.min(1) })).optional(),
    sourceConditions: z
      .array(
        z
          .object({
            path: text.min(1),
            value: z.unknown(),
            language: language.optional(),
            url: z.url(),
          })
          .strict(),
      )
      .optional(),
    // Source collection cannot supply a human scope decision or AI enrichment.
    sourceScopeReview: z.never().optional(),
    documentPages: z.never().optional(),
    summary: z.null(),
    requirements: z.array(text).length(0),
    evidence: z.array(
      z
        .object({
          url: z.url(),
          field: text,
          quote: text,
          page: z.number().int().positive().optional(),
        })
        .strict(),
    ),
    documents: z.array(
      z
        .object({ title: text, url: z.url(), requiresLogin: z.boolean() })
        .strict(),
    ),
    reviewRequired: z.boolean(),
    reviewReasons: z.array(text),
    revision: text.regex(/^simap-v2:[a-f0-9]{64}$/),
    canonicalKey: text.min(1),
  })
  .strict();

export function copyNormalizedDocumentaryPublication(
  value: unknown,
  identity: Identity,
  sourceRevision: string,
): Publication {
  const p = normalizedSchema.parse(copySafeJson(value));
  const sourceUrl = `https://www.simap.ch/it/project-detail/${identity.projectId}`;
  const urls = [
    ...(p.originalDescriptions ?? []),
    ...(p.originalTitles ?? []),
    ...(p.sourceConditions ?? []),
    ...p.evidence,
    ...p.documents,
  ];
  if (
    p.id !== `simap-${identity.projectId}` ||
    p.externalId !== identity.projectId ||
    p.projectId !== identity.projectId ||
    p.revision !== sourceRevision ||
    p.sourceUrl !== sourceUrl ||
    p.sourceUrls[0] !== sourceUrl ||
    urls.some(({ url }) => url !== sourceUrl && url !== identity.detailUrl) ||
    (!p.reviewRequired && p.reviewReasons.length > 0)
  )
    throw new Error("Risultato normalizzato e acquisizione discordanti.");
  return p;
}

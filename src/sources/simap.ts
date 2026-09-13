import { z } from "zod";
import type {
  OriginalDescription,
  OriginalTitle,
  Publication,
  SourceCondition,
} from "@/lib/domain";
import {
  classifySectors,
  fetchOfficial,
  fingerprint,
  parseDeadline,
  plainText,
  publicationDate,
  translation,
  zoneFromCity,
  type SourceAdapter,
  type SourceEntry,
} from "./common";
const projectSchema = z
  .object({
    id: z.uuid(),
    publicationId: z.uuid(),
    publicationDate: z.string(),
    projectNumber: z.string(),
    pubType: z.string(),
    processType: z.string(),
    title: z.unknown(),
    procOfficeName: z.unknown(),
    orderAddress: z.record(z.string(), z.unknown()).nullish(),
    lots: z.array(z.unknown()).optional(),
  })
  .passthrough();
const searchSchema = z.object({
  projects: z.array(projectSchema),
  pagination: z.object({ lastItem: z.string().nullish() }).passthrough(),
});
const publicationHeaderSchema = z.object({
  id: z.uuid(),
  dates: z.object({ publicationDate: z.string().min(1) }),
  pubType: z.string().min(1),
  title: z.unknown(),
});
const projectHeaderSchema = z.object({
  id: z.uuid(),
  projectNumber: z.string().min(1),
  processType: z.string().min(1),
  lotsType: z.string().nullish(),
  latestPublication: publicationHeaderSchema.nullish(),
  lots: z
    .array(z.object({ latestPublication: publicationHeaderSchema.nullish() }))
    .nullish(),
});
const record = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
function originalDescriptions(
  value: unknown,
  url: string,
): OriginalDescription[] {
  if (typeof value === "string") {
    const text = plainText(value);
    return text ? [{ language: null, text, url }] : [];
  }
  const descriptions = record(value);
  return (["it", "de", "fr", "en"] as const).flatMap((language) => {
    const raw = descriptions[language];
    const text = typeof raw === "string" ? plainText(raw) : "";
    return text ? [{ language, text, url }] : [];
  });
}
function originalTitles(
  value: unknown,
  url: string,
  path: "project-info.title" | "entry.title",
): OriginalTitle[] {
  return originalDescriptions(value, url).map((title) => ({
    ...title,
    path: title.language ? `${path}.${title.language}` : path,
  }));
}
function sourceConditions(
  terms: Record<string, unknown>,
  procurement: Record<string, unknown>,
  url: string,
): SourceCondition[] {
  const fields = [
    ["terms", terms, "subContractorAllowed", false],
    ["terms", terms, "subContractorNote", true],
    ["procurement", procurement, "partialOffers", false],
    ["procurement", procurement, "partialOffersNote", true],
  ] as const;
  return fields.flatMap(([section, values, field, translated]) => {
    if (!Object.hasOwn(values, field)) return [];
    const path = `${section}.${field}`;
    const value = values[field];
    const translations = record(value);
    const keys = Object.keys(translations).sort();
    if (translated && keys.length)
      return keys.map((key): SourceCondition => ({
        path: `${path}.${key}`,
        value: translations[key],
        ...(["it", "de", "fr", "en"].includes(key)
          ? { language: key as SourceCondition["language"] }
          : {}),
        url,
      }));
    // Keep nulls, unlabelled notes and unexpected values for source review.
    // Never flatten subcontracting conditions into selectable service passages.
    return [{ path, value, url }];
  });
}
const legacyRevisions = new WeakMap<Publication, string>();
// Only a freshly parsed response can prove equality with an old { p, d } hash.
// Keep that proof out of serialized publications and customer-facing data.
export function legacySimapRevision(publication: Publication) {
  return legacyRevisions.get(publication);
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, ordered(child)]),
    );
  return value;
}
export function normalizeSimap(
  entry: SourceEntry,
  input: unknown,
): Publication {
  const p = projectSchema.parse(entry.raw);
  const d = z
    .object({
      id: z.uuid(),
      type: z.string(),
      base: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough()
    .parse(input);
  if (d.id !== p.publicationId)
    throw new Error("Dettaglio simap riferito a una pubblicazione diversa");
  const info = record(d["project-info"]),
    proc = record(d.procurement),
    dates = record(d.dates),
    terms = record(d.terms);
  const address = record(proc.orderAddress ?? p.orderAddress);
  const title = translation(info.title) || translation(p.title);
  if (!title) throw new Error("Bando simap privo di titolo");
  const sourceUrl = `https://www.simap.ch/it/project-detail/${p.id}`;
  const detailUrl = `https://www.simap.ch/api/publications/v1/project/${p.id}/publication-details/${p.publicationId}`;
  const detailTitles = originalTitles(
    info.title,
    detailUrl,
    "project-info.title",
  );
  const description = plainText(translation(proc.orderDescription));
  const requirements = [
    translation(terms.termsNote),
    translation(terms.otherRequirements),
    translation(dates.specificDeadlinesAndFormalRequirements),
  ]
    .map(plainText)
    .filter(Boolean);
  const cpv = [
    String(record(proc.cpvCode).code ?? record(d.base?.cpvCode).code ?? ""),
    ...(Array.isArray(proc.additionalCpvCodes)
      ? proc.additionalCpvCodes.map((c) => String(record(c).code ?? ""))
      : []),
  ].filter(Boolean);
  const deadline = parseDeadline(
    p.processType === "selective"
      ? dates.participationRequestDeadline
      : dates.offerDeadline,
  );
  const location =
    translation(address.city) ||
    plainText(translation(proc.orderAddressDescription));
  const status: Publication["status"] = ["award", "direct_award"].includes(
    d.type,
  )
    ? "awarded"
    : ["abandonment", "revocation"].includes(d.type)
      ? "cancelled"
      : d.type === "tender" && p.processType !== "invitation"
        ? "open"
        : "closed";
  const reviewReasons = [
    ...(!deadline && status === "open"
      ? ["Scadenza non disponibile o priva di orario"]
      : []),
    ...(Array.isArray(d.lots) && d.lots.length > 0
      ? ["Gara con lotti: verificare i requisiti e le scadenze del lotto"]
      : []),
    ...(!location ? ["Luogo di esecuzione da verificare"] : []),
  ];
  const publication: Publication = {
    id: `simap-${p.id}`,
    externalId: p.id,
    projectId: p.id,
    canonicalKey: `simap:${p.projectNumber}`,
    source: "simap",
    title,
    buyer: translation(p.procOfficeName) || "Ente non indicato",
    location: location || "Non indicato",
    canton: String(address.cantonId ?? ""),
    zone: zoneFromCity(location),
    publishedAt: publicationDate(p.publicationDate),
    updatedAt: publicationDate(p.publicationDate),
    visibleAt: publicationDate(p.publicationDate, 8),
    deadline,
    valueChf: null,
    procedure:
      (
        {
          open: "Concorso pubblico",
          selective: "Procedura selettiva",
          invitation: "Su invito",
        } as Record<string, string>
      )[p.processType] ?? p.processType,
    status,
    sectors: classifySectors(title + " " + description, cpv),
    cpv,
    sourceUrl,
    sourceUrls: [sourceUrl],
    originalText: [title, description, ...requirements].join("\n\n"),
    originalDescriptions: originalDescriptions(
      proc.orderDescription,
      detailUrl,
    ),
    originalTitles: detailTitles.length
      ? detailTitles
      : // The entry comes from search, or from the header during refresh.
        // Its request URL is unavailable; link to the public project page.
        originalTitles(p.title, sourceUrl, "entry.title"),
    sourceConditions: sourceConditions(terms, proc, detailUrl),
    summary: null,
    requirements: [],
    evidence: [
      { url: sourceUrl, field: "Oggetto", quote: description || title },
      ...(deadline
        ? [
            {
              url: sourceUrl,
              field: "Scadenza",
              quote: String(
                p.processType === "selective"
                  ? dates.participationRequestDeadline
                  : dates.offerDeadline,
              ),
            },
          ]
        : []),
    ],
    documents: d.hasProjectDocuments
      ? [
          {
            title: "Documenti di gara su simap",
            url: sourceUrl,
            requiresLogin: true,
          },
        ]
      : [],
    reviewRequired: reviewReasons.length > 0,
    reviewReasons,
    revision: `simap-v2:${fingerprint(
      ordered({
        project: {
          id: p.id,
          publicationId: p.publicationId,
          publicationDate: publicationDate(p.publicationDate),
          projectNumber: p.projectNumber,
          pubType: p.pubType,
          processType: p.processType,
          title,
          buyer: translation(p.procOfficeName) || "Ente non indicato",
          location: location || "Non indicato",
          canton: String(address.cantonId ?? ""),
        },
        // Retain every detail field, including publication identity, terms and
        // document metadata that may not yet have a dedicated display field.
        detail: d,
      }),
    )}`,
  };
  legacyRevisions.set(publication, fingerprint({ p, d }));
  return publication;
}
export const simap: SourceAdapter = {
  id: "simap",
  async list(since) {
    const all = new Map<string, SourceEntry>();
    for (const mode of ["canton", "unstructured"]) {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (let page = 0; page < 100; page++) {
        const url = new URL(
          "https://www.simap.ch/api/publications/v2/project/project-search",
        );
        for (const kind of ["construction", "service", "supply"])
          url.searchParams.append("projectSubTypes", kind);
        url.searchParams.set(
          "newestPublicationFrom",
          since.toISOString().slice(0, 10),
        );
        if (mode === "canton")
          url.searchParams.set("orderAddressCantons", "TI");
        else url.searchParams.set("search", "Ticino");
        if (cursor) url.searchParams.set("lastItem", cursor);
        const data = searchSchema.parse(
          JSON.parse(await fetchOfficial(url.toString(), ["www.simap.ch"])),
        );
        for (const p of data.projects) all.set(p.id, { id: p.id, raw: p });
        const next = data.pagination.lastItem;
        if (!next || data.projects.length === 0) break;
        if (cursors.has(next)) throw new Error("Paginazione simap ripetuta");
        cursors.add(next);
        cursor = next;
        if (page === 99)
          throw new Error("Paginazione simap incompleta: limite raggiunto");
      }
    }
    return [...all.values()];
  },
  async detail(entry) {
    const p = projectSchema.parse(entry.raw);
    const url = `https://www.simap.ch/api/publications/v1/project/${p.id}/publication-details/${p.publicationId}`;
    return normalizeSimap(
      entry,
      JSON.parse(await fetchOfficial(url, ["www.simap.ch"])),
    );
  },
};

// Recheck tracked open projects even when their publication is outside the search window.
export async function readSimapRefreshEntry(
  previous: Publication,
): Promise<SourceEntry> {
  const parsed = projectHeaderSchema.safeParse(
    JSON.parse(
      await fetchOfficial(
        `https://www.simap.ch/api/publications/v2/project/${previous.externalId}/project-header`,
        ["www.simap.ch"],
      ),
    ),
  );
  if (!parsed.success || parsed.data.id !== previous.externalId)
    throw new Error("Header simap non riconosciuto");
  const header = parsed.data;
  let latest = header.latestPublication;
  if (!latest) {
    // For projects with lots, simap puts the latest publication on each lot.
    // A single project record is safe only when every lot points to the same
    // publication. Divergent or incomplete lots need review, not a guessed state.
    const first = header.lots?.[0]?.latestPublication;
    if (
      header.lotsType !== "with" ||
      !first ||
      header.lots!.some(
        ({ latestPublication: candidate }) =>
          !candidate ||
          candidate.id !== first.id ||
          candidate.pubType !== first.pubType ||
          candidate.dates.publicationDate !== first.dates.publicationDate,
      )
    )
      throw new Error(
        "Pubblicazioni dei lotti simap incomplete o discordanti: richiesta revisione",
      );
    latest = first;
  }
  return {
    id: previous.externalId,
    raw: {
      id: previous.externalId,
      publicationId: latest.id,
      publicationDate: latest.dates.publicationDate,
      projectNumber: header.projectNumber,
      pubType: latest.pubType,
      processType: header.processType,
      title: latest.title,
      procOfficeName: previous.buyer,
    },
  };
}
simap.refresh = async (previous) =>
  simap.detail(await readSimapRefreshEntry(previous));

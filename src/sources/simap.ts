import { z } from "zod";
import type { Publication } from "@/lib/domain";
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
const record = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
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
  const info = record(d["project-info"]),
    proc = record(d.procurement),
    dates = record(d.dates),
    terms = record(d.terms);
  const address = record(proc.orderAddress ?? p.orderAddress);
  const title = translation(info.title) || translation(p.title);
  if (!title) throw new Error("Bando simap privo di titolo");
  const sourceUrl = `https://www.simap.ch/it/project-detail/${p.id}`;
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
  return {
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
    revision: fingerprint({ p, d }),
  };
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
simap.refresh = async (previous) => {
  const header = JSON.parse(
    await fetchOfficial(
      `https://www.simap.ch/api/publications/v2/project/${previous.externalId}/project-header`,
      ["www.simap.ch"],
    ),
  );
  const latest = header.latestPublication;
  if (!latest?.id) throw new Error("Header simap non riconosciuto");
  return simap.detail({
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
  });
};

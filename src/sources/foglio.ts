import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { Publication } from "@/lib/domain";
import { foglioStatus } from "./foglio-lifecycle";
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
const xml = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  processEntities: true,
});
const metaSchema = z
  .object({
    id: z.uuid(),
    publicationNumber: z.string(),
    publicationDate: z.string(),
    publicationState: z.enum(["PUBLISHED", "CANCELLED"]),
    subRubric: z.string(),
    title: z.unknown(),
    registrationOffice: z.record(z.string(), z.unknown()).optional(),
    onBehalfOf: z.string().optional(),
  })
  .passthrough();
export function parseFoglioList(text: string) {
  const root = xml.parse(text)["bulk-export"];
  if (!root || !/^\d+$/.test(String(root.total)))
    throw new Error("Formato elenco Foglio Ufficiale non riconosciuto");
  const entries = root.publication
    ? Array.isArray(root.publication)
      ? root.publication
      : [root.publication]
    : [];
  return {
    total: Number(root.total),
    entries: entries.map((p: Record<string, unknown>) => {
      const meta = metaSchema.parse(p.meta);
      return { id: meta.id, raw: { ...p, meta } };
    }) as SourceEntry[],
  };
}
export function normalizeFoglio(text: string): Publication {
  const root = xml.parse(text).publication;
  if (!root?.content)
    throw new Error("Formato dettaglio Foglio Ufficiale non riconosciuto");
  const m = metaSchema.parse(root.meta);
  const c = root.content as Record<string, unknown>;
  const title = translation(c.title) || translation(m.title);
  const body = plainText(String(c.publication ?? ""));
  if (!title || !body) throw new Error("Contenuto del bando mancante");
  const sourceUrl = `https://amtsblattportal.ch/api/v1/publications/${m.id}/pdf`;
  const deadlineMatch = body.match(
    /(?:Presentazione\s+dell['’]offerta|Termine\s+(?:per\s+)?(?:l['’])?inoltro\s+(?:delle\s+)?offerte)\s*:?\s*(\d{2}\.\d{2}\.\d{4}),?\s+(\d{2}:\d{2})/i,
  );
  const deadline = deadlineMatch
    ? parseDeadline(
        `${deadlineMatch[1].split(".").reverse().join("-")}T${deadlineMatch[2]}`,
      )
    : null;
  const legacyStatus: Publication["status"] =
    m.publicationState === "CANCELLED" ||
    /^(?:annullamento|revoca|interruzione)/i.test(title)
      ? "cancelled"
      : /^(?:aggiudicazione|delibera|incarico diretto)/i.test(title)
        ? "awarded"
        : /^Bando(?:\s*[-–:]|\s+di\s+concorso)/i.test(title)
          ? "open"
          : "closed";
  const status = foglioStatus(m.publicationState, title, c.contractNotice);
  const location =
    body
      .match(
        /Luogo (?:di adempimento del mandato|di esecuzione)\s*:\s*([^\n]+)/i,
      )?.[1]
      ?.trim() || "Non indicato";
  const simapNumber = String(c.simapPublicationNumber ?? "").replace(/^#/, "");
  const cpv = [...body.matchAll(/\b(\d{8})\s*[-–]/g)].map((x) => x[1]);
  const reviewReasons = [
    ...(!deadline && status === "open"
      ? ["Termine di presentazione da verificare sul PDF ufficiale"]
      : []),
    ...(location === "Non indicato"
      ? ["Luogo di esecuzione da verificare"]
      : []),
  ];
  return {
    id: `foglio-ti-${m.id}`,
    externalId: m.id,
    projectId: simapNumber || undefined,
    canonicalKey: simapNumber
      ? `simap:${simapNumber.split("-")[0]}`
      : undefined,
    source: "foglio-ti",
    title,
    buyer:
      m.onBehalfOf ||
      String(m.registrationOffice?.displayName ?? "Ente non indicato"),
    location,
    canton: "TI",
    zone: zoneFromCity(location),
    publishedAt: publicationDate(m.publicationDate),
    updatedAt: publicationDate(m.publicationDate),
    visibleAt: publicationDate(m.publicationDate, simapNumber ? 8 : 0),
    deadline,
    valueChf: null,
    procedure: typeof c.typeOfProcedure === "string" ? c.typeOfProcedure : null,
    status,
    sectors: classifySectors(title + " " + body, cpv),
    cpv,
    sourceUrl,
    sourceUrls: [sourceUrl],
    originalText: body,
    summary: null,
    requirements: [],
    evidence:
      deadline && deadlineMatch
        ? [{ url: sourceUrl, field: "Scadenza", quote: deadlineMatch[0] }]
        : [],
    documents: [
      {
        title: "Pubblicazione ufficiale firmata (PDF)",
        url: sourceUrl,
        requiresLogin: false,
      },
    ],
    reviewRequired: reviewReasons.length > 0,
    reviewReasons,
    revision: `${status === legacyStatus ? "" : "foglio-lifecycle-v2:"}${fingerprint(root)}`,
  };
}
export async function listFoglioPublications(
  filters: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<SourceEntry[]> {
  const result = new Map<string, SourceEntry>();
  for (const state of ["PUBLISHED", "CANCELLED"]) {
    const ids = new Set<string>();
    for (let page = 0; page < 500; page++) {
      signal?.throwIfAborted();
      const url = new URL("https://amtsblattportal.ch/api/v1/publications/xml");
      Object.entries({
        ...filters,
        tenant: "kabti",
        publicationStates: state,
        rubrics: "OB-TI",
        "pageRequest.size": "100",
        "pageRequest.page": String(page),
        // Old notices can be corrected or cancelled today. Publication date
        // alone is not an update cursor. Scan metadata for the whole history.
        "pageRequest.sortOrders": "column:UPDATE_DATE|direction:DESC",
      }).forEach(([k, v]) => url.searchParams.set(k, v));
      const data = parseFoglioList(
        await fetchOfficial(
          url.toString(),
          ["amtsblattportal.ch"],
          12_000_000,
          signal,
        ),
      );
      for (const entry of data.entries) {
        if (ids.has(entry.id))
          throw new Error(
            "Elenco Foglio Ufficiale incompleto: pagina ripetuta",
          );
        ids.add(entry.id);
        result.set(entry.id, entry);
      }
      if ((page + 1) * 100 >= data.total) {
        if (ids.size !== data.total)
          throw new Error("Conteggio Foglio Ufficiale non riconciliato");
        break;
      }
      if (data.entries.length === 0 || page === 499)
        throw new Error("Elenco Foglio Ufficiale incompleto");
    }
  }
  return [...result.values()];
}
export const foglio: SourceAdapter = {
  id: "foglio-ti",
  async list(_since) {
    return listFoglioPublications();
  },
  async detail(entry) {
    const id = z.uuid().parse(entry.id);
    return normalizeFoglio(
      await fetchOfficial(
        `https://amtsblattportal.ch/api/v1/publications/${id}/xml`,
        ["amtsblattportal.ch"],
      ),
    );
  },
};

foglio.refresh = async (previous) =>
  foglio.detail({ id: previous.externalId, raw: {} });

export async function attachFoglioPdf(p: Publication): Promise<Publication> {
  if (p.status !== "open") return p;
  let pdf: typeof import("./pdf") | undefined;
  try {
    pdf = await import("./pdf");
    const pages = await pdf.extractPublicPdf(p.sourceUrl);
    return {
      ...p,
      documentPages: pages.map((page) => ({ ...page, url: p.sourceUrl })),
    };
  } catch (error) {
    if (pdf && error instanceof pdf.TemporaryPdfError) throw error;
    return {
      ...p,
      reviewRequired: true,
      reviewReasons: [
        ...p.reviewReasons,
        pdf && error instanceof pdf.PdfReviewRequiredError
          ? error.message
          : "PDF non elaborabile: verificare il documento ufficiale",
      ],
    };
  }
}

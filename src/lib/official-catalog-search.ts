import { listSimapProjects, SIMAP_TICINO_ISSUER } from "@/sources/simap";
import { listFoglioPublications } from "@/sources/foglio";
import {
  plainText,
  publicationDate,
  translation,
  zoneFromCity,
  type SourceEntry,
} from "@/sources/common";
import type { SourceId } from "./domain";

export type OfficialSearchHit = {
  id: string;
  source: SourceId;
  externalId: string;
  title: string;
  buyer: string;
  location: string;
  publishedAt: string;
  sourceUrl: string;
  status: "unverified" | "cancelled" | "awarded" | "closed";
};
export type OfficialSearchReceipt = {
  source: SourceId;
  state: "complete" | "partial" | "unavailable" | "query-too-short";
  checkedAt: string;
  hits: OfficialSearchHit[];
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
function simapHit(entry: SourceEntry): OfficialSearchHit {
  const p = entry.raw;
  const address = object(p.orderAddress);
  const type = String(p.pubType);
  return {
    id: `simap-${entry.id}`,
    source: "simap",
    externalId: entry.id,
    title: plainText(translation(p.title)),
    buyer: plainText(translation(p.procOfficeName)) || "Ente non indicato",
    location: plainText(translation(address.city)) || "Consulta SIMAP",
    publishedAt: publicationDate(String(p.publicationDate)),
    sourceUrl: `https://www.simap.ch/it/project-detail/${entry.id}`,
    status: ["abandonment", "revocation"].includes(type)
      ? "cancelled"
      : ["award", "direct_award"].includes(type)
        ? "awarded"
        : ["tender", "competition", "study_contract"].includes(type)
          ? "unverified"
          : "closed",
  };
}
function ticinoEntry(entry: SourceEntry, known: ReadonlySet<string>) {
  if (known.has(entry.id)) return true;
  const p = entry.raw;
  const addresses = [
    p.orderAddress,
    ...(Array.isArray(p.lots) ? p.lots.map((l) => object(l).orderAddress) : []),
  ].map(object);
  return (
    addresses.some(
      (a) => a.cantonId === "TI" || !!zoneFromCity(translation(a.city)),
    ) || /\b(?:Ticino|Tessin)\b/iu.test(JSON.stringify([p.title, ...addresses]))
  );
}
export function foglioSearchHit(entry: SourceEntry): OfficialSearchHit {
  const m = object(entry.raw.meta),
    title = plainText(translation(m.title));
  return {
    id: `foglio-ti-${entry.id}`,
    source: "foglio-ti",
    externalId: entry.id,
    title,
    buyer: plainText(
      String(
        m.onBehalfOf ||
          object(m.registrationOffice).displayName ||
          "Ente non indicato",
      ),
    ),
    location: "Ticino · consulta il Foglio Ufficiale",
    publishedAt: publicationDate(String(m.publicationDate)),
    sourceUrl: `https://amtsblattportal.ch/api/v1/publications/${entry.id}/pdf`,
    status:
      m.publicationState === "CANCELLED" ||
      /^(?:annullamento|revoca|interruzione)/i.test(title)
        ? "cancelled"
        : /^(?:aggiudicazione|delibera|incarico diretto)/i.test(title)
          ? "awarded"
          : "unverified",
  };
}
// Public metadata only. These receipts never become source snapshots, company
// matches, AI inputs, approvals or notification eligibility.
export async function searchOfficialCatalog(
  query: string,
  foglioEnabled: boolean,
  knownSimapIds: ReadonlySet<string>,
): Promise<OfficialSearchReceipt[]> {
  const checkedAt = new Date().toISOString();
  const signal = AbortSignal.timeout(12_000);
  const simap = async (): Promise<OfficialSearchReceipt> => {
    if (query.trim().length < 3)
      return { source: "simap", state: "query-too-short", checkedAt, hits: [] };
    const results = await Promise.allSettled([
      listSimapProjects({ search: query, orderAddressCantons: "TI" }, signal),
      listSimapProjects(
        { search: query, issuedByOrganizations: SIMAP_TICINO_ISSUER },
        signal,
      ),
      // Includes unstructured performance addresses and previously discovered
      // TI projects. A foreign project is not admitted by keyword alone.
      listSimapProjects({ search: query }, signal).then((rows) =>
        rows.filter((e) => ticinoEntry(e, knownSimapIds)),
      ),
    ]);
    const hits = new Map<string, OfficialSearchHit>();
    for (const r of results)
      if (r.status === "fulfilled")
        for (const e of r.value) hits.set(e.id, simapHit(e));
    const failures = results.filter((r) => r.status === "rejected").length;
    return {
      source: "simap",
      state:
        failures === results.length
          ? "unavailable"
          : failures
            ? "partial"
            : "complete",
      checkedAt,
      hits: [...hits.values()],
    };
  };
  const foglio = async (): Promise<OfficialSearchReceipt> => {
    try {
      const rows = await listFoglioPublications({ keyword: query }, signal);
      return {
        source: "foglio-ti",
        state: "complete",
        checkedAt,
        hits: rows.map(foglioSearchHit),
      };
    } catch {
      return { source: "foglio-ti", state: "unavailable", checkedAt, hits: [] };
    }
  };
  return Promise.all([
    simap().catch((): OfficialSearchReceipt => ({
      source: "simap",
      state: "unavailable",
      checkedAt,
      hits: [],
    })),
    ...(foglioEnabled ? [foglio()] : []),
  ]);
}

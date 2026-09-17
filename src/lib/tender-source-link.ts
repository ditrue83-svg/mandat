import type { Publication } from "./domain";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function publicLink(value: unknown) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}
export function tenderSourceLink(
  p: Pick<Publication, "source" | "sourceUrl"> & { externalId?: string },
) {
  if (p.source === "simap") {
    if (p.externalId && uuid.test(p.externalId))
      return `https://www.simap.ch/it/project-detail/${p.externalId}`;
    const url = publicLink(p.sourceUrl);
    return /^https:\/\/www\.simap\.ch\/(?:it|de|fr|en)\/project-detail\/[^/?#]+\/?$/.test(
      url,
    )
      ? url
      : "";
  }
  return publicLink(p.sourceUrl);
}

// Keep exact acquisition URLs in provenance, while sending people to the
// readable official publication. PDF and other document references stay exact.
export function tenderReferenceLink(value: string) {
  const url = publicLink(value);
  const match =
    /^https:\/\/www\.simap\.ch\/api\/publications\/v1\/project\/([^/]+)\/publication-details\/([^/?#]+)$/.exec(
      url,
    );
  return match && uuid.test(match[1]) && uuid.test(match[2])
    ? `https://www.simap.ch/it/project-detail/${match[1]}`
    : url;
}
export const tenderSourceLabel = (source: Publication["source"]) =>
  source === "simap"
    ? "Apri il bando su simap ↗"
    : "Apri il bando sul Foglio TI ↗";

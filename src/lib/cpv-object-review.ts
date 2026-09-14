import type { CompanyProfile, Publication } from "./domain";
import vocabulary from "./cpv-building-objects.json";

// An object in a classification is a reason
// to inspect a role mismatch, never a commissioned service or a match score.
export const OBJECT_REVIEW_VERSION = "published-building-object-review-v2";
const objects = [
  { id: "doors", words: ["porta", "porte", "portone", "portoni"] },
  { id: "gates", words: ["cancello", "cancelli"] },
  { id: "locks", words: ["serratura", "serrature"] },
] as const;
const tokens = (text: string) =>
  [...text.matchAll(/[\p{L}\p{M}\p{N}\p{Pc}]+/gu)].map((m) => ({
    normalized: m[0].normalize("NFC").toLowerCase(),
    quote: m[0],
    start: m.index!,
    end: m.index! + m[0].length,
  }));
// Exact positive object classes from the official vocabulary. Sibling classes
// (for example furniture locks or windows excluding doors) are not inferred.
const catalogue = new Map<
  string,
  { code: string; label: string; object: string }
>();
for (const entry of vocabulary.entries) {
  catalogue.set(entry.code, entry);
  catalogue.set(entry.code.slice(0, 8), entry);
}

export function findPublishedObjectReview(
  publication: Pick<Publication, "cpv" | "sourceUrl">,
  profile: Pick<CompanyProfile, "activities" | "sectors">,
) {
  if (!profile.sectors.includes("manutenzioni")) return undefined;
  const words = tokens(profile.activities);
  const signals = [];
  for (const object of objects) {
    const declared = words.find((t) =>
      (object.words as readonly string[]).includes(t.normalized),
    );
    if (!declared) continue;
    for (let i = 0; i < publication.cpv.length; i++) {
      const code = publication.cpv[i],
        entry = catalogue.get(code);
      if (!entry || entry.object !== object.id) continue;
      signals.push({
        object: object.id,
        source: {
          field: `cpv[${i}]`,
          value: code,
          url: publication.sourceUrl,
          basis: "published_classification_only" as const,
        },
        vocabulary: {
          code: entry.code,
          label: entry.label,
          language: "it" as const,
        },
        profile: { field: "activities", ...declared },
      });
      break;
    }
  }
  if (!signals.length) return undefined;
  return {
    version: OBJECT_REVIEW_VERSION,
    disposition: "manual_review_only" as const,
    score: 0 as const,
    professionalRelationEstablished: false as const,
    signals,
    reason:
      "La classificazione pubblicata riguarda componenti presenti nel profilo. Occorre verificare il lavoro richiesto: fornitura, installazione e manutenzione possono essere incarichi diversi.",
  };
}

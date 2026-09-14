import type { CompanyProfile, Publication } from "./domain";
import vocabulary from "./cpv-service-labels.json";

// An object in a classification is a reason
// to inspect a role mismatch, never a commissioned service or a match score.
export const OBJECT_REVIEW_VERSION = "published-building-object-review-v1";
const objects = [
  { id: "doors", words: ["porta", "porte", "portone", "portoni"] },
  { id: "gates", words: ["cancello", "cancelli"] },
] as const;
const tokens = (text: string) =>
  [...text.matchAll(/[\p{L}\p{M}\p{N}\p{Pc}]+/gu)].map((m) => ({
    normalized: m[0].normalize("NFC").toLowerCase(),
    quote: m[0],
    start: m.index!,
    end: m.index! + m[0].length,
  }));
// Explicit positive object classes, read from the existing official CPV
// vocabulary. Do not infer inclusion from labels such as "doors excluded".
const classes = {
  "45421100-5": "doors",
  "45421110-8": "doors",
  "45421111-5": "doors",
  "45421130-4": "doors",
  "45421131-1": "doors",
  "45421148-3": "gates",
} as const;
const catalogue = new Map<
  string,
  { code: string; label: string; object: "doors" | "gates" }
>();
for (const [code, object] of Object.entries(classes)) {
  const entry = vocabulary.entries.find((e) => e.code === code);
  if (!entry) throw new Error("Verified CPV object class is missing");
  const value = { code, label: entry.labels.it, object };
  catalogue.set(code, value);
  catalogue.set(code.slice(0, 8), value);
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

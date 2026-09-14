import type { CompanyProfile, Publication } from "./domain";

export const GARDEN_ACTIVITY_REVIEW_VERSION = "garden-activity-review-v1";

// This is a review lexicon, not a CPV vocabulary or a semantic classifier.
// Require an object declared in the profile and an operation in the same
// source sentence. Complete words only; never stem German compound words.
const objects = [
  {
    id: "trees",
    profile: ["albero", "alberi"],
    source: {
      it: ["albero", "alberi"],
      de: ["baum", "bäume", "bäumen"],
      fr: ["arbre", "arbres"],
      en: ["tree", "trees"],
    },
  },
  {
    id: "hedges",
    profile: ["siepe", "siepi", "arbusto", "arbusti"],
    source: {
      it: ["siepe", "siepi", "arbusto", "arbusti"],
      de: ["hecke", "hecken", "strauch", "sträucher", "sträuchern"],
      fr: ["haie", "haies", "arbuste", "arbustes", "arbrisseaux"],
      en: ["hedge", "hedges", "shrub", "shrubs"],
    },
  },
  {
    id: "lawns",
    profile: ["prato", "prati"],
    source: {
      it: ["prato", "prati"],
      de: ["rasen", "rasenflächen", "wiese", "wiesen", "blumenwiesen"],
      fr: ["pelouse", "pelouses", "prairie", "prairies"],
      en: ["lawn", "lawns", "meadow", "meadows"],
    },
  },
  {
    id: "beds",
    profile: ["aiuola", "aiuole"],
    source: {
      it: ["aiuola", "aiuole"],
      de: ["beet", "beete", "beeten", "blumenbeete"],
      fr: ["parterre", "parterres", "massifs"],
      en: ["flowerbed", "flowerbeds"],
    },
  },
] as const;
const operations = {
  it: [
    "piantumazione",
    "piantagione",
    "piantare",
    "impianto",
    "cura",
    "manutenzione",
    "potatura",
    "sfalcio",
    "semina",
    "irrigazione",
  ],
  de: [
    "pflanzung",
    "anpflanzung",
    "bepflanzung",
    "pflege",
    "pflegearbeiten",
    "pflegemassnahmen",
    "schnitt",
    "rückschnitt",
    "mähen",
    "mahd",
    "ansaat",
    "aussaat",
    "bewässerung",
  ],
  fr: [
    "plantation",
    "plantations",
    "entretien",
    "soins",
    "élagage",
    "taille",
    "tonte",
    "fauchage",
    "ensemencement",
    "semis",
    "irrigation",
    "arrosage",
  ],
  en: [
    "planting",
    "maintenance",
    "care",
    "pruning",
    "trimming",
    "mowing",
    "seeding",
    "irrigation",
    "watering",
  ],
} as const;
type Language = keyof typeof operations;
const languages: Language[] = ["it", "de", "fr", "en"];
type Word = { normalized: string; quote: string; start: number; end: number };
const words = (text: string, offset = 0): Word[] =>
  [...text.matchAll(/[\p{L}\p{M}\p{N}\p{Pc}]+/gu)].map((m) => ({
    normalized: m[0].normalize("NFC").toLowerCase(),
    quote: m[0],
    start: offset + m.index!,
    end: offset + m.index! + m[0].length,
  }));
const includes = (list: readonly string[], word: Word) =>
  list.includes(word.normalized);

export type GardenActivitySignal = {
  sector: "giardinaggio";
  basis: "source_activity_terms";
  object: (typeof objects)[number]["id"];
  lexiconLanguage: Language;
  language: string | null;
  field: string;
  quote: string;
  url: string;
  page?: number;
  start: number;
  end: number;
  terms: { object: Word; operation: Word };
  profileEvidence: {
    field: "activities";
    quote: string;
    start: number;
    end: number;
  };
};

export function findGardenActivityReview(
  p: Publication,
  profile: Pick<CompanyProfile, "sectors" | "activities">,
) {
  if (!profile.sectors.includes("giardinaggio")) return undefined;
  const declaredWords = words(profile.activities);
  const declared = objects.flatMap((object) => {
    const word = declaredWords.find((w) => includes(object.profile, w));
    return word ? [{ object, word }] : [];
  });
  if (!declared.length) return undefined;
  // Prefer the original language-labelled description. Generated summaries,
  // filenames and buyer names cannot provide these signals.
  const units: {
    text: string;
    field: string;
    url: string;
    language: string | null;
    page?: number;
  }[] = [
    ...(p.originalDescriptions ?? []).map((d, i) => ({
      ...d,
      field: `originalDescriptions[${i}]`,
    })),
    ...(p.documentPages ?? []).map((d, i) => ({
      ...d,
      field: `documentPages[${i}]`,
      language: null,
    })),
    {
      text: p.originalText,
      field: "originalText",
      url: p.sourceUrl,
      language: null,
    },
  ];
  for (const unit of units) {
    for (const sentence of unit.text.matchAll(/[^.!?;\r\n]+/gu)) {
      const from = sentence.index!;
      const terms = words(sentence[0], from);
      for (const language of languages) {
        const operation = terms.find((w) => includes(operations[language], w));
        if (!operation) continue;
        for (const { object, word } of declared) {
          const sourceObject = terms.find((w) =>
            includes(object.source[language], w),
          );
          if (!sourceObject) continue;
          const signal: GardenActivitySignal = {
            sector: "giardinaggio",
            basis: "source_activity_terms",
            object: object.id,
            lexiconLanguage: language,
            language: unit.language,
            field: unit.field,
            quote: sentence[0],
            url: unit.url,
            ...(unit.page === undefined ? {} : { page: unit.page }),
            start: from,
            end: from + sentence[0].length,
            terms: { object: sourceObject, operation },
            profileEvidence: {
              field: "activities",
              quote: word.quote,
              start: word.start,
              end: word.end,
            },
          };
          // Co-occurrence may describe a partial, optional or excluded task.
          // Preserve the complete sentence for the reviewer, never assign a role.
          return {
            version: GARDEN_ACTIVITY_REVIEW_VERSION,
            signals: [signal],
            reason:
              "La fonte contiene riferimenti al verde presenti nel profilo. Occorre verificare quali attività fanno parte dell’incarico e se coprono i servizi della ditta.",
          };
        }
      }
    }
  }
  return undefined;
}

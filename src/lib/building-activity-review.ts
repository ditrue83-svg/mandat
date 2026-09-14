import type { CompanyProfile, Publication } from "./domain";

export const BUILDING_ACTIVITY_REVIEW_VERSION = "building-activity-review-v1";

// Lexical candidates for human review. Shared components and operations do not
// establish who performs the work, whether it is optional, or whether it fits.
const objects = [
  {
    id: "doors",
    profile: ["porta", "porte", "portone", "portoni"],
    source: {
      it: ["porta", "porte", "portone", "portoni"],
      de: [
        "tür",
        "türen",
        "innentür",
        "innentüren",
        "aussentür",
        "aussentüren",
      ],
      fr: ["porte", "portes"],
      en: ["door", "doors"],
    },
  },
  {
    id: "gates",
    profile: ["cancello", "cancelli"],
    source: {
      it: ["cancello", "cancelli"],
      de: ["tor", "tore", "toren"],
      fr: ["portail", "portails"],
      en: ["gate", "gates"],
    },
  },
  {
    id: "locks",
    profile: ["serratura", "serrature"],
    source: {
      it: ["serratura", "serrature"],
      de: ["schloss", "schlösser", "schlössern"],
      fr: ["serrure", "serrures"],
      en: ["lock", "locks"],
    },
  },
] as const;
const operations = {
  it: [
    "riparazione",
    "riparazioni",
    "manutenzione",
    "regolazione",
    "adeguamento",
    "sostituzione",
    "installazione",
  ],
  de: [
    "reparatur",
    "reparaturen",
    "instandhaltung",
    "instandsetzung",
    "ertüchtigung",
    "wartung",
    "montage",
    "einbau",
    "erneuerung",
  ],
  fr: [
    "réparation",
    "réparations",
    "entretien",
    "rénovation",
    "remplacement",
    "installation",
    "réhabilitation",
    "pose",
  ],
  en: [
    "maintenance",
    "repair",
    "repairs",
    "adjustment",
    "replacement",
    "installation",
    "renovation",
    "refurbishment",
  ],
} as const;
type Language = keyof typeof operations;
type Word = { normalized: string; quote: string; start: number; end: number };
const words = (text: string, offset = 0): Word[] =>
  [...text.matchAll(/[\p{L}\p{M}\p{N}\p{Pc}]+/gu)].map((m) => ({
    normalized: m[0].normalize("NFC").toLowerCase(),
    quote: m[0],
    start: offset + m.index!,
    end: offset + m.index! + m[0].length,
  }));
const includes = (terms: readonly string[], word: Word) =>
  terms.includes(word.normalized);

export type BuildingActivitySignal = {
  sector: "manutenzioni";
  basis: "source_building_activity_terms";
  object: (typeof objects)[number]["id"];
  lexiconLanguage: Language;
  language: string | null;
  field: string;
  quote: string;
  url: string;
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

export function findBuildingActivityReview(
  p: Publication,
  profile: Pick<CompanyProfile, "sectors" | "activities">,
) {
  if (!profile.sectors.includes("manutenzioni")) return undefined;
  const declaredWords = words(profile.activities);
  const declared = objects.flatMap((object) => {
    const word = declaredWords.find((w) => includes(object.profile, w));
    return word ? [{ object, word }] : [];
  });
  if (!declared.length) return undefined;
  // Only preserved originals. A generated summary, buyer, document filename
  // or the combined administrative text cannot create a component signal.
  const units = [
    ...(p.originalDescriptions ?? []).map((d, i) => ({
      ...d,
      field: `originalDescriptions[${i}]`,
      title: false,
    })),
    ...(p.originalTitles ?? []).map((d, i) => ({
      ...d,
      field: `originalTitles[${i}]`,
      title: true,
    })),
  ];
  for (const unit of units) {
    // Titles are complete headings, including decimal classification codes.
    // Descriptions retain the matched sentence as context. Co-occurrence does
    // not establish that the operation applies to this component.
    const spans = unit.title
      ? [{ text: unit.text, start: 0 }]
      : [...unit.text.matchAll(/[^.!?;\r\n]+/gu)].map((m) => ({
          text: m[0],
          start: m.index!,
        }));
    for (const span of spans) {
      const terms = words(span.text, span.start);
      for (const language of Object.keys(operations) as Language[]) {
        const operation = terms.find((w) => includes(operations[language], w));
        if (!operation) continue;
        for (const { object, word } of declared) {
          const sourceObject = terms.find((w) =>
            includes(object.source[language], w),
          );
          if (!sourceObject) continue;
          const signal: BuildingActivitySignal = {
            sector: "manutenzioni",
            basis: "source_building_activity_terms",
            object: object.id,
            lexiconLanguage: language,
            language: unit.language,
            field: unit.field,
            quote: span.text,
            url: unit.url,
            start: span.start,
            end: span.start + span.text.length,
            terms: { object: sourceObject, operation },
            profileEvidence: {
              field: "activities",
              quote: word.quote,
              start: word.start,
              end: word.end,
            },
          };
          return {
            version: BUILDING_ACTIVITY_REVIEW_VERSION,
            signals: [signal],
            reason:
              "La fonte menziona componenti presenti nel profilo. Verifica quali interventi sono richiesti e chi deve eseguirli.",
          };
        }
      }
    }
  }
  return undefined;
}

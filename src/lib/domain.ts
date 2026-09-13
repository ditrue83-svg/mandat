// Text signals are complete tokens, including explicitly supported inflections
// and German compounds. Do not add stems that match inside unrelated words.
export const SECTORS = [
  {
    id: "pulizie",
    label: "Pulizie",
    cpv: ["909"],
    words: [
      "pulizia",
      "pulizie",
      "cleaning",
      "nettoyage",
      "reinigung",
      "gebäudereinigung",
      "unterhaltsreinigung",
      "fensterreinigung",
      "industriereinigung",
      "baureinigung",
      "grundreinigung",
    ],
  },
  {
    id: "giardinaggio",
    label: "Giardinaggio",
    cpv: ["773"],
    words: [
      "verde",
      "giardino",
      "giardini",
      "giardinaggio",
      "giardiniere",
      "giardinieri",
      "sfalcio",
      "potatura",
      "grün",
      "grünflächen",
      "grünflächenpflege",
      "grünanlagen",
      "grünanlagenpflege",
      "grünpflege",
      "grünflächenunterhalt",
      "jardin",
      "jardins",
      "jardinage",
      "jardinier",
      "jardiniers",
    ],
  },
  {
    id: "manutenzioni",
    label: "Manutenzioni",
    cpv: ["500", "507", "508"],
    words: [
      "manutenzione",
      "manutenzioni",
      "maintenance",
      "unterhalt",
      "gebäudeunterhalt",
      "strassenunterhalt",
      "anlagenunterhalt",
      "gartenunterhalt",
      "grünflächenunterhalt",
      "unterhaltsarbeiten",
      "unterhaltsdienst",
      "unterhaltsreinigung",
    ],
  },
  {
    id: "edilizia",
    label: "Edilizia minore",
    cpv: ["450", "451", "452", "454"],
    words: [
      "edili",
      "edile",
      "edilizia",
      "edilizio",
      "edilizi",
      "edilizie",
      "muratura",
      "risanamento",
      "ristrutturazione",
    ],
  },
  {
    id: "impianti",
    label: "Impianti",
    cpv: ["453", "505"],
    words: [
      "elettrico",
      "elettrica",
      "elettrici",
      "elettriche",
      "elettricità",
      "elettricista",
      "elettricisti",
      "idraulico",
      "idraulica",
      "idraulici",
      "idrauliche",
      "sanitario",
      "sanitaria",
      "sanitari",
      "sanitarie",
      "riscaldamento",
      "impianti",
      "elektro",
      "elektroinstallation",
      "elektroinstallationen",
      "elektroarbeiten",
    ],
  },
  {
    id: "sicurezza",
    label: "Sicurezza",
    cpv: ["797"],
    words: ["sorveglianza", "vigilanza", "sicurezza", "guarding", "security"],
  },
  {
    id: "catering",
    label: "Catering",
    cpv: ["555", "553"],
    words: [
      "ristorazione",
      "mensa",
      "pasti",
      "catering",
      "verpflegung",
      "gemeinschaftsverpflegung",
      "betriebsverpflegung",
      "schulverpflegung",
    ],
  },
  {
    id: "trasporti",
    label: "Trasporti",
    cpv: ["601", "600"],
    words: [
      "trasporto",
      "trasporti",
      "transport",
      "transports",
      "transportation",
      "transporte",
      "transportdienstleistungen",
      "gütertransport",
      "personentransport",
      "schülertransport",
      "schülertransporte",
      "scuolabus",
    ],
  },
] as const;
export type Sector = (typeof SECTORS)[number]["id"];
export const ZONES = [
  "Tutto il Ticino",
  "Luganese",
  "Mendrisiotto",
  "Bellinzonese",
  "Locarnese",
  "Riviera",
  "Blenio",
  "Leventina",
  "Vallemaggia",
];
export type SourceId = "simap" | "foglio-ti";
export type RadarStatus = {
  state: "ready" | "processing" | "delayed";
  pendingCount: number;
};
export type Evidence = {
  url: string;
  field: string;
  quote: string;
  page?: number;
};
export type OriginalDescription = {
  // Null means the source supplied an unlabelled string, not an inferred language.
  language: "it" | "de" | "fr" | "en" | null;
  // Source wording in its original language, with HTML converted to plain text.
  text: string;
  url: string;
};
export type OriginalTitle = OriginalDescription & {
  // Identifies the source field, including its translation key when present.
  path: string;
};
export type SourceScopeReview = {
  status: "required" | "resolved";
  kind: "ambiguous" | "conflicting";
  token: string;
  sourceRevision: string;
  updatedAt: string;
};
export type SourceCondition = {
  // Exact source field, including the translation key when present.
  path: string;
  // Preserve the source value: null and unexpected types are not yes/no answers.
  value: unknown;
  language?: "it" | "de" | "fr" | "en";
  url: string;
};
export type Publication = {
  id: string;
  source: SourceId;
  externalId: string;
  projectId?: string;
  title: string;
  buyer: string;
  location: string;
  canton: string;
  zone: string | null;
  publishedAt: string;
  updatedAt: string;
  visibleAt: string;
  deadline: string | null;
  valueChf: number | null;
  procedure: string | null;
  status: "open" | "cancelled" | "awarded" | "closed";
  sectors: Sector[];
  cpv: string[];
  sourceUrl: string;
  sourceUrls: string[];
  originalText: string;
  // Optional for older records and sources that do not expose language variants.
  originalDescriptions?: OriginalDescription[];
  originalTitles?: OriginalTitle[];
  sourceScopeReview?: SourceScopeReview;
  // Source context for review, separate from the requested service and AI text.
  sourceConditions?: SourceCondition[];
  summary: string | null;
  requirements: string[];
  evidence: Evidence[];
  documents: { title: string; url: string; requiresLogin: boolean }[];
  reviewRequired: boolean;
  reviewReasons: string[];
  revision: string;
  canonicalKey?: string;
  documentPages?: { page: number; text: string; url: string }[];
};
export type CompanyProfile = {
  name: string;
  activities: string;
  employees: number;
  sectors: Sector[];
  zones: string[];
  keywords: string[];
  exclusions: string[];
  minValue: number | null;
  maxValue: number | null;
  emailEnabled: boolean;
};
export type MatchAssessment =
  | "preliminary"
  | "uncertain"
  | "ai"
  | "reviewed"
  | "rejected"
  | "excluded"
  | "demo";
export type Opportunity = Publication & {
  score: number;
  reason: string;
  assessment: MatchAssessment;
  saved: boolean;
  dismissed: boolean;
  feedback: "relevant" | "irrelevant" | null;
};
export type Viewer = {
  userId: string;
  companyId: string;
  name: string;
  email: string;
  admin: boolean;
  demo: boolean;
  profile: CompanyProfile;
};
export function sectorLabel(id: string) {
  return SECTORS.find((s) => s.id === id)?.label ?? id;
}
export function formatMoney(n: number | null) {
  return n === null
    ? "Non indicato"
    : `CHF ${new Intl.NumberFormat("it-CH", { maximumFractionDigits: 0 }).format(n)}`;
}
export function formatDate(date: string | null) {
  return date
    ? new Intl.DateTimeFormat("it-CH", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "Europe/Zurich",
      }).format(new Date(date))
    : "Non indicata";
}
export function daysUntil(date: string | null, now = Date.now()) {
  return date ? Math.ceil((new Date(date).getTime() - now) / 86400000) : null;
}
export function formatDeadline(date: string | null) {
  return date
    ? `${new Intl.DateTimeFormat("it-CH", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" }).format(new Date(date))} (ora svizzera)`
    : "Non indicata";
}

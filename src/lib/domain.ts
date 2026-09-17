import type { projectLotAssessmentDto } from "./lot-assessment";
import type { PublicationClassification } from "./sector-classification";
export { SECTORS, type Sector } from "./sectors";
import { SECTORS, type Sector } from "./sectors";
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
  // Read-time derived projection; never written back to documentary snapshots.
  classification?: PublicationClassification;
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
  | "unreviewed"
  | "preliminary"
  | "uncertain"
  | "ai"
  | "reviewed"
  | "rejected"
  | "excluded"
  | "demo";
export type Opportunity = Publication & {
  tenderBrief?: import("./tender-brief").TenderBrief;
  lotReview?: ReturnType<typeof projectLotAssessmentDto>;
  catalogOnly?: boolean;
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
  invitationAcceptedAt: string | null;
  invitationAcceptanceVersion: string | null;
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

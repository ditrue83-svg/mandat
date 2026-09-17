import type { Publication, Sector } from "./domain";
import vocabulary from "./cpv-service-labels.json";
import { isMatchContentCurrent } from "./source-scope-review";
import { findPublishedObjectReview } from "./cpv-object-review";
import {
  findBuildingActivityReview,
  type BuildingActivitySignal,
} from "./building-activity-review";
import {
  findGardenActivityReview,
  type GardenActivitySignal,
} from "./garden-activity-review";

export const CPV_ACTIVITY_REVIEW_VERSION = "cpv-labels-v1";
export const CPV_ACTIVITY_REVIEW_MARKER = ":activity-review:";

export type CpvSignal = {
  sector: Sector;
  cpv: string;
  lexiconLanguage: string;
  language: string | null;
  label: string;
  field: string;
  quote: string;
  url: string;
  page?: number;
  start: number;
  end: number;
  basis?: "published_cpv_component";
  profileEvidence?: {
    field: string;
    quote: string;
    start: number;
    end: number;
  };
};
type Token = { text: string; start: number; end: number };
type Term = {
  cpv: string;
  sector: Sector;
  lexiconLanguage: string;
  label: string;
};
type Node = { children: Map<string, Node>; terms: Term[] };
const node = (): Node => ({ children: new Map(), terms: [] });
const root = node();

// Keep offsets in the original string. Normalization is used only for token
// comparison, so a quote remains exact even with combining marks or emoji.
function tokens(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)].map((match) => ({
    text: match[0].normalize("NFC").toLowerCase(),
    start: match.index!,
    end: match.index! + match[0].length,
  }));
}
for (const entry of vocabulary.entries) {
  for (const [language, label] of Object.entries(entry.labels)) {
    const words = tokens(label);
    if (!words.length) continue;
    let cursor = root;
    for (const word of words) {
      if (!cursor.children.has(word.text))
        cursor.children.set(word.text, node());
      cursor = cursor.children.get(word.text)!;
    }
    for (const sector of entry.sectors)
      cursor.terms.push({
        cpv: entry.code,
        sector: sector as Sector,
        lexiconLanguage: language,
        label,
      });
  }
}

export function findCpvServiceSignals(
  p: Publication,
  sectors: readonly Sector[],
): CpvSignal[] {
  const allowed = new Set(sectors);
  const units: {
    text: string;
    field: string;
    url: string;
    language: string | null;
    page?: number;
  }[] = [
    { text: p.title, field: "title", url: p.sourceUrl, language: null },
    {
      text: p.originalText,
      field: "originalText",
      url: p.sourceUrl,
      language: null,
    },
    ...(p.originalTitles ?? []).map((t, i) => ({
      text: t.text,
      field: `originalTitles[${i}]`,
      url: t.url,
      language: t.language,
    })),
    ...(p.originalDescriptions ?? []).map((t, i) => ({
      text: t.text,
      field: `originalDescriptions[${i}]`,
      url: t.url,
      language: t.language,
    })),
    ...(p.documentPages ?? []).map((t, i) => ({
      text: t.text,
      field: `documentPages[${i}]`,
      url: t.url,
      page: t.page,
      language: null,
    })),
  ];
  const best = new Map<Sector, { signal: CpvSignal; length: number }>();
  for (const unit of units) {
    const words = tokens(unit.text);
    for (let start = 0; start < words.length; start++) {
      let cursor = root;
      for (let end = start; end < words.length; end++) {
        // A term never continues into another sentence. Punctuation within a
        // CPV phrase (commas, parentheses, hyphens) may differ typographically.
        if (
          end > start &&
          /[.!?;:]/u.test(unit.text.slice(words[end - 1].end, words[end].start))
        )
          break;
        const next = cursor.children.get(words[end].text);
        if (!next) break;
        cursor = next;
        for (const term of cursor.terms) {
          if (!allowed.has(term.sector)) continue;
          const length = end - start + 1;
          if ((best.get(term.sector)?.length ?? 0) >= length) continue;
          const from = words[start].start;
          const to = words[end].end;
          best.set(term.sector, {
            length,
            signal: {
              ...term,
              language: unit.language,
              field: unit.field,
              quote: unit.text.slice(from, to),
              url: unit.url,
              ...(unit.page === undefined ? {} : { page: unit.page }),
              start: from,
              end: to,
            },
          });
        }
      }
    }
  }
  // These are lexical review candidates. Neither the term nor its sector
  // establishes that it belongs to this contract or that this firm can do it.
  return sectors.flatMap((sector) =>
    best.has(sector) ? [best.get(sector)!.signal] : [],
  );
}

export type ActivityReview = {
  version: string;
  signals: (CpvSignal | GardenActivitySignal | BuildingActivitySignal)[];
  reason: string;
};

export function findActivityReview(
  p: Publication,
  sectors: readonly Sector[],
  activities?: string,
): ActivityReview | undefined {
  const signals = findCpvServiceSignals(p, sectors);
  if (signals.length)
    return {
      version: CPV_ACTIVITY_REVIEW_VERSION,
      signals,
      reason: `La fonte cita «${signals[0].quote}». Attività e ruolo della ditta da verificare nel contesto dell’incarico.`,
    };
  if (!activities) return undefined;
  const related = findPublishedObjectReview(p, {
    activities,
    sectors: [...sectors],
  });
  if (!related)
    return (
      findBuildingActivityReview(p, { sectors: [...sectors], activities }) ??
      findGardenActivityReview(p, { sectors: [...sectors], activities })
    );
  return {
    version: related.version,
    reason: related.reason,
    signals: related.signals.map((signal): CpvSignal => ({
      sector: "manutenzioni",
      cpv: signal.vocabulary.code,
      lexiconLanguage: signal.vocabulary.language,
      language: null,
      label: signal.vocabulary.label,
      field: signal.source.field,
      quote: signal.source.value,
      url: signal.source.url,
      start: 0,
      end: signal.source.value.length,
      basis: "published_cpv_component",
      profileEvidence: {
        field: signal.profile.field,
        quote: signal.profile.quote,
        start: signal.profile.start,
        end: signal.profile.end,
      },
    })),
  };
}

export function hasActivityReviewRevision(
  revision: string | null | undefined,
): boolean {
  return !!revision?.includes(CPV_ACTIVITY_REVIEW_MARKER);
}

export function activityReviewForMatch(input: {
  publication: Publication;
  sectors: readonly Sector[];
  activities?: string;
  preliminary: { eligible: boolean; activityReview?: ActivityReview };
  revision: string | null | undefined;
  profileRevision: string;
}): ActivityReview | undefined {
  if (!input.preliminary.eligible) return undefined;
  if (input.preliminary.activityReview) return input.preliminary.activityReview;
  // Summary enrichment can add inferred sectors without changing the source
  // revision. It cannot promote a match already routed to activity review.
  if (
    hasActivityReviewRevision(input.revision) &&
    isMatchContentCurrent({
      revision: input.revision,
      publication: input.publication,
      profileRevision: input.profileRevision,
    })
  )
    return findActivityReview(
      input.publication,
      input.sectors,
      input.activities,
    );
  return undefined;
}

export function activityReviewBlocksAutomatic(
  match: {
    revision: string;
    approved: boolean | null;
    reviewedAt: Date | null;
  },
  preliminary: {
    activityReview?: ActivityReview;
    classificationReview?: string;
  },
  binding: {
    publication: Pick<Publication, "revision">;
    profileRevision: string;
  },
): boolean {
  if (
    preliminary.classificationReview &&
    !(
      match.approved === true &&
      match.reviewedAt &&
      match.revision.includes(preliminary.classificationReview) &&
      isMatchContentCurrent({ revision: match.revision, ...binding })
    )
  )
    return true;
  return (
    !(
      match.approved === true &&
      match.reviewedAt &&
      isMatchContentCurrent({
        revision: match.revision,
        ...binding,
      })
    ) &&
    (!!preliminary.activityReview || hasActivityReviewRevision(match.revision))
  );
}

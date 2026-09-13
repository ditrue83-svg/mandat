import type { MatchAssessment, Opportunity, Publication } from "./domain";
import type { SourceContext, SourceDependency } from "./source-review-context";
import {
  hasActivityReviewRevision,
  type ActivityReview,
} from "./cpv-service-signals";
import {
  sourceReviewBindingState,
  sourceReviewReason,
  manualSourceComparisonReason,
} from "./source-review-policy";
import {
  hasSourceScopeReview,
  isMatchRevisionCurrent,
  sourceScopeReviewReason,
} from "./source-scope-review";

type Match = {
  revision: string;
  reason: string;
  eligible: boolean;
  approved: boolean | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
  sourceReviewDependency?: SourceDependency | null;
};

export const assessmentLabels: Record<MatchAssessment, string> = {
  preliminary: "Pertinenza da verificare",
  uncertain: "Pertinenza da verificare",
  ai: "Pertinenza stimata dall’AI",
  reviewed: "Pertinenza revisionata",
  rejected: "Valutata non pertinente",
  excluded: "Non selezionata dal Radar",
  demo: "Esempio dimostrativo",
};

// Only return product-facing text. Internal review notes can contain user IDs.
export function presentMatch({
  match,
  publication,
  aiRevision,
  profileRevision,
  preliminary,
  sourceReview = null,
}: {
  match: Match;
  publication: Pick<Publication, "revision" | "summary" | "sourceScopeReview">;
  aiRevision: string | null;
  profileRevision: string;
  preliminary?: {
    eligible: boolean;
    reason: string;
    activityReview?: ActivityReview;
  };
  sourceReview?: SourceContext | null;
}): Pick<Opportunity, "assessment" | "reason"> &
  Partial<Pick<Opportunity, "score">> {
  const manuallyReviewed =
    match.approved === false || (match.approved === true && !!match.reviewedAt);
  const current = isMatchRevisionCurrent({
    revision: match.revision,
    publication,
    profileRevision,
    manuallyReviewed,
  });
  if (current && match.approved === false)
    return {
      assessment: "rejected",
      reason:
        "La revisione manuale ha ritenuto questa proposta non pertinente per la tua ditta.",
    };
  if (
    hasActivityReviewRevision(match.revision) &&
    preliminary &&
    !preliminary.eligible
  )
    return { assessment: "excluded", reason: preliminary.reason, score: 0 };
  const sourceState = sourceReviewBindingState(
    sourceReview,
    match.sourceReviewDependency,
  );
  if (sourceReview && preliminary && !preliminary.eligible)
    return { assessment: "excluded", reason: preliminary.reason, score: 0 };
  if (sourceState === "blocked" || sourceState === "stale") {
    if (preliminary && !preliminary.eligible)
      return { assessment: "excluded", reason: preliminary.reason, score: 0 };
    return {
      assessment: "uncertain",
      reason: sourceReviewReason(sourceReview),
      score: 0,
    };
  }
  if (sourceReview && manuallyReviewed && !current)
    return {
      assessment: "uncertain",
      reason:
        "Il bando o il profilo della ditta sono cambiati dopo la revisione manuale. La pertinenza deve essere ricontrollata.",
      score: 0,
    };
  if (hasSourceScopeReview(publication)) {
    if (preliminary && !preliminary.eligible)
      return { assessment: "excluded", reason: preliminary.reason };
    return {
      assessment: "uncertain",
      reason: sourceScopeReviewReason,
      ...(sourceReview ? { score: 0 } : {}),
    };
  }
  if (sourceReview && !manuallyReviewed)
    return {
      assessment: "uncertain",
      reason: manualSourceComparisonReason,
      score: 0,
    };
  if (current && match.approved === true && match.reviewedAt)
    return {
      assessment: "reviewed",
      reason:
        "La proposta è stata ritenuta pertinente in una revisione manuale. Verifica comunque i requisiti nella fonte originale.",
    };
  if (preliminary?.activityReview || hasActivityReviewRevision(match.revision))
    return {
      assessment: "uncertain",
      score: 0,
      reason:
        preliminary?.activityReview?.reason ??
        (current
          ? match.reason
          : "Il bando o il profilo sono cambiati. Le attività citate nella fonte richiedono una nuova verifica."),
    };

  const prefix = `${publication.revision}:${profileRevision}:`;
  if (current && !match.eligible)
    return { assessment: "excluded", reason: match.reason };
  if (
    !current ||
    !publication.summary ||
    aiRevision !== publication.revision ||
    !match.revision.startsWith(`${prefix}ready:`) ||
    match.revision.endsWith(":retry")
  )
    return {
      assessment: "preliminary",
      reason:
        "L’analisi della pertinenza per il tuo profilo non è ancora completata. Consulta la pubblicazione originale prima di valutarla.",
    };
  if (match.reviewNotes)
    return {
      assessment: "uncertain",
      reason:
        "L’analisi non ha stabilito con sufficiente certezza la pertinenza per la tua ditta. Verifica attività e luogo nella fonte originale.",
    };
  return { assessment: "ai", reason: match.reason };
}

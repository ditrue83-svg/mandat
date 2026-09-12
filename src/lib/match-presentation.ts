import type { MatchAssessment, Opportunity, Publication } from "./domain";
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
}: {
  match: Match;
  publication: Pick<Publication, "revision" | "summary" | "sourceScopeReview">;
  aiRevision: string | null;
  profileRevision: string;
  preliminary?: { eligible: boolean; reason: string };
}): Pick<Opportunity, "assessment" | "reason"> {
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
  if (hasSourceScopeReview(publication)) {
    if (preliminary && !preliminary.eligible)
      return { assessment: "excluded", reason: preliminary.reason };
    return {
      assessment: "uncertain",
      reason: sourceScopeReviewReason,
    };
  }
  if (current && match.approved === true && match.reviewedAt)
    return {
      assessment: "reviewed",
      reason:
        "La proposta è stata ritenuta pertinente in una revisione manuale. Verifica comunque i requisiti nella fonte originale.",
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

import type { SourceContext, SourceDependency } from "./source-review-context";

export const manualSourceComparisonReason =
  "La fonte è stata esaminata. Il confronto con le attività della ditta richiede una revisione manuale.";

// A dependency identifies documentary content and a human source event. It
// says nothing about a company's suitability or the truth of the annotation.
export function sameSourceReviewDependency(
  left: SourceDependency | null | undefined,
  right: SourceDependency | null | undefined,
): boolean {
  if (!left || !right) return !left && !right;
  const fields = [
    "version",
    "publicationId",
    "sourceSnapshotHash",
    "corpusHash",
    "reviewEventId",
    "reviewEventHash",
  ] as const;
  return (
    Object.keys(left).length === fields.length &&
    Object.keys(right).length === fields.length &&
    fields.every((field) => left[field] === right[field])
  );
}

export function sourceReviewBlocksComparison(context: SourceContext | null) {
  return (
    !!context &&
    (context.state !== "manual_source" || context.form !== "defined_service")
  );
}

export function sourceReviewReason(context: SourceContext | null): string {
  if (context?.state === "manual_source" && context.form === "broad_scope")
    return "La fonte descrive un ambito generale. Le prestazioni effettive richiedono una verifica prima di valutare la pertinenza per la ditta.";
  if (
    context?.state === "review_required" &&
    context.reason === "source_changed"
  )
    return "I testi originali sono cambiati dopo la revisione dell’oggetto. La fonte e la pertinenza richiedono una nuova verifica.";
  if (context?.state === "input_refused")
    return "Non è stato possibile esaminare integralmente gli originali archiviati. La pertinenza richiede una verifica della fonte.";
  if (sourceReviewBlocksComparison(context))
    return "La revisione dell’oggetto della fonte è aperta o non ha chiarito le prestazioni. La pertinenza richiede una verifica.";
  return "La valutazione si basa su una revisione precedente della fonte. La pertinenza deve essere ricontrollata.";
}

export function sourceReviewBindingState(
  context: SourceContext | null,
  dependency: SourceDependency | null | undefined,
): "untracked" | "blocked" | "stale" | "current" {
  if (!context) return dependency ? "stale" : "untracked";
  if (sourceReviewBlocksComparison(context)) return "blocked";
  return sameSourceReviewDependency(dependency, context.dependency)
    ? "current"
    : "stale";
}

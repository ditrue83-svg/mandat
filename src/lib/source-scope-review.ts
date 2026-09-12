import type { Publication } from "./domain";

type SourceReviewPublication = Pick<Publication, "sourceScopeReview">;

export const sourceScopeReviewReason =
  "L’oggetto del bando contiene informazioni incomplete o in contrasto. La pertinenza richiede una verifica della fonte.";

export function hasSourceScopeReview(p: SourceReviewPublication): boolean {
  // A new source revision does not resolve an explicitly recorded ambiguity.
  return p.sourceScopeReview?.status === "required";
}

export function sourceScopeReviewSuffix(p: SourceReviewPublication): string {
  return p.sourceScopeReview
    ? `:source-scope:${p.sourceScopeReview.token}`
    : "";
}

export function isMatchContentCurrent({
  revision,
  publication,
  profileRevision,
}: {
  revision: string | null | undefined;
  publication: Pick<Publication, "revision">;
  profileRevision: string;
}): boolean {
  return (
    !!revision?.startsWith(`${publication.revision}:${profileRevision}:`) &&
    !revision.endsWith(":profile-update")
  );
}

export function isMatchRevisionCurrent({
  revision,
  publication,
  profileRevision,
  manuallyReviewed = false,
}: {
  revision: string | null | undefined;
  publication: Pick<Publication, "revision" | "sourceScopeReview">;
  profileRevision: string;
  manuallyReviewed?: boolean;
}): boolean {
  if (
    !isMatchContentCurrent({ revision, publication, profileRevision }) ||
    !revision
  )
    return false;
  // Source review changes do not erase a review of the same content/profile.
  if (manuallyReviewed) return true;
  const withoutRetry = revision.endsWith(":retry")
    ? revision.slice(0, -":retry".length)
    : revision;
  const suffix = sourceScopeReviewSuffix(publication);
  if (suffix && !withoutRetry.endsWith(suffix)) return false;
  const base = suffix ? withoutRetry.slice(0, -suffix.length) : withoutRetry;
  return (
    !base.includes(":source-scope:") &&
    !base.endsWith(":retry") &&
    !base.endsWith(":profile-update")
  );
}

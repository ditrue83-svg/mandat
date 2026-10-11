import {
  automaticBasisFromFacts,
  automaticComparisonResponseSchema,
} from "./automatic-comparison";

// Negative-only list optimization. This cannot approve an opportunity: every
// retained candidate still passes the canonical source/profile/permission reader.
// Human evaluations, saved items and dismissals bypass this hint in queries.ts.
export function automaticResponseMayReachRadar(
  response: unknown,
  includeRelatedReview: boolean,
): boolean {
  // A source-only result cannot be direct or a verified related activity.
  if (response === null) return false;
  const parsed = automaticComparisonResponseSchema.safeParse(response);
  // Unknown formats retain the full reader rather than guessing their meaning.
  if (!parsed.success) return true;
  const basis = automaticBasisFromFacts(parsed.data.facts);
  return (
    basis === "same_service" ||
    (includeRelatedReview && basis === "related_activity")
  );
}

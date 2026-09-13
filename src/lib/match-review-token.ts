import { fingerprint } from "@/sources/common";
import type { SourceDependency } from "./source-review-context";

// The revision alone does not change on a manual approval or rejection.
// Bind an approval to the complete decision the founder actually viewed.
export function matchReviewToken(match: {
  id: string;
  revision: string;
  score: number;
  eligible: boolean;
  reason: string;
  approved: boolean | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
  updatedAt: Date;
  sourceReviewDependency: SourceDependency | null;
}): string {
  return fingerprint({
    id: match.id,
    revision: match.revision,
    score: match.score,
    eligible: match.eligible,
    reason: match.reason,
    approved: match.approved,
    reviewedAt: match.reviewedAt,
    reviewNotes: match.reviewNotes,
    updatedAt: match.updatedAt,
    sourceReviewDependency: match.sourceReviewDependency,
  });
}

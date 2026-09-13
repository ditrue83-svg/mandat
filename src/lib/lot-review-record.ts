import type { LotEvaluationSet, ProjectLotSuppression } from "./lot-assessment";
import type { LotSourceSnapshot } from "./lot-source-context";
import type {
  LotProjectSuppressionView,
  CanonicalLotSuppression,
} from "./lot-project-suppression";

export type LotMatchReviewState = {
  evaluations: LotEvaluationSet | null;
  suppression: ProjectLotSuppression | null;
};
type ReviewRecordFields = {
  id: string;
  matchId: string;
  companyId: string;
  publicationId: string;
  sequence: number;
  actorId: string;
  at: string;
  note: string;
  sourceSnapshotHash: string;
  evidenceSnapshot: LotSourceSnapshot;
  profileHash: string;
  groupBefore: LotProjectSuppressionView["before"];
  groupAfter: CanonicalLotSuppression | null;
  before: LotMatchReviewState;
  after: LotMatchReviewState;
  previousToken: string;
  nextToken: string;
};
export type LegacyLotMatchReviewRecord = ReviewRecordFields & {
  version: "human-lot-match-review-v1";
  action: "assess_lot" | "veto_project" | "reopen_project";
};
export type TargetMatchReviewRecord = ReviewRecordFields & {
  version: "human-lot-match-review-v2";
  action: "assess_lot" | "assess_project" | "veto_project" | "reopen_project";
  shapeEpochToken: string | null;
};
export type LotMatchReviewRecord =
  LegacyLotMatchReviewRecord | TargetMatchReviewRecord;

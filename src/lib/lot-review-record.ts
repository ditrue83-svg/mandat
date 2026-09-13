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
export type LotMatchReviewRecord = {
  version: "human-lot-match-review-v1";
  id: string;
  matchId: string;
  companyId: string;
  publicationId: string;
  sequence: number;
  action: "assess_lot" | "veto_project" | "reopen_project";
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

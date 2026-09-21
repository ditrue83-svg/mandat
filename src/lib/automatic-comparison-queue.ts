import { randomUUID } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { PgBoss, fromDrizzle } from "pg-boss";
import { automaticMatchRuns } from "@/db/schema";
import type { LoadedLotMatchReview } from "./lot-match-reviews";
import { assessmentTargetKey } from "./lot-assessment";
import {
  AutomaticComparisonUnavailable,
  buildAutomaticComparisonRequest,
} from "./automatic-comparison";
import type { getDb } from "@/db";

export const AUTOMATIC_COMPARISON_QUEUE = "documentary-compare";
export const automaticComparisonEnabled = () =>
  process.env.DOCUMENTARY_COMPARISON_ENABLED === "true";
export type AutomaticComparisonJob = {
  runId: string;
  publicationId: string;
  companyId: string;
};
type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

// Called under canonical → company → match locks. A unique input row and the
// durable job commit together; repeated hourly scans do not repeat paid work.
export async function enqueueAutomaticComparisons(
  tx: Tx,
  loaded: LoadedLotMatchReview,
) {
  if (
    !automaticComparisonEnabled() ||
    loaded.project.suppressed ||
    loaded.project.dismissed
  )
    return 0;
  let queued = 0;
  for (const target of loaded.project.targets) {
    if (
      target.evaluation ||
      target.automatic ||
      !target.preliminary?.eligible ||
      target.state === "removed-or-unresolved"
    )
      continue;
    try {
      const request = buildAutomaticComparisonRequest({
        ...loaded.input,
        target: target.target,
        preliminary: target.preliminary,
      });
      if (request.sourceBlocked) continue;
      const [run] = await tx
        .insert(automaticMatchRuns)
        .values({
          id: randomUUID(),
          matchId: loaded.match.id,
          companyId: loaded.company.id,
          publicationId: loaded.publication.id,
          target: target.target,
          targetKey: assessmentTargetKey(target.target),
          inputHash: request.inputHash,
        })
        .onConflictDoUpdate({
          target: [
            automaticMatchRuns.matchId,
            automaticMatchRuns.targetKey,
            automaticMatchRuns.inputHash,
          ],
          // A profile may change A → B → A while work is pending. Reuse the
          // original input row and remaining attempts, never reset its budget
          // or retry completed/failed work merely because a scan repeats.
          set: {
            status: "queued",
            issue: null,
            leaseUntil: null,
            updatedAt: new Date(),
          },
          setWhere: and(
            eq(automaticMatchRuns.status, "superseded"),
            lt(automaticMatchRuns.attempts, 3),
          ),
        })
        .returning({ id: automaticMatchRuns.id });
      if (!run) continue;
      const producer = new PgBoss({
        db: fromDrizzle(tx, sql),
        schema: "pgboss",
        schedule: false,
        supervise: false,
        migrate: false,
        createSchema: false,
      });
      const id = await producer.send(AUTOMATIC_COMPARISON_QUEUE, {
        runId: run.id,
        publicationId: loaded.publication.id,
        companyId: loaded.company.id,
      } satisfies AutomaticComparisonJob);
      if (!id) throw new Error("Confronto automatico non accodato.");
      queued++;
    } catch (error) {
      if (!(error instanceof AutomaticComparisonUnavailable)) throw error;
      // Missing/unusable source remains visible in the founder review queue.
    }
  }
  return queued;
}

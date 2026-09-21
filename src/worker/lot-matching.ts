import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { companies, matches } from "@/db/schema";
import { lockCanonicalPublications } from "@/lib/canonical-lock";
import { readLotMatchReview } from "@/lib/lot-match-reviews";
import { companyAllowsPilotProcessingSql } from "@/lib/pilot-processing";
import { enqueueAutomaticComparisons } from "@/lib/automatic-comparison-queue";

export const LOT_WORKER_REVIEW_VERSION = "lot-worker-review-v1";

// A completed worker pass creates a project row for human review. Its legacy
// score is never a lot verdict: readers must resolve the adopted source and the
// actual human evaluations again. In particular, a parent-sector exclusion is
// not allowed to prevent this row from being created.
export async function matchAdoptedPublication({
  publicationId,
  now = new Date(),
  signal,
}: {
  publicationId: string;
  now?: Date;
  signal?: AbortSignal;
}): Promise<{ handled: boolean; matched: number }> {
  signal?.throwIfAborted();
  if (!Number.isFinite(now.getTime()))
    throw new Error("Invalid lot matching clock");
  return getDb().transaction(async (tx) => {
    const locked = await lockCanonicalPublications(tx, publicationId);
    if (!locked?.publication.documentarySnapshotId)
      return { handled: false, matched: 0 };
    // Acquire every participating company before match/feedback locks. Profiles
    // from the scheduler's earlier inventory must not become comparison inputs.
    const firms = await tx
      .select()
      .from(companies)
      .where(
        and(
          isNull(companies.disabledAt),
          isNotNull(companies.onboardedAt),
          companyAllowsPilotProcessingSql(),
        ),
      )
      .orderBy(companies.id)
      .for("share");
    let matched = 0;
    for (const company of firms) {
      signal?.throwIfAborted();
      await tx
        .insert(matches)
        .values({
          id: crypto.randomUUID(),
          companyId: company.id,
          publicationId,
          revision: `${LOT_WORKER_REVIEW_VERSION}:unresolved`,
          score: 0,
          eligible: false,
          reason:
            "La fonte adottata richiede una valutazione umana della pertinenza.",
          reviewNotes: "Richiesta revisione umana della pertinenza",
        })
        .onConflictDoNothing();
      const [match] = await tx
        .select()
        .from(matches)
        .where(
          and(
            eq(matches.companyId, company.id),
            eq(matches.publicationId, publicationId),
          ),
        )
        .for("update");
      if (!match) throw new Error("Lot review match was not created");
      const loaded = await readLotMatchReview(
        tx,
        locked.publication,
        company,
        match,
        now,
      );
      await enqueueAutomaticComparisons(tx, loaded);
      signal?.throwIfAborted();
      // Preserve the exact earlier company decisions and their revision. A
      // change in source/profile invalidates consumption, not historical data.
      const human =
        match.reviewedAt !== null ||
        match.approved !== null ||
        match.lotEvaluations !== null;
      if (!human) {
        // A ready row is not a positive verdict. The resolver also describes a
        // real project target or an unresolved structure without synthetic lots.
        const reason = loaded.project.reason;
        const revision = `${LOT_WORKER_REVIEW_VERSION}:${loaded.project.projectBindingHash}`;
        if (
          match.revision !== revision ||
          match.score !== 0 ||
          match.eligible ||
          match.reason !== reason
        )
          await tx
            .update(matches)
            .set({
              revision,
              score: 0,
              eligible: false,
              reason,
              reviewNotes: "Richiesta revisione umana della pertinenza",
              updatedAt: new Date(),
            })
            .where(eq(matches.id, match.id));
      }
      matched++;
    }
    signal?.throwIfAborted();
    return { handled: true, matched };
  });
}

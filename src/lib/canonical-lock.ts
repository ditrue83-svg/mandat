import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { publications } from "@/db/schema";

export type CanonicalExecutor = Pick<
  ReturnType<typeof getDb>,
  "select" | "execute"
>;
export class CanonicalMembershipConflict extends Error {}

// Acquire every group before any row lock; callers must never append another
// group after locking a company or its matches. An empty inventory is valid for
// a newly onboarded company and must be rechecked under its company lock.
export async function lockCanonicalPublicationGroups(
  tx: CanonicalExecutor,
  canonicalIds: readonly string[],
) {
  const groups = [...new Set(canonicalIds)].sort();
  for (const group of groups)
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`mandat-canonical:${group}`}, 0))`,
    );
  if (!groups.length) return [];
  return tx
    .select()
    .from(publications)
    .where(inArray(publications.canonicalId, groups))
    .orderBy(publications.id)
    .for("update");
}

// Call only inside a transaction. Every participating writer must acquire this
// group lock before its publication/company/match/feedback/notification locks.
// The initial lookup chooses a lock, never the final membership to operate on.
export async function lockCanonicalPublications(
  tx: CanonicalExecutor,
  publicationId: string,
) {
  const [observed] = await tx
    .select({ canonicalId: publications.canonicalId })
    .from(publications)
    .where(eq(publications.id, publicationId));
  if (!observed) return null;
  const rows = await lockCanonicalPublicationGroups(tx, [observed.canonicalId]);
  const publication = rows.find((row) => row.id === publicationId);
  if (!publication)
    throw new CanonicalMembershipConflict(
      "Il gruppo della pubblicazione è cambiato: ripetere la transazione.",
    );
  return { canonicalId: observed.canonicalId, publication, publications: rows };
}

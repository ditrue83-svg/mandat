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
async function lockCanonicalGroups(
  tx: CanonicalExecutor,
  canonicalIds: readonly string[],
  readOnly: boolean,
) {
  const groups = [...new Set(canonicalIds)].sort();
  for (const group of groups)
    await tx.execute(
      readOnly
        ? sql`select pg_advisory_xact_lock_shared(hashtextextended(${`mandat-canonical:${group}`}, 0))`
        : sql`select pg_advisory_xact_lock(hashtextextended(${`mandat-canonical:${group}`}, 0))`,
    );
  if (!groups.length) return [];
  return tx
    .select()
    .from(publications)
    .where(inArray(publications.canonicalId, groups))
    .orderBy(publications.id)
    .for(readOnly ? "share" : "update");
}

// Writers keep exclusive locks. Read-only transactions can coexist while still
// blocking every membership/source/profile writer that uses the same key.
export const lockCanonicalPublicationGroups = (
  tx: CanonicalExecutor,
  ids: readonly string[],
) => lockCanonicalGroups(tx, ids, false);
export const lockCanonicalPublicationReadGroups = (
  tx: CanonicalExecutor,
  ids: readonly string[],
) => lockCanonicalGroups(tx, ids, true);

// Call only inside a transaction. Every participating writer must acquire this
// group lock before its publication/company/match/feedback/notification locks.
// The initial lookup chooses a lock, never the final membership to operate on.
async function lockCanonical(
  tx: CanonicalExecutor,
  publicationId: string,
  readOnly: boolean,
) {
  const [observed] = await tx
    .select({ canonicalId: publications.canonicalId })
    .from(publications)
    .where(eq(publications.id, publicationId));
  if (!observed) return null;
  const rows = await lockCanonicalGroups(tx, [observed.canonicalId], readOnly);
  const publication = rows.find((row) => row.id === publicationId);
  if (!publication)
    throw new CanonicalMembershipConflict(
      "Il gruppo della pubblicazione è cambiato: ripetere la transazione.",
    );
  return { canonicalId: observed.canonicalId, publication, publications: rows };
}

export const lockCanonicalPublications = (tx: CanonicalExecutor, id: string) =>
  lockCanonical(tx, id, false);
export const lockCanonicalPublicationRead = (
  tx: CanonicalExecutor,
  id: string,
) => lockCanonical(tx, id, true);

// Display-only MVCC readers. Call inside REPEATABLE READ / READ ONLY; never use
// this view to authorize a mutation, notification claim or quality approval.
export async function readCanonicalPublicationGroupSnapshot(
  tx: CanonicalExecutor,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return tx
    .select()
    .from(publications)
    .where(inArray(publications.canonicalId, [...new Set(ids)]))
    .orderBy(publications.id);
}
export async function readCanonicalPublicationSnapshot(
  tx: CanonicalExecutor,
  id: string,
) {
  const [observed] = await tx
    .select({ canonicalId: publications.canonicalId })
    .from(publications)
    .where(eq(publications.id, id));
  if (!observed) return null;
  const rows = await readCanonicalPublicationGroupSnapshot(tx, [
    observed.canonicalId,
  ]);
  const publication = rows.find((row) => row.id === id);
  if (!publication)
    throw new CanonicalMembershipConflict(
      "La pubblicazione non appartiene allo snapshot canonico.",
    );
  return { canonicalId: observed.canonicalId, publication, publications: rows };
}

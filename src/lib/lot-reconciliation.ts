import { sql } from "drizzle-orm";
import { PgBoss, fromDrizzle, type DrizzleTransactionLike } from "pg-boss";

export const LOT_RECONCILIATION_QUEUE = "lot-notice-reconcile";
export type LotReconciliationJob = {
  publicationId: string;
  canonicalId: string;
  eventId: string;
};
// Source changes affect every company attached to the project. The consumer
// must reload those matches and current policy; the payload carries no verdict.
export async function enqueueLotReconciliation(
  tx: DrizzleTransactionLike,
  data: LotReconciliationJob,
) {
  const producer = new PgBoss({
    db: fromDrizzle(tx, sql),
    schema: "pgboss",
    schedule: false,
    supervise: false,
    migrate: false,
    createSchema: false,
  });
  // No group singleton: a review arriving during another job must not be lost.
  const id = await producer.send(LOT_RECONCILIATION_QUEUE, data);
  if (!id) throw new Error("Riconciliazione dei lotti non accodata.");
  return id;
}

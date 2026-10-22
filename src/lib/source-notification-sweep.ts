import { sql } from "drizzle-orm";
import { PgBoss, fromDrizzle, type DrizzleTransactionLike } from "pg-boss";
import { requestPublicationMatching } from "@/worker/matching-scheduling";
import { requestNotificationSweeps } from "@/worker/notification-scheduling";
// Persist the wake-up in the source transaction. Digest/send reconstruct
// outstanding changes from committed source history and revalidate every claim.
// No company evaluation or notification reconciliation runs inside ingestion.
export async function enqueueSourceFollowUps(
  tx: DrizzleTransactionLike,
  publicationId: string,
  notify: boolean,
) {
  const producer = new PgBoss({
    db: fromDrizzle(tx, sql),
    schema: "pgboss",
    schedule: false,
    supervise: false,
    migrate: false,
    createSchema: false,
  });
  await requestPublicationMatching(producer, { publicationId }, true);
  if (notify) await requestNotificationSweeps(producer);
}

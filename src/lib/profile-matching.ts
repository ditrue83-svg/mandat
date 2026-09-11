import { sql } from "drizzle-orm";
import { PgBoss, fromDrizzle, type DrizzleTransactionLike } from "pg-boss";

export async function enqueueProfileMatching(tx: DrizzleTransactionLike) {
  // A producer can send through the existing transaction without starting
  // pg-boss: the worker owns queue creation, migrations and background timers.
  const producer = new PgBoss({
    db: fromDrizzle(tx, sql),
    schema: "pgboss",
    schedule: false,
    supervise: false,
    migrate: false,
    createSchema: false,
  });
  const id = await producer.send("match", {}, { singletonKey: "all" });
  if (!id)
    throw new Error(
      "Non è stato possibile accodare l’aggiornamento del Radar.",
    );
  return id;
}

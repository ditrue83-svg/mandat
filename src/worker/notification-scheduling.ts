import type { PgBoss } from "pg-boss";

// All jobs reread committed state. Keep a trailing sweep when a new event
// arrives during the active one, without adding a full-company scan per item.
// Debouncing persists both the current and next time slot in PostgreSQL; a
// process restart cannot lose the trailing request. Queue policy is unchanged.
export async function requestNotificationSweeps(
  boss: Pick<PgBoss, "sendDebounced">,
) {
  await boss.sendDebounced("digest", {}, {}, 60, "all");
  await requestNotificationDelivery(boss);
}

export async function requestNotificationDelivery(
  boss: Pick<PgBoss, "sendDebounced">,
) {
  await boss.sendDebounced("send", {}, {}, 60, "all");
}

import type { PgBoss } from "pg-boss";

export const NOTIFICATION_WORK_QUEUE = "notification-work";
export type NotificationWorkJob = { kind: "digest" | "send" };

export function notificationWorkJob(value: unknown): NotificationWorkJob {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind !== "digest" && kind !== "send")
    throw new Error("Invalid notification work intent");
  return { kind };
}

// Queue one pending refresh per kind, including while that kind is active.
// Unlike a minute debounce, stately stays bounded when a scan takes minutes.
// A fixed 60-second pending slot batches source events without moving its due
// time on every signal or continually scanning all projects between matches.
// One consumer serializes the existing digest and delivery handlers; each still
// reloads policy/current source evidence and owns its original delivery claims.
async function requestNotificationWork(
  boss: Pick<PgBoss, "send" | "upsert">,
  kind: NotificationWorkJob["kind"],
  sourceBound: boolean,
) {
  const inserted = await boss.send(
    NOTIFICATION_WORK_QUEUE,
    { kind },
    { singletonKey: kind, startAfter: 60 },
  );
  // Keep an existing pending deadline, but lock that intent through the source
  // transaction. If a consumer took it between send and upsert, upsert creates
  // a trailing request instead. Neither path can acknowledge an unseen source.
  // Outside a source transaction, results are committed before this wake-up;
  // an ordinary send is sufficient. A newly inserted row is already held by its
  // transaction. Only a coalesced source-bound signal needs the extra row lock.
  if (sourceBound && !inserted)
    await boss.upsert(
      NOTIFICATION_WORK_QUEUE,
      { kind },
      { singletonKey: kind },
    );
}
export async function requestNotificationDigest(
  boss: Pick<PgBoss, "send" | "upsert">,
  sourceBound = false,
) {
  await requestNotificationWork(boss, "digest", sourceBound);
}
export async function requestNotificationSweeps(
  boss: Pick<PgBoss, "send" | "upsert">,
  sourceBound = false,
) {
  await requestNotificationDigest(boss, sourceBound);
  await requestNotificationDelivery(boss, sourceBound);
}
export async function requestNotificationDelivery(
  boss: Pick<PgBoss, "send" | "upsert">,
  sourceBound = false,
) {
  await requestNotificationWork(boss, "send", sourceBound);
}

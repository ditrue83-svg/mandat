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
// One consumer serializes the existing digest and delivery handlers; each still
// reloads policy/current source evidence and owns its original delivery claims.
export async function requestNotificationSweeps(boss: Pick<PgBoss, "send">) {
  await boss.send(
    NOTIFICATION_WORK_QUEUE,
    { kind: "digest" },
    { singletonKey: "digest" },
  );
  await requestNotificationDelivery(boss);
}

export async function requestNotificationDelivery(boss: Pick<PgBoss, "send">) {
  await boss.send(
    NOTIFICATION_WORK_QUEUE,
    { kind: "send" },
    { singletonKey: "send" },
  );
}

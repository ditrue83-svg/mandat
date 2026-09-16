import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { notifications, settings } from "@/db/schema";
import type { Viewer } from "./domain";

export const NOTIFICATION_STATUS_LABELS: Record<string, string> = {
  pending: "In preparazione",
  approved: "Pronta per l’invio",
  sending: "Invio in corso",
  sent: "Accettata dal server email",
  failed: "Invio non riuscito",
  uncertain: "Esito da verificare",
  cancelled: "Invio annullato",
};
export async function readNotificationStatus(viewer: Viewer) {
  if (viewer.demo) return { mode: "demo" as const, recent: [] };
  const db = getDb();
  const [configuration, rows] = await Promise.all([
    db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, ["automation_enabled", "pilot_started_at"])),
    db
      .select({
        id: notifications.id,
        kind: notifications.kind,
        subject: notifications.subject,
        status: notifications.status,
        createdAt: notifications.createdAt,
        sentAt: notifications.sentAt,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.companyId, viewer.companyId),
          inArray(notifications.kind, ["digest", "change", "lot-update"]),
        ),
      )
      .orderBy(desc(notifications.createdAt), notifications.id)
      .limit(10),
  ]);
  const values = new Map(configuration.map((row) => [row.key, row.value]));
  return {
    mode: !values.get("pilot_started_at")
      ? ("preparation" as const)
      : values.get("automation_enabled") === true
        ? ("automatic" as const)
        : ("manual" as const),
    recent: rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      status: NOTIFICATION_STATUS_LABELS[row.status] ?? "In lavorazione",
      date: (row.sentAt ?? row.createdAt).toISOString(),
    })),
  };
}
export type NotificationStatus = Awaited<
  ReturnType<typeof readNotificationStatus>
>;

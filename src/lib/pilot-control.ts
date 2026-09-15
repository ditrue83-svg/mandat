import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { settings } from "@/db/schema";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

export const PILOT_CONTROL_SETTING = "pilot_control";

export async function lockPilotControl(tx: Tx) {
  await tx
    .insert(settings)
    .values({
      key: PILOT_CONTROL_SETTING,
      value: { version: "pilot-control-v1" },
    })
    .onConflictDoNothing({ target: settings.key });
  const [control] = await tx
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, PILOT_CONTROL_SETTING))
    .for("update");
  if (!control) throw new Error("Pilot control lock unavailable");
}

export async function readPilotStartedAtInTransaction(tx: Tx) {
  const [row] = await tx
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "pilot_started_at"));
  if (typeof row?.value !== "string") return null;
  const date = new Date(row.value);
  return Number.isFinite(date.getTime()) ? date : null;
}

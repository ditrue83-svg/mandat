import { inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { getDb } from "@/db";
import { settings } from "@/db/schema";

// This only controls admission to the consumer. infer() still reserves every
// request atomically and includes actual costs and all uncertainty reserves.
export async function aiBudgetPaused(now = new Date()) {
  const month = DateTime.fromJSDate(now)
    .setZone("Europe/Zurich")
    .toFormat("yyyy-MM");
  if (!Number.isFinite(now.getTime()))
    throw new Error("Invalid AI budget clock");
  const budget = Number(process.env.AI_MONTHLY_BUDGET_CHF || 10);
  if (!Number.isFinite(budget) || budget < 0)
    throw new Error("Invalid monthly AI budget");
  if (budget === 0) return true;
  const rows = await getDb()
    .select()
    .from(settings)
    .where(
      inArray(settings.key, ["ai_budget_blocked", "ai_budget_blocked_limit"]),
    );
  if (rows.find((row) => row.key === "ai_budget_blocked")?.value !== month)
    return false;
  const limit = rows.find(
    (row) => row.key === "ai_budget_blocked_limit",
  )?.value;
  // Legacy blocks have no recorded cap: leave them paused until the month
  // rolls over or an operator explicitly reconciles the admission flag.
  if (!limit || typeof limit !== "object" || Array.isArray(limit)) return true;
  const previous = limit as { month?: unknown; budgetChf?: unknown };
  return !(
    previous.month === month &&
    typeof previous.budgetChf === "number" &&
    Number.isFinite(previous.budgetChf) &&
    previous.budgetChf >= 0 &&
    budget > previous.budgetChf
  );
}

// Serialize heartbeat/startup decisions. Stopping waits for active work to
// finish; pending jobs, case attempts and provider receipts are never edited.
export function budgetAwareConsumer(options: {
  paused: () => Promise<boolean>;
  start: () => Promise<unknown>;
  stop: () => Promise<unknown>;
}) {
  let running = false;
  let pending: Promise<void> = Promise.resolve();
  return () => {
    const next = pending.then(async () => {
      const paused = await options.paused();
      if (paused && running) {
        await options.stop();
        running = false;
      } else if (!paused && !running) {
        await options.start();
        running = true;
      }
    });
    pending = next.catch(() => undefined);
    return next;
  };
}

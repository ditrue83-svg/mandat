import { eq, and, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { settings, issues } from "@/db/schema";
import { DateTime } from "luxon";
import { isDemo } from "@/lib/config";
export const dynamic = "force-dynamic";
export async function GET() {
  if (isDemo()) return Response.json({ status: "demo" });
  try {
    const [heartbeat] = await getDb()
      .select()
      .from(settings)
      .where(eq(settings.key, "worker_heartbeat"));
    const ok =
      typeof heartbeat?.value === "string" &&
      Date.now() - new Date(heartbeat.value).getTime() < 15 * 60000;
    const [budget] = await getDb()
      .select()
      .from(settings)
      .where(eq(settings.key, "ai_budget_blocked"));
    const critical = await getDb()
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.severity, "critical"), isNull(issues.resolvedAt)))
      .limit(1);
    if (
      critical.length ||
      budget?.value ===
        DateTime.now().setZone("Europe/Zurich").toFormat("yyyy-MM")
    )
      return Response.json({ status: "attention_required" }, { status: 503 });
    return Response.json(
      { status: ok ? "ready" : "worker_unavailable" },
      { status: ok ? 200 : 503 },
    );
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}

import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { isDemo } from "@/lib/config";
export const dynamic = "force-dynamic";
export async function GET() {
  if (isDemo()) return Response.json({ status: "demo" });
  try {
    await getDb().execute(sql`select 1`);
    return Response.json({ status: "ok" });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}

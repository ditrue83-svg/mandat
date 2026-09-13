import { DOCUMENTARY_ADOPTION_CAPABILITY } from "@/lib/documentary-capability";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { isDemo } from "@/lib/config";
export const dynamic = "force-dynamic";
export async function GET() {
  if (isDemo()) return Response.json({ status: "demo" });
  try {
    await getDb().execute(sql`select 1`);
    return Response.json({
      status: "ok",
      documentary: {
        role: "web",
        capability: DOCUMENTARY_ADOPTION_CAPABILITY,
        buildId: process.env.MANDAT_BUILD_ID ?? "development",
      },
    });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}

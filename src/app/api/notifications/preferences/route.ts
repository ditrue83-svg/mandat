import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { companies, notifications } from "@/db/schema";
import { requireViewer } from "@/lib/viewer";
import { apiError, checkOrigin, readJson } from "@/lib/http";
export async function PUT(request: Request) {
  try {
    checkOrigin(request);
    const v = await requireViewer({ mutation: true });
    const { emailEnabled } = z
      .object({ emailEnabled: z.boolean() })
      .parse(await readJson(request));
    await getDb().transaction(async (tx) => {
      await tx
        .update(companies)
        .set({
          profile: sql`jsonb_set(${companies.profile}, '{emailEnabled}', ${JSON.stringify(emailEnabled)}::jsonb)`,
        })
        .where(eq(companies.id, v.companyId));
      if (!emailEnabled)
        await tx
          .update(notifications)
          .set({ status: "cancelled" })
          .where(
            and(
              eq(notifications.companyId, v.companyId),
              eq(notifications.status, "pending"),
            ),
          );
    });
    return Response.json({ ok: true });
  } catch (e) {
    return apiError(e);
  }
}

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  companies,
  matches,
  notifications,
  publications,
  feedback,
} from "@/db/schema";
import type { CompanyProfile } from "./domain";
import { enqueueProfileMatching } from "./profile-matching";

export async function updateCompanyProfile(
  companyId: string,
  profile: CompanyProfile,
) {
  await getDb().transaction(async (tx) => {
    await tx
      .update(companies)
      .set({ profile, onboardedAt: new Date() })
      .where(eq(companies.id, companyId));
    await tx
      .update(matches)
      .set({
        eligible: false,
        approved: null,
        reviewedAt: null,
        revision: sql`${matches.revision} || ':profile-update'`,
      })
      .where(eq(matches.companyId, companyId));
    await tx
      .update(notifications)
      .set({
        status: "cancelled",
        error: "Profilo modificato: serve una nuova valutazione",
      })
      .where(
        and(
          eq(notifications.companyId, companyId),
          eq(notifications.kind, "digest"),
          eq(notifications.status, "pending"),
        ),
      );
    await enqueueProfileMatching(tx);
  });
}
export async function saveCompanyFeedback(
  companyId: string,
  publicationId: string,
  input: { saved?: boolean; dismissed?: boolean; relevant?: boolean | null },
) {
  const db = getDb();
  const [owned] = await db
    .select({ p: publications })
    .from(matches)
    .innerJoin(publications, eq(publications.id, matches.publicationId))
    .where(
      and(
        eq(matches.companyId, companyId),
        eq(matches.publicationId, publicationId),
      ),
    );
  if (!owned) throw new Error("Opportunità non associata alla ditta");
  const related = await db
    .select({ id: publications.id })
    .from(publications)
    .where(eq(publications.canonicalId, owned.p.canonicalId));
  await db.transaction(async (tx) => {
    for (const row of related) {
      const values =
        row.id === publicationId
          ? input
          : { saved: input.saved, dismissed: input.dismissed };
      if (Object.values(values).every((value) => value === undefined)) continue;
      await tx
        .insert(feedback)
        .values({
          id: crypto.randomUUID(),
          companyId,
          publicationId: row.id,
          ...values,
        })
        .onConflictDoUpdate({
          target: [feedback.companyId, feedback.publicationId],
          set: { ...values, updatedAt: new Date() },
        });
    }
  });
}

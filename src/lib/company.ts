import { and, or, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  companies,
  matches,
  notifications,
  publications,
  feedback,
  settings,
} from "@/db/schema";
import type { CompanyProfile } from "./domain";
import { enqueueProfileMatching } from "./profile-matching";
import {
  CanonicalMembershipConflict,
  lockCanonicalPublicationGroups,
  lockCanonicalPublications,
} from "./canonical-lock";
import {
  readCanonicalFeedbackState,
  type CanonicalFeedbackState,
} from "./canonical-feedback";
import { HttpError } from "./viewer";

async function companyGroups(
  tx: Pick<ReturnType<typeof getDb>, "select">,
  companyId: string,
) {
  const rows = await tx
    .select({ canonicalId: publications.canonicalId })
    .from(matches)
    .innerJoin(publications, eq(publications.id, matches.publicationId))
    .where(eq(matches.companyId, companyId));
  return [...new Set(rows.map((row) => row.canonicalId))].sort();
}
export async function updateCompanyProfile(
  companyId: string,
  profile: CompanyProfile,
) {
  const detachedProfile = structuredClone(profile);
  // A match can join a new group between inventory and the company lock. Retry
  // the whole transaction, never acquire that new group in the reverse order.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await getDb().transaction(async (tx) => {
        const groups = await companyGroups(tx, companyId);
        await lockCanonicalPublicationGroups(tx, groups);
        const [company] = await tx
          .select()
          .from(companies)
          .where(eq(companies.id, companyId))
          .for("update");
        if (!company || company.disabledAt)
          throw new HttpError(404, "Ditta non disponibile.");
        const currentGroups = await companyGroups(tx, companyId);
        if (currentGroups.some((group) => !groups.includes(group)))
          throw new CanonicalMembershipConflict(
            "La ditta ha nuove pubblicazioni da bloccare.",
          );
        await tx
          .update(companies)
          .set({ profile: detachedProfile, onboardedAt: new Date() })
          .where(eq(companies.id, companyId));
        // Adopted rows retain every human/legacy field, including the original
        // timestamps and revision. Freshness is resolved against the new profile.
        await tx
          .update(matches)
          .set({
            eligible: false,
            approved: null,
            reviewedAt: null,
            revision: sql`${matches.revision} || ':profile-update'`,
          })
          .where(
            and(
              eq(matches.companyId, companyId),
              isNull(matches.lotEvaluations),
              isNull(matches.lotSuppression),
              // A legacy veto on another copy is still the project's veto.
              // Preserve the entire group's history once any copy is adopted.
              sql`NOT EXISTS (SELECT 1 FROM ${publications} AS member
                INNER JOIN ${publications} AS adopted ON adopted.canonical_id = member.canonical_id
                WHERE member.id = ${matches.publicationId} AND adopted.documentary_snapshot_id IS NOT NULL)`,
            ),
          );
        await tx
          .update(notifications)
          .set({
            status: "cancelled",
            error: "Profilo modificato: serve una nuova valutazione",
          })
          .where(
            and(
              eq(notifications.companyId, companyId),
              or(
                inArray(notifications.kind, ["digest", "lot-update"]),
                and(
                  eq(notifications.kind, "change"),
                  sql`EXISTS (
                  SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${notifications.items}) = 'array' THEN ${notifications.items} ELSE '[]'::jsonb END) AS item
                  WHERE item ? 'lotNotice'
                )`,
                ),
              ),
              eq(notifications.status, "pending"),
            ),
          );
        await enqueueProfileMatching(tx);
      });
      return;
    } catch (error) {
      if (!(error instanceof CanonicalMembershipConflict)) throw error;
      if (attempt === 2)
        throw new HttpError(
          409,
          "Le pubblicazioni della ditta sono cambiate. Ripeti il salvataggio del profilo.",
        );
    }
  }
}
const feedbackInputSchema = z
  .object({
    saved: z.boolean().optional(),
    dismissed: z.boolean().optional(),
    relevant: z.boolean().nullable().optional(),
  })
  .strict();
export async function saveCompanyFeedback(
  companyId: string,
  publicationId: string,
  input: { saved?: boolean; dismissed?: boolean; relevant?: boolean | null },
) {
  const draft = feedbackInputSchema.parse(structuredClone(input));
  await getDb().transaction(async (tx) => {
    const group = await lockCanonicalPublications(tx, publicationId);
    if (!group) throw new Error("Opportunità non associata alla ditta");
    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .for("share");
    if (!company || company.disabledAt)
      throw new HttpError(404, "Ditta non disponibile.");
    const ids = group.publications.map((row) => row.id);
    const owned = await tx
      .select({ publicationId: matches.publicationId })
      .from(matches)
      .where(
        and(
          eq(matches.companyId, companyId),
          inArray(matches.publicationId, ids),
        ),
      )
      .orderBy(matches.id)
      .for("update");
    if (!owned.some((row) => row.publicationId === publicationId))
      throw new Error("Opportunità non associata alla ditta");
    await tx
      .select()
      .from(feedback)
      .where(
        and(
          eq(feedback.companyId, companyId),
          inArray(feedback.publicationId, ids),
        ),
      )
      .orderBy(feedback.id)
      .for("update");
    const canonical = await readCanonicalFeedbackState(
      tx,
      companyId,
      group.canonicalId,
    );
    if (draft.saved !== undefined || draft.dismissed !== undefined) {
      const state: CanonicalFeedbackState = {
        version: "canonical-company-feedback-v1",
        companyId,
        canonicalId: group.canonicalId,
        saved: draft.saved ?? canonical.saved,
        dismissed: draft.dismissed ?? canonical.dismissed,
        updatedAt: new Date().toISOString(),
      };
      await tx
        .insert(settings)
        .values({ key: canonical.key, value: state })
        .onConflictDoUpdate({ target: settings.key, set: { value: state } });
    }
    for (const publication of group.publications) {
      const values =
        publication.id === publicationId
          ? draft
          : { saved: draft.saved, dismissed: draft.dismissed };
      if (Object.values(values).every((value) => value === undefined)) continue;
      await tx
        .insert(feedback)
        .values({
          id: crypto.randomUUID(),
          companyId,
          publicationId: publication.id,
          ...values,
        })
        .onConflictDoUpdate({
          target: [feedback.companyId, feedback.publicationId],
          set: { ...values, updatedAt: new Date() },
        });
    }
  });
}

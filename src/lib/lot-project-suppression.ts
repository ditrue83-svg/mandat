import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { matches, publications, settings } from "@/db/schema";
import type { SourceReviewExecutor } from "./source-reviews";
import type { ProjectLotSuppression } from "./lot-assessment";
import { stableDocumentaryJson } from "./documentary-observation";

export type CanonicalLotSuppression = {
  version: "canonical-lot-suppression-v1";
  companyId: string;
  canonicalId: string;
  eventId: string;
  suppression: ProjectLotSuppression;
};
const suppressionSchema = z
  .object({
    active: z.boolean(),
    reason: z.string().min(1).max(4000),
    rejection: z
      .object({
        bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
        eventId: z.string().min(1),
        at: z.string().datetime(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal("canonical-lot-suppression-v1"),
    companyId: z.string().min(1),
    canonicalId: z.string().min(1),
    eventId: z.string().min(1),
    suppression: suppressionSchema,
  })
  .strict();
export function lotProjectSuppressionKey(
  companyId: string,
  canonicalId: string,
) {
  return `lot-project-suppression:${JSON.stringify([companyId, canonicalId])}`;
}
export function legacyLotReviewState(match: typeof matches.$inferSelect) {
  return {
    approved: match.approved,
    reviewedAt: match.reviewedAt?.toISOString() ?? null,
    reviewNotes: match.reviewNotes,
    revision: match.revision,
    score: match.score,
    reason: match.reason,
    eligible: match.eligible,
    sourceReviewDependency: match.sourceReviewDependency,
  };
}

// The canonical setting is private, scoped by the authenticated company's ID.
// Missing state conservatively preserves any legacy veto in the group. A saved
// explicit reopening covers later copies as well; it never approves their lots.
export async function readLotProjectSuppression(
  tx: SourceReviewExecutor,
  companyId: string,
  canonicalId: string,
) {
  const members = await tx
    .select({ id: publications.id })
    .from(publications)
    .where(eq(publications.canonicalId, canonicalId))
    .orderBy(publications.id);
  const group = await tx
    .select({
      match: matches,
      reviewedSql: sql<string | null>`${matches.reviewedAt}::text`,
      updatedSql: sql<string>`${matches.updatedAt}::text`,
    })
    .from(matches)
    .innerJoin(publications, eq(publications.id, matches.publicationId))
    .where(
      and(
        eq(matches.companyId, companyId),
        eq(publications.canonicalId, canonicalId),
      ),
    )
    .orderBy(matches.id);
  const key = lotProjectSuppressionKey(companyId, canonicalId);
  const [row] = await tx.select().from(settings).where(eq(settings.key, key));
  const state = row ? stateSchema.parse(row.value) : null;
  if (
    state &&
    (state.companyId !== companyId || state.canonicalId !== canonicalId)
  )
    throw new Error("Soppressione canonicale di un’altra ditta o gruppo.");
  const legacy = group.map(({ match, reviewedSql, updatedSql }) => ({
    matchId: match.id,
    publicationId: match.publicationId,
    legacy: legacyLotReviewState(match),
    reviewedSql,
    updatedSql,
    localSuppression: match.lotSuppression,
  }));
  const before = { members: members.map((member) => member.id), legacy, state };
  const token = createHash("sha256")
    .update(stableDocumentaryJson(before))
    .digest("hex");
  const fallback = group.some(
    ({ match }) => match.lotSuppression?.active || match.approved === false,
  );
  return {
    key,
    state,
    before,
    token,
    suppression:
      state?.suppression ??
      (fallback
        ? {
            active: true,
            reason:
              "Il fondatore aveva escluso il progetto. Serve una riconsiderazione esplicita.",
            rejection: null,
          }
        : null),
  };
}
export type LotProjectSuppressionView = Awaited<
  ReturnType<typeof readLotProjectSuppression>
>;

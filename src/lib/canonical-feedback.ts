import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { feedback, publications, settings } from "@/db/schema";
import type { SourceReviewExecutor } from "./source-reviews";

const stateSchema = z
  .object({
    version: z.literal("canonical-company-feedback-v1"),
    companyId: z.string().min(1),
    canonicalId: z.string().min(1),
    saved: z.boolean(),
    dismissed: z.boolean(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type CanonicalFeedbackState = z.infer<typeof stateSchema>;
export function canonicalFeedbackKey(companyId: string, canonicalId: string) {
  return `canonical-company-feedback:${JSON.stringify([companyId, canonicalId])}`;
}

// Mutation/claim callers hold the canonical group lock before company and
// feedback locks. Absence is conservative; an explicit later false overrides
// old per-publication flags, including those on a newly discovered copy.
export async function readCanonicalFeedbackState(
  tx: SourceReviewExecutor,
  companyId: string,
  canonicalId: string,
) {
  const key = canonicalFeedbackKey(companyId, canonicalId);
  const [row] = await tx.select().from(settings).where(eq(settings.key, key));
  if (row) {
    const state = stateSchema.parse(row.value);
    if (state.companyId !== companyId || state.canonicalId !== canonicalId)
      throw new Error("Feedback canonico di un'altra ditta o progetto.");
    return { key, state, saved: state.saved, dismissed: state.dismissed };
  }
  const rows = await tx
    .select({ saved: feedback.saved, dismissed: feedback.dismissed })
    .from(feedback)
    .innerJoin(publications, eq(publications.id, feedback.publicationId))
    .where(
      and(
        eq(feedback.companyId, companyId),
        eq(publications.canonicalId, canonicalId),
      ),
    );
  return {
    key,
    state: null,
    saved: rows.some((row) => row.saved),
    dismissed: rows.some((row) => row.dismissed),
  };
}
export async function readCanonicalFeedback(
  tx: SourceReviewExecutor,
  companyId: string,
  canonicalId: string,
): Promise<{ saved: boolean; dismissed: boolean }> {
  const { saved, dismissed } = await readCanonicalFeedbackState(
    tx,
    companyId,
    canonicalId,
  );
  return { saved, dismissed };
}

export async function readCanonicalFeedbackBatch(
  executor: SourceReviewExecutor,
  companyId: string,
  canonicalIds: readonly string[],
): Promise<Map<string, { saved: boolean; dismissed: boolean }>> {
  const ids = [...new Set(canonicalIds)];
  const result = new Map(
    ids.map((canonicalId) => [canonicalId, { saved: false, dismissed: false }]),
  );
  if (!ids.length) return result;

  const keys = ids.map((canonicalId) =>
    canonicalFeedbackKey(companyId, canonicalId),
  );
  const canonicalIdByKey = new Map(
    ids.map((canonicalId) => [
      canonicalFeedbackKey(companyId, canonicalId),
      canonicalId,
    ]),
  );
  const stored = await executor
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, keys));
  const resolved = new Set<string>();
  for (const row of stored) {
    const canonicalId = canonicalIdByKey.get(row.key);
    if (!canonicalId) continue;
    const state = stateSchema.parse(row.value);
    if (state.companyId !== companyId || state.canonicalId !== canonicalId)
      throw new Error("Feedback canonico di un'altra ditta o progetto.");
    result.set(canonicalId, {
      saved: state.saved,
      dismissed: state.dismissed,
    });
    resolved.add(canonicalId);
  }

  const unresolved = ids.filter((canonicalId) => !resolved.has(canonicalId));
  if (!unresolved.length) return result;
  const legacy = await executor
    .select({
      canonicalId: publications.canonicalId,
      saved: feedback.saved,
      dismissed: feedback.dismissed,
    })
    .from(feedback)
    .innerJoin(publications, eq(publications.id, feedback.publicationId))
    .where(
      and(
        eq(feedback.companyId, companyId),
        inArray(publications.canonicalId, unresolved),
      ),
    );
  for (const row of legacy) {
    const current = result.get(row.canonicalId)!;
    result.set(row.canonicalId, {
      saved: current.saved || row.saved,
      dismissed: current.dismissed || row.dismissed,
    });
  }
  return result;
}

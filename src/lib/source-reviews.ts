import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { administrators, publications, sourceReviewEvents } from "@/db/schema";
import type { Publication, Viewer } from "./domain";
import { HttpError } from "./viewer";
import {
  captureSourceSnapshot,
  CONTEXT_VERSION,
  createSourceReviewRecord,
  resolveSourceContext,
  ReviewConflict,
  type ReviewRecord,
  type SourceContext,
} from "./source-review-context";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceReviewInputSchema = z
  .object({
    publicationId: z.string().min(1).max(200),
    expectedEventId: z.string().min(1).max(200).nullable(),
    expectedSourceSnapshotHash: sha256,
    expectedCorpusHash: sha256.nullable(),
    action: z.enum(["opened", "recorded"]),
    form: z
      .enum(["defined_service", "broad_scope", "unclear", "conflicting"])
      .nullable(),
    references: z
      .array(
        z
          .object({
            unitId: z.string().min(1).max(200),
            originIndex: z.number().int().nonnegative(),
            startUtf16: z.number().int().nonnegative(),
            endUtf16: z.number().int().positive(),
          })
          .strict(),
      )
      .max(128),
    note: z.string().trim().min(10).max(800),
  })
  .strict();
export type SourceReviewInput = z.infer<typeof sourceReviewInputSchema>;
export type SourceReviewViewer = Pick<Viewer, "userId" | "admin" | "demo">;
export type SourceReviewExecutor = Pick<ReturnType<typeof getDb>, "select">;
type PublicationRow = Pick<
  typeof publications.$inferSelect,
  "id" | "title" | "revision" | "data"
>;
type SourceRow = Publication | { id: string; data: Publication };

// A legacy reader must never quietly filter out targeted events and recover an
// older positive review. Documentary consumers select their own branch first.
export function legacySourceReviewRecord(
  row: Pick<typeof sourceReviewEvents.$inferSelect, "event" | "snapshot">,
): ReviewRecord {
  if (
    row.event.version !== CONTEXT_VERSION ||
    row.snapshot.version !== CONTEXT_VERSION
  )
    throw new HttpError(
      409,
      "Questa fonte richiede la revisione dei lotti. Aggiorna la pagina.",
    );
  return { event: row.event, snapshot: row.snapshot };
}

// Internal server reader: callers that consume this result during a write or
// claim must already hold the publication lock in this SAME executor/transaction.
// Never serialize its history, actor or notes into a company-facing response.
export async function readSourceReviewContexts(
  executor: SourceReviewExecutor,
  rows: readonly SourceRow[],
): Promise<Map<string, SourceContext | null>> {
  const result = new Map<string, SourceContext | null>();
  if (!rows.length) return result;
  // Some callers carry only Publication.data, which has no adoption pointer.
  // Read it from the authoritative row before even considering legacy history.
  const current = await executor
    .select({ documentarySnapshotId: publications.documentarySnapshotId })
    .from(publications)
    .where(
      inArray(
        publications.id,
        rows.map((row) => row.id),
      ),
    );
  if (current.some((row) => row.documentarySnapshotId))
    throw new HttpError(
      409,
      "Questa fonte richiede la revisione dei lotti. Aggiorna la pagina.",
    );
  const stored = await executor
    .select()
    .from(sourceReviewEvents)
    .where(
      inArray(
        sourceReviewEvents.publicationId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(sourceReviewEvents.publicationId, sourceReviewEvents.sequence);
  const histories = new Map<string, ReviewRecord[]>();
  for (const record of stored) {
    const history = histories.get(record.publicationId) ?? [];
    history.push(legacySourceReviewRecord(record));
    histories.set(record.publicationId, history);
  }
  for (const row of rows) {
    const history = histories.get(row.id);
    result.set(
      row.id,
      history?.length
        ? resolveSourceContext(
            captureSourceSnapshot(row.id, "data" in row ? row.data : row),
            history,
          )
        : null,
    );
  }
  return result;
}
export async function readSourceReviewContext(
  executor: SourceReviewExecutor,
  row: SourceRow,
): Promise<SourceContext | null> {
  return (await readSourceReviewContexts(executor, [row])).get(row.id) ?? null;
}
function assertViewer(viewer: SourceReviewViewer) {
  if (!viewer || viewer.demo || !viewer.admin || !viewer.userId)
    throw new HttpError(403, "Accesso riservato al fondatore autenticato.");
}
async function assertAdministrator(
  executor: SourceReviewExecutor,
  viewer: SourceReviewViewer,
) {
  const [admin] = await executor
    .select({ id: administrators.userId })
    .from(administrators)
    .where(eq(administrators.userId, viewer.userId))
    .for("share");
  if (!admin)
    throw new HttpError(403, "Accesso riservato al fondatore autenticato.");
}
async function loadReview(
  executor: SourceReviewExecutor,
  publication: PublicationRow,
) {
  const stored = await executor
    .select()
    .from(sourceReviewEvents)
    .where(eq(sourceReviewEvents.publicationId, publication.id))
    .orderBy(sourceReviewEvents.sequence);
  const history: readonly ReviewRecord[] = stored.map(legacySourceReviewRecord);
  const snapshot = captureSourceSnapshot(publication.id, publication.data);
  const context = resolveSourceContext(snapshot, history);
  return {
    publication: {
      id: publication.id,
      title: publication.title,
      sourceUrl: publication.data.sourceUrl,
      sourceRevision: publication.revision,
      contentRevision: publication.data.revision,
      sourceScopeReview: publication.data.sourceScopeReview,
    },
    snapshot,
    history,
    context,
    expected: {
      eventId: history.at(-1)?.event.id ?? null,
      sourceSnapshotHash: snapshot.sourceSnapshotHash,
      corpusHash: snapshot.source.accepted
        ? snapshot.source.corpus.inputHash
        : null,
    },
  };
}
export type LoadedSourceReview = Awaited<ReturnType<typeof loadReview>>;

// viewer must come from the caller's authenticated server session, never JSON.
export async function loadSourceReviewContext(
  publicationId: string,
  viewer: SourceReviewViewer,
): Promise<LoadedSourceReview> {
  assertViewer(viewer);
  return getDb().transaction(async (tx) => {
    await assertAdministrator(tx, viewer);
    const [publication] = await tx
      .select()
      .from(publications)
      .where(eq(publications.id, publicationId))
      .for("share");
    if (!publication) throw new HttpError(404, "Bando non trovato.");
    if (publication.documentarySnapshotId)
      throw new HttpError(
        409,
        "Questa fonte richiede la revisione dei lotti. Aggiorna la pagina.",
      );
    return loadReview(tx, publication);
  });
}
export async function appendSourceReview(
  input: unknown,
  viewer: SourceReviewViewer,
): Promise<LoadedSourceReview> {
  assertViewer(viewer);
  const draft = sourceReviewInputSchema.parse(input);
  return getDb().transaction(async (tx) => {
    await assertAdministrator(tx, viewer);
    // Serialize even the first event, when there is no history row to lock.
    // All consumers use publication SHARE before reading this separate history.
    const [publication] = await tx
      .select()
      .from(publications)
      .where(eq(publications.id, draft.publicationId))
      .for("update");
    if (!publication) throw new HttpError(404, "Bando non trovato.");
    if (publication.documentarySnapshotId)
      throw new HttpError(
        409,
        "Questa fonte richiede la revisione dei lotti. Aggiorna la pagina.",
      );
    const loaded = await loadReview(tx, publication);
    let record: ReviewRecord;
    try {
      record = createSourceReviewRecord(
        { ...draft, actorId: viewer.userId },
        loaded.snapshot,
        loaded.history,
        {
          id: randomUUID(),
          sourceRevision: publication.revision,
          contentRevision: publication.data.revision,
          createdAt: new Date().toISOString(),
        },
      );
    } catch (error) {
      if (error instanceof ReviewConflict)
        throw new HttpError(
          409,
          "La fonte o la revisione sono cambiate. Aggiorna la pagina.",
        );
      throw new HttpError(
        400,
        "Stato o riferimenti della revisione non validi per la fonte completa.",
      );
    }
    await tx.insert(sourceReviewEvents).values({
      id: record.event.id,
      publicationId: publication.id,
      sequence: record.event.sequence,
      event: record.event,
      snapshot: record.snapshot,
    });
    return loadReview(tx, publication);
  });
}

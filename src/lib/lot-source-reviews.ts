import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  administrators,
  issues,
  publicationDocumentarySnapshots,
  publications,
  sourceReviewEvents,
} from "@/db/schema";
import { lockCanonicalPublications } from "./canonical-lock";
import { decodeDocumentarySnapshotRow } from "./documentary-store";
import { stableDocumentaryJson } from "./documentary-observation";
import { enqueueLotReconciliation } from "./lot-reconciliation";
import {
  captureLotSourceSnapshot,
  createLotSourceReviewRecord,
  resolveLotSourceContext,
  verifyLotSourceHistory,
  type LotSourceTarget,
  type MixedSourceReviewRecord,
} from "./lot-source-context";
import { ReviewConflict } from "./source-review-context";
import type {
  SourceReviewExecutor,
  SourceReviewViewer,
} from "./source-reviews";
import { HttpError } from "./viewer";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const publicationId = z.string().min(1).max(200);
export const lotSourceTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), publicationId }).strict(),
  z
    .object({
      kind: z.literal("lot"),
      publicationId,
      sourceProjectId: z.uuid(),
      lotId: z.uuid(),
    })
    .strict(),
]);
export const lotSourceReviewInputSchema = z
  .object({
    target: lotSourceTargetSchema,
    expectedObservationId: z.uuid(),
    expectedSnapshotHash: hash,
    expectedSelectionHash: hash.nullable(),
    expectedTargetEventId: z.string().min(1).max(200).nullable(),
    expectedProjectBarrierHash: hash,
    action: z.enum(["opened", "recorded"]),
    form: z
      .enum(["defined_service", "broad_scope", "unclear", "conflicting"])
      .nullable(),
    references: z
      .array(
        z
          .object({
            selectionHash: hash,
            rawPath: z.string().min(1).max(4096),
            startUtf16: z.number().int().nonnegative(),
            endUtf16: z.number().int().positive(),
          })
          .strict(),
      )
      .max(128),
    note: z.string().trim().min(10).max(800),
    resolveLegacyScope: z.boolean().default(false),
  })
  .strict();
export type LotSourceReviewInput = z.infer<typeof lotSourceReviewInputSchema>;
export type LotPublicationRow = Pick<
  typeof publications.$inferSelect,
  "id" | "canonicalId" | "title" | "revision" | "data" | "documentarySnapshotId"
>;

function assertViewer(viewer: SourceReviewViewer) {
  if (!viewer || viewer.demo || !viewer.admin || !viewer.userId)
    throw new HttpError(403, "Accesso riservato al fondatore autenticato.");
}
async function assertAdministrator(
  tx: SourceReviewExecutor,
  viewer: SourceReviewViewer,
) {
  const [admin] = await tx
    .select()
    .from(administrators)
    .where(eq(administrators.userId, viewer.userId))
    .for("share");
  if (!admin)
    throw new HttpError(403, "Accesso riservato al fondatore autenticato.");
}

// Internal reader: mutation/claim callers hold the publication lock in this
// transaction. An unadopted shadow observation never selects this branch.
export async function readLotSourceState(
  tx: SourceReviewExecutor,
  publication: LotPublicationRow,
) {
  if (!publication.documentarySnapshotId) return null;
  const [row] = await tx
    .select()
    .from(publicationDocumentarySnapshots)
    .where(
      eq(publicationDocumentarySnapshots.id, publication.documentarySnapshotId),
    );
  if (!row) throw new Error("Archivio documentario adottato non disponibile.");
  const observation = decodeDocumentarySnapshotRow(row, publication.id);
  const acquisition = observation.acquisition;
  const snapshot = captureLotSourceSnapshot({
    publicationId: publication.id,
    observationId: observation.id,
    acquisition:
      acquisition.state === "accepted"
        ? { state: "accepted", archive: acquisition.archive }
        : {
            state: "refused",
            identity: acquisition.identity,
            reason: `${acquisition.refusal.stage}:${acquisition.refusal.code}`,
            receiptHash: createHash("sha256")
              .update(stableDocumentaryJson(acquisition.receipt))
              .digest("hex"),
          },
    sourceScopeReview: publication.data.sourceScopeReview ?? null,
  });
  const stored = await tx
    .select()
    .from(sourceReviewEvents)
    .where(eq(sourceReviewEvents.publicationId, publication.id))
    .orderBy(sourceReviewEvents.sequence);
  const history = verifyLotSourceHistory(
    publication.id,
    stored.map((record) => {
      if (
        record.event.id !== record.id ||
        record.event.sequence !== record.sequence ||
        record.event.publicationId !== record.publicationId
      )
        throw new Error("Identità dello storico fonte discordante.");
      return {
        event: record.event,
        snapshot: record.snapshot,
      } as MixedSourceReviewRecord;
    }),
  );
  return { snapshot, history };
}
async function loadReview(
  tx: SourceReviewExecutor,
  publication: LotPublicationRow,
  target: LotSourceTarget,
) {
  const state = await readLotSourceState(tx, publication);
  if (!state)
    throw new HttpError(409, "La fonte non usa ancora la revisione dei lotti.");
  const context = resolveLotSourceContext(
    state.snapshot,
    target,
    state.history,
  );
  return {
    publication: {
      id: publication.id,
      title: publication.title,
      sourceUrl: publication.data.sourceUrl,
      sourceRevision: publication.revision,
      contentRevision: publication.data.revision,
      sourceScopeReview: publication.data.sourceScopeReview ?? null,
    },
    ...state,
    context,
    expected: {
      observationId: state.snapshot.observationId,
      snapshotHash: state.snapshot.snapshotHash,
      selectionHash: context.dependency.selectionHash,
      targetEventId: context.dependency.reviewEventId,
      projectBarrierHash: context.projectBarrier.barrierHash,
    },
  };
}
export type LoadedLotSourceReview = Awaited<ReturnType<typeof loadReview>>;

// viewer must be created from the authenticated server session, never JSON.
export async function loadLotSourceReview(
  targetInput: unknown,
  viewer: SourceReviewViewer,
) {
  assertViewer(viewer);
  const target = lotSourceTargetSchema.parse(targetInput);
  return getDb().transaction(async (tx) => {
    const [publication] = await tx
      .select()
      .from(publications)
      .where(eq(publications.id, target.publicationId))
      .for("share");
    await assertAdministrator(tx, viewer);
    if (!publication) throw new HttpError(404, "Bando non trovato.");
    return loadReview(tx, publication, target);
  });
}

export async function appendLotSourceReview(
  input: unknown,
  viewer: SourceReviewViewer,
) {
  assertViewer(viewer);
  const draft = lotSourceReviewInputSchema.parse(input);
  return getDb().transaction(async (tx) => {
    const locked = await lockCanonicalPublications(
      tx,
      draft.target.publicationId,
    );
    await assertAdministrator(tx, viewer);
    if (!locked) throw new HttpError(404, "Bando non trovato.");
    let publication = locked.publication;
    const loaded = await loadReview(tx, publication, draft.target);
    if (draft.expectedObservationId !== loaded.snapshot.observationId)
      throw new HttpError(
        409,
        "L’archivio della fonte è cambiato. Aggiorna la pagina.",
      );
    const {
      expectedObservationId: _id,
      resolveLegacyScope,
      ...command
    } = draft;
    const metadata = {
      id: randomUUID(),
      sourceRevision: publication.revision,
      contentRevision: publication.data.revision,
      createdAt: new Date().toISOString(),
    };
    let record;
    try {
      // Validate the caller's actual pre-change CAS and evidence first, even
      // when the explicit project action also resolves the old source flag.
      record = createLotSourceReviewRecord(
        { ...command, actorId: viewer.userId },
        loaded.snapshot,
        loaded.history,
        metadata,
      );
      if (resolveLegacyScope) {
        const previous = publication.data.sourceScopeReview;
        if (
          draft.target.kind !== "project" ||
          draft.action !== "recorded" ||
          !["defined_service", "broad_scope"].includes(draft.form ?? "") ||
          previous?.status !== "required"
        )
          throw new HttpError(
            400,
            "La risoluzione esplicita riguarda la verifica aperta del progetto.",
          );
        const state = {
          ...previous,
          status: "resolved" as const,
          token: randomUUID(),
          sourceRevision: publication.revision,
          updatedAt: metadata.createdAt,
        };
        publication = {
          ...publication,
          data: { ...publication.data, sourceScopeReview: state },
        };
        const snapshot = captureLotSourceSnapshot({
          publicationId: publication.id,
          observationId: loaded.snapshot.observationId,
          acquisition: loaded.snapshot.acquisition,
          sourceScopeReview: state,
        });
        const context = resolveLotSourceContext(
          snapshot,
          draft.target,
          loaded.history,
        );
        record = createLotSourceReviewRecord(
          {
            ...command,
            actorId: viewer.userId,
            expectedSnapshotHash: snapshot.snapshotHash,
            expectedProjectBarrierHash: context.projectBarrier.barrierHash,
          },
          snapshot,
          loaded.history,
          metadata,
        );
        await tx
          .update(publications)
          .set({
            data: publication.data,
            updatedAt: new Date(metadata.createdAt),
          })
          .where(eq(publications.id, publication.id));
        await tx
          .insert(issues)
          .values({
            id: randomUUID(),
            key: `source-scope-audit:${state.token}`,
            publicationId: publication.id,
            severity: "info",
            title: "Verifica dell’oggetto risolta",
            detail: JSON.stringify({
              action: "resolve-source-scope",
              actorId: viewer.userId,
              note: draft.note,
              previousScopeToken: previous.token,
              sourceReviewEventId: record.event.id,
              ...state,
            }),
            createdAt: new Date(metadata.createdAt),
            resolvedAt: new Date(metadata.createdAt),
          });
      }
    } catch (error) {
      if (error instanceof ReviewConflict)
        throw new HttpError(
          409,
          "La fonte o la revisione sono cambiate. Aggiorna la pagina.",
        );
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        400,
        "Stato o riferimenti non validi per la fonte e il lotto selezionati.",
      );
    }
    await tx
      .insert(sourceReviewEvents)
      .values({
        id: record.event.id,
        publicationId: publication.id,
        sequence: record.event.sequence,
        event: record.event,
        snapshot: record.snapshot,
      });
    await enqueueLotReconciliation(tx, {
      publicationId: publication.id,
      canonicalId: locked.canonicalId,
      eventId: record.event.id,
    });
    return loadReview(tx, publication, draft.target);
  });
}

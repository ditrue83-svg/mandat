import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import {
  publicationDocumentarySnapshots,
  publications,
  publicationVersions,
  issues,
} from "@/db/schema";
import type { SimapAcquisitionResult } from "@/sources/simap-documentary";
import { legacySimapRevision } from "@/sources/simap";
import { lockCanonicalPublications } from "./canonical-lock";
import {
  stableDocumentaryJson,
  validateDocumentaryObservation,
  type DocumentaryRequest,
} from "./documentary-observation";
import { decodeDocumentarySnapshotRow } from "./documentary-store";
import { enqueueLotReconciliation } from "./lot-reconciliation";
import { copyNormalizedDocumentaryPublication } from "./documentary-normalized";
import type { Publication } from "./domain";
import { sourceScopeReviewReason } from "./source-scope-review";
import { sourceEdition } from "./source-edition";

import {
  DOCUMENTARY_ADOPTION_CAPABILITY,
  DOCUMENTARY_RELEASE_ATTESTATION_VERSION,
  DOCUMENTARY_ADOPTION_CONSUMERS,
} from "./documentary-capability";
export {
  DOCUMENTARY_ADOPTION_CAPABILITY,
  DOCUMENTARY_RELEASE_ATTESTATION_VERSION,
  DOCUMENTARY_ADOPTION_CONSUMERS,
} from "./documentary-capability";

// Supplied only by the controlled server rollout, never an HTTP client. This
// describes evidence already checked by the operator: parsing it does not prove
// that old processes were drained, authenticate its author, or inspect a build.
// Once adopted, rollback must retain compatible readers or maintenance mode.
export type DocumentaryReleaseAttestation = {
  version: typeof DOCUMENTARY_RELEASE_ATTESTATION_VERSION;
  releaseId: string;
  verifiedAt: string;
  evidenceId: string;
  previousProcessesDrained: true;
  consumers: Record<
    (typeof DOCUMENTARY_ADOPTION_CONSUMERS)[number],
    { capability: typeof DOCUMENTARY_ADOPTION_CAPABILITY; buildId: string }
  >;
};
export type DocumentaryAdoptionActivation = {
  enabled: boolean;
  attestation?: DocumentaryReleaseAttestation;
};
export type DocumentaryEnabledActivation = {
  enabled: true;
  attestation: DocumentaryReleaseAttestation;
};
const consumerSchema = z
  .object({
    capability: z.literal(DOCUMENTARY_ADOPTION_CAPABILITY),
    buildId: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .strict();
const activationSchema = z
  .object({
    enabled: z.literal(true),
    attestation: z
      .object({
        version: z.literal(DOCUMENTARY_RELEASE_ATTESTATION_VERSION),
        releaseId: z.string().trim().min(1).max(200),
        verifiedAt: z.iso.datetime(),
        evidenceId: z.string().trim().min(1).max(512),
        previousProcessesDrained: z.literal(true),
        consumers: z
          .object(
            Object.fromEntries(
              DOCUMENTARY_ADOPTION_CONSUMERS.map((name) => [
                name,
                consumerSchema,
              ]),
            ),
          )
          .strict(),
      })
      .strict(),
  })
  .strict();

export class DocumentaryAdoptionDisabled extends Error {}
export class DocumentaryAdoptionConflict extends Error {}

// Also used by the orchestrator before HTTP. Zod copies the complete strict
// shape; freeze the returned copy so later caller mutations cannot enable or
// alter a run. The attestation remains an operator assertion, not drain proof.
export function assertDocumentaryAdoptionActivation(
  input: unknown,
): DocumentaryEnabledActivation {
  const parsed = activationSchema.safeParse(input);
  if (!parsed.success)
    throw new DocumentaryAdoptionDisabled(
      "Adozione disabilitata: manca l’attestazione dei consumer compatibili.",
    );
  function freeze(value: unknown) {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  }
  freeze(parsed.data);
  return parsed.data as DocumentaryEnabledActivation;
}

// Internal repository only: no runtime caller enables it in this module. The
// acquisition and complete normalized result are detached before the first
// async boundary. All source data, history, pointer and job commit together.
export async function adoptDocumentaryObservation(
  request: DocumentaryRequest,
  result: SimapAcquisitionResult,
  activation: DocumentaryAdoptionActivation = { enabled: false },
) {
  assertDocumentaryAdoptionActivation(activation);
  // Only the normalizer's original object carries this WeakMap proof. Capture
  // it before validation detaches the publication or any await can intervene.
  const originalPublication = result.publication;
  const legacyRevision = originalPublication
    ? legacySimapRevision(originalPublication)
    : undefined;
  const candidate = validateDocumentaryObservation(request, result);
  const normalized =
    candidate.acquisition.state === "accepted"
      ? copyNormalizedDocumentaryPublication(
          originalPublication,
          candidate.request.identity,
          candidate.acquisition.sourceRevision,
        )
      : null;
  if (!candidate.request.observedPublication)
    throw new DocumentaryAdoptionConflict(
      "La richiesta non osservava una pubblicazione già esistente.",
    );
  const observed = candidate.request.observedPublication;
  const publicationId = `simap-${candidate.request.identity.projectId}`;
  return getDb().transaction(async (tx) => {
    const group = await lockCanonicalPublications(tx, publicationId);
    if (!group)
      throw new DocumentaryAdoptionConflict(
        "La pubblicazione documentaria non esiste più.",
      );
    const publication = group.publication;
    if (
      publication.source !== "simap" ||
      publication.externalId !== candidate.request.identity.projectId ||
      (publication.projectId !== null &&
        publication.projectId !== candidate.request.identity.projectId) ||
      publication.data.id !== publicationId ||
      publication.data.source !== "simap" ||
      publication.data.externalId !== candidate.request.identity.projectId ||
      (publication.data.projectId !== undefined &&
        publication.data.projectId !== candidate.request.identity.projectId)
    )
      throw new DocumentaryAdoptionConflict(
        "Identità della pubblicazione documentaria discordante.",
      );
    const [existing] = await tx
      .select()
      .from(publicationDocumentarySnapshots)
      .where(eq(publicationDocumentarySnapshots.id, candidate.request.id));
    function assertExact(
      row: typeof publicationDocumentarySnapshots.$inferSelect,
    ) {
      const decoded = decodeDocumentarySnapshotRow(row, publicationId);
      if (
        stableDocumentaryJson(decoded.request) !==
          stableDocumentaryJson(candidate.request) ||
        stableDocumentaryJson(decoded.acquisition) !==
          stableDocumentaryJson(candidate.acquisition)
      )
        throw new DocumentaryAdoptionConflict(
          "Lo snapshot documentario conserva un esito diverso della richiesta.",
        );
    }
    if (existing) assertExact(existing);
    // An exact retry while this same observation is still current is a no-op.
    // It never sends a duplicate job, restores an older pointer, or changes data.
    if (
      publication.documentarySnapshotId === candidate.request.id &&
      existing
    ) {
      if (publication.revision !== (normalized?.revision ?? observed.revision))
        throw new DocumentaryAdoptionConflict(
          "La revisione non coincide con l’osservazione corrente.",
        );
      return {
        publicationId,
        observationId: existing.id,
        state: existing.state,
        adopted: true as const,
        changed: false,
        sourceChanged: false,
        jobId: null,
      };
    }
    if (publication.revision !== observed.revision)
      throw new DocumentaryAdoptionConflict(
        "La revisione sorgente è cambiata dopo la richiesta.",
      );
    if (publication.documentarySnapshotId !== observed.documentarySnapshotId)
      throw new DocumentaryAdoptionConflict(
        "Il puntatore documentario è cambiato dopo la richiesta.",
      );
    if (
      normalized &&
      /^[a-f0-9]{64}$/.test(publication.revision) &&
      !legacyRevision
    )
      throw new DocumentaryAdoptionConflict(
        "La fonte legacy richiede il risultato originale del normalizzatore per distinguere una rettifica dalla migrazione dell’hash.",
      );
    if (
      !existing &&
      normalized &&
      publication.revision === normalized.revision &&
      publication.documentarySnapshotId
    ) {
      const [currentSnapshot] = await tx
        .select()
        .from(publicationDocumentarySnapshots)
        .where(
          eq(
            publicationDocumentarySnapshots.id,
            publication.documentarySnapshotId,
          ),
        );
      if (!currentSnapshot)
        throw new DocumentaryAdoptionConflict(
          "Snapshot corrente non disponibile.",
        );
      const current = decodeDocumentarySnapshotRow(
        currentSnapshot,
        publicationId,
      );
      if (
        current.acquisition.state === "accepted" &&
        candidate.acquisition.state === "accepted" &&
        current.acquisition.sourceRevision ===
          candidate.acquisition.sourceRevision &&
        stableDocumentaryJson(current.acquisition.identity) ===
          stableDocumentaryJson(candidate.acquisition.identity) &&
        stableDocumentaryJson(current.acquisition.archive) ===
          stableDocumentaryJson(candidate.acquisition.archive)
      ) {
        // The source run records the successful check. Identical accepted GETs
        // do not append a fresh receipt/archive or job. Keep the original receipt
        // intact; transitions, UUID changes and pre-existing shadows still append.
        return {
          publicationId,
          observationId: currentSnapshot.id,
          state: "accepted" as const,
          adopted: true as const,
          changed: false,
          sourceChanged: false,
          jobId: null,
        };
      }
    }
    if (!existing)
      await tx
        .insert(publicationDocumentarySnapshots)
        .values({
          id: candidate.request.id,
          publicationId,
          sourceProjectId: candidate.request.identity.projectId,
          sourcePublicationId: candidate.request.identity.publicationId,
          state: candidate.acquisition.state,
          request: candidate.request,
          acquisition: candidate.acquisition,
        })
        .onConflictDoNothing({ target: publicationDocumentarySnapshots.id });
    // Shadow collection can race this transaction. Compare its immutable row
    // after the insert conflict as well, including the exact original receipt.
    const [stored] = await tx
      .select()
      .from(publicationDocumentarySnapshots)
      .where(eq(publicationDocumentarySnapshots.id, candidate.request.id));
    if (!stored) throw new Error("Snapshot documentario non archiviato.");
    assertExact(stored);
    const formatMigration =
      !!normalized &&
      legacyRevision === publication.revision &&
      normalized.revision !== publication.revision;
    async function archiveExact(data: Publication) {
      const serialized = stableDocumentaryJson(data);
      const [normal] = await tx
        .select()
        .from(publicationVersions)
        .where(
          and(
            eq(publicationVersions.publicationId, publicationId),
            eq(publicationVersions.revision, data.revision),
          ),
        );
      if (normal && stableDocumentaryJson(normal.data) === serialized) return;
      // A summary or scope flag may change without changing data.revision. This
      // extra key is a content snapshot, never an official source revision.
      const revision = normal
        ? `documentary-history-v1:${createHash("sha256").update(serialized).digest("hex")}`
        : data.revision;
      await tx
        .insert(publicationVersions)
        .values({ id: randomUUID(), publicationId, revision, data })
        .onConflictDoNothing();
      const [saved] = await tx
        .select()
        .from(publicationVersions)
        .where(
          and(
            eq(publicationVersions.publicationId, publicationId),
            eq(publicationVersions.revision, revision),
          ),
        );
      if (!saved || stableDocumentaryJson(saved.data) !== serialized)
        throw new DocumentaryAdoptionConflict(
          "La versione storica conserva un contenuto diverso.",
        );
    }
    if (normalized && formatMigration) {
      // Identical parsed source input under the old normalizer fingerprint is
      // a hash format migration, not proof of identical HTTP bytes. Preserve
      // the actual enriched/editorial current row.
      await archiveExact(publication.data);
      await archiveExact(normalized);
      await tx
        .update(publications)
        .set({
          revision: normalized.revision,
          documentarySnapshotId: stored.id,
        })
        .where(eq(publications.id, publicationId));
    } else if (normalized && normalized.revision !== publication.revision) {
      // Never import caller-provided links or move canonical membership. Only
      // source URLs belonging to the locked current group are merged here.
      const sourceUrls = [
        ...new Set([
          normalized.sourceUrl,
          ...group.publications.map((row) => row.data.sourceUrl),
        ]),
      ];
      if (
        sourceUrls.some((url) => {
          try {
            return !["https:", "http:"].includes(new URL(url).protocol);
          } catch {
            return true;
          }
        })
      )
        throw new DocumentaryAdoptionConflict(
          "Collegamenti del gruppo canonico non validi.",
        );
      const cousins = group.publications.filter(
        (row) => row.id !== publicationId,
      );
      const newer = (a: Publication, b: Publication) => {
        const at = new Date(a.publishedAt).getTime(),
          bt = new Date(b.publishedAt).getTime();
        return at > bt || (at === bt && sourceEdition(a) > sourceEdition(b));
      };
      const status = cousins.some(
        (row) =>
          row.source === normalized.source && newer(row.data, normalized),
      )
        ? ("closed" as const)
        : normalized.status;
      const conflict =
        status !== "closed" &&
        cousins.some(
          (row) =>
            row.source !== normalized.source &&
            row.status !== "closed" &&
            (row.status !== status ||
              (row.deadline &&
                normalized.deadline &&
                row.deadline.toISOString() !==
                  new Date(normalized.deadline).toISOString())),
        );
      const scope = publication.data.sourceScopeReview;
      const reviewReasons = [
        ...new Set([
          ...normalized.reviewReasons,
          ...(scope?.status === "required" ? [sourceScopeReviewReason] : []),
          ...(conflict ? ["Fonti discordanti su stato o scadenza"] : []),
        ]),
      ];
      const data: Publication = {
        ...normalized,
        canonicalKey: group.canonicalId,
        sourceUrls,
        status,
        ...(scope ? { sourceScopeReview: scope } : {}),
        reviewRequired: normalized.reviewRequired || reviewReasons.length > 0,
        reviewReasons,
      };
      if (conflict)
        await tx
          .insert(issues)
          .values({
            id: randomUUID(),
            key: `conflict:${group.canonicalId}`,
            title: "Fonti discordanti",
            detail:
              `${data.title}: stato o scadenza discordanti fra le fonti del gruppo canonico.`.slice(
                0,
                1500,
              ),
            severity: "critical",
            publicationId,
          })
          .onConflictDoUpdate({
            target: issues.key,
            set: {
              title: "Fonti discordanti",
              detail:
                `${data.title}: stato o scadenza discordanti fra le fonti del gruppo canonico.`.slice(
                  0,
                  1500,
                ),
              severity: "critical",
              resolvedAt: null,
            },
          });
      // Read under the same lock: include late editorial fixes and summaries in
      // history, while the new revision starts solely from the new normalized
      // source. Old document pages, summaries and judgments are never copied.
      await archiveExact(publication.data);
      await archiveExact(data);
      await tx
        .update(publications)
        .set({
          projectId: normalized.projectId,
          title: data.title,
          status: data.status,
          visibleAt: new Date(data.visibleAt),
          deadline: data.deadline ? new Date(data.deadline) : null,
          data,
          revision: normalized.revision,
          aiRevision: null,
          documentarySnapshotId: stored.id,
          updatedAt: new Date(),
        })
        .where(eq(publications.id, publicationId));
    } else {
      // Same-source enrichment and refused acquisition preserve every business
      // column and every JSON field, including editorial content and timestamps.
      await tx
        .update(publications)
        .set({ documentarySnapshotId: stored.id })
        .where(eq(publications.id, publicationId));
    }
    const jobId = await enqueueLotReconciliation(tx, {
      publicationId,
      canonicalId: group.canonicalId,
      eventId: `documentary-adoption:${stored.id}`,
    });
    return {
      publicationId,
      observationId: stored.id,
      state: stored.state,
      adopted: true as const,
      changed: true,
      sourceChanged:
        !!normalized &&
        normalized.revision !== publication.revision &&
        !formatMigration,
      jobId,
    };
  });
}

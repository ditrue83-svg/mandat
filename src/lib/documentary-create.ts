import { randomUUID } from "node:crypto";
import { and, eq, ne, or } from "drizzle-orm";
import { getDb } from "@/db";
import {
  issues,
  publicationDocumentarySnapshots,
  publications,
  publicationVersions,
} from "@/db/schema";
import type { SimapAcquisitionResult } from "@/sources/simap-documentary";
import {
  assertDocumentaryAdoptionActivation,
  DocumentaryAdoptionConflict,
  type DocumentaryAdoptionActivation,
} from "./documentary-adoption";
import { lockCanonicalPublicationGroups } from "./canonical-lock";
import {
  stableDocumentaryJson,
  validateDocumentaryObservation,
  type DocumentaryRequest,
} from "./documentary-observation";
import { copyNormalizedDocumentaryPublication } from "./documentary-normalized";
import { decodeDocumentarySnapshotRow } from "./documentary-store";
import { enqueueLotReconciliation } from "./lot-reconciliation";
import { possibleDuplicate } from "./matching";
import { sourceScopeReviewReason } from "./source-scope-review";
import type { Publication } from "./domain";
import { sourceEdition } from "./source-edition";

// A separate first-insert protocol: never manufacture observedPublication from
// a response, upsert a concurrent import, or call the post-commit legacy store.
export async function createDocumentaryPublication(
  request: DocumentaryRequest,
  result: SimapAcquisitionResult,
  activation: DocumentaryAdoptionActivation = { enabled: false },
) {
  assertDocumentaryAdoptionActivation(activation);
  const candidate = validateDocumentaryObservation(request, result);
  if (
    candidate.request.observedPublication !== null ||
    candidate.acquisition.state !== "accepted"
  )
    throw new DocumentaryAdoptionConflict(
      "La prima creazione richiede un’acquisizione accepted che non osservava una pubblicazione.",
    );
  const normalized = copyNormalizedDocumentaryPublication(
    result.publication,
    candidate.request.identity,
    candidate.acquisition.sourceRevision,
  );
  const publicationId = normalized.id;
  const canonicalId = normalized.canonicalKey || publicationId;
  return getDb().transaction(async (tx) => {
    // The group lock also exists for an empty group. A conflict with a row in a
    // different group is rejected without acquiring another group out of order.
    const cousins = await lockCanonicalPublicationGroups(tx, [canonicalId]);
    const current = await tx
      .select()
      .from(publications)
      .where(
        or(
          eq(publications.id, publicationId),
          and(
            eq(publications.source, normalized.source),
            eq(publications.externalId, normalized.externalId),
          ),
        ),
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
          "La richiesta conserva un’altra osservazione documentaria.",
        );
    }
    if (existing) assertExact(existing);
    if (current.length) {
      const row = current[0];
      if (
        current.length === 1 &&
        existing &&
        row.id === publicationId &&
        row.canonicalId === canonicalId &&
        row.source === normalized.source &&
        row.externalId === normalized.externalId &&
        row.projectId === normalized.projectId &&
        row.data.id === publicationId &&
        row.data.source === normalized.source &&
        row.data.externalId === normalized.externalId &&
        row.data.projectId === normalized.projectId &&
        row.documentarySnapshotId === candidate.request.id &&
        row.revision === normalized.revision
      )
        return {
          publicationId,
          observationId: existing.id,
          state: "accepted" as const,
          adopted: true as const,
          changed: false,
          sourceChanged: false,
          jobId: null,
        };
      throw new DocumentaryAdoptionConflict(
        "Una pubblicazione è stata inserita dopo la richiesta: nessun aggiornamento implicito.",
      );
    }
    const newer = (a: Publication, b: Publication) => {
      const at = new Date(a.publishedAt).getTime(),
        bt = new Date(b.publishedAt).getTime();
      return at > bt || (at === bt && sourceEdition(a) > sourceEdition(b));
    };
    const sameSource = cousins.filter(
      (row) => row.source === normalized.source,
    );
    const predecessor =
      [...sameSource].sort((a, b) =>
        newer(a.data, b.data)
          ? -1
          : newer(b.data, a.data)
            ? 1
            : a.id.localeCompare(b.id),
      )[0] ?? cousins[0];
    const scope =
      predecessor?.data.sourceScopeReview?.status === "required"
        ? predecessor.data.sourceScopeReview
        : undefined;
    const sourceUrls = [
      ...new Set([
        normalized.sourceUrl,
        ...cousins.map((row) => row.data.sourceUrl),
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
    const status = sameSource.some((row) => newer(row.data, normalized))
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
    // Ambiguity is a warning, never an automatic merge with another group.
    const otherSources =
      normalized.status === "open"
        ? await tx
            .select()
            .from(publications)
            .where(
              and(
                ne(publications.source, normalized.source),
                eq(publications.status, "open"),
                ne(publications.canonicalId, canonicalId),
              ),
            )
            .orderBy(publications.id)
        : [];
    const duplicate = otherSources.find((row) =>
      possibleDuplicate(normalized, row.data),
    );
    const reviewReasons = [
      ...new Set([
        ...normalized.reviewReasons,
        ...(scope ? [sourceScopeReviewReason] : []),
        ...(conflict ? ["Le fonti riportano stati o scadenze differenti"] : []),
        ...(duplicate
          ? ["Possibile duplicato: identità della gara da verificare"]
          : []),
      ]),
    ];
    const data: Publication = {
      ...normalized,
      canonicalKey: canonicalId,
      sourceUrls,
      status,
      ...(scope ? { sourceScopeReview: scope } : {}),
      reviewRequired: normalized.reviewRequired || reviewReasons.length > 0,
      reviewReasons,
    };
    const changedAt = new Date();
    // The null pointer exists only inside this uncommitted transaction, to
    // satisfy the publication/snapshot FK cycle. No reader sees it committed.
    const inserted = await tx
      .insert(publications)
      .values({
        id: publicationId,
        canonicalId,
        source: data.source,
        externalId: data.externalId,
        projectId: data.projectId,
        title: data.title,
        status,
        visibleAt: new Date(data.visibleAt),
        deadline: data.deadline ? new Date(data.deadline) : null,
        data,
        revision: data.revision,
        aiRevision: null,
        updatedAt: changedAt,
      })
      .onConflictDoNothing()
      .returning({ id: publications.id });
    if (inserted.length !== 1)
      throw new DocumentaryAdoptionConflict(
        "La prima creazione è stata superata da un inserimento concorrente.",
      );
    await tx
      .insert(publicationDocumentarySnapshots)
      .values({
        id: candidate.request.id,
        publicationId,
        sourceProjectId: candidate.request.identity.projectId,
        sourcePublicationId: candidate.request.identity.publicationId,
        state: "accepted",
        request: candidate.request,
        acquisition: candidate.acquisition,
      })
      .onConflictDoNothing({ target: publicationDocumentarySnapshots.id });
    const [stored] = await tx
      .select()
      .from(publicationDocumentarySnapshots)
      .where(eq(publicationDocumentarySnapshots.id, candidate.request.id));
    if (!stored)
      throw new Error("Snapshot della nuova pubblicazione non archiviato.");
    assertExact(stored);
    await tx.insert(publicationVersions).values({
      id: randomUUID(),
      publicationId,
      revision: data.revision,
      data,
    });
    async function issue(
      key: string,
      title: string,
      detail: string,
      severity: "critical" | "warning",
    ) {
      await tx
        .insert(issues)
        .values({
          id: randomUUID(),
          key,
          title,
          detail: detail.slice(0, 1500),
          severity,
          publicationId,
        })
        .onConflictDoUpdate({
          target: issues.key,
          set: {
            title,
            detail: detail.slice(0, 1500),
            severity,
            resolvedAt: null,
          },
        });
    }
    if (duplicate)
      await issue(
        `duplicate:${publicationId}`,
        "Possibile doppia pubblicazione",
        `Confrontare la gara con ${duplicate.data.sourceUrl}. Le schede restano separate finché l’identità non è certa.`,
        "warning",
      );
    if (conflict)
      await issue(
        `conflict:${canonicalId}`,
        "Fonti discordanti",
        data.title,
        "critical",
      );
    if (data.reviewRequired)
      await issue(
        `review:${publicationId}`,
        "Bando da verificare",
        reviewReasons.join("; "),
        "warning",
      );
    for (const cousin of cousins) {
      const closed = cousin.source === data.source && newer(data, cousin.data);
      // These rows were read under UPDATE locks. Only explicit source-link and
      // supersession fields change; editorial content, pointers and AI stay.
      const cousinData = {
        ...cousin.data,
        sourceUrls: [...new Set([...cousin.data.sourceUrls, ...sourceUrls])],
        ...(closed ? { status: "closed" as const } : {}),
      };
      await tx
        .update(publications)
        .set({
          data: cousinData,
          ...(closed ? { status: "closed" } : {}),
          updatedAt: changedAt,
        })
        .where(eq(publications.id, cousin.id));
    }
    await tx
      .update(publications)
      .set({ documentarySnapshotId: stored.id })
      .where(eq(publications.id, publicationId));
    const jobId = await enqueueLotReconciliation(tx, {
      publicationId,
      canonicalId,
      eventId: `documentary-adoption:${stored.id}`,
    });
    return {
      publicationId,
      observationId: stored.id,
      state: "accepted" as const,
      adopted: true as const,
      changed: true,
      sourceChanged: true,
      jobId,
    };
  });
}

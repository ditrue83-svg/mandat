import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { publicationDocumentarySnapshots, publications } from "@/db/schema";
import type { SimapAcquisitionResult } from "@/sources/simap-documentary";
import type { Identity } from "./source-lots";
import {
  createDocumentaryRequest,
  stableDocumentaryJson,
  validateDocumentaryAcquisition,
  validateDocumentaryObservation,
  type DocumentaryRequest,
} from "./documentary-observation";

export class DocumentaryObservationConflict extends Error {}
export type DocumentaryRefreshExpectation = {
  revision: string;
  documentarySnapshotId: string | null;
  buyer: string;
};

// Internal worker protocol, not a client API. This captures the row seen before
// acquisition; the checksum detects altered context but is not authentication.
export async function beginDocumentaryRequest(
  identity: Identity,
  expectedRefresh?: DocumentaryRefreshExpectation | null,
): Promise<DocumentaryRequest> {
  // The refresh header uses the previous buyer as a fallback. Never rebase that
  // header onto a row that changed during its HTTP request, even if only an
  // editorial buyer correction changed without a new official revision.
  const expected =
    expectedRefresh === null
      ? null
      : expectedRefresh
        ? { ...expectedRefresh }
        : undefined;
  const draft = createDocumentaryRequest({
    id: randomUUID(),
    identity,
    startedAt: new Date().toISOString(),
    observedPublication: null,
  });
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({
        source: publications.source,
        externalId: publications.externalId,
        revision: publications.revision,
        documentarySnapshotId: publications.documentarySnapshotId,
        data: publications.data,
      })
      .from(publications)
      .where(eq(publications.id, `simap-${draft.identity.projectId}`))
      .for("share");
    if (expected === null && row)
      throw new DocumentaryObservationConflict(
        "La pubblicazione è comparsa durante il recupero dell’elenco simap.",
      );
    if (
      row &&
      (row.source !== "simap" || row.externalId !== draft.identity.projectId)
    )
      throw new DocumentaryObservationConflict(
        "Identità della pubblicazione discordante",
      );
    if (
      expected &&
      (!row ||
        row.revision !== expected.revision ||
        row.documentarySnapshotId !== expected.documentarySnapshotId ||
        row.data.buyer !== expected.buyer)
    )
      throw new DocumentaryObservationConflict(
        "La fonte è cambiata durante il recupero dell’elenco o dell’header simap.",
      );
    return createDocumentaryRequest({
      id: draft.id,
      identity: draft.identity,
      startedAt: draft.startedAt,
      observedPublication: row
        ? {
            revision: row.revision,
            documentarySnapshotId: row.documentarySnapshotId,
          }
        : null,
    });
  });
}

type SnapshotRow = typeof publicationDocumentarySnapshots.$inferSelect;
export function decodeDocumentarySnapshotRow(
  row: SnapshotRow,
  expectedPublicationId: string | null,
) {
  if (row.publicationId !== expectedPublicationId)
    throw new DocumentaryObservationConflict(
      "Archivio di un'altra pubblicazione",
    );
  const decoded = validateDocumentaryAcquisition(row.request, row.acquisition);
  if (row.id !== decoded.request.id)
    throw new DocumentaryObservationConflict(
      "Identità dell'osservazione discordante",
    );
  assertSameObservation(row, decoded);
  return { ...row, ...decoded };
}
function storedResult(row: SnapshotRow) {
  return {
    id: row.id,
    publicationId: row.publicationId,
    state: row.state,
    adopted: false as const,
  };
}
function assertSameObservation(
  row: SnapshotRow,
  candidate: ReturnType<typeof validateDocumentaryObservation>,
) {
  if (
    row.sourceProjectId !== candidate.request.identity.projectId ||
    row.sourcePublicationId !== candidate.request.identity.publicationId ||
    row.state !== candidate.acquisition.state ||
    stableDocumentaryJson(row.request) !==
      stableDocumentaryJson(candidate.request) ||
    stableDocumentaryJson(row.acquisition) !==
      stableDocumentaryJson(candidate.acquisition)
  )
    throw new DocumentaryObservationConflict(
      "La richiesta documentaria ha già un esito diverso",
    );
}

// Append only. Deliberately does not call storePublication or change a current
// pointer, match, review, job or notification. A later adoption transaction must
// prove the request/source/pointer CAS with all consumers already compatible.
export async function storeDocumentaryObservation(
  request: DocumentaryRequest,
  result: SimapAcquisitionResult,
) {
  const validated = validateDocumentaryObservation(request, result);
  const requestId = validated.request.id;
  return getDb().transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(publicationDocumentarySnapshots)
      .where(eq(publicationDocumentarySnapshots.id, requestId));
    if (existing) {
      assertSameObservation(existing, validated);
      return storedResult(existing);
    }
    const [publication] = await tx
      .select({
        id: publications.id,
        source: publications.source,
        externalId: publications.externalId,
      })
      .from(publications)
      .where(
        eq(publications.id, `simap-${validated.request.identity.projectId}`),
      )
      .for("share");
    if (
      publication &&
      (publication.source !== "simap" ||
        publication.externalId !== validated.request.identity.projectId)
    )
      throw new DocumentaryObservationConflict(
        "Identità della pubblicazione discordante",
      );
    if (!publication && validated.acquisition.state === "accepted")
      throw new DocumentaryObservationConflict(
        "Archiviare prima la pubblicazione normalizzata; nessuna adozione implicita",
      );
    await tx
      .insert(publicationDocumentarySnapshots)
      .values({
        id: requestId,
        publicationId: publication?.id ?? null,
        sourceProjectId: validated.request.identity.projectId,
        sourcePublicationId: validated.request.identity.publicationId,
        state: validated.acquisition.state,
        request: validated.request,
        acquisition: validated.acquisition,
      })
      .onConflictDoNothing({ target: publicationDocumentarySnapshots.id });
    // A concurrent retry can win the insert. Read its immutable outcome and
    // compare every saved field rather than treating any conflict as success.
    const [stored] = await tx
      .select()
      .from(publicationDocumentarySnapshots)
      .where(eq(publicationDocumentarySnapshots.id, requestId));
    if (!stored) throw new Error("Osservazione documentaria non archiviata");
    assertSameObservation(stored, validated);
    return storedResult(stored);
  });
}

// Private server reader. Authorization of the enclosing route remains the
// caller's responsibility; company-facing DTOs must not spread this record.
export async function readDocumentarySnapshot(
  id: string,
  expectedPublicationId: string | null,
) {
  z.uuid().parse(id);
  const [row] = await getDb()
    .select()
    .from(publicationDocumentarySnapshots)
    .where(eq(publicationDocumentarySnapshots.id, id));
  if (!row) return null;
  return decodeDocumentarySnapshotRow(row, expectedPublicationId);
}

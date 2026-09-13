import type { Publication } from "@/lib/domain";
import {
  beginDocumentaryRequest,
  storeDocumentaryObservation,
  type DocumentaryRefreshExpectation,
} from "@/lib/documentary-store";
import {
  adoptDocumentaryObservation,
  assertDocumentaryAdoptionActivation,
  type DocumentaryAdoptionActivation,
} from "@/lib/documentary-adoption";
import { createDocumentaryPublication } from "@/lib/documentary-create";
import type { SourceEntry } from "@/sources/common";
import {
  acquireSimap,
  simapDocumentaryIdentity,
} from "@/sources/simap-documentary";

// Shadow collection only. Source storage and observation append may be retried
// independently; there is no claim of atomic operational adoption in this path.
export async function collectSimapDocumentary(
  entry: SourceEntry,
  persistPublication: (publication: Publication) => Promise<boolean>,
) {
  const requestedEntry = structuredClone(entry);
  const request = await beginDocumentaryRequest(
    simapDocumentaryIdentity(requestedEntry),
  );
  const result = await acquireSimap(requestedEntry);
  const imported = result.publication
    ? await persistPublication(result.publication)
    : false;
  const observation = await storeDocumentaryObservation(request, result);
  return {
    imported,
    observation,
    requiresReview: result.documentaryAcquisition.state === "refused",
    refusalCode:
      result.documentaryAcquisition.state === "refused"
        ? result.documentaryAcquisition.refusal.code
        : null,
  };
}

// Operational collection has no legacy storage callback: the normalized source,
// immutable observation, current pointer and reconciliation job commit together.
// The request is captured before the detail GET and is never rebased after it.
export async function collectAndAdoptSimapDocumentary(
  entry: SourceEntry,
  activation: DocumentaryAdoptionActivation,
  options: {
    expectedRefresh?: DocumentaryRefreshExpectation | null;
    signal?: AbortSignal;
  } = {},
) {
  const enabled = assertDocumentaryAdoptionActivation(activation);
  const requestedEntry = structuredClone(entry);
  options.signal?.throwIfAborted();
  const request = await beginDocumentaryRequest(
    simapDocumentaryIdentity(requestedEntry),
    options.expectedRefresh,
  );
  options.signal?.throwIfAborted();
  const result = await acquireSimap(requestedEntry);
  options.signal?.throwIfAborted();
  const observation = request.observedPublication
    ? await adoptDocumentaryObservation(request, result, enabled)
    : result.documentaryAcquisition.state === "accepted"
      ? await createDocumentaryPublication(request, result, enabled)
      : await storeDocumentaryObservation(request, result);
  const adopted = observation.adopted;
  return {
    imported:
      adopted &&
      "changed" in observation &&
      observation.changed &&
      result.documentaryAcquisition.state === "accepted" &&
      (!request.observedPublication ||
        ("sourceChanged" in observation && observation.sourceChanged === true)),
    documentaryChanged:
      adopted && "changed" in observation && observation.changed,
    observation,
    requiresReview: result.documentaryAcquisition.state === "refused",
    refusalCode:
      result.documentaryAcquisition.state === "refused"
        ? result.documentaryAcquisition.refusal.code
        : null,
  };
}

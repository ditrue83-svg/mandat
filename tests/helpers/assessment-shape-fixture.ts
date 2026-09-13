import { createHash } from "node:crypto";
import {
  createDocumentaryRequest,
  stableDocumentaryJson,
} from "../../src/lib/documentary-observation";
import {
  resolveAssessmentShapeHistory,
  type DocumentarySnapshotRow,
} from "../../src/lib/assessment-shape";
import type { LotSourceSnapshot } from "../../src/lib/lot-source-context";
import { restoreSimapDetail } from "../../src/lib/source-lots";
import { normalizeSimap } from "../../src/sources/simap";
import { SIMAP_ACQUISITION_VERSION } from "../../src/sources/simap-documentary";
import type { Identity } from "../../src/lib/source-lots";

function refusedReceipt(identity: Identity) {
  return {
    url: identity.detailUrl,
    receivedAt: "2026-01-01T00:00:00.000Z",
    bodyByteLength: 4,
    bodySha256: createHash("sha256").update("null").digest("hex"),
  };
}
export function refusedUiAcquisition(identity: Identity) {
  return {
    state: "refused" as const,
    identity,
    reason: "archive:ui_refused",
    receiptHash: createHash("sha256")
      .update(stableDocumentaryJson(refusedReceipt(identity)))
      .digest("hex"),
  };
}

// Invented in-memory deposit rows for pure UI fixtures. Uses the actual decoder
// and ancestry resolver; this supplies no SQL, authentication or adoption proof.
export function shapeFixture(snapshot: LotSourceSnapshot) {
  const acquisition = snapshot.acquisition;
  const identity =
    acquisition.state === "accepted"
      ? acquisition.archive.identity
      : acquisition.identity;
  const at = "2026-01-01T00:00:00.000Z";
  const detail =
    acquisition.state === "accepted"
      ? restoreSimapDetail(acquisition.archive)
      : null;
  const body = JSON.stringify(detail);
  const revision = detail
    ? normalizeSimap(
        {
          id: identity.projectId,
          raw: {
            id: identity.projectId,
            publicationId: identity.publicationId,
            projectNumber: "INVENTED-UI-SHAPE",
            publicationDate: "2026-01-01",
            pubType: "tender",
            processType: "open",
            procOfficeName: { it: "Ente inventato" },
            title: { it: "Progetto inventato per UI" },
          },
        },
        detail,
      ).revision
    : null;
  const request = createDocumentaryRequest({
    id: snapshot.observationId,
    identity,
    startedAt: at,
    observedPublication: null,
  });
  const common = {
    version: SIMAP_ACQUISITION_VERSION as typeof SIMAP_ACQUISITION_VERSION,
    identity,
    receipt:
      acquisition.state === "refused"
        ? refusedReceipt(identity)
        : {
            url: identity.detailUrl,
            receivedAt: at,
            bodyByteLength: Buffer.byteLength(body),
            bodySha256: createHash("sha256").update(body).digest("hex"),
          },
  };
  const row: DocumentarySnapshotRow = {
    id: snapshot.observationId,
    publicationId: snapshot.publicationId,
    sourceProjectId: identity.projectId,
    sourcePublicationId: identity.publicationId,
    state: acquisition.state,
    request,
    createdAt: new Date(at),
    acquisition:
      acquisition.state === "accepted"
        ? {
            ...common,
            state: "accepted",
            sourceRevision: revision!,
            archive: acquisition.archive,
          }
        : {
            ...common,
            state: "refused",
            sourceRevision: null,
            refusal: { stage: "archive", code: "ui_refused" },
          },
  };
  return resolveAssessmentShapeHistory({
    publicationId: snapshot.publicationId,
    currentObservationId: snapshot.observationId,
    observations: [row],
  });
}

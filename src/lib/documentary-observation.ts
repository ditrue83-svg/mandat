import { createHash } from "node:crypto";
import { z } from "zod";
import {
  preserveSimapLots,
  restoreSimapDetail,
  type Identity,
  type LotArchive,
} from "./source-lots";
import {
  SIMAP_ACQUISITION_VERSION,
  type SimapAcquisitionResult,
  type SimapDocumentaryAcquisition,
} from "@/sources/simap-documentary";

export const DOCUMENTARY_REQUEST_VERSION = "documentary-request-v1";
export type DocumentaryRequest = Readonly<{
  version: typeof DOCUMENTARY_REQUEST_VERSION;
  id: string;
  identity: Readonly<Identity>;
  startedAt: string;
  observedPublication: Readonly<{
    revision: string;
    documentarySnapshotId: string | null;
  }> | null;
  token: string;
}>;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const safeText = z
  .string()
  .min(1)
  .max(512)
  .refine((s) => s.isWellFormed() && !s.includes("\u0000"));
const identitySchema = z
  .object({
    projectId: z.uuid(),
    publicationId: z.uuid(),
    detailUrl: z.string().url().max(512),
  })
  .strict()
  .refine(
    (v) =>
      v.detailUrl ===
      `https://www.simap.ch/api/publications/v1/project/${v.projectId}/publication-details/${v.publicationId}`,
  );
const requestSchema = z
  .object({
    version: z.literal(DOCUMENTARY_REQUEST_VERSION),
    id: z.uuid(),
    identity: identitySchema,
    startedAt: z.iso.datetime(),
    observedPublication: z
      .object({
        revision: safeText,
        documentarySnapshotId: z.uuid().nullable(),
      })
      .strict()
      .nullable(),
    token: sha256,
  })
  .strict();
const acquisitionSchema = z.intersection(
  z.object({
    version: z.literal(SIMAP_ACQUISITION_VERSION),
    identity: identitySchema,
    receipt: z
      .object({
        url: z.string().url().max(512),
        receivedAt: z.iso.datetime(),
        bodySha256: sha256,
        bodyByteLength: z.number().int().min(0).max(12_000_000),
      })
      .strict(),
  }),
  z.discriminatedUnion("state", [
    z.object({
      state: z.literal("accepted"),
      sourceRevision: z.string().regex(/^simap-v2:[a-f0-9]{64}$/),
      archive: z.unknown(),
    }),
    z.object({
      state: z.literal("refused"),
      sourceRevision: z.null(),
      refusal: z
        .object({
          stage: z.enum(["decode", "parse", "archive", "normalize"]),
          code: safeText,
          path: z
            .string()
            .max(512)
            .refine((s) => s.isWellFormed() && !s.includes("\u0000"))
            .optional(),
        })
        .strict(),
    }),
  ]),
);

export function stableDocumentaryJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableDocumentaryJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableDocumentaryJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) =>
  createHash("sha256").update(stableDocumentaryJson(value)).digest("hex");

export function createDocumentaryRequest(
  input: Omit<DocumentaryRequest, "version" | "token">,
): DocumentaryRequest {
  const unsigned = { version: DOCUMENTARY_REQUEST_VERSION, ...input };
  return validateDocumentaryRequest({ ...unsigned, token: hash(unsigned) });
}

export function validateDocumentaryRequest(input: unknown): DocumentaryRequest {
  const request = requestSchema.parse(input);
  const { token, ...unsigned } = request;
  if (hash(unsigned) !== token)
    throw new Error("La richiesta documentaria è stata modificata");
  Object.freeze(request.identity);
  if (request.observedPublication) Object.freeze(request.observedPublication);
  return Object.freeze(request);
}

export function validateDocumentaryAcquisition(
  requestInput: unknown,
  acquisitionInput: unknown,
): { request: DocumentaryRequest; acquisition: SimapDocumentaryAcquisition } {
  const request = validateDocumentaryRequest(requestInput);
  const acquisition = acquisitionSchema.parse(acquisitionInput);
  if (
    stableDocumentaryJson(acquisition.identity) !==
      stableDocumentaryJson(request.identity) ||
    acquisition.receipt.url !== request.identity.detailUrl ||
    Date.parse(acquisition.receipt.receivedAt) < Date.parse(request.startedAt)
  )
    throw new Error("Ricevuta documentaria non coerente con la richiesta");
  if (acquisition.state === "accepted") {
    const archive = acquisition.archive as LotArchive;
    // Rebuild and validate the immutable archive, including its hash and IDs.
    const original = restoreSimapDetail(archive);
    if (
      stableDocumentaryJson(archive.identity) !==
        stableDocumentaryJson(request.identity)
    )
      throw new Error("Identità dell'archivio documentario discordante");
    // z.unknown retains references. Detach and freeze the verified archive
    // before the repository awaits a transaction, so caller mutations cannot
    // replace a checked body while it is being persisted.
    acquisition.archive = preserveSimapLots(original, request.identity);
  }
  // Receipts come from the server HTTP reader. A checksum binds content but
  // does not authenticate a source; canonical JSON cannot recover wire bytes.
  return {
    request,
    acquisition: acquisition as SimapDocumentaryAcquisition,
  };
}

export function validateDocumentaryObservation(
  requestInput: unknown,
  result: SimapAcquisitionResult,
): { request: DocumentaryRequest; acquisition: SimapDocumentaryAcquisition } {
  const validated = validateDocumentaryAcquisition(
    requestInput,
    result.documentaryAcquisition,
  );
  const { request, acquisition } = validated;
  if (acquisition.state === "accepted") {
    if (
      !result.publication ||
      result.publication.source !== "simap" ||
      result.publication.id !== `simap-${request.identity.projectId}` ||
      result.publication.externalId !== request.identity.projectId ||
      result.publication.projectId !== request.identity.projectId ||
      result.publication.revision !== acquisition.sourceRevision
    )
      throw new Error("Pubblicazione e archivio documentario discordanti");
  } else if (result.publication !== null) {
    throw new Error("Un'acquisizione rifiutata non può creare una pubblicazione");
  }
  return validated;
}

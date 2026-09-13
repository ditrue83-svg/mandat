import { z } from "zod";
import type { Publication } from "@/lib/domain";
import {
  LotInputError,
  preserveSimapLots,
  type Identity,
  type LotArchive,
} from "@/lib/source-lots";
import {
  fetchOfficialResponse,
  type OfficialResponseReceipt,
  type SourceEntry,
} from "./common";
import { normalizeSimap } from "./simap";

export const SIMAP_ACQUISITION_VERSION = "simap-documentary-acquisition-v1";

// This is a receipt for Fetch response-body bytes (possibly decompressed by
// Fetch), not the HTTP wire representation and not a signature by the source.
export type DocumentaryReceipt = Readonly<{
  url: string;
  receivedAt: string;
  bodySha256: string;
  bodyByteLength: number;
}>;
type AcquisitionBase = Readonly<{
  version: typeof SIMAP_ACQUISITION_VERSION;
  identity: Readonly<Identity>;
  receipt: DocumentaryReceipt;
}>;
export type SimapDocumentaryAcquisition = AcquisitionBase &
  (
    | Readonly<{
        state: "accepted";
        sourceRevision: string;
        archive: LotArchive;
      }>
    | Readonly<{
        state: "refused";
        // No normalized revision is claimed when parsing or preservation fails.
        sourceRevision: null;
        refusal: Readonly<{
          stage: "decode" | "parse" | "archive" | "normalize";
          code: string;
          path?: string;
        }>;
      }>
  );
export type SimapAcquisitionResult =
  | {
      publication: Publication;
      documentaryAcquisition: SimapDocumentaryAcquisition & {
        state: "accepted";
      };
    }
  | {
      publication: null;
      documentaryAcquisition: SimapDocumentaryAcquisition & {
        state: "refused";
      };
    };

const requestIdentity = z.object({ id: z.uuid(), publicationId: z.uuid() });

export function simapDocumentaryIdentity(entry: SourceEntry): Readonly<Identity> {
  const p = requestIdentity.parse(entry.raw);
  if (entry.id !== p.id)
    throw new Error("Identità della richiesta simap discordante");
  return Object.freeze({
    projectId: p.id,
    publicationId: p.publicationId,
    detailUrl: `https://www.simap.ch/api/publications/v1/project/${p.id}/publication-details/${p.publicationId}`,
  });
}

function refusalPath(path: string) {
  // JSON property names may be arbitrarily long. Keep diagnostic fields safe
  // for JSONB/logging without copying source values or an exception message.
  return Array.from(path.toWellFormed())
    .slice(0, 256)
    .join("")
    .replace(/[\u0000-\u001f\u007f]/g, "?");
}

function normalizedTextIssue(publication: Publication) {
  // The normalized result also uses search/header strings (for example buyer
  // and a fallback title), which are outside the archived detail. Check only
  // values actually retained in Publication, not unused header metadata.
  const pending: unknown[] = [publication];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (!value.isWellFormed()) return "invalid_unicode";
      if (value.includes("\u0000")) return "unsupported_jsonb_text";
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) pending.push(key, child);
    }
  }
  return null;
}

function interpretResponse(
  entry: SourceEntry,
  identity: Readonly<Identity>,
  response: OfficialResponseReceipt,
): SimapAcquisitionResult {
  // The response is created by our HTTP reader, never supplied by a client.
  if (response.url !== identity.detailUrl)
    throw new Error("Risposta simap estranea alla richiesta documentaria");
  const base: AcquisitionBase = Object.freeze({
    version: SIMAP_ACQUISITION_VERSION,
    identity,
    receipt: Object.freeze({
      url: response.url,
      receivedAt: response.receivedAt,
      bodySha256: response.bodySha256,
      bodyByteLength: response.bodyByteLength,
    }),
  });
  function refuse(
    stage: "decode" | "parse" | "archive" | "normalize",
    code: string,
    path?: string,
  ): SimapAcquisitionResult {
    return {
      publication: null,
      documentaryAcquisition: Object.freeze({
        ...base,
        state: "refused" as const,
        sourceRevision: null,
        refusal: Object.freeze({
          stage,
          code,
          ...(path === undefined ? {} : { path: refusalPath(path) }),
        }),
      }),
    };
  }
  let text: string;
  try {
    // A replacement character would silently change the source and citations.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      response.body,
    );
  } catch {
    return refuse("decode", "invalid_utf8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse("parse", "invalid_json");
  }
  let archive: LotArchive;
  try {
    // Apply identity, JSONB, size and depth guards before the older normalizer
    // traverses the detail. Refused lot data never becomes a legacy Publication.
    archive = preserveSimapLots(raw, identity);
  } catch (error) {
    if (!(error instanceof LotInputError)) throw error;
    return refuse("archive", error.code, error.field);
  }
  let publication: Publication;
  try {
    publication = normalizeSimap(entry, raw);
  } catch {
    return refuse("normalize", "invalid_publication");
  }
  const textIssue = normalizedTextIssue(publication);
  if (textIssue) return refuse("normalize", textIssue);
  return {
    publication,
    documentaryAcquisition: Object.freeze({
      ...base,
      state: "accepted" as const,
      sourceRevision: publication.revision,
      archive,
    }),
  };
}

// Staged entrypoint: the live SourceAdapter/worker must only adopt these results
// after storage and every Radar/review/email consumer understands the lot branch.
// HTTP failures still throw; a received but unusable body returns a refusal
// receipt, with no fabricated Publication or fallback to an old positive match.
export async function acquireSimap(
  entry: SourceEntry,
): Promise<SimapAcquisitionResult> {
  // Freeze the request context in time as well as its IDs: callers may refresh
  // their search/header object while the HTTP request is still in flight.
  const requestedEntry = structuredClone(entry);
  const identity = simapDocumentaryIdentity(requestedEntry);
  const response = await fetchOfficialResponse(identity.detailUrl, [
    "www.simap.ch",
  ]);
  return interpretResponse(requestedEntry, identity, response);
}

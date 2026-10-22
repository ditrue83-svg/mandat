import { createHash } from "node:crypto";
import { z } from "zod";
import type { SourceCondition } from "@/lib/domain";
import type { OfficialResponseReceipt } from "./common";

const publication = z.object({
  id: z.uuid(),
  pubType: z.literal("abandonment"),
  dates: z.object({ publicationDate: z.iso.date() }),
});
const header = z.object({
  id: z.uuid(),
  lotsType: z.literal("with"),
  latestPublication: z.null(),
  lots: z
    .array(z.object({ id: z.uuid(), latestPublication: publication }))
    .min(1)
    .max(64),
});
export const abandonmentHeaderUrl = (projectId: string) =>
  `https://www.simap.ch/api/publications/v2/project/${projectId}/project-header`;

// A notice for ONE lot cannot cancel its siblings. Only an independently
// fetched, exact project header with every lot abandoned proves that state.
export function validateAbandonmentHeader(
  body: string,
  projectId: string,
  publicationId: string,
  lotId?: string,
) {
  const h = header.parse(JSON.parse(body));
  if (
    h.id !== projectId ||
    new Set(h.lots.map((lot) => lot.id)).size !== h.lots.length ||
    !h.lots.some(
      (lot) =>
        lot.latestPublication.id === publicationId &&
        (!lotId || lot.id === lotId),
    )
  )
    throw new Error("Stato di annullamento dei lotti simap non confermato");
  return h;
}

export function abandonmentHeaderCondition(
  response: OfficialResponseReceipt,
  projectId: string,
  publicationId: string,
  lotId: string,
): SourceCondition {
  if (response.url !== abandonmentHeaderUrl(projectId))
    throw new Error("Header di annullamento estraneo al progetto");
  const body = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
  validateAbandonmentHeader(body, projectId, publicationId, lotId);
  return {
    path: "project-header.abandonment",
    url: response.url,
    value: {
      body,
      receivedAt: response.receivedAt,
      bodySha256: response.bodySha256,
    },
  };
}

export function verifyAbandonmentCondition(
  condition: SourceCondition,
  projectId: string,
  publicationId: string,
) {
  if (
    condition.path !== "project-header.abandonment" ||
    condition.url !== abandonmentHeaderUrl(projectId)
  )
    return false;
  const receipt = z
    .object({
      body: z.string(),
      receivedAt: z.iso.datetime(),
      bodySha256: z.string(),
    })
    .strict()
    .parse(condition.value);
  if (
    createHash("sha256").update(receipt.body).digest("hex") !==
    receipt.bodySha256
  )
    throw new Error("Ricevuta dell'header simap alterata");
  validateAbandonmentHeader(receipt.body, projectId, publicationId);
  return true;
}

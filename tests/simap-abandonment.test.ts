import { afterEach, expect, it, vi } from "vitest";
import { acquireSimap } from "../src/sources/simap-documentary";
import { copyNormalizedDocumentaryPublication } from "../src/lib/documentary-normalized";
import { preserveSimapLots, restoreSimapDetail } from "../src/lib/source-lots";
import { readSimapRefreshEntry, normalizeSimap } from "../src/sources/simap";
const projectId = "11111111-1111-4111-8111-111111111111";
const publicationId = "22222222-2222-4222-8222-222222222222";
const originalId = "33333333-3333-4333-8333-333333333333";
const lotId = "44444444-4444-4444-8444-444444444444";
const siblingId = "55555555-5555-4555-8555-555555555555";
const siblingPublicationId = "66666666-6666-4666-8666-666666666666";
const entry = {
  id: projectId,
  raw: {
    id: projectId,
    publicationId,
    publicationDate: "2030-10-01",
    projectNumber: "SYNTHETIC-CLOSED",
    pubType: "abandonment",
    processType: "open",
    title: { it: "Gara fittizia annullata" },
    procOfficeName: "Ente inventato",
  },
};
const detail = (partial = false) => ({
  id: publicationId,
  type: "abandonment",
  "project-info": { title: { it: "Gara fittizia annullata" } },
  abandonment: {
    reasons: ["requirements_changed"],
    otherReason: { it: "Motivazione inventata" },
  },
  abandonedLot: partial
    ? { id: lotId, lotNumber: 1, title: { it: "Lotto inventato" } }
    : null,
  base: {
    id: publicationId,
    type: "abandonment",
    projectId,
    lotsType: "with",
    referencingPubId: originalId,
    referencingLotId: partial ? lotId : null,
  },
});
const latest = (id: string, pubType = "abandonment") => ({
  id,
  pubType,
  dates: { publicationDate: "2030-10-01" },
  title: { it: "Avviso inventato" },
});
const header = (otherType = "abandonment") => ({
  id: projectId,
  projectNumber: "SYNTHETIC-CLOSED",
  processType: "open",
  lotsType: "with",
  latestPublication: null,
  lots: [
    { id: lotId, latestPublication: latest(publicationId) },
    {
      id: siblingId,
      latestPublication: latest(siblingPublicationId, otherType),
    },
  ],
});
afterEach(() => vi.unstubAllGlobals());
function respond(d: unknown, h = header()) {
  const fetchMock = vi.fn(async (url: string) =>
    Response.json(url.endsWith("project-header") ? h : d),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
it("preserves and adopts a project-wide abandonment without inventing a lot directory", async () => {
  const raw = detail();
  const fetchMock = respond(raw);
  const result = await acquireSimap(entry);
  expect(result.documentaryAcquisition.state).toBe("accepted");
  expect(result.publication?.status).toBe("cancelled");
  if (result.documentaryAcquisition.state !== "accepted")
    throw new Error("not accepted");
  expect(result.documentaryAcquisition.archive.directory).toEqual([]);
  expect(restoreSimapDetail(result.documentaryAcquisition.archive)).toEqual(
    raw,
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("requires independently collected evidence that ALL lots are abandoned, even with distinct notice IDs", async () => {
  const raw = detail(true);
  respond(raw);
  const result = await acquireSimap(entry);
  expect(result.publication?.status).toBe("cancelled");
  if (result.documentaryAcquisition.state !== "accepted" || !result.publication)
    throw new Error("not accepted");
  const p = result.publication;
  expect(restoreSimapDetail(result.documentaryAcquisition.archive)).toEqual(
    raw,
  );
  expect(p.sourceConditions?.[0].url).toContain("project-header");
  expect(
    copyNormalizedDocumentaryPublication(
      p,
      result.documentaryAcquisition.identity,
      p.revision,
    ),
  ).toEqual(p);
  const changed = structuredClone(p);
  (changed.sourceConditions![0].value as { body: string }).body += " ";
  expect(() =>
    copyNormalizedDocumentaryPublication(
      changed,
      result.documentaryAcquisition.identity,
      p.revision,
    ),
  ).toThrow("alterata");
  const refreshed = await readSimapRefreshEntry(
    normalizeSimap(entry, detail()),
  );
  expect(refreshed.raw.publicationId).toBe(publicationId);
});
it("never closes open sibling lots or accepts a header for the wrong project/lot/notice", async () => {
  for (const h of [
    header("tender"),
    { ...header(), id: originalId },
    {
      ...header(),
      lots: [{ id: siblingId, latestPublication: latest(publicationId) }],
    },
    {
      ...header(),
      lots: [{ id: lotId, latestPublication: latest(originalId) }],
    },
    { ...header(), lots: [header().lots[0], header().lots[0]] },
  ]) {
    respond(detail(true), h);
    const result = await acquireSimap(entry);
    expect(result.publication).toBeNull();
    expect(result.documentaryAcquisition.state).toBe("refused");
  }
});
it("keeps missing-lot guards for tenders and rejects inconsistent abandonment references", () => {
  const identity = {
    projectId,
    publicationId,
    detailUrl: `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${publicationId}`,
  };
  for (const raw of [
    { ...detail(), type: "tender" },
    {
      ...detail(true),
      base: { ...detail(true).base, referencingLotId: siblingId },
    },
    { ...detail(), abandonedLot: undefined },
  ]) {
    expect(() => preserveSimapLots(raw, identity)).toThrow();
  }
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeSimap, simap } from "../src/sources/simap";

const projectId = "11111111-1111-4111-8111-111111111111";
const previousPublicationId = "22222222-2222-4222-8222-222222222222";
const latestPublicationId = "33333333-3333-4333-8333-333333333333";
const otherPublicationId = "44444444-4444-4444-8444-444444444444";
const headerUrl = `https://www.simap.ch/api/publications/v2/project/${projectId}/project-header`;
const detailUrl = `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${latestPublicationId}`;

function publicationDetail(id = latestPublicationId, type = "tender") {
  return {
    id,
    type,
    "project-info": { title: { it: "Pulizia di locali comunali — esempio" } },
    dates: { offerDeadline: "2030-12-01T12:00:00+01:00" },
    procurement: {
      orderDescription: {
        it: "Pulizia ordinaria di locali comunali inventati.",
      },
      orderAddress: { city: { it: "Lugano" }, cantonId: "TI" },
      cpvCode: { code: "90910000" },
    },
  };
}

function previousPublication() {
  return normalizeSimap(
    {
      id: projectId,
      raw: {
        id: projectId,
        publicationId: previousPublicationId,
        publicationDate: "2030-09-01",
        projectNumber: "TEST-REFRESH-1",
        pubType: "tender",
        processType: "open",
        title: { it: "Pulizia di locali comunali — esempio" },
        procOfficeName: { it: "Ente interamente inventato" },
      },
    },
    publicationDetail(previousPublicationId),
  );
}

function latestPublication() {
  return {
    id: latestPublicationId,
    dates: { publicationDate: "2030-10-01" },
    pubType: "tender",
    title: { it: "Pulizia di locali comunali — esempio aggiornato" },
  };
}

function legacyHeader() {
  return {
    id: projectId,
    projectNumber: "TEST-REFRESH-1",
    processType: "open",
    lotsType: "without",
    latestPublication: latestPublication(),
    lots: [],
  };
}

function lotHeader() {
  return {
    ...legacyHeader(),
    lotsType: "with",
    latestPublication: null,
    lots: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        latestPublication: latestPublication(),
      },
      {
        id: "66666666-6666-4666-8666-666666666666",
        latestPublication: latestPublication(),
      },
    ],
  };
}

const fetchMock = vi.fn<typeof fetch>();

function respondWith(header: unknown, detail = publicationDetail()) {
  fetchMock.mockImplementation(async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === headerUrl) return Response.json(header);
    if (url === detailUrl) return Response.json(detail);
    throw new Error("Richiesta non prevista nel test simap senza rete");
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("Aggiornamento dei progetti simap", () => {
  it("usa latestPublication del progetto senza lotti e normalizza il dettaglio", async () => {
    const previous = previousPublication();
    respondWith(legacyHeader());

    const refreshed = await simap.refresh!(previous);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, headerUrl, expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, detailUrl, expect.any(Object));
    expect(refreshed).toMatchObject({
      externalId: projectId,
      canonicalKey: "simap:TEST-REFRESH-1",
      title: "Pulizia di locali comunali — esempio",
      status: "open",
      location: "Lugano",
      deadline: "2030-12-01T11:00:00.000Z",
      publishedAt: "2030-09-30T22:00:00.000Z",
    });
    expect(previous.publishedAt).toBe("2030-08-31T22:00:00.000Z");
  });

  it("usa la pubblicazione unanime dei lotti quando quella del progetto è null", async () => {
    const header = lotHeader();
    header.lots[1].latestPublication.title = {
      it: "Titolo specifico del secondo lotto",
    };
    respondWith(header);

    const refreshed = await simap.refresh!(previousPublication());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(2, detailUrl, expect.any(Object));
    expect(refreshed).toMatchObject({
      externalId: projectId,
      status: "open",
      title: "Pulizia di locali comunali — esempio",
      deadline: "2030-12-01T11:00:00.000Z",
      publishedAt: "2030-09-30T22:00:00.000Z",
    });
  });

  it.each([
    {
      change: "identificatori diversi",
      second: { ...latestPublication(), id: otherPublicationId },
    },
    {
      change: "date diverse",
      second: {
        ...latestPublication(),
        dates: { publicationDate: "2030-10-02" },
      },
    },
    {
      change: "tipi diversi",
      second: { ...latestPublication(), pubType: "award" },
    },
    { change: "pubblicazione di un lotto null", second: null },
    { change: "pubblicazione di un lotto mancante", second: undefined },
    {
      change: "data di un lotto mancante",
      second: { ...latestPublication(), dates: {} },
    },
    {
      change: "tipo di un lotto mancante",
      second: { ...latestPublication(), pubType: undefined },
    },
  ])(
    "richiede revisione per $change senza richiedere un dettaglio",
    async ({ second }) => {
      const previous = previousPublication();
      const unchanged = structuredClone(previous);
      const header = lotHeader();
      respondWith({
        ...header,
        lots: [
          header.lots[0],
          { ...header.lots[1], latestPublication: second },
        ],
      });

      await expect(simap.refresh!(previous)).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(headerUrl, expect.any(Object));
      expect(previous).toEqual(unchanged);
      expect(previous.status).toBe("open");
    },
  );

  it.each([
    { change: "nessun lotto", header: { ...lotHeader(), lots: [] } },
    { change: "lotti mancanti", header: { ...lotHeader(), lots: undefined } },
    {
      change: "nessuna pubblicazione del progetto senza lotti",
      header: { ...legacyHeader(), latestPublication: null },
    },
    {
      change: "progetto diverso",
      header: { ...legacyHeader(), id: otherPublicationId },
    },
    {
      change: "identificatore progetto mancante",
      header: { ...legacyHeader(), id: undefined },
    },
    {
      change: "numero progetto mancante",
      header: { ...legacyHeader(), projectNumber: undefined },
    },
    {
      change: "numero progetto non testuale",
      header: { ...legacyHeader(), projectNumber: 123 },
    },
    {
      change: "procedura mancante",
      header: { ...legacyHeader(), processType: undefined },
    },
    {
      change: "procedura non testuale",
      header: { ...legacyHeader(), processType: 123 },
    },
  ])(
    "rifiuta header con $change senza inventare una chiusura",
    async ({ header }) => {
      const previous = previousPublication();
      const unchanged = structuredClone(previous);
      respondWith(header);

      await expect(simap.refresh!(previous)).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(previous).toEqual(unchanged);
      expect(previous.status).toBe("open");
    },
  );

  it("riconosce l’annullamento soltanto dal dettaglio esplicito", async () => {
    respondWith(
      lotHeader(),
      publicationDetail(latestPublicationId, "abandonment"),
    );

    const refreshed = await simap.refresh!(previousPublication());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed.status).toBe("cancelled");
    expect(refreshed.externalId).toBe(projectId);
  });
});

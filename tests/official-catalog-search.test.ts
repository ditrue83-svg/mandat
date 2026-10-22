import { afterEach, expect, it, vi } from "vitest";
import { searchOfficialCatalog } from "../src/lib/official-catalog-search";
const id = "11111111-1111-4111-8111-111111111111",
  foreign = "11111111-1111-4111-8111-111111111112";
const raw = (projectId = id) => ({
  id: projectId,
  publicationId: "22222222-2222-4222-8222-222222222222",
  publicationDate: "2026-04-01",
  projectNumber: "DEMO",
  pubType: "tender",
  processType: "open",
  title: { it: "Titolo che non contiene il termine cercato" },
  procOfficeName: { it: "Ente inventato" },
  orderAddress: { cantonId: projectId === id ? "TI" : "ZH" },
});
afterEach(() => vi.unstubAllGlobals());
it("uses the official engine in all languages and scopes, including matches outside the current title", async () => {
  const urls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(new URL(url));
      return Response.json({
        projects: [raw()],
        pagination: { lastItem: null },
      });
    }),
  );
  const results = await searchOfficialCatalog("giardino", false, new Set());
  expect(urls).toHaveLength(3);
  expect(
    urls.every(
      (u) =>
        u.searchParams.get("search") === "giardino" &&
        !u.searchParams.has("lang") &&
        !u.searchParams.has("newestPublicationFrom"),
    ),
  ).toBe(true);
  expect(results[0].state).toBe("complete");
  expect(results[0].hits[0]).toMatchObject({
    id: `simap-${id}`,
    status: "unverified",
  });
  expect(results[0].hits[0]).not.toHaveProperty("deadline");
  expect(results[0].hits[0]).not.toHaveProperty("assessment");
});
it("does not admit a new non-Ticino project from the national keyword scope", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      Response.json({
        projects: new URL(url).searchParams.size === 1 ? [raw(foreign)] : [],
        pagination: { lastItem: null },
      }),
    ),
  );
  expect(
    (await searchOfficialCatalog("giardino", false, new Set()))[0].hits,
  ).toEqual([]);
  expect(
    (await searchOfficialCatalog("giardino", false, new Set([foreign])))[0]
      .hits,
  ).toHaveLength(1);
});
it("reports an incomplete source instead of returning a confident empty result on HTTP failures", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 503 })),
  );
  expect(
    (await searchOfficialCatalog("giardino", true, new Set())).map(
      (s) => s.state,
    ),
  ).toEqual(["unavailable", "unavailable"]);
});
it("preserves successful independent scopes when one fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      new URL(url).searchParams.has("issuedByOrganizations")
        ? new Response("", { status: 503 })
        : Response.json({ projects: [raw()], pagination: { lastItem: null } }),
    ),
  );
  const [r] = await searchOfficialCatalog("giardino", false, new Set());
  expect(r.state).toBe("partial");
  expect(r.hits).toHaveLength(1);
});
it("handles short queries explicitly without sending invalid SIMAP requests", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect((await searchOfficialCatalog("ab", false, new Set()))[0].state).toBe(
    "query-too-short",
  );
  expect(fetch).not.toHaveBeenCalled();
});
it("searches all published and cancelled Foglio history without a publication-date cutoff", async () => {
  const urls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url);
      urls.push(u);
      if (u.hostname === "www.simap.ch")
        return Response.json({ projects: [], pagination: { lastItem: null } });
      const cancelled = u.searchParams.get("publicationStates") === "CANCELLED";
      return new Response(
        `<bulk-export><total>${cancelled ? 0 : 1}</total>${cancelled ? "" : `<publication><meta><id>${id}</id><publicationNumber>OB-TI10-demo</publicationNumber><publicationDate>2021-01-01</publicationDate><publicationState>PUBLISHED</publicationState><subRubric>OB-TI10</subRubric><title><it>Bando - Esempio inventato</it></title></meta></publication>`}</bulk-export>`,
      );
    }),
  );
  const r = await searchOfficialCatalog("giardino", true, new Set());
  const f = r.find((s) => s.source === "foglio-ti")!;
  expect(f.state).toBe("complete");
  expect(f.hits).toHaveLength(1);
  expect(f.hits[0].status).toBe("unverified");
  expect(
    urls
      .filter((u) => u.hostname === "amtsblattportal.ch")
      .every(
        (u) =>
          u.searchParams.get("keyword") === "giardino" &&
          u.searchParams.get("rubrics") === "OB-TI" &&
          u.searchParams.get("tenant") === "kabti" &&
          !u.searchParams.has("publicationDate.start"),
      ),
  ).toBe(true);
});

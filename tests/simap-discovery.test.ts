import { afterEach, expect, it, vi } from "vitest";
import { simap, normalizeSimap } from "../src/sources/simap";
import { needsSimapDetail } from "../src/sources/simap-discovery";
const id = "11111111-1111-4111-8111-111111111111",
  pub = "22222222-2222-4222-8222-222222222222";
const raw = {
  id,
  publicationId: pub,
  publicationDate: "2024-09-01",
  projectNumber: "TEST",
  pubType: "competition",
  processType: "open",
  title: { it: "Concorso inventato" },
  procOfficeName: { it: "Ente inventato" },
};
afterEach(() => vi.unstubAllGlobals());
it("scans all pages, dates and project types in TI, Ticino issuers, Ticino and Tessin and deduplicates", async () => {
  const urls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      urls.push(url);
      const last = url.searchParams.get("lastItem");
      return Response.json({
        projects: last ? [] : [raw],
        pagination: { lastItem: last ? null : "cursor" },
      });
    }),
  );
  const rows = await simap.list(new Date("2030-01-01"));
  expect(rows).toHaveLength(1);
  expect(urls).toHaveLength(8);
  for (const url of urls) {
    expect(url.searchParams.has("projectSubTypes")).toBe(false);
    expect(url.searchParams.has("newestPublicationFrom")).toBe(false);
  }
  expect(
    urls.some((u) => u.searchParams.get("orderAddressCantons") === "TI"),
  ).toBe(true);
  expect(
    urls.some(
      (u) =>
        u.searchParams.get("issuedByOrganizations") ===
        "1306538b-12b9-4874-801c-9d0e4fa18a4d",
    ),
  ).toBe(true);
  expect(urls.some((u) => u.searchParams.get("search") === "Tessin")).toBe(
    true,
  );
});
it("fails visibly on repeated pagination instead of accepting a partial inventory", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ projects: [raw], pagination: { lastItem: "loop" } }),
    ),
  );
  await expect(simap.list(new Date())).rejects.toThrow(
    "Paginazione simap ripetuta",
  );
});
it.each(["tender", "competition", "study_contract"])(
  "keeps an open %s discoverable with its original deadline",
  (type) => {
    const p = normalizeSimap(
      { id, raw: { ...raw, pubType: type } },
      {
        id: pub,
        type,
        dates: { offerDeadline: "2030-12-01T12:00:00+01:00" },
        procurement: { orderDescription: { it: "Oggetto pubblico" } },
      },
    );
    expect(p.status).toBe("open");
    expect(p.deadline).toBe("2030-12-01T11:00:00.000Z");
  },
);
it("does not turn an award or information request into an open tender", () => {
  for (const type of ["award", "request_for_information", "advance_notice"]) {
    const p = normalizeSimap(
      { id, raw: { ...raw, pubType: type } },
      { id: pub, type },
    );
    expect(p.status).not.toBe("open");
  }
});
it("never skips a missing, changed or still-open notice, even outside the date window", () => {
  const e = { id, raw };
  const since = new Date("2030-01-01"),
    now = new Date("2030-02-01");
  const old = { sourcePublicationId: pub, status: "awarded", deadline: null };
  expect(needsSimapDetail(e, undefined, since, now)).toBe(true);
  expect(
    needsSimapDetail(e, { ...old, sourcePublicationId: null }, since, now),
  ).toBe(true);
  expect(
    needsSimapDetail(e, { ...old, sourcePublicationId: id }, since, now),
  ).toBe(true);
  expect(needsSimapDetail(e, { ...old, status: "open" }, since, now)).toBe(
    true,
  );
  expect(
    needsSimapDetail(
      e,
      { ...old, status: "open", deadline: new Date("2031-01-01") },
      since,
      now,
    ),
  ).toBe(true);
  expect(needsSimapDetail(e, old, since, now)).toBe(false);
  expect(
    needsSimapDetail(
      { id, raw: { ...raw, publicationDate: "2030-01-31" } },
      old,
      since,
      now,
    ),
  ).toBe(true);
});
it("rejects an empty page that still advertises a continuation", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ projects: [], pagination: { lastItem: "more" } }),
    ),
  );
  await expect(simap.list(new Date())).rejects.toThrow(
    "pagina vuota con cursore",
  );
});
it("does not overwrite a later canton edition with an older keyword hit", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) =>
      Response.json({
        projects: [
          {
            ...raw,
            publicationDate: new URL(input).searchParams.has("search")
              ? "2024-01-01"
              : "2025-01-01",
          },
        ],
        pagination: { lastItem: null },
      }),
    ),
  );
  expect((await simap.list(new Date()))[0].raw.publicationDate).toBe(
    "2025-01-01",
  );
});

import { afterEach, expect, it, vi } from "vitest";
import { foglio } from "../src/sources/foglio";
const row = (n: number, state = "PUBLISHED") =>
  `<publication><meta><id>11111111-1111-4111-8111-${String(n).padStart(12, "0")}</id><publicationNumber>OB-TI10-${n}</publicationNumber><publicationDate>2021-01-01</publicationDate><publicationState>${state}</publicationState><subRubric>OB-TI10</subRubric><title><it>Bando - ${n}</it></title></meta></publication>`;
afterEach(() => vi.unstubAllGlobals());
it("reconciles every page of the full published and cancelled inventory, including notices older than since", async () => {
  const urls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const u = new URL(input);
      urls.push(u);
      const state = u.searchParams.get("publicationStates"),
        page = u.searchParams.get("pageRequest.page");
      return new Response(
        state === "CANCELLED"
          ? `<bulk-export><total>1</total>${row(102, "CANCELLED")}</bulk-export>`
          : `<bulk-export><total>101</total>${page === "0" ? Array.from({ length: 100 }, (_, i) => row(i + 1)).join("") : row(101)}</bulk-export>`,
      );
    }),
  );
  const rows = await foglio.list(new Date("2026-01-01"));
  expect(rows).toHaveLength(102);
  expect(urls).toHaveLength(3);
  expect(urls.every((u) => !u.searchParams.has("publicationDate.start"))).toBe(
    true,
  );
  expect(rows.at(-1)?.raw.meta).toMatchObject({
    publicationState: "CANCELLED",
  });
});
it("does not accept a repeated page as complete history", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          `<bulk-export><total>101</total>${Array.from({ length: 100 }, (_, i) => row(i + 1)).join("")}</bulk-export>`,
        ),
    ),
  );
  await expect(foglio.list(new Date())).rejects.toThrow("pagina ripetuta");
});
it("does not accept an advertised total that is not accounted for by returned identifiers", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(`<bulk-export><total>90</total>${row(1)}</bulk-export>`),
    ),
  );
  await expect(foglio.list(new Date())).rejects.toThrow(
    "Conteggio Foglio Ufficiale non riconciliato",
  );
});

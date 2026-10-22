import { expect, it } from "vitest";
import { planFoglioDetails } from "../src/sources/foglio-discovery";
const entries = Array.from({ length: 320 }, (_, i) => ({
  id: String(i),
  raw: { meta: { publicationState: "PUBLISHED" } },
}));
it("discovers the whole history while bounding new detail backfill", () => {
  const p = planFoglioDetails(entries, [], null);
  expect(p.discovered).toBe(320);
  expect(p.entries).toHaveLength(100);
  expect(p.deferredCount).toBe(220);
});
it("prioritizes the newest changed records, active notices and old cancellations, then rotates every other archive", () => {
  const input = entries.map((e) => ({
    ...e,
    raw: {
      meta: { publicationState: e.id === "319" ? "CANCELLED" : "PUBLISHED" },
    },
  }));
  const collected = entries.map((e) => ({
    externalId: e.id,
    status: e.id === "318" ? "open" : "closed",
    deadline: null,
  }));
  const first = planFoglioDetails(input, collected, null);
  expect(first.entries.map((e) => e.id)).toEqual(
    expect.arrayContaining(["0", "39", "318", "319"]),
  );
  const visited = new Set(first.entries.map((e) => e.id));
  let cursor = first.nextCursor;
  for (let i = 0; i < 6; i++) {
    const p = planFoglioDetails(input, collected, cursor);
    p.entries.forEach((e) => visited.add(e.id));
    cursor = p.nextCursor;
  }
  expect(visited.size).toBe(320);
  expect(first.deferredCount).toBe(0);
});
it("does not indefinitely prioritize expired open-labelled notices", () => {
  const c = entries.map((e) => ({
    externalId: e.id,
    status: "open",
    deadline: new Date("2020-01-01"),
  }));
  const p = planFoglioDetails(entries, c, null, new Date("2026-01-01"));
  expect(p.entries).toHaveLength(100);
});
it("a missing/deleted cursor restarts a complete rotation safely", () => {
  const c = entries.map((e) => ({ externalId: e.id, status: "closed" }));
  expect(planFoglioDetails(entries, c, "gone").entries).toEqual(
    planFoglioDetails(entries, c, null).entries,
  );
});
it("permanent failures in the first backfill batch cannot starve the remaining historical notices", () => {
  const first = planFoglioDetails(entries, [], null);
  const second = planFoglioDetails(entries, [], first.nextCursor);
  expect(first.entries.map((e) => e.id)).toContain("99");
  expect(second.entries.map((e) => e.id)).toContain("100");
  const visited = new Set(first.entries.map((e) => e.id));
  let cursor = first.nextCursor;
  for (let i = 0; i < 5; i++) {
    const p = planFoglioDetails(entries, [], cursor);
    p.entries.forEach((e) => visited.add(e.id));
    cursor = p.nextCursor;
  }
  expect(visited.size).toBe(320);
});

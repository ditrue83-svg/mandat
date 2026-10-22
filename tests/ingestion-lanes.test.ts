import { expect, it } from "vitest";
import { planFoglioLane } from "../src/sources/foglio-discovery";
const now = new Date("2030-01-01T12:00:00Z");
const entries = Array.from({ length: 300 }, (_, i) => ({
  id: String(i),
  raw: {
    meta: { publicationDate: "2021-01-01", publicationState: "PUBLISHED" },
  },
}));
it("keeps late-arriving new tenders and old newly-updated notices in the current lane, with no archive overlap", () => {
  const input = [
    ...entries,
    {
      id: "new",
      raw: {
        meta: { publicationDate: "2030-01-01", publicationState: "PUBLISHED" },
      },
    },
  ];
  const current = planFoglioLane(input, [], null, "current", now);
  const archive = planFoglioLane(input, [], null, "archive", now);
  expect(current.entries.map((e) => e.id)).toContain("new");
  expect(current.entries.map((e) => e.id)).toContain("0");
  expect(
    archive.entries.some((e) => current.entries.some((c) => c.id === e.id)),
  ).toBe(false);
  expect(current.entries).toHaveLength(41);
  expect(archive.entries).toHaveLength(80);
});
it("resumes immediately after the last attempted historical notice when a slice ends early", () => {
  const first = planFoglioLane(entries, [], null, "archive", now);
  first.completeEntry("40");
  const p = first.progress();
  expect(p.nextCursor.backfill).toBe("40");
  expect(p.remainingSelected).toBe(79);
  expect(
    planFoglioLane(entries, [], p.nextCursor, "archive", now).entries[0].id,
  ).toBe("41");
});
it("does not repeatedly prioritize old unknown deadlines; rechecks them in the archive lane", () => {
  const known = entries.map((e) => ({
    externalId: e.id,
    status: "open",
    deadline: null,
  }));
  const current = planFoglioLane(entries, known, null, "current", now);
  expect(current.entries).toHaveLength(40);
  expect(
    planFoglioLane(entries, known, null, "archive", now).entries,
  ).toHaveLength(20);
});
it("advances the current cursor without discarding either historical cursor", () => {
  const known = entries.map((e) => ({ externalId: e.id, status: "closed" }));
  const previous = { archive: "95", backfill: "250", current: null };
  const lane = planFoglioLane(entries, known, previous, "current", now);
  lane.completeEntry("0");
  const p = lane.progress();
  expect(p.nextCursor).toEqual({
    archive: "95",
    backfill: "250",
    current: "0",
  });
  expect(
    planFoglioLane(entries, known, p.nextCursor, "current", now).entries[0].id,
  ).toBe("1");
});

import { expect, it } from "vitest";
import { sourceEdition } from "../src/lib/source-edition";
import {
  compareCanonicalPublications,
  type CanonicalPublication,
} from "../src/lib/canonical-publication";
const source = (
  id: string,
  values: Partial<CanonicalPublication> = {},
): CanonicalPublication => ({
  id,
  canonicalId: "invented-project",
  source: "simap",
  documentarySnapshotId: null,
  data: { publishedAt: "2026-09-01T06:00:00Z" },
  updatedAt: new Date("2026-09-01T07:00:00Z"),
  ...values,
});
it("an adopted refusal or not-yet-matched copy takes precedence without consulting a positive legacy score", () => {
  const oldAdopted = source("adopted", {
    documentarySnapshotId: "immutable-observation",
  });
  const newLegacy = source("legacy", {
    data: { publishedAt: "2026-09-02T06:00:00Z" },
  });
  expect([newLegacy, oldAdopted].sort(compareCanonicalPublications)[0].id).toBe(
    "adopted",
  );
});
it("closing an old edition later does not make its receipt time the new publication date", () => {
  const old = source("old", {
    source: "foglio-ti",
    updatedAt: new Date("2026-09-03T12:00:00Z"),
  });
  const current = source("current", {
    source: "foglio-ti",
    data: { publishedAt: "2026-09-02T06:00:00Z" },
  });
  expect([old, current].sort(compareCanonicalPublications)[0].id).toBe(
    "current",
  );
});
it("two adopted versions choose the later official publication, independently of state or judgment", () => {
  const before = source("before", {
    documentarySnapshotId: "first",
    updatedAt: new Date("2026-09-04T12:00:00Z"),
  });
  const after = source("after", {
    documentarySnapshotId: "second",
    data: { publishedAt: "2026-09-03T06:00:00Z" },
  });
  expect([before, after].sort(compareCanonicalPublications)[0].id).toBe(
    "after",
  );
});
it("uses simap preference and a deterministic id tie-break, with no status or score preference", () => {
  const official = source("simap");
  const foglio = source("foglio", {
    source: "foglio-ti",
    data: { publishedAt: "2026-09-05T06:00:00Z" },
  });
  expect([foglio, official].sort(compareCanonicalPublications)[0].id).toBe(
    "simap",
  );
  expect(
    [source("b"), source("a")]
      .sort(compareCanonicalPublications)
      .map((v) => v.id),
  ).toEqual(["a", "b"]);
});
it.each([false, true])(
  "uses the source edition before receipt time for copies published on the same date (adopted=%s)",
  (adopted) => {
    const old = source("old", {
      source: "foglio-ti",
      documentarySnapshotId: adopted ? "previous-observation" : null,
      data: { publishedAt: "2026-09-01T06:00:00Z", projectId: "123456-41" },
      updatedAt: new Date("2026-09-03T12:00:00Z"),
    });
    const current = source("current", {
      source: "foglio-ti",
      documentarySnapshotId: adopted ? "current-observation" : null,
      data: { publishedAt: "2026-09-01T06:00:00Z", projectId: "123456-42" },
    });
    expect([old, current].sort(compareCanonicalPublications)[0].id).toBe(
      "current",
    );
  },
);

it.each([
  "10000000-0000-4000-8000-999999999999",
  "10000000-0000-4000-8000-999e99999999",
])("does not turn a simap UUID tail into an edition: %s", (projectId) => {
  const old = source("old", {
    documentarySnapshotId: "previous-observation",
    data: { publishedAt: "2026-09-01T06:00:00Z", projectId },
  });
  const current = source("current", {
    documentarySnapshotId: "current-observation",
    data: {
      publishedAt: "2026-09-01T06:00:00Z",
      projectId: "10000000-0000-4000-8000-aaaaaaaaaaaa",
    },
    updatedAt: new Date("2026-09-01T08:00:00Z"),
  });
  expect([old, current].sort(compareCanonicalPublications)[0].id).toBe(
    "current",
  );
});

it("recognizes only an explicit, safe Foglio publication edition", () => {
  expect(sourceEdition({ source: "foglio-ti", projectId: "123456-02" })).toBe(
    2,
  );
  for (const projectId of [
    undefined,
    "123456",
    "123456-2e3",
    "123456-9007199254740992",
    "10000000-0000-4000-8000-999999999999",
  ]) {
    expect(sourceEdition({ source: "foglio-ti", projectId })).toBe(0);
  }
  expect(sourceEdition({ source: "simap", projectId: "123456-42" })).toBe(0);
});

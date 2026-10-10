import { expect, it } from "vitest";
import { assessmentLocation } from "../src/lib/assessment-location";
import type { PreliminaryProjectMatch } from "../src/lib/project-matching";
import type { PreliminaryLotMatch } from "../src/lib/lot-matching";

function project(city: unknown): PreliminaryProjectMatch {
  return {
    eligible: true,
    requiresReview: false,
    reason: "Fixture",
    operationalInputHash: "unchanged",
    reviewReasons: [],
    automaticReviewReasons: [],
    signals: { sectors: [], keyword: false },
    operational: {
      country: "CH",
      canton: "TI",
      zone: null,
      cpv: [],
      deadline: null,
      valueChf: null,
    },
    evidence: [
      {
        scope: "project_context",
        purpose: "location",
        presence: "present",
        rawPath: "/procurement/orderAddress",
        url: "https://example.invalid/source",
        value: { countryId: "CH", cantonId: "TI", city },
      },
    ],
  };
}
it("shows an original locality even when no district mapping exists", () => {
  const input = project("Porza"),
    before = JSON.stringify(input);
  expect(assessmentLocation(input, "project")).toBe("Porza · TI");
  expect(JSON.stringify(input)).toBe(before);
});
it("retains the known canton when the original city is absent or malformed", () => {
  for (const city of [null, "", { unknown: "Porza" }, ["Porza"], 123])
    expect(assessmentLocation(project(city), "project")).toBe("TI");
});
it("preserves translated city labels without choosing a territory", () => {
  expect(
    assessmentLocation(
      project({ it: "Bellinzona", de: "Bellinzona", fr: "Bellinzone" }),
      "project",
    ),
  ).toBe("Bellinzona / Bellinzone · TI");
});
it("does not revive an address cleared by the operational conflict check", () => {
  const input = project("Porza");
  input.operational.country = null;
  input.operational.canton = null;
  expect(assessmentLocation(input, "project")).toBe("Luogo da verificare");
});
it("does not treat a description-only address as a structured work location", () => {
  const input = project("Porza");
  input.evidence = [
    ...input.evidence,
    {
      ...input.evidence[0]!,
      rawPath: "/procurement/orderAddressOnlyDescription",
      value: "yes",
    },
  ];
  expect(assessmentLocation(input, "project")).toBe("TI");
});
it("shows the selected lot locality without using a project or buyer address", () => {
  const parentAddress = {
    ...project("Parent city").evidence[0]!,
    purpose: "location" as const,
  };
  const input: PreliminaryLotMatch = {
    ...project("Parent city"),
    operational: { ...project(null).operational, deadline: null },
    evidence: [
      parentAddress,
      {
        scope: "selected_lot",
        purpose: "location",
        rawPath: "/lots/1/orderAddress",
        url: "https://example.invalid/lot",
        value: { city: "Porza" },
      },
    ],
  };
  expect(assessmentLocation(input, "lot")).toBe("Porza · TI");
  input.evidence = [parentAddress];
  expect(assessmentLocation(input, "lot")).toBe("TI");
});

it("shows the original description-only execution text without assigning a city or district", () => {
  const input = project(null);
  input.operational.country = null;
  input.operational.canton = null;
  input.evidence = [
    {
      ...input.evidence[0]!,
      rawPath: "/procurement/orderAddressDescription",
      value: {
        it: "Nei locali dell’offerente",
        de: "In den Räumlichkeiten des Anbieters",
      },
    },
    {
      ...input.evidence[0]!,
      rawPath: "/procurement/orderAddressOnlyDescription",
      value: "yes",
    },
  ];
  const before = JSON.stringify(input);
  expect(assessmentLocation(input, "project")).toBe(
    "Nei locali dell’offerente / In den Räumlichkeiten des Anbieters",
  );
  expect(input.operational.zone).toBe(null);
  expect(JSON.stringify(input)).toBe(before);
});

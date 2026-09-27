import { expect, it } from "vitest";
import {
  demoProfile,
  getDemoOpportunities,
  matchesDemoProfile,
} from "../src/lib/demo";

const now = new Date("2030-01-01T12:00:00Z");
const item = getDemoOpportunities(now)[0];

it("filters demo activities and preserves territory, exclusions and amount choices", () => {
  expect(matchesDemoProfile(item, demoProfile, now)).toBe(true);
  expect(
    matchesDemoProfile(item, { ...demoProfile, sectors: ["catering"] }, now),
  ).toBe(false);
  expect(
    matchesDemoProfile(
      item,
      { ...demoProfile, sectors: ["catering"], keywords: [item.title] },
      now,
    ),
  ).toBe(true);
  expect(
    matchesDemoProfile(item, { ...demoProfile, zones: ["Mendrisiotto"] }, now),
  ).toBe(false);
  expect(
    matchesDemoProfile(item, { ...demoProfile, exclusions: [item.title] }, now),
  ).toBe(false);
  expect(
    matchesDemoProfile(
      { ...item, valueChf: 100 },
      { ...demoProfile, minValue: 200 },
      now,
    ),
  ).toBe(false);
  expect(
    matchesDemoProfile(
      { ...item, valueChf: null },
      { ...demoProfile, minValue: 200 },
      now,
    ),
  ).toBe(true);
});

it("never uses demo filtering to admit real, closed or embargoed opportunities", () => {
  for (const change of [
    { assessment: "ai" },
    { status: "cancelled" },
    { status: "awarded" },
    { deadline: now.toISOString() },
    { visibleAt: new Date(now.getTime() + 1).toISOString() },
    { canton: "GE" },
  ] as const)
    expect(matchesDemoProfile({ ...item, ...change }, demoProfile, now)).toBe(
      false,
    );
});

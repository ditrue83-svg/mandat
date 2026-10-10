import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "vitest";
import { preliminaryProjectMatch } from "../src/lib/project-matching";
import {
  captureLotSourceSnapshot,
  resolveLotSourceContext,
} from "../src/lib/lot-source-context";
import { preserveSimapLots } from "../src/lib/source-lots";

// Exact original material; this offline fixture is not an AI approval.
const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/snow-operational-original.json", import.meta.url),
    "utf8",
  ),
);
const { case: original, source, profile, observationId } = fixture;
function run(raw = source.raw, overrides = {}, pubOverrides = {}) {
  const snapshot = captureLotSourceSnapshot({
    publicationId: source.publication.id,
    observationId: observationId,
    sourceScopeReview: null,
    acquisition: {
      state: "accepted",
      archive: preserveSimapLots(raw, source.identity),
    },
  });
  const context = resolveLotSourceContext(snapshot, original.target, []);
  return preliminaryProjectMatch({
    publication: { ...source.publication, ...pubOverrides },
    profile: { ...profile, ...overrides },
    context,
    now: new Date(original.effectiveAt),
  });
}

test("Original snow case: precise execution area and absent visit leave no automatic hold; source review remains mandatory", () => {
  const before = JSON.stringify({ original, source, profile });
  const result = run();
  assert.equal(result.eligible, true);
  assert.deepEqual(result.automaticReviewReasons, []);
  assert.deepEqual(
    [
      result.operational.country,
      result.operational.canton,
      result.operational.zone,
    ],
    ["CH", "TI", "Leventina"],
  );
  assert.equal(result.requiresReview, true); // no source review event fabricated
  for (const key of [
    "/procurement/orderAddressDescription",
    "/terms/walkThroughNotes",
  ])
    assert.deepEqual(
      result.evidence.find((e) => e.rawPath === key)?.value,
      key.endsWith("walkThroughNotes")
        ? source.raw.terms.walkThroughNotes
        : source.raw.procurement.orderAddressDescription,
    );
  assert.equal(JSON.stringify({ original, source, profile }), before);
});

test("Structured and editorial contradictions cannot be erased by an execution-area description", () => {
  for (const change of [
    { countryId: "IT" },
    { cantonId: "ZH" },
    { city: { it: "Zürich" } },
    { cantonId: "XX" },
    { postalCode: "8000" },
  ]) {
    const raw = structuredClone(source.raw);
    raw.procurement.orderAddress = {
      ...raw.procurement.orderAddress,
      ...change,
    };
    const result = run(raw);
    assert.ok(result.automaticReviewReasons.length);
    assert.equal(result.operational.canton, null);
  }
  for (const publication of [{ canton: "ZH" }, { zone: "Luganese" }]) {
    const result = run(source.raw, {}, publication);
    assert.ok(result.automaticReviewReasons.length);
    assert.equal(result.operational.canton, null);
  }
});

test("Qualifications, conflicting translations and unknown execution areas remain review", () => {
  for (const change of [
    {
      it:
        source.raw.procurement.orderAddressDescription.it +
        " Altri luoghi da concordare.",
    },
    { fr: "Secteur E32 (Zurich)." },
    { it: "Il fornitore ha sede in alta Leventina." },
    { it: "Settore E32 (Luogo da concordare)." },
  ]) {
    const raw = structuredClone(source.raw);
    raw.procurement.orderAddressDescription = {
      ...raw.procurement.orderAddressDescription,
      ...change,
    };
    assert.ok(
      run(raw).automaticReviewReasons.includes(
        "Luogo di esecuzione del progetto da verificare.",
      ),
    );
  }
});

test("A recognized area still enforces profile zones and the frozen clock", () => {
  assert.equal(run(source.raw, { zones: ["Luganese"] }).eligible, false);
  assert.equal(run(source.raw, { zones: ["Leventina"] }).eligible, true);
  assert.equal(run().eligible, true);
  const raw = structuredClone(source.raw);
  raw.dates.offerDeadline = "2026-08-13T11:00:00+02:00";
  assert.equal(
    run(raw, {}, { deadline: "2026-08-13T09:00:00.000Z" }).eligible,
    false,
  );
});

test("Additional attendance obligations and language disagreement keep the visit hold", () => {
  for (const note of [
    {
      it:
        source.raw.terms.walkThroughNotes.it + " Partecipazione obbligatoria.",
    },
    { fr: "Visite obligatoire le 4 mai." },
    { it: "Nessun sopralluogo previsto. Si assume la conoscenza dei luoghi." },
  ]) {
    const raw = structuredClone(source.raw);
    raw.terms.walkThroughNotes = { ...raw.terms.walkThroughNotes, ...note };
    assert.ok(
      run(raw).automaticReviewReasons.some((r) => r.includes("sopralluogo")),
    );
  }
});

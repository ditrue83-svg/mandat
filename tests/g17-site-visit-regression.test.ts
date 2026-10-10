import assert from "node:assert/strict";
import { test } from "vitest";
import { explicitlyNoSiteVisit } from "../src/lib/site-visit-notes";
import {
  captureLotSourceSnapshot,
  resolveLotSourceContext,
} from "../src/lib/lot-source-context";
import { preliminaryAssessmentMatch } from "../src/lib/lot-assessment";

const notes = {
  it: "non viene effettuata alcun sopraluogo.",
  de: "Es findet keine Begehung statt.",
  fr: null,
  en: null,
};
test("Complete Italian and German absence statements resolve attendance", () => {
  assert.equal(explicitlyNoSiteVisit(notes), true);
});
test.each([
  { ...notes, it: notes.it + " La partecipazione è obbligatoria." },
  {
    ...notes,
    de: notes.de + " Eine Begehung ist am 12. August obligatorisch.",
  },
  { ...notes, it: "non viene effettuata alcun sopraluogo il 12 agosto." },
  { ...notes, fr: "Visite obligatoire." },
  { ...notes, de: "Es findet keine Begehung statt, außer auf Anfrage." },
])(
  "G17 additional conditions and conflicting languages retain review: %j",
  (value) => {
    assert.equal(explicitlyNoSiteVisit(value), false);
  },
);

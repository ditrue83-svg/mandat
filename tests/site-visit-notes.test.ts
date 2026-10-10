import assert from "node:assert/strict";
import { test } from "vitest";
import {
  explicitlyNoSiteVisit,
  explicitlyUnscheduledIndividualVisit,
} from "../src/lib/site-visit-notes";

test.each([
  { it: "Sopralluogo non previsto" },
  { it: "Non è previsto alcun sopralluogo." },
  { it: "Non sono previsti sopralluoghi." },
  { it: "<p>Non è previsto nessun sopralluogo.</p>" },
  { it: "Nessun sopralluogo.\n" },
  { it: "NESSUN SOPRALLUOGO PREVISTO." },
  { fr: "Aucune visite des lieux n’est prévue." },
  { de: "Es ist keine Begehung vorgesehen." },
  { en: "No site visit is scheduled." },
  { it: "Nessun sopralluogo", de: null, fr: "", en: " <br> \n" },
  { it: "Nessun sopralluogo.", fr: "Aucune visite n'est prévue." },
  "Nessun sopralluogo.",
])("A complete absence statement needs no visit review: %j", (value) => {
  assert.equal(explicitlyNoSiteVisit(value), true);
});

test.each([
  null,
  {},
  { it: null },
  { it: 0 },
  { xx: "Nessun sopralluogo." },
  ["Nessun sopralluogo."],
  { it: "Nessun sopralluogo previsto, salvo convocazione successiva." },
  { it: "Nessun sopralluogo previsto. Sopralluogo individuale obbligatorio." },
  { it: "Non è vero che non è previsto alcun sopralluogo." },
  { it: "Nessun sopralluogo organizzato." },
  { it: "Nessun sopralluogo.", fr: "Visite obligatoire le 4 mai." },
  { it: "Su richiesta" },
  { it: "Sopralluogo facoltativo." },
  { en: "No site visit is required." },
  { de: "Eine freiwillige Besichtigung ist möglich." },
  { it: "Nessun sopralluogo previsto. Si assume la conoscenza dei luoghi." },
])(
  "Other notes remain for review without inferring attendance: %j",
  (value) => {
    assert.equal(explicitlyNoSiteVisit(value), false);
  },
);

test.each([
  {
    it: "Nessun sopralluogo organizzato. È tuttavia consigliato un sopralluogo individuale.",
  },
  {
    it: "<p>Non è previsto alcun sopralluogo organizzato. È raccomandato un sopralluogo individuale.</p>",
  },
  {
    fr: "Aucune visite organisée n’est prévue. Une visite individuelle est toutefois conseillée.",
  },
  {
    de: "Es ist keine organisierte Begehung vorgesehen. Eine individuelle Begehung wird jedoch empfohlen.",
  },
  {
    en: "No organized site visit is planned. However, an individual site visit is recommended.",
  },
  {
    it: "Nessun sopralluogo organizzato. È consigliato un sopralluogo individuale.",
    fr: "Aucune visite n'est prévue.",
    en: null,
  },
])(
  "Explicit undated individual advice has no attendance obligation: %j",
  (notes) => {
    assert.equal(explicitlyUnscheduledIndividualVisit(notes), true);
  },
);

test.each([
  null,
  {},
  { it: null },
  { it: "Nessun sopralluogo." },
  { it: "Sopralluogo facoltativo il 4 maggio." },
  { it: "Nessun sopralluogo organizzato." },
  {
    it: "Nessun sopralluogo organizzato. È tuttavia consigliato un sopralluogo individuale. Si richiede prenotazione.",
  },
  {
    it: "Nessun sopralluogo organizzato. È obbligatorio un sopralluogo individuale.",
  },
  {
    it: "Nessun sopralluogo organizzato. È consigliato un sopralluogo individuale.",
    de: "Eine Besichtigung ist obligatorisch.",
  },
  {
    xx: "Nessun sopralluogo organizzato. È consigliato un sopralluogo individuale.",
  },
])(
  "Ambiguous, dated or conflicting visit notes keep their review: %j",
  (notes) => {
    assert.equal(explicitlyUnscheduledIndividualVisit(notes), false);
  },
);

import { explicitlyNoVisitWithAssumedKnowledge } from "../src/lib/site-visit-notes";
const knowledge = {
  it: "Nessun sopralluogo previsto. Si assume che gli offerenti conoscano bene il luogo di intervento, le condizioni ambientali e quelle di lavoro valide per la presente commessa.",
  fr: "Aucune visite des lieux n'est prévue. On part du principe que les soumissionnaires connaissent bien le lieu d'intervention, ainsi que les conditions environnementales et de travail applicables au présent marché.",
};
test("No organized visit with a knowledge presumption retains source conditions but resolves attendance", () => {
  assert(explicitlyNoVisitWithAssumedKnowledge(knowledge));
  assert.equal(explicitlyNoSiteVisit(knowledge), false);
  assert.equal(
    explicitlyNoVisitWithAssumedKnowledge({
      ...knowledge,
      it: knowledge.it + " Partecipazione obbligatoria il 4 maggio.",
    }),
    false,
  );
  assert.equal(
    explicitlyNoVisitWithAssumedKnowledge({
      ...knowledge,
      fr: "Visite obligatoire.",
    }),
    false,
  );
  assert.equal(
    explicitlyNoVisitWithAssumedKnowledge({ xx: knowledge.it }),
    false,
  );
  assert.equal(explicitlyNoVisitWithAssumedKnowledge(knowledge.it), false);
});

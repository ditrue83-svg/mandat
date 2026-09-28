import assert from "node:assert/strict";
import { test } from "vitest";
import { explicitlyNoSiteVisit } from "../src/lib/site-visit-notes";

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

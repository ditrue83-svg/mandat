import { expect, it } from "vitest";
import { foglioStatus } from "../src/sources/foglio-lifecycle";
import { normalizeFoglio } from "../src/sources/foglio";
it.each([
  "Bando - Lavori",
  "Bando di concorso per lavori",
  "Concorso - Assicurazioni",
  "Appel d’offres - Assicurazioni",
  "Appel d'offres - Projet",
  "Invitation to tender - Packaging materials",
  "Ausschreibung - Arbeiten",
  "Wettbewerb - Bau",
  "Mandato di studio - Paese",
])(
  "recognises a tender independently of the original language: %s",
  (title) => {
    expect(foglioStatus("PUBLISHED", title)).toBe("open");
  },
);
it.each([
  "Interruzione - Gara",
  "Revoca - Appalto",
  "Annulation - Projet",
  "Révocation - Projet",
  "Abbruch - Bau",
  "Widerruf - Bau",
])("retains negative official lifecycle: %s", (title) =>
  expect(foglioStatus("PUBLISHED", title)).toBe("cancelled"),
);
it("uses the structured official contract notice enum before a generic translated title", () => {
  expect(
    foglioStatus("PUBLISHED", "Bando - Progetto", { selectType: "award" }),
  ).toBe("awarded");
  expect(
    foglioStatus("PUBLISHED", "Tipo non riconosciuto", {
      selectType: "invitationToTender",
    }),
  ).toBe("open");
  expect(
    foglioStatus("CANCELLED", "Bando - Progetto", {
      selectType: "invitationToTender",
    }),
  ).toBe("cancelled");
  expect(
    foglioStatus("PUBLISHED", "Bando - Progetto", [
      { selectType: "award" },
      { selectType: "competition" },
    ]),
  ).toBe("closed");
  expect(
    foglioStatus("PUBLISHED", "Bando - Progetto", {
      selectType: "otherTenderPublication",
    }),
  ).toBe("closed");
});
it("versions an actually changed interpretation so unchanged XML can repair a wrongly closed stored tender", () => {
  const xml = (title: string) =>
    `<publication><meta><id>11111111-1111-4111-8111-111111111111</id><publicationNumber>OB-TI10-DEMO</publicationNumber><subRubric>OB-TI10</subRubric><publicationDate>2026-10-22</publicationDate><publicationState>PUBLISHED</publicationState><title><it>${title}</it></title></meta><content><publication>Testo originale inventato</publication></content></publication>`;
  expect(normalizeFoglio(xml("Concorso - Esempio"))).toMatchObject({
    status: "open",
    revision: expect.stringMatching(/^foglio-lifecycle-v2:/),
  });
  expect(normalizeFoglio(xml("Bando - Esempio")).revision).toMatch(
    /^[a-f0-9]{64}$/,
  );
});

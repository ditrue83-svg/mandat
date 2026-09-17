import { describe, expect, it } from "vitest";
import { demoProfile } from "../src/lib/demo";
import { preliminaryMatch } from "../src/lib/matching";
import { classifySectors } from "../src/sources/common";
import { normalizeSimap } from "../src/sources/simap";
import type { Sector } from "../src/lib/domain";

describe("segnali testuali dei settori a parole intere", () => {
  it.each([
    "Pfahlgründung, Gründung und Begründung.",
    "Die Kabel liegen verdeckt.",
    "Immensamente e prediligere.",
    "Une étude de transportabilité.",
    "An uncleansing test with precleaningdata.",
    "Elektrochemische Messungen.",
    "Potatura2 e 2potatura.",
    "Αpotatura e potaturaЖ.",
    "pulizie_extra e _potatura.",
  ])("non promuove frammenti dentro altre parole: %s", (text) => {
    expect(classifySectors(text, [])).toEqual([]);
  });

  it.each<[string, Sector]>([
    ["Pulizie degli ambienti.", "pulizie"],
    ["Lavori di giardinaggio e potatura.", "giardinaggio"],
    ["Manutenzione periodica.", "manutenzioni"],
    ["Lavori di edilizia e muratura.", "edilizia"],
    ["Interventi elettrici e idraulici.", "impianti"],
    ["Servizi di sorveglianza.", "sicurezza"],
    ["Servizio di ristorazione.", "catering"],
    ["Trasporto di merci.", "trasporti"],
    ["Nettoyage des locaux.", "pulizie"],
    ["Entretien des jardins.", "giardinaggio"],
    ["Transports de voyageurs.", "trasporti"],
    ["Building cleaning.", "pulizie"],
    ["Security guarding.", "sicurezza"],
    ["Passenger transportation.", "trasporti"],
  ])("conserva il segnale completo: %s", (text, sector) => {
    expect(classifySectors(text, [])).toContain(sector);
  });

  it.each<[string, Sector[]]>([
    ["Gebäudereinigung", ["pulizie"]],
    ["Fensterreinigung", ["pulizie"]],
    ["Unterhaltsreinigung", ["pulizie"]],
    ["Grünflächenpflege", ["giardinaggio"]],
    ["Grünanlagenpflege", ["giardinaggio"]],
    ["Grünflächenunterhalt", ["giardinaggio"]],
    ["Gebäudeunterhalt", ["manutenzioni"]],
    ["Elektroinstallationen", ["impianti"]],
    ["Gemeinschaftsverpflegung", ["catering"]],
    ["Schülertransport", ["trasporti"]],
  ])("conserva il composto tedesco esplicito: %s", (text, sectors) => {
    expect(classifySectors(text, [])).toEqual(sectors);
  });

  it("normalizza maiuscole e accenti senza togliere i confini Unicode", () => {
    expect(classifySectors("🪴 GRÜNFLÄCHENPFLEGE / (POTATURA)", [])).toEqual([
      "giardinaggio",
    ]);
    expect(classifySectors("GRU\u0308NFLÄCHENPFLEGE", [])).toEqual([
      "giardinaggio",
    ]);
    expect(classifySectors("l’idraulica; cleaning-service", [])).toEqual([
      "pulizie",
      "impianti",
    ]);
    expect(classifySectors("potatura\u0301", [])).toEqual([]);
  });

  it("mantiene i prefissi CPV principali e secondari indipendenti dai segnali testuali", () => {
    expect(classifySectors("Pfahlgründung", ["45311200"])).toEqual([
      "impianti",
    ]);
    expect(
      classifySectors("Prestazioni secondo capitolato", [
        "15000000",
        "55523100",
      ]),
    ).toEqual(["catering", "alimentari"]);
    expect(classifySectors("Descrizione senza segnale", ["77310000"])).toEqual([
      "giardinaggio",
    ]);
  });

  it("non aggiunge giardinaggio nella normalizzazione e nel prefiltro di opere elettriche inventate", () => {
    const publicationId = "82222222-2222-4222-8222-222222222222";
    const publication = normalizeSimap(
      {
        id: "81111111-1111-4111-8111-111111111111",
        raw: {
          id: "81111111-1111-4111-8111-111111111111",
          publicationId,
          publicationDate: "2030-09-01",
          projectNumber: "INVENTED-BOUNDARIES",
          pubType: "tender",
          processType: "open",
          title: { de: "Elektroinstallationen" },
          procOfficeName: { it: "Ente inventato" },
        },
      },
      {
        id: publicationId,
        type: "tender",
        "project-info": { title: { de: "Elektroinstallationen" } },
        dates: { offerDeadline: "2030-12-01T12:00:00+01:00" },
        procurement: {
          orderDescription: {
            de: "Für das erfundene Bauwerk ist eine Pfahlgründung erforderlich.",
          },
          orderAddress: { city: { it: "Lugano" }, cantonId: "TI" },
        },
      },
    );
    expect(publication.originalText).toContain("Pfahlgründung");
    expect(publication.sectors).toEqual(["impianti"]);
    const result = preliminaryMatch(
      publication,
      {
        ...demoProfile,
        sectors: ["giardinaggio"],
        keywords: [],
        exclusions: [],
      },
      new Date("2030-10-01T12:00:00Z"),
    );
    expect(result).toMatchObject({
      eligible: false,
      score: 0,
      reason: "Nessun segnale di attività riconosciuto dal filtro.",
    });
  });
});

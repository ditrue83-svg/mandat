import { expect, it } from "vitest";
import { SECTORS, type Sector } from "../src/lib/sectors";
import {
  catalogSearchText,
  SECTOR_SEARCH_TERMS,
} from "../src/lib/catalog-search";
import { getDemoOpportunities } from "../src/lib/demo";
import { matchesSearch } from "../src/lib/search";
import { classifyProcurement } from "../src/lib/sector-classification";
const examples: [Sector, string, string][] = [
  ["pulizie", "90910000", "nettoyage"],
  ["giardinaggio", "77310000", "giardiniere"],
  ["manutenzioni", "50700000", "riparazioni"],
  ["edilizia", "45233120", "costruzione"],
  ["impianti", "45310000", "elettricista"],
  ["sicurezza", "79710000", "sorveglianza"],
  ["catering", "55510000", "mensa"],
  ["trasporti", "60100000", "trasporto"],
  ["progettazione", "71322000", "ingegnere"],
  ["informatica", "32422000", "informatica"],
  ["assicurazioni", "66512100", "assicurazione"],
  ["arredi", "39180000", "arredamento"],
  ["abbigliamento", "18130000", "vestiario"],
  ["energia", "09132100", "carburante"],
  ["materiali", "44161200", "materiali"],
  ["veicoli", "34100000", "automezzi"],
  ["sanita", "33124110", "sanitario"],
  ["ambiente", "90513100", "smaltimento"],
  ["alimentari", "15000000", "alimenti"],
  ["ufficio", "30199000", "cancelleria"],
  ["ospitalita", "55100000", "albergo"],
  ["consulenza", "79400000", "consulente"],
];
it("covers every public category exactly once", () => {
  expect(examples.map((e) => e[0]).sort()).toEqual(
    SECTORS.map((s) => s.id).sort(),
  );
  expect(Object.keys(SECTOR_SEARCH_TERMS).sort()).toEqual(
    SECTORS.map((s) => s.id).sort(),
  );
});
it.each(examples)(
  "discovers %s from its official code and ordinary name",
  (sector, cpv, query) => {
    const classification = classifyProcurement({
      titles: ["Oggetto contrattuale"],
      descriptions: [],
      mainCpv: cpv,
      additionalCpv: [],
    });
    expect(classification.sectors).toContain(sector);
    const p = {
      ...getDemoOpportunities()[0],
      title: "Oggetto contrattuale",
      originalText: "Prestazioni previste",
      originalTitles: [],
      originalDescriptions: [],
      sectors: classification.sectors,
      cpv: [cpv],
    };
    const before = JSON.stringify(p);
    const index = catalogSearchText(p);
    expect(matchesSearch(index, query)).toBe(true);
    expect(matchesSearch(index, cpv)).toBe(true);
    expect(JSON.stringify(p)).toBe(before);
  },
);
it("indexes all original languages and lot subjects, without private or legal metadata", () => {
  const p = {
    ...getDemoOpportunities()[0],
    sectors: [],
    originalTitles: [
      {
        language: "de" as const,
        text: "Datenleitungen",
        path: "project-info.title.de",
        url: "https://www.simap.ch",
      },
    ],
    originalDescriptions: [
      {
        language: "fr" as const,
        text: "Fibres optiques",
        url: "https://www.simap.ch",
      },
    ],
    summary: "PRIVATE_AI_SUMMARY",
  };
  const archive = {
    projectSections: {
      procurement: { orderDescription: { en: "Public fibre networks" } },
      terms: { privateNote: "PRIVATE_TERM" },
    },
    directory: [{ id: "lot1", number: 1 }],
    lotField: {
      lots: [
        {
          id: "lot1",
          title: { it: "Moduli ottici" },
          orderDescription: { de: "Glasfaseranschlüsse" },
          cpvCode: { code: "32500000" },
        },
      ],
    },
  };
  const index = catalogSearchText(p, archive);
  for (const query of [
    "Datenleitungen",
    "fibres optiques",
    "fibre networks",
    "moduli ottici",
    "Glasfaseranschlüsse",
    "32500000",
  ])
    expect(matchesSearch(index, query)).toBe(true);
  expect(index).not.toContain("PRIVATE_AI_SUMMARY");
  expect(index).not.toContain("PRIVATE_TERM");
});
it("does not add aliases from unrelated sectors to unclassified notices", () => {
  const p = {
    ...getDemoOpportunities()[0],
    title: "Mandato specifico",
    buyer: "Comune",
    location: "Località",
    originalText: "Dati originali",
    originalTitles: [],
    originalDescriptions: [],
    sectors: [],
    cpv: [],
  };
  expect(matchesSearch(catalogSearchText(p), "assicurazione")).toBe(false);
});
it("recognises a multilingual vehicle supply without inventing a transport-service conflict", () => {
  const c = classifyProcurement({
    titles: [
      "Fornitura di 1 veicolo per il trasporto di utenza",
      "Supply of one vehicle for the transportation of clients.",
    ],
    descriptions: [],
    mainCpv: "34110000",
    additionalCpv: [],
  });
  expect(c.sectors).toEqual(["veicoli"]);
  expect(c.needsClassification).toBe(false);
});

it.each([
  ["Fornitura del materiale di pulizia in carta", "33760000", "pulizie"],
  ["Fornitura di materiale di pulizia in carta", "33772000", "pulizie"],
  ["Assorbenti e tamponi igienici", "33771100", "sanita"],
  ["Fornitura di sacchi per rifiuti", "19640000", "ambiente"],
  [
    "Progetto selvicolturale e gestione neofite invasive",
    "03000000",
    "giardinaggio",
  ],
])(
  "classifies observed official subjects without dropping a category: %s",
  (title, mainCpv, sector) => {
    expect(
      classifyProcurement({
        titles: [title],
        descriptions: [],
        mainCpv,
        additionalCpv: [],
      }).sectors,
    ).toContain(sector);
  },
);

it("bounds discovery diagnostics without truncating their JSON and binds them to the source ID", async () => {
  const { discoveryIssueDetail, readDiscoveryIssue } =
    await import("../src/lib/catalog-discovery");
  const id = "11111111-1111-4111-8111-111111111111";
  const detail = discoveryIssueDetail(
    {
      id,
      raw: {
        title: { it: '"'.repeat(1000) },
        procOfficeName: { it: "Ente" },
        publicationDate: "2026-09-15",
        pubType: "tender",
      },
    },
    "Refused " + "error".repeat(100),
  );
  expect(detail.length).toBeLessThanOrEqual(1400);
  expect(readDiscoveryIssue(`source-item:simap:${id}`, detail)?.id).toBe(id);
  expect(readDiscoveryIssue("source-item:simap:other", detail)).toBeNull();
});

// An application used for planning remains software. A translated purpose
// clause must not turn its purchase into a construction design mandate.
it("preserves the purchased subject before French purpose clauses", () => {
  const result = classifyProcurement({
    titles: [
      "Concorso per la fornitura di un applicativo informatico per la pianificazione e gestione di agende, appuntamenti ambulatoriali e sale operatorie",
      "Appel d’offres pour la fourniture d’une application informatique destinée à la planification et à la gestion des agendas, des rendez-vous ambulatoires et des salles d’opération",
    ],
    descriptions: [], mainCpv: "48000000", additionalCpv: [],
  });
  expect(result.sectors).toEqual(["informatica"]);
  expect(result.needsClassification).toBe(false);
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { briefFixture, briefIdentity } from "./fixtures/tender-brief";
import {
  buildTenderBrief,
  potentialInterest,
  tenderWorkExcerpt,
  type BriefFact,
} from "../src/lib/tender-brief";
import {
  TenderBriefPanels,
  TenderDecisionSummary,
  TenderSourceButton,
} from "../src/components/tender-brief";
import {
  publicLink,
  tenderSourceLink,
  tenderReferenceLink,
} from "../src/lib/tender-source-link";
import { demoViewer } from "../src/lib/demo";
import { preliminaryMatch } from "../src/lib/matching";
const texts = (facts: BriefFact[]) => facts.map((f) => f.text).join("\n");

it("espone lavoro, requisiti, prove, sopralluogo, termini e recapito con citazioni risolvibili", () => {
  const { publication, archive, raw } = briefFixture();
  const brief = buildTenderBrief(publication, archive);
  expect(texts(brief.description)).toContain("Potatura di alberi");
  expect(texts(brief.description)).not.toContain("<p>");
  expect(texts(brief.requirements)).toContain("nei documenti di gara");
  expect(texts(brief.requirements)).toContain(
    "La pubblicazione riporta alcuni criteri di idoneità",
  );
  expect(texts(brief.requirements)).not.toContain(
    "non sono elencati in questa pubblicazione",
  );
  expect(texts(brief.requirements)).toContain("Non ammesso");
  expect(texts(brief.documents)).toContain("Allegare due referenze");
  expect(texts(brief.visits)).toContain(
    "Sopralluogo obbligatorio il 21 settembre 2026 alle 09:15",
  );
  expect(
    brief.deadlines.find((f) => f.label === "Presentazione dell’offerta")?.text,
  ).toContain("09:00");
  expect(texts(brief.submission)).toContain(
    "due copie firmate in busta chiusa",
  );
  expect(
    brief.submission.find((f) => f.label === "Recapito per l’offerta")?.text,
  ).toBe("Ufficio offerte inventato, Via Test 1, 6900, Lugano, CH");
  expect(texts(brief.submission)).not.toContain("domande@example.invalid");
  expect(texts(brief.submission)).not.toContain("documenti@example.invalid");
  expect(texts(brief.submission)).not.toContain("QUESTO NON È IL RECAPITO");
  // Every displayed fact has a real path and an exact quotation in this copy.
  for (const fact of [
    ...brief.description,
    ...brief.requirements,
    ...brief.visits,
    ...brief.deadlines,
    ...brief.submission,
    ...brief.documents,
  ]) {
    expect(fact.source.url).toBe(briefIdentity.detailUrl);
    const value = fact.source.path
      .split("/")
      .slice(1)
      .reduce((v: unknown, key) => (v as Record<string, unknown>)[key], raw);
    if (typeof value === "string") expect(fact.source.quote).toBe(value);
    else expect(JSON.parse(fact.source.quote)).toEqual(value);
  }
});

it("spiega correttamente quando tutti i criteri rinviano ai documenti", () => {
  const { publication, archive } = briefFixture({
    criteria: {
      qualificationCriteriaInDocuments: "yes",
      qualificationCriteria: [],
      qualificationCriteriaNote: null,
    },
  });
  const requirements = texts(
    buildTenderBrief(publication, archive).requirements,
  );
  expect(requirements).toContain(
    "I criteri di idoneità sono nei documenti di gara; non sono elencati in questa pubblicazione.",
  );
  expect(requirements).not.toContain("La pubblicazione riporta alcuni criteri");
});

it("mette in apertura lavoro, fase, sopralluogo e modalità decisive senza perdere i dettagli", () => {
  const { publication, archive } = briefFixture();
  const brief = buildTenderBrief(publication, archive);
  const html = renderToStaticMarkup(
    createElement(TenderDecisionSummary, {
      brief,
      location: publication.location,
    }),
  );
  expect(html).toContain("Le condizioni decisive, in breve");
  expect(html).toContain("Potatura di alberi");
  expect(html).toContain("Presentazione dell’offerta");
  expect(html).toContain("Sopralluogo obbligatorio");
  expect(html).toContain("due copie firmate in busta chiusa");
  expect(html).toContain('href="#brief-submit"');
  expect(html).toContain("Esperienza in manutenzione di parchi");
  expect(html).toContain("Lugano");
});

it("crea una descrizione breve concreta senza ripetere il titolo", () => {
  expect(
    tenderWorkExcerpt({
      title: "Pulizia scuole comunali",
      originalText:
        "Pulizia scuole comunali\n\nServizio giornaliero di pulizia delle aule e delle palestre.",
    }),
  ).toBe("Servizio giornaliero di pulizia delle aule e delle palestre.");
  expect(
    tenderWorkExcerpt({
      title: "Titolo soltanto",
      originalText: "Titolo soltanto",
    }),
  ).toContain("Descrizione dettagliata");
});

it("non usa l’orario di apertura come scadenza e lascia le date senza ora esplicite", () => {
  const { publication, archive } = briefFixture();
  const brief = buildTenderBrief(publication, archive);
  expect(texts(brief.deadlines)).not.toContain("10:00");
  expect(
    brief.deadlines.find((f) => f.label.startsWith("Domande di chiarimento"))
      ?.text,
  ).toContain("orario non indicato");
  expect(
    brief.deadlines.find((f) => f.label === "Documenti disponibili fino al")
      ?.text,
  ).toContain("25 set 2026");
});

it("associa alla data delle domande l’orario pubblicato nella stessa voce", () => {
  const { publication, archive } = briefFixture({
    dates: {
      processType: "open",
      offerDeadline: "2026-10-29T16:00:00+01:00",
      qnas: [{ date: "2026-10-02", note: { it: "ore 16:00" } }],
    },
  });
  const deadlines = buildTenderBrief(publication, archive).deadlines;
  const questions = deadlines.filter((fact) =>
    fact.label.startsWith("Domande di chiarimento"),
  );
  expect(questions).toHaveLength(1);
  expect(questions[0].text).toContain("2 ott 2026 · ore 16:00");
  expect(questions[0].source.path).toContain("/dates/qnas/0");
  expect(deadlines.some((fact) => fact.label === "Come porre le domande")).toBe(
    false,
  );
});

it("mantiene nome, via e città negli indirizzi tradotti di simap", () => {
  const { publication, archive } = briefFixture({
    "project-info": {
      offerAddress: {
        name: { it: "Ufficio inventato", de: null },
        street: { it: "Via Prova 12" },
        city: { it: "Lugano" },
        postalCode: "6900",
        countryId: "CH",
      },
    },
  });
  const address = buildTenderBrief(publication, archive).submission.find(
    (f) => f.label === "Recapito per l’offerta",
  );
  expect(address?.text).toBe(
    "Ufficio inventato, Via Prova 12, 6900, Lugano, CH",
  );
  expect(address?.language).toBe("it");
});

it("nelle procedure selettive mantiene la domanda distinta dall’offerta successiva", () => {
  const { publication, archive } = briefFixture({
    base: {
      id: briefIdentity.publicationId,
      projectId: briefIdentity.projectId,
      lotsType: "without",
      processType: "selective",
    },
    dates: {
      processType: "selective",
      offerDeadline: "2026-12-01T09:00:00+01:00",
    },
    "project-info": {
      processType: "selective",
      offerTypes: ["offer_digital_simap"],
    },
  });
  const brief = buildTenderBrief(publication, archive);
  expect(
    brief.deadlines.find((f) => f.label === "Domanda di partecipazione")?.text,
  ).toContain("Termine non indicato");
  expect(
    brief.deadlines.find((f) => f.label.startsWith("Offerta: fase successiva"))
      ?.text,
  ).toContain("1 dic 2026");
  expect(
    brief.deadlines.some((f) => f.label === "Presentazione dell’offerta"),
  ).toBe(false);
  expect(texts(brief.submission)).toContain("elettronica su simap");
});

it.each([
  "2026-02-30",
  "2026-03-29T02:30:00",
  "2026-10-25T02:30:00",
  "non è una data",
])("non inventa una scadenza da %s", (date) => {
  const { publication, archive } = briefFixture({
    dates: { offerDeadline: date },
  });
  expect(texts(buildTenderBrief(publication, archive).deadlines)).toContain(
    "Data o orario da verificare",
  );
});

it("segnala il termine mancante anche quando è nota la scadenza per le domande", () => {
  const { publication, archive } = briefFixture({
    dates: { qnas: [{ date: "2026-09-18" }] },
  });
  expect(texts(buildTenderBrief(publication, archive).deadlines)).toContain(
    "Termine non indicato",
  );
});

it("segnala procedure discordanti senza nascondere le informazioni della fonte", () => {
  const { publication, archive } = briefFixture({
    dates: {
      processType: "selective",
      participationRequestDeadline: "2026-10-01T10:00:00+02:00",
    },
  });
  expect(texts(buildTenderBrief(publication, archive).deadlines)).toContain(
    "procedure diverse",
  );
});

it("i lotti non ereditano scadenze, sopralluoghi o istruzioni da altri lotti o dal progetto", () => {
  const lotOne = "33000000-0000-4000-8000-000000000003",
    lotTwo = "44000000-0000-4000-8000-000000000004";
  const { publication, archive, raw } = briefFixture({
    base: {
      id: briefIdentity.publicationId,
      projectId: briefIdentity.projectId,
      lotsType: "with",
    },
    lots: [
      {
        id: lotOne,
        lotNumber: 1,
        orderDescription: { it: "Potatura, solo lotto uno." },
        partialOffers: "no",
        terms: { walkThroughNotes: { it: "Sopralluogo del solo lotto uno." } },
      },
      {
        id: lotTwo,
        lotNumber: 2,
        orderDescription: { it: "Impianti, solo lotto due." },
      },
    ],
  });
  const brief = buildTenderBrief(publication, archive);
  expect(brief.lots.map((l) => l.deadlines)).toEqual([[], []]);
  expect(brief.lots.map((l) => l.submission)).toEqual([[], []]);
  expect(brief.lots[1].visits).toEqual([]);
  expect(texts(brief.lots[1].description)).not.toContain("Potatura");
  for (const fact of [...brief.lots[0].requirements, ...brief.lots[0].visits]) {
    const value = fact.source.path
      .split("/")
      .slice(1)
      .reduce((v: unknown, key) => (v as Record<string, unknown>)[key], raw);
    expect(fact.source.quote).toBe(value);
  }
});

it("non ricicla descrizioni o requisiti precedenti se l’ultima acquisizione è illeggibile", () => {
  const { publication, archive } = briefFixture();
  const refused = buildTenderBrief(publication, null, true);
  expect(refused.warning).toContain("più recente non è leggibile");
  expect(refused.description).toEqual([]);
  expect(refused.requirements).toEqual([]);
  expect(refused.documents).toEqual([]);
  expect(() =>
    buildTenderBrief({ ...publication, externalId: "wrong-project" }, archive),
  ).toThrow(/another publication/);
});

it("non presenta requisiti AI senza riscontro completo nel testo citato", () => {
  const { publication } = briefFixture();
  const brief = buildTenderBrief({
    ...publication,
    requirements: ["Requisito inventato dal modello", "Due referenze"],
    evidence: [
      { field: "requisiti", quote: "", url: publication.sourceUrl },
      {
        field: "requisiti",
        quote: "Richieste Due referenze firmate",
        url: publication.sourceUrl,
        page: 4,
      },
    ],
  });
  expect(texts(brief.requirements)).toBe("Due referenze");
  expect(brief.requirements[0].source.page).toBe(4);
});

it("confronta solo il profilo dato e rende espliciti esclusioni, territorio, fascia e scadenza", () => {
  const { publication } = briefFixture();
  const profile = {
    ...demoViewer.profile,
    sectors: ["giardinaggio"] as const,
    zones: ["Mendrisiotto"],
    keywords: ["potatura"],
    exclusions: ["aiuole"],
    minValue: 100,
    maxValue: 1000,
  };
  const reason = potentialInterest(
    { ...publication, valueChf: 2000 },
    { ...profile, sectors: [...profile.sectors] },
    new Date("2026-11-01"),
  );
  expect(reason).toContain("scaduto");
  expect(reason).toContain("escluso (aiuole)");
  expect(reason).toContain("parole chiave: potatura");
  expect(reason).toContain("fuori dalle zone");
  expect(reason).toContain("fuori dalla fascia");
  expect(reason).toContain("non ammette il bando nel Radar");
});

it("riconosce il cantone TI per Tutto il Ticino anche senza distretto classificato", () => {
  const { publication } = briefFixture();
  const source = { ...publication, location: "Magliaso", zone: null };
  const profile = { ...demoViewer.profile, zones: ["Tutto il Ticino"] };
  const before = structuredClone(source);
  const now = new Date("2026-09-20T12:00:00Z");
  const reason = potentialInterest(source, profile, now);
  expect(reason).toContain(
    "Il luogo indicato (Magliaso) è nel territorio che hai selezionato.",
  );
  expect(reason).not.toContain(
    "territorio di esecuzione deve essere verificato",
  );
  expect(preliminaryMatch(source, profile, now).uncertain).toBe(false);
  expect(reason).toContain("non ammette il bando nel Radar");
  expect(source).toEqual(before);
});

it.each([
  {
    label: "distretto selezionato",
    location: "Lugano",
    canton: "TI",
    zone: "Luganese",
    zones: ["Luganese"],
    expected: "è nel territorio che hai selezionato",
  },
  {
    label: "distretto fuori profilo",
    location: "Lugano",
    canton: "TI",
    zone: "Luganese",
    zones: ["Mendrisiotto"],
    expected: "è fuori dalle zone che hai selezionato",
  },
  {
    label: "cantone fuori dal Ticino",
    location: "Zürich",
    canton: "ZH",
    zone: null,
    zones: ["Tutto il Ticino"],
    expected: "cantone ZH, fuori dalle zone ticinesi",
  },
  {
    label: "distretto mancante per un profilo locale",
    location: "Magliaso",
    canton: "TI",
    zone: null,
    zones: ["Luganese"],
    expected: "Il territorio di esecuzione deve essere verificato.",
  },
  {
    label: "cantone mancante anche con una località ticinese",
    location: "Lugano",
    canton: "",
    zone: "Luganese",
    zones: ["Tutto il Ticino"],
    expected: "Il territorio di esecuzione deve essere verificato.",
  },
  {
    label: "località mancante",
    location: "",
    canton: "TI",
    zone: null,
    zones: ["Tutto il Ticino"],
    expected: "Il territorio di esecuzione deve essere verificato.",
  },
  {
    label: "località esplicitamente non indicata",
    location: "Non indicato",
    canton: "TI",
    zone: null,
    zones: ["Tutto il Ticino"],
    expected: "Il territorio di esecuzione deve essere verificato.",
  },
  {
    label: "città in conflitto con il cantone",
    location: "Lugano",
    canton: "ZH",
    zone: null,
    zones: ["Tutto il Ticino"],
    expected: "sono discordanti: il territorio deve essere verificato",
  },
  {
    label: "distretto in conflitto con il cantone",
    location: "Località da chiarire",
    canton: "ZH",
    zone: "Luganese",
    zones: ["Tutto il Ticino"],
    expected: "sono discordanti: il territorio deve essere verificato",
  },
  {
    label: "città in conflitto con il distretto",
    location: "Lugano",
    canton: "TI",
    zone: "Mendrisiotto",
    zones: ["Tutto il Ticino"],
    expected: "sono discordanti: il territorio deve essere verificato",
  },
])(
  "distingue il territorio del lavoro: $label",
  ({ label: _label, zones, expected, ...place }) => {
    const { publication } = briefFixture();
    const reason = potentialInterest(
      { ...publication, ...place, buyer: "Comune di Lugano" },
      { ...demoViewer.profile, zones },
      new Date("2026-09-20T12:00:00Z"),
    );
    expect(reason).toContain(expected);
    if (!expected.startsWith("è nel territorio"))
      expect(reason).not.toContain("è nel territorio che hai selezionato");
  },
);

it("non scambia un settore mancante per un settore diverso da quelli del profilo", () => {
  const { publication } = briefFixture();
  const source = {
    ...publication,
    title: "Oggetto da chiarire",
    originalText: "Descrizione non indicata",
    originalTitles: [],
    originalDescriptions: [],
    cpv: [],
    sectors: [],
    classification: undefined,
  };
  const reason = potentialInterest(source, demoViewer.profile);
  expect(reason).toContain("Il settore del bando è ancora da classificare");
  expect(reason).not.toContain("non coincidono");
  const html = renderToStaticMarkup(
    createElement(TenderBriefPanels, {
      brief: buildTenderBrief(source),
      relevance: reason,
    }),
  );
  expect(html).toContain("Il settore del bando è ancora da classificare");
});

it("mantiene distinto un settore conosciuto diverso dalle attività del profilo", () => {
  const { publication } = briefFixture();
  const reason = potentialInterest(publication, {
    ...demoViewer.profile,
    sectors: ["informatica"],
  });
  expect(reason).toContain("non coincidono con quelli del tuo profilo");
  expect(reason).not.toContain("ancora da classificare");
});

it("mostra tutte le sezioni anche con campi mancanti e impedisce script o URL attivi non sicuri", () => {
  const { publication } = briefFixture();
  const brief = buildTenderBrief({
    ...publication,
    originalDescriptions: [],
    originalText: "<script>alert('x')</script>Descrizione disponibile",
    requirements: [],
    evidence: [],
    documents: [
      { title: "Documento", url: "javascript:alert(1)", requiresLogin: false },
    ],
  });
  const html = renderToStaticMarkup(
    createElement(TenderBriefPanels, {
      brief,
      relevance: "Motivazione per la sola ditta corrente",
    }),
  );
  for (const title of [
    "Il lavoro richiesto",
    "Perché può interessare alla tua ditta",
    "Requisiti e documenti",
    "Sopralluoghi",
    "Scadenze e modalità di partecipazione",
  ])
    expect(html).toContain(title);
  expect(html).toContain("Requisiti non indicati");
  expect(html).toContain("Non significa che il sopralluogo non sia richiesto");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("javascript:");
});

it("il pulsante apre il progetto simap corretto, mantiene l’etichetta richiesta e disabilita la demo", () => {
  const { publication } = briefFixture();
  const html = renderToStaticMarkup(
    createElement(TenderSourceButton, {
      publication: { ...publication, sourceUrl: "https://www.simap.ch/it" },
    }),
  );
  expect(html).toContain('href="' + publication.sourceUrl + '"');
  expect(html).toContain("Apri il bando su simap ↗");
  expect(html).toContain('rel="noopener noreferrer"');
  const demo = renderToStaticMarkup(
    createElement(TenderSourceButton, { publication, demo: true }),
  );
  expect(demo).not.toContain("href=");
  expect(demo).toContain('aria-disabled="true"');
  expect(publicLink("https://user:password@example.invalid/file")).toBe("");
  expect(tenderReferenceLink(briefIdentity.detailUrl)).toBe(
    publication.sourceUrl,
  );
  expect(
    tenderReferenceLink("https://example.invalid/capitolato.pdf#page=4"),
  ).toBe("https://example.invalid/capitolato.pdf#page=4");
  expect(
    tenderSourceLink({
      source: "simap",
      sourceUrl: "https://fake.invalid/project-detail/test",
    }),
  ).toBe("");
});

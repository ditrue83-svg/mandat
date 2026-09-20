import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { demoViewer } from "../src/lib/demo";
import type { CatalogDetailEntry } from "../src/lib/catalog";
import { buildTenderBrief } from "../src/lib/tender-brief";
import { getDemoOpportunities } from "../src/lib/demo";
import { briefFixture } from "./fixtures/tender-brief";
import type { Opportunity } from "../src/lib/domain";

const state = vi.hoisted(() => ({
  item: null as CatalogDetailEntry | null,
  opportunity: null as Opportunity | null,
}));
vi.mock("@/lib/queries", () => ({
  getOpportunity: async () => state.opportunity,
}));

vi.mock("@/lib/viewer", () => ({
  pageViewer: async () => ({ ...demoViewer, demo: false }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not-found");
  },
  usePathname: () => "/esplora",
}));
vi.mock("@/lib/catalog", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/catalog")>(
      "../src/lib/catalog",
    );
  return {
    ...actual,
    readCatalog: async () => ({
      filters: {
        q: "pulizia scuole",
        settore: "pulizie",
        stato: "all",
        ordine: "scadenza",
      },
      page: 2,
      pages: 3,
      total: 41,
      collectedCount: 200,
      openCount: 70,
      items: [state.item],
      foglioAvailable: false,
      collectedAt: "2026-09-16T09:01:00.000Z",
      sourceStatus: {
        state: "error",
        lastSuccessAt: "2026-09-16T09:01:00.000Z",
        lastAttemptAt: "2026-09-16T09:30:01.000Z",
      },
      sources: [
        {
          id: "simap",
          label: "simap",
          included: true,
          state: "error",
          lastSuccessAt: "2026-09-16T09:01:00.000Z",
          lastAttemptAt: "2026-09-16T09:30:01.000Z",
        },
        {
          id: "foglio-ti",
          label: "Foglio Ufficiale TI",
          included: false,
          state: "disabled",
          lastSuccessAt: null,
          lastAttemptAt: null,
        },
      ],
      sourceDelayed: true,
    }),
    readCatalogEntry: async () => state.item,
  };
});

import Explore from "../src/app/esplora/page";
import CatalogDetail from "../src/app/esplora/[id]/page";
import RadarDetail from "../src/app/bandi/[id]/page";

state.item = {
  id: "bando prova",
  title: "Pulizia scuole comunali",
  buyer: "Comune inventato",
  location: "Lugano",
  source: "simap",
  sourceUrl: "https://www.simap.ch/it/project-detail/test",
  publishedAt: "2026-09-15T06:00:00Z",
  deadline: "2026-10-01T12:00:00Z",
  valueChf: null,
  status: "open",
  sectors: ["pulizie"],
  needsSectorClassification: false,
  originalText: "Servizio inventato per il collaudo.",
  documents: [],
  saved: false,
  tenderBrief: buildTenderBrief(getDemoOpportunities()[0]),
  reason: "Pulizie nel territorio selezionato: confronto ancora da verificare.",
  assessment: "unreviewed",
};

it("rende visibili salvataggio, problema fonte e collegamenti con filtri", async () => {
  const html = renderToStaticMarkup(
    await Explore({
      searchParams: Promise.resolve({}),
    }),
  );
  expect(html).toContain("simap: problema nell’ultimo aggiornamento");
  expect(html).toContain("Foglio Ufficiale TI: non attivo nella beta");
  expect(html).toContain('role="alert"');
  expect(html).toContain("Mandat riproverà automaticamente");
  expect(html).toContain("Copertura e ultimo aggiornamento");
  expect(html).toContain('aria-label="Cerca tra tutti i bandi raccolti"');
  expect(html).toContain("Sono mostrati inizialmente i bandi in corso");
  expect(html).toContain("Vedi dettagli");
  expect(html).toContain("Salva");
  expect(html).toContain(
    "/esplora/bando%20prova?ritorno=%2Fesplora%3Fq%3Dpulizia%2Bscuole%26settore%3Dpulizie%26stato%3Dall%26ordine%3Dscadenza%26pagina%3D2",
  );
});

it("la scheda torna alla ricerca esatta e offre lo stesso salvataggio", async () => {
  const ritorno =
    "/esplora?q=pulizia+scuole&settore=pulizie&stato=all&ordine=scadenza&pagina=2";
  const html = renderToStaticMarkup(
    await CatalogDetail({
      params: Promise.resolve({ id: "bando prova" }),
      searchParams: Promise.resolve({ ritorno }),
    }),
  );
  expect(html).toContain(`href="${ritorno.replaceAll("&", "&amp;")}"`);
  expect(html).toContain("Salvalo anche se la pertinenza");
  expect(html).toContain("Salva");
});

it("ogni scheda, Radar ed Esplora, include i cinque contenuti e il collegamento diretto a simap", async () => {
  const f = briefFixture(),
    brief = buildTenderBrief(f.publication, f.archive);
  state.opportunity = {
    ...getDemoOpportunities()[0],
    ...f.publication,
    tenderBrief: brief,
    reason:
      "Potatura nel territorio della ditta: possibile interesse da verificare.",
  };
  const original = state.item;
  state.item = {
    ...original!,
    tenderBrief: brief,
    reason: state.opportunity.reason,
    sourceUrl: f.publication.sourceUrl,
  };
  try {
    for (const page of [
      await CatalogDetail({
        params: Promise.resolve({ id: "test" }),
        searchParams: Promise.resolve({}),
      }),
      await RadarDetail({ params: Promise.resolve({ id: "test" }) }),
    ]) {
      const html = renderToStaticMarkup(page);
      for (const text of [
        "Il lavoro richiesto",
        "Potatura di alberi",
        "Perché può interessare alla tua ditta",
        "Potatura nel territorio della ditta",
        "Requisiti e documenti",
        "Allegare due referenze",
        "Sopralluogo obbligatorio",
        "Le condizioni decisive, in breve",
        "Scadenze e modalità di partecipazione",
        "due copie firmate in busta chiusa",
        "Fonti e testo originale",
        "Apri il bando su simap ↗",
      ])
        expect(html).toContain(text);
      expect(html).toContain('href="' + f.publication.sourceUrl + '"');
      expect(html).toContain("Fonte: Modalità e formalità di presentazione");
      expect(html).not.toContain('href="' + f.archive.identity.detailUrl + '"');
    }
  } finally {
    state.item = original;
  }
});

it("il dettaglio Radar conserva filtri e raccolta nel collegamento di ritorno", async () => {
  state.opportunity = {
    ...getDemoOpportunities()[0],
    id: "ritorno-radar",
  };
  const ritorno =
    "/?q=verde&settore=giardinaggio&ordine=scadenza&vista=escluse";
  const html = renderToStaticMarkup(
    await RadarDetail({
      params: Promise.resolve({ id: "ritorno-radar" }),
      searchParams: Promise.resolve({ ritorno }),
    }),
  );
  expect(html).toContain(`href="${ritorno.replaceAll("&", "&amp;")}"`);
  expect(html).toContain("Torna a Per la tua ditta");
});

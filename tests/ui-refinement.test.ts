import { createElement as h } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { demoViewer, getDemoOpportunities } from "../src/lib/demo";
import { buildTenderBrief, type BriefFact } from "../src/lib/tender-brief";
import { briefFixture } from "./fixtures/tender-brief";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/esplora",
}));
import { Dashboard } from "../src/components/dashboard";
import { CatalogFilters } from "../src/components/catalog-filters";
import { TenderListCard } from "../src/components/tender-list-card";
import {
  TenderDecisionSummary,
  TenderBriefPanels,
} from "../src/components/tender-brief";
import { PageLoadError, RouteLoading } from "../src/components/page-states";
import { ProfileForm } from "../src/components/profile-form";
const viewer = { ...demoViewer, demo: false };
afterEach(() => vi.useRealTimers());

it("attende i salvataggi locali prima di dichiarare vuota la demo", () => {
  const html = render(
    h(Dashboard, { viewer: demoViewer, opportunities: [], savedOnly: true }),
  );
  expect(html).toContain('aria-busy="true"');
  expect(html).not.toContain("Non hai ancora salvato");
});

it("distingue raccolta assente da risultati nascosti dai filtri", () => {
  const empty = render(h(Dashboard, { viewer, opportunities: [] }));
  expect(empty).toContain("Esplora i bandi in corso");
  expect(empty).not.toContain('aria-label="Filtra per settore"');
  const filtered = render(
    h(Dashboard, {
      viewer,
      opportunities: getDemoOpportunities(),
      initialFilters: {
        q: "nessunrisultatoxyz",
        settore: "informatica",
        ordine: "scadenza",
      },
    }),
  );
  expect(filtered).toContain("Nessun risultato corrisponde ai filtri.");
  expect(filtered).toContain('aria-label="Criteri applicati"');
  expect(filtered).toContain('value="nessunrisultatoxyz"');
  expect(filtered).toContain("Informatica");
  expect(filtered).toContain("Azzera i filtri");
  expect(filtered).not.toContain("Nessuna proposta ancora selezionata");
});

it("mantiene distinti elaborazione, caricamento della pagina ed errore", () => {
  const processing = render(
    h(Dashboard, {
      viewer,
      opportunities: [],
      radarStatus: { state: "processing", pendingCount: 3 },
    }),
  );
  expect(processing).toContain("Stiamo preparando le proposte");
  expect(processing).not.toContain("Nessuna proposta ancora selezionata");
  const loading = render(h(RouteLoading, { previewPath: "/esplora" }));
  expect(loading).toContain('aria-label="Raccolte di bandi"');
  expect(loading).toContain("Apro la pagina…");
  expect(loading).not.toContain("Nessun risultato");
  const error = render(h(PageLoadError, { reset: vi.fn() }));
  expect(error).toContain('role="alert"');
  expect(error).toContain("Riprova");
  expect(error).not.toContain("Nessun risultato");
});

it("segnala il ritardo anche quando il Radar non ha ancora proposte", () => {
  const html = render(
    h(Dashboard, {
      viewer,
      opportunities: [],
      radarStatus: { state: "delayed", pendingCount: 3 },
    }),
  );
  expect(html).toContain(
    "L’elaborazione sta richiedendo più tempo del previsto.",
  );
  expect(html).toContain(
    "Le proposte per la tua ditta non sono ancora pronte.",
  );
  expect(html).toContain("Esplora i bandi in corso");
  expect(html).not.toContain("L’elaborazione è in corso.");
  expect(html).not.toContain("Nessuna proposta ancora selezionata");
});

it("i criteri del catalogo restano nel form GET anche a pannello chiuso", () => {
  const html = render(
    h(CatalogFilters, {
      filters: {
        q: "verde",
        settore: "giardinaggio",
        stato: "open",
        ordine: "scadenza",
      },
      statuses: { open: "In corso" },
    }),
  );
  expect(html).toContain('action="/esplora"');
  expect(html).toContain('aria-expanded="false"');
  for (const name of ["q", "settore", "stato", "ordine"])
    expect(html).toContain(`name="${name}"`);
  expect(html).toContain('value="giardinaggio" selected=""');
  expect(html).toContain("Criteri applicati");
  expect(html).toContain("Applica filtri");
});

it("mette in evidenza solo le scadenze vicine senza attribuire ore alle date", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-17T08:00:00Z"));
  const props = {
    title: "Titolo ufficiale molto lungo " + "completo ".repeat(20),
    buyer: "Ente esteso",
    description: "",
    location: "Località estesa",
    deadline: "2026-09-19",
    status: "In corso",
    sector: "Da classificare",
    detailHref: "/esplora/test",
    saveAction: h("button", {}, "Salva"),
  };
  const html = render(h(TenderListCard, props));
  expect(html).toContain(props.title);
  expect(html).toContain("In scadenza");
  expect(html).toContain('dateTime="2026-09-19"');
  expect(html).not.toContain("00:00");
  expect(html).toContain("Descrizione non disponibile");
  expect(
    render(h(TenderListCard, { ...props, status: "Scaduto" })),
  ).not.toContain("In scadenza");
  const missing = render(h(TenderListCard, { ...props, deadline: null }));
  expect(missing).toContain("Non indicata");
  expect(missing).not.toContain("In scadenza");
});

it("conserva interi requisiti lunghi, importi, sopralluoghi e termini distinti", () => {
  const f = briefFixture();
  const brief = buildTenderBrief(f.publication, f.archive);
  const text =
    "Qualifica professionale e lavori analoghi. ".repeat(12) +
    "Importo minimo della referenza CHF 400’000, IVA esclusa.";
  brief.requirements = [
    {
      label: "Idoneità",
      text,
      source: {
        url: brief.sourceUrl,
        path: "/criteria/qualificationCriteriaNote/it",
        quote: text,
      },
      language: "it",
    },
  ];
  brief.description[0].text = "Descrizione estesa del lavoro. ".repeat(30);
  const html = render(
    h(TenderDecisionSummary, { brief, location: "Magliaso" }),
  );
  expect(html).toContain(text);
  expect(html).toContain("Sopralluogo obbligatorio");
  expect(html).toContain("Presentazione dell’offerta");
  expect(html).toContain("Domande di chiarimento");
  expect(html).toContain("orario non indicato");
  expect(html).not.toContain(brief.description[0].text);
  expect(html).toContain('href="#brief-work"');
  const full = render(
    h(TenderBriefPanels, { brief, relevance: "Confronto preliminare" }),
  );
  expect(full).toContain(brief.description[0].text);
  expect(full).toContain(text);
  expect(full).toContain("due copie firmate in busta chiusa");
});

it("non presenta scadenze e requisiti dei singoli lotti come condizioni generali", () => {
  const f = briefFixture();
  const brief = buildTenderBrief(f.publication, f.archive);
  const fact = (label: string, text: string): BriefFact => ({
    label,
    text,
    source: { path: "/local", url: brief.sourceUrl, quote: text },
  });
  brief.deadlines = [];
  brief.lots = [1, 2].map((number) => ({
    id: `lot-${number}`,
    number,
    description: [],
    requirements: [fact("Idoneità", `Qualifica specifica ${number}`)],
    documents: [],
    visits: [
      fact("Sopralluogo", `Sopralluogo obbligatorio del lotto ${number}`),
    ],
    deadlines: [
      fact(
        "Presentazione dell’offerta",
        `${number} ottobre 2026 · orario non indicato`,
      ),
    ],
    submission: [fact("Modalità di inoltro", `Recapito per lotto ${number}`)],
  }));
  const html = render(h(TenderDecisionSummary, { brief, location: "Ticino" }));
  for (const number of [1, 2]) {
    expect(html).toContain(`Lotto ${number} · Presentazione dell’offerta`);
    expect(html).toContain(`Qualifica specifica ${number}`);
    expect(html).toContain(`Recapito per lotto ${number}`);
  }
});

it("rende leggibili le scelte del profilo senza cambiare identificativi", () => {
  const html = render(h(ProfileForm, { viewer }));
  expect(html).toContain("3 settori selezionati");
  expect(html).toContain("Vedi i settori scelti");
  for (const value of viewer.profile.sectors)
    expect(html).toContain(`value="${value}"`);
  expect(html).toContain("Salva le preferenze");
});

it("mostra il termine disponibile anche quando la fonte non ne precisa la fase", () => {
  const brief = buildTenderBrief(getDemoOpportunities()[0]);
  const html = render(h(TenderDecisionSummary, { brief, location: "Lugano" }));
  expect(html).toContain("Termine indicato");
  expect(html).not.toContain(
    "Non indicati nei dati acquisiti: verifica la fase",
  );
  expect(html).not.toContain("Presentazione dell’offerta");
});

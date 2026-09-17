import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { demoViewer, getDemoOpportunities } from "../src/lib/demo";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/",
}));

import { Dashboard } from "../src/components/dashboard";
import Loading from "../src/app/loading";

it("riunisce le tre raccolte sotto Bandi con descrizioni e ricerche esplicite", () => {
  const radar = renderToStaticMarkup(
    createElement(Dashboard, {
      viewer: demoViewer,
      opportunities: [],
    }),
  );
  for (const label of ["Per la tua ditta", "Tutti i bandi", "Salvati"])
    expect(radar).toContain(label);
  expect(radar).toContain(
    "I bandi selezionati in base all’attività e alle zone della tua ditta.",
  );
  expect(radar).toContain("Cerca nei bandi selezionati per te…");
  expect(radar).toContain(
    "Nessuna proposta ancora selezionata per la tua ditta.",
  );
  expect(radar).toContain("Puoi già cercare tra i bandi raccolti.");
  expect(radar).not.toContain("IL LAVORO DI DOMANI, OGGI");
  expect(radar).not.toContain("Le occasioni giuste");

  const saved = renderToStaticMarkup(
    createElement(Dashboard, {
      viewer: demoViewer,
      opportunities: [],
      savedOnly: true,
    }),
  );
  expect(saved).toContain("I bandi che hai conservato per approfondirli.");
  expect(saved).toContain("Cerca nei tuoi salvati…");
  expect(saved).toContain("Non hai ancora salvato nessun bando.");
  expect(saved).not.toContain("0 risultati");
  expect(saved).not.toContain("opportunità nel Radar");
});

it("conserva ricerca, settore e ordinamento nel ritorno dal dettaglio", () => {
  const item = {
    ...getDemoOpportunities()[0],
    title: "Cura del verde comunale",
    originalText:
      "Cura del verde comunale\nPotatura di alberi e manutenzione delle aiuole.",
    sectors: ["giardinaggio" as const],
  };
  const html = renderToStaticMarkup(
    createElement(Dashboard, {
      viewer: demoViewer,
      opportunities: [item],
      initialFilters: {
        q: "verde",
        settore: "giardinaggio",
        ordine: "scadenza",
      },
    }),
  );
  expect(html).toContain("Potatura di alberi e manutenzione delle aiuole.");
  expect(html).toContain("Vedi dettagli");
  expect(html).toContain("Salva");
  expect(html).toContain(
    "ritorno=%2F%3Fq%3Dverde%26settore%3Dgiardinaggio%26ordine%3Dscadenza",
  );
  expect(html).toContain("In corso");
  expect(html).toContain("Esempio dimostrativo");
});

it("mostra un caricamento distinto da una raccolta vuota", () => {
  const html = renderToStaticMarkup(createElement(Loading));
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain("Apro la pagina…");
  expect(html).toContain("Sto preparando i bandi e i filtri della raccolta.");
  expect(html).not.toContain("Nessun");
});

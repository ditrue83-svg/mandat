import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { demoViewer } from "../src/lib/demo";
import type { CatalogEntry } from "../src/lib/catalog";

const state = vi.hoisted(() => ({
  item: null as CatalogEntry | null,
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
  originalText: "Servizio inventato per il collaudo.",
  documents: [],
  saved: false,
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

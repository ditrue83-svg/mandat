import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/",
}));
import { Dashboard } from "../src/components/dashboard";
import { demoViewer, getDemoOpportunities } from "../src/lib/demo";
const positive = {
  ...getDemoOpportunities()[0]!,
  id: "selected",
  title: "Servizio selezionato inventato",
  assessment: "ai" as const,
  reviewCandidate: false,
  dismissed: false,
};
const related = {
  ...positive,
  id: "related",
  title: "Fornitura collegata inventata",
  assessment: "uncertain" as const,
  reviewCandidate: true,
  score: 0,
};
const excluded = {
  ...related,
  id: "excluded",
  title: "Proposta esclusa inventata",
  dismissed: true,
};
function render(vista?: string, savedOnly = false) {
  return renderToStaticMarkup(
    createElement(Dashboard, {
      viewer: { ...demoViewer, demo: false },
      opportunities: [positive, related, excluded],
      initialFilters: { vista },
      savedOnly,
    }),
  );
}
it("Selected, related and excluded opportunities remain in separate customer collections", () => {
  expect(render()).toContain(positive.title);
  expect(render()).not.toContain(related.title);
  const html = render("da-verificare");
  expect(html).toContain(related.title);
  expect(html).not.toContain(positive.title);
  expect(html).not.toContain(excluded.title);
  expect(html).toContain("Pertinenza da verificare");
  expect(html).toContain("non sono inclusi nei riepiloghi email automatici");
  expect(html).toContain("vista%3Dda-verificare");
  expect(render("escluse")).toContain(excluded.title);
  expect(render("escluse")).not.toContain(related.title);
});
it("An empty review collection does not claim pending AI work or confirmed relevance", () => {
  const html = renderToStaticMarkup(
    createElement(Dashboard, {
      viewer: { ...demoViewer, demo: false },
      opportunities: [],
      initialFilters: { vista: "da-verificare" },
      radarStatus: { state: "processing", pendingCount: 2 },
    }),
  );
  expect(html).toContain("Nessuna opportunità da verificare.");
  expect(html).not.toContain("Stiamo preparando");
});

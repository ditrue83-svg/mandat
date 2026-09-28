import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/",
}));
import { Dashboard } from "../src/components/dashboard";
import { demoViewer } from "../src/lib/demo";

it("An inactive AI permission shows the profile action instead of an endless processing state", () => {
  const html = renderToStaticMarkup(
    createElement(Dashboard, {
      viewer: { ...demoViewer, demo: false },
      opportunities: [],
      radarStatus: { state: "processing", pendingCount: 12 },
      aiProcessingBlocked: "permission",
    }),
  );
  expect(html).toContain("I nuovi confronti AI sono disattivati.");
  expect(html).toContain("/profilo#ai-processing-heading");
  expect(html).not.toContain("Stiamo preparando");
  expect(html).not.toContain("L’elaborazione è in corso");
});

it("A temporarily unavailable provider does not request another permission", () => {
  const html = renderToStaticMarkup(
    createElement(Dashboard, {
      viewer: { ...demoViewer, demo: false },
      opportunities: [],
      aiProcessingBlocked: "unavailable",
    }),
  );
  expect(html).toContain("temporaneamente indisponibili");
  expect(html).not.toContain("Gestisci i confronti AI");
});

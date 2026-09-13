import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { SourceScopeReviewControls } from "../src/components/source-scope-review-controls";
import type { OriginalTitle, SourceScopeReview } from "../src/lib/domain";
const url =
  "https://www.simap.ch/api/publications/v1/project/11111111-1111-4111-8111-111111111111/publication-details/22222222-2222-4222-8222-222222222222";
const review: SourceScopeReview = {
  status: "required",
  kind: "conflicting",
  token: "33333333-3333-4333-8333-333333333333",
  sourceRevision: "source-1",
  updatedAt: "2026-09-12T10:00:00Z",
};
function render(
  overrides: Partial<Parameters<typeof SourceScopeReviewControls>[0]> = {},
) {
  return renderToStaticMarkup(
    createElement(SourceScopeReviewControls, {
      publicationId: "p",
      sourceRevision: "source-1",
      contentRevision: "corrected-1",
      disabled: false,
      onAction: vi.fn(),
      ...overrides,
    }),
  );
}
it("rende due azioni distinte e nessun form annidato quando la verifica è aperta", () => {
  const html = render({ review });
  expect(html).toContain("Aggiorna il dubbio sull’oggetto");
  expect(html).toContain("Conferma risoluzione dell’oggetto");
  expect(html).toContain("non approva proposte per le ditte");
  const forms = [...html.matchAll(/<\/?form(?:\s[^>]*)?>/g)].map((m) =>
    m[0].startsWith("</") ? -1 : 1,
  );
  let depth = 0;
  for (const delta of forms) {
    depth += delta;
    expect(depth).toBeGreaterThanOrEqual(0);
    expect(depth).toBeLessThanOrEqual(1);
  }
  expect(forms).toHaveLength(4);
  expect(depth).toBe(0);
});
it("conserva titoli e lingua, sfugge HTML e permette solo il collegamento alla pubblicazione esatta", () => {
  const text = "  <script>alert('x')</script> Servizio richiesto  ";
  const titles: OriginalTitle[] = [
    { path: "title.fr", language: "fr", text, url },
    {
      path: "title.de",
      language: "de",
      text: "Titel",
      url: "javascript:alert(1)",
    },
    {
      path: "title.it",
      language: "it",
      text: "Titolo",
      url: "https://www.simap.ch.attacker.invalid/data",
    },
    {
      path: "title.en",
      language: "en",
      text: "Title",
      url: url + "?redirect=https://foreign.invalid",
    },
  ];
  const html = render({ titles });
  expect(html).toContain("Francese");
  expect(html).toContain('lang="fr"');
  expect(html).toContain(
    "  &lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt; Servizio richiesto  ",
  );
  expect(html).not.toContain("<script>");
  expect([...html.matchAll(/href=/g)]).toHaveLength(1);
  expect(html).toContain(`href="${url}"`);
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("attacker.invalid");
});
it("non presenta l’assenza del flag o dei titoli come fonte verificata", () => {
  const html = render();
  expect(html).toContain("Questo non equivale a una verifica della fonte");
  expect(html).toContain("Titoli originali non disponibili");
  expect(html).toContain("Segnala dubbio sull’oggetto");
  expect(html).not.toContain("Conferma risoluzione");
});
it("distingue un dubbio precedente da un conflitto dimostrato nella nuova fonte", () => {
  const html = render({ review, sourceRevision: "new-source" });
  expect(html).toContain(
    "La fonte è stata aggiornata: il dubbio precedente deve essere ricontrollato",
  );
});
it("la risoluzione non dichiara verificate nuove versioni", () => {
  const html = render({
    review: { ...review, status: "resolved" },
    sourceRevision: "new-source",
  });
  expect(html).toContain("la fonte è stata aggiornata dopo quel controllo");
  expect(html).not.toContain("Conferma risoluzione");
});
it("ignora metadati privati estranei e disabilita azioni nella demo", () => {
  const html = render({
    disabled: true,
    review: {
      ...review,
      note: "PRIVATE-NOTE",
      actorId: "PRIVATE-ACTOR",
    } as SourceScopeReview,
  });
  expect(html).not.toContain("PRIVATE-NOTE");
  expect(html).not.toContain("PRIVATE-ACTOR");
  expect([...html.matchAll(/<button[^>]*disabled=""/g)]).toHaveLength(2);
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/admin",
}));
import { AdminDashboard } from "../src/components/admin-dashboard";
import type { AdminSnapshot } from "../src/lib/admin";
import { demoViewer } from "../src/lib/demo";
it("il filtro iniziale dell’admin include i negativi AI da verificare e conserva gli scarti del prefiltro", () => {
  function row(
    id: string,
    values: Partial<AdminSnapshot["matches"][number]>,
  ): AdminSnapshot["matches"][number] {
    return {
      id,
      publicationId: id,
      title: id,
      company: "Ditta inventata",
      companyActivities: "Attività dichiarate nella fixture inventata.",
      profileRevision: "profile",
      score: 0,
      eligible: false,
      assessment: "uncertain",
      reason: "Verifica la fonte",
      approved: null,
      reviewed: false,
      evaluationRevision: "content-1:profile:ready:model:true",
      evaluationToken: "a".repeat(64),
      sourceReviewState: "untracked",
      sourceReviewDependency: null,
      reviewRequired: true,
      sourceScopeReview: review,
      sourceRevision: "source-1",
      contentRevision: "content-1",
      reviewReasons: [],
      summary: "Sintesi",
      deadline: null,
      valueChf: null,
      location: "Lugano",
      sourceUrl: url,
      sourceConditions: [],
      originalTitles: [],
      ...values,
    };
  }
  const data: AdminSnapshot = {
    demo: true,
    gate: {
      allowed: false,
      reviewed: 0,
      approved: 0,
      criticalIssues: 0,
      elapsedDays: 0,
      precision: 0,
    },
    automatic: false,
    spend: 0,
    runs: [],
    invites: [],
    issues: [],
    notifications: [],
    feedback: [],
    sourceEnabled: { simap: false, foglio: false },
    matches: [
      row("LOW-CACHE-CANDIDATE", {}),
      row("HIGH-CACHE-PREFILTER-EXCLUDED", {
        eligible: true,
        assessment: "excluded",
      }),
      row("MANUAL-REJECTED", {
        eligible: true,
        assessment: "rejected",
        approved: false,
      }),
      row("NORMAL-POSITIVE", {
        eligible: true,
        assessment: "ai",
        reviewRequired: false,
        sourceScopeReview: undefined,
      }),
      row("NORMAL-NEGATIVE", {
        eligible: false,
        assessment: "excluded",
        reviewRequired: false,
        sourceScopeReview: undefined,
      }),
    ],
  };
  const html = renderToStaticMarkup(
    createElement(AdminDashboard, { viewer: demoViewer, data }),
  );
  expect(html).toContain("LOW-CACHE-CANDIDATE");
  expect(html).toContain("NORMAL-POSITIVE");
  expect(html).not.toContain("HIGH-CACHE-PREFILTER-EXCLUDED");
  expect(html).not.toContain("MANUAL-REJECTED");
  expect(html).not.toContain("NORMAL-NEGATIVE");
  expect(data.matches[0].eligible).toBe(false);
});

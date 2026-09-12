import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import type { SourceCondition } from "../src/lib/domain";
import { demoProfile, getDemoOpportunities } from "../src/lib/demo";
import { SourceConditions } from "../src/components/source-conditions";

const context = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => context.db }));
vi.mock("@/lib/viewer", () => ({ HttpError: class extends Error {} }));
import { adminSnapshot } from "../src/lib/admin";

const url =
  "https://www.simap.ch/api/publications/v1/project/10000000-0000-4000-8000-000000000001/publication-details/20000000-0000-4000-8000-000000000002";
const render = (conditions?: SourceCondition[]) =>
  renderToStaticMarkup(createElement(SourceConditions, { conditions }));
const flag = (value: unknown): SourceCondition => ({
  path: "terms.subContractorAllowed",
  value,
  url,
});

it.each([
  ["yes", "Ammesso."],
  ["no", "Non ammesso."],
  ["not_specified", "Non specificato."],
  [null, "Non indicato (valore nullo)."],
] as const)(
  "distingue l'etichetta italiana dal valore originale %s",
  (value, label) => {
    const html = render([flag(value)]);
    expect(html).toContain("Condizioni riportate dalla fonte");
    expect(html).toContain(label);
    expect(html).toContain(
      `<blockquote class="original-text">${value ?? "null"}</blockquote>`,
    );
    expect(html).toContain(`href="${url}"`);
    expect(html).not.toContain("/it/project-detail/");
  },
);

it.each([false, true, 0, 1, "future_value", [], { allowed: true }])(
  "non converte il valore inatteso %j in autorizzazione o diniego",
  (value) => {
    const html = render([flag(value)]);
    expect(html).toContain("Valore non riconosciuto");
    expect(html).not.toContain("Ammesso.");
    expect(html).not.toContain("Non ammesso.");
    expect(html).toContain("Valore originale");
    expect(html).not.toMatch(
      /score|idone[ao]|pertinenza|opportunità aggiuntiv/i,
    );
  },
);

it("mantiene letterali le note linguistiche senza eseguire HTML", () => {
  const html = render([
    { path: "procurement.partialOffers", value: "no", url },
    {
      path: "procurement.partialOffersNote.fr",
      language: "fr",
      value:
        '  Texte original\n<script>alert("x")</script><img src=x onerror=alert(1)>  ',
      url,
    },
  ]);
  expect(html).toContain("Offerte parziali");
  expect(html).toContain("Non ammesse.");
  expect(html).toContain("Note sulle offerte parziali");
  expect(html).toContain("Francese");
  expect(html).toContain('lang="fr">  Texte original\n&lt;script&gt;');
  expect(html).toContain("&lt;/script&gt;&lt;img");
  expect(html).toContain("  </blockquote>");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
});

it.each([undefined, []])(
  "non presenta dati assenti come un diniego",
  (conditions) => {
    const html = render(conditions);
    expect(html).toContain("Condizioni non disponibili nei dati acquisiti.");
    expect(html).not.toContain("Non ammesso");
  },
);

it("conserva campo e valore sconosciuti senza inventare una lingua", () => {
  const html = render([
    { path: "terms.extra.zz", value: "testo originale", url },
  ]);
  expect(html).toContain("Campo non riconosciuto");
  expect(html).toContain("terms.extra.zz");
  expect(html).toContain("testo originale");
  expect(html).not.toContain("lang=");
});

it.each([
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  url.replace("www.simap.ch", "www.simap.ch.example.invalid"),
  url.replace("https:", "http:"),
  "https://www.simap.ch/it/project-detail/10000000-0000-4000-8000-000000000001",
])("non rende navigabile il collegamento non ammesso %s", (unsafeUrl) => {
  const html = render([{ ...flag("yes"), url: unsafeUrl }]);
  expect(html).not.toContain("href=");
  expect(html).toContain("Collegamento alla pubblicazione non disponibile.");
});

const pg = new PGlite();
const db = drizzle(pg, { schema });
beforeAll(async () => {
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
});
afterAll(async () => pg.close());

it("espone le condizioni archiviate nell'area fondatore senza cambiare la valutazione", async () => {
  const p = { ...getDemoOpportunities()[0], id: "conditions-publication" };
  await db
    .insert(schema.user)
    .values({
      id: "conditions-user",
      name: "Ditta prova",
      email: "conditions@example.invalid",
    });
  await db
    .insert(schema.companies)
    .values({
      id: "conditions-company",
      ownerId: "conditions-user",
      profile: demoProfile,
    });
  await db.insert(schema.publications).values({
    id: p.id,
    externalId: p.id,
    canonicalId: p.id,
    source: p.source,
    title: p.title,
    status: p.status,
    visibleAt: new Date(p.visibleAt),
    revision: p.revision,
    aiRevision: p.revision,
    data: p,
  });
  await db.insert(schema.matches).values({
    id: "conditions-match",
    companyId: "conditions-company",
    publicationId: p.id,
    revision: "test-revision",
    eligible: false,
    score: 0,
    reason: "Valutazione conservata",
    approved: false,
  });
  const before = await adminSnapshot(false);
  expect(before.matches[0].sourceConditions).toEqual([]);
  const conditions: SourceCondition[] = [
    flag("not_specified"),
    {
      path: "terms.subContractorNote.it",
      language: "it",
      value: ' Nota esatta con "virgolette".\n',
      url,
    },
  ];
  await db
    .update(schema.publications)
    .set({ data: { ...p, sourceConditions: conditions } })
    .where(eq(schema.publications.id, p.id));
  const after = await adminSnapshot(false);
  expect(after.matches[0]).toEqual({
    ...before.matches[0],
    sourceConditions: conditions,
  });
  expect(after.matches[0].sourceConditions[1].value).toBe(conditions[1].value);
});

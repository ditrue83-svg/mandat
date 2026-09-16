import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../src/db/schema";
import { demoViewer, getDemoOpportunities } from "../src/lib/demo";
import type { Publication } from "../src/lib/domain";
import { matchesSearch } from "../src/lib/search";

const context = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => context.db }));
import {
  readCatalog,
  readCatalogEntry,
  presentCatalogEntry,
  catalogHref,
} from "../src/lib/catalog";
const pg = new PGlite();
const db = drizzle(pg, { schema });
const now = new Date("2026-09-16T10:00:00Z");
const viewer = { ...demoViewer, demo: false };
beforeAll(async () => {
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
});
beforeEach(async () => {
  vi.stubEnv("FOGLIO_REUSE_CONFIRMED", "false");
  await db.delete(schema.publications);
  await db.delete(schema.sourceRuns);
});
it("segnala una raccolta assente o ferma e mostra l'ultimo completamento riuscito", async () => {
  expect((await readCatalog(viewer, {}, now)).sourceDelayed).toBe(true);
  await db
    .insert(schema.sourceRuns)
    .values({
      id: "old",
      source: "simap",
      status: "success",
      startedAt: new Date("2026-09-15T07:00:00Z"),
      finishedAt: new Date("2026-09-15T07:01:00Z"),
    });
  expect((await readCatalog(viewer, {}, now)).sourceDelayed).toBe(true);
  await db
    .insert(schema.sourceRuns)
    .values({
      id: "fresh",
      source: "simap",
      status: "success",
      startedAt: new Date("2026-09-16T09:00:00Z"),
      finishedAt: new Date("2026-09-16T09:01:00Z"),
    });
  const data = await readCatalog(viewer, {}, now);
  expect(data).toMatchObject({
    sourceDelayed: false,
    collectedAt: "2026-09-16T09:01:00.000Z",
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});

async function publication(
  id: string,
  changes: Partial<Publication> = {},
  canonicalId = id,
) {
  const p: Publication = {
    ...getDemoOpportunities()[0],
    id,
    externalId: id,
    source: "simap",
    status: "open",
    title: `Bando ${id}`,
    publishedAt: "2026-09-15T06:00:00Z",
    visibleAt: "2026-09-15T06:00:00Z",
    deadline: "2026-10-01T12:00:00Z",
    sourceUrl: "https://www.simap.ch/it/project-detail/test",
    originalText: "Pulizia delle scuole e manutenzione del verde.",
    summary: "SINTESI AI DA NON ESPORRE",
    evidence: [
      {
        url: "https://example.invalid/private",
        field: "private",
        quote: "Riservato",
      },
    ],
    ...changes,
  };
  await db.insert(schema.publications).values({
    id,
    externalId: id,
    canonicalId,
    source: p.source,
    title: p.title,
    status: p.status,
    data: p,
    revision: p.revision,
    visibleAt: new Date(p.visibleAt),
    deadline: p.deadline ? new Date(p.deadline) : null,
  });
  return p;
}

it("consente consultazione senza match, senza esporre valutazioni o creare dati aziendali", async () => {
  await publication("uno");
  const result = await readCatalog(viewer, {}, now);
  expect(result.total).toBe(1);
  expect(result.items[0]).not.toHaveProperty("score");
  expect(JSON.stringify(result)).not.toContain("SINTESI AI");
  expect(
    JSON.stringify(await readCatalogEntry(viewer, "uno", now)),
  ).not.toContain("private");
  expect(await db.select().from(schema.matches)).toEqual([]);
  expect(await db.select().from(schema.feedback)).toEqual([]);
});
it("rispetta l'embargo anche chiedendo direttamente il dettaglio", async () => {
  await publication("future", { visibleAt: "2026-09-16T10:01:00Z" });
  expect((await readCatalog(viewer, { stato: "all" }, now)).total).toBe(0);
  expect(await readCatalogEntry(viewer, "future", now)).toBeNull();
});
it("non ripiega sulla vecchia edizione quando la corrente è annullata o sotto embargo", async () => {
  await publication("old", {}, "same");
  await publication(
    "new",
    { status: "cancelled", publishedAt: "2026-09-16T06:00:00Z" },
    "same",
  );
  expect((await readCatalog(viewer, {}, now)).total).toBe(0);
  expect(
    (await readCatalog(viewer, { stato: "all" }, now)).items.map((p) => p.id),
  ).toEqual(["new"]);
  expect(await readCatalogEntry(viewer, "old", now)).toBeNull();
  await publication(
    "future",
    { publishedAt: "2026-09-17T06:00:00Z", visibleAt: "2026-09-17T06:00:00Z" },
    "same",
  );
  expect((await readCatalog(viewer, { stato: "all" }, now)).total).toBe(0);
});
it("applica il blocco Foglio TI a elenco e dettaglio e mantiene un solo rappresentante", async () => {
  await publication("foglio", { source: "foglio-ti" });
  expect((await readCatalog(viewer, {}, now)).total).toBe(0);
  expect(await readCatalogEntry(viewer, "foglio", now)).toBeNull();
  vi.stubEnv("FOGLIO_REUSE_CONFIRMED", "true");
  await publication("simap", {}, "foglio");
  expect((await readCatalog(viewer, {}, now)).items.map((p) => p.id)).toEqual([
    "simap",
  ]);
});
it("esclude dagli in corso termini già scaduti anche da pochi minuti e le aggiudicazioni", async () => {
  await publication("expired", { deadline: "2026-09-16T09:59:00Z" });
  await publication("awarded", { status: "awarded" });
  await publication("unknown", { deadline: null });
  expect((await readCatalog(viewer, {}, now)).items.map((p) => p.id)).toEqual([
    "unknown",
  ]);
  expect(
    (await readCatalog(viewer, { stato: "expired" }, now)).items[0].status,
  ).toBe("expired");
  expect((await readCatalog(viewer, { stato: "all" }, now)).total).toBe(3);
});
it("cerca nel testo originale con accenti e ordine indipendenti; conserva i filtri tra pagine", async () => {
  await publication("uno", {
    title: "Città di Bellinzona",
    sectors: ["pulizie"],
  });
  expect(
    (
      await readCatalog(
        viewer,
        { q: " SCUOLE Citta ", settore: "pulizie" },
        now,
      )
    ).total,
  ).toBe(1);
  expect((await readCatalog(viewer, { q: "scuole catering" }, now)).total).toBe(
    0,
  );
  expect(matchesSearch("Rénovation d’un bâtiment", "batiment renovation")).toBe(
    true,
  );
  expect(catalogHref({ q: "scuole & asili", stato: "all" }, 2)).toBe(
    "/esplora?q=scuole+%26+asili&stato=all&pagina=2",
  );
});
it("pagina senza salti, limita parametri fuori intervallo e ordina scadenze mancanti in fondo", async () => {
  for (let i = 0; i < 23; i++)
    await publication(`p${String(i).padStart(2, "0")}`);
  const first = await readCatalog(viewer, { pagina: "-3" }, now);
  const last = await readCatalog(viewer, { pagina: "999999" }, now);
  expect(first.items).toHaveLength(20);
  expect(last.page).toBe(2);
  expect(new Set([...first.items, ...last.items].map((p) => p.id)).size).toBe(
    23,
  );
  await publication("missing", { deadline: null });
  expect(
    (
      await readCatalog(viewer, { ordine: "scadenza", pagina: "2" }, now)
    ).items.at(-1)?.id,
  ).toBe("missing");
});
it("rende testo semplice e ammette soltanto collegamenti web", async () => {
  const p = await publication("safe", {
    title: "<b>Gara</b>",
    originalText: "<p>Testo</p><script>alert(1)</script>",
    sourceUrl: "javascript:alert(1)",
    documents: [
      {
        title: "<b>Allegato</b>",
        url: "javascript:alert(1)",
        requiresLogin: false,
      },
    ],
  });
  expect(presentCatalogEntry(p, now)).toMatchObject({
    title: "Gara",
    sourceUrl: "",
    documents: [],
  });
  expect(presentCatalogEntry(p, now).originalText).not.toContain("script");
});

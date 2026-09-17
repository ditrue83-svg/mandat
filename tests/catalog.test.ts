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
  catalogDetailHref,
  catalogReturnHref,
  collectionReturnHref,
  catalogSourceStatus,
} from "../src/lib/catalog";
import { saveCatalogBookmark } from "../src/lib/company";
import { readCanonicalFeedback } from "../src/lib/canonical-feedback";
import { listOpportunities } from "../src/lib/queries";
const pg = new PGlite();
const db = drizzle(pg, { schema });
const now = new Date("2026-09-16T10:00:00Z");
const viewer = { ...demoViewer, demo: false };
const otherViewer = {
  ...viewer,
  userId: "catalog-other-user",
  companyId: "catalog-other-company",
  email: "catalog-other@example.invalid",
};
beforeAll(async () => {
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.insert(schema.user).values({
    id: viewer.userId,
    name: viewer.name,
    email: viewer.email,
  });
  await db.insert(schema.companies).values({
    id: viewer.companyId,
    ownerId: viewer.userId,
    profile: viewer.profile,
    onboardedAt: new Date(),
  });
  await db.insert(schema.user).values({
    id: otherViewer.userId,
    name: otherViewer.name,
    email: otherViewer.email,
  });
  await db.insert(schema.companies).values({
    id: otherViewer.companyId,
    ownerId: otherViewer.userId,
    profile: otherViewer.profile,
    onboardedAt: new Date(),
  });
});
beforeEach(async () => {
  vi.stubEnv("FOGLIO_REUSE_CONFIRMED", "false");
  await db.delete(schema.publications);
  await db.delete(schema.sourceRuns);
  await db.delete(schema.settings);
});
it("segnala una raccolta assente o ferma e mostra l'ultimo completamento riuscito", async () => {
  expect((await readCatalog(viewer, {}, now)).sourceDelayed).toBe(true);
  await db.insert(schema.sourceRuns).values({
    id: "old",
    source: "simap",
    status: "success",
    startedAt: new Date("2026-09-15T07:00:00Z"),
    finishedAt: new Date("2026-09-15T07:01:00Z"),
  });
  expect((await readCatalog(viewer, {}, now)).sourceDelayed).toBe(true);
  await db.insert(schema.sourceRuns).values({
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
    sourceStatus: { state: "ok" },
    sources: [
      { id: "simap", included: true, state: "ok" },
      { id: "foglio-ti", included: false, state: "disabled" },
    ],
  });
  await db.insert(schema.sourceRuns).values({
    id: "failed-after-success",
    source: "simap",
    status: "failed",
    startedAt: new Date("2026-09-16T09:30:00Z"),
    finishedAt: new Date("2026-09-16T09:30:01Z"),
    error: "HTTP 503 dettaglio interno",
  });
  expect(await readCatalog(viewer, {}, now)).toMatchObject({
    sourceDelayed: true,
    collectedAt: "2026-09-16T09:01:00.000Z",
    sourceStatus: {
      state: "error",
      lastAttemptAt: "2026-09-16T09:30:01.000Z",
    },
  });
});

it("distingue un aggiornamento normale da uno bloccato", () => {
  expect(
    catalogSourceStatus(
      {
        status: "running",
        startedAt: new Date("2026-09-16T09:55:00Z"),
        finishedAt: null,
      },
      new Date("2026-09-16T09:00:00Z"),
      now,
    ).state,
  ).toBe("updating");
  expect(
    catalogSourceStatus(
      {
        status: "running",
        startedAt: new Date("2026-09-16T09:00:00Z"),
        finishedAt: null,
      },
      new Date("2026-09-16T09:00:00Z"),
      now,
    ).state,
  ).toBe("delayed");
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
it("salva da Esplora senza creare valutazioni e rende il bando visibile nei Salvati", async () => {
  await publication("bookmark", {}, "progetto-bookmark");
  await saveCatalogBookmark(viewer.companyId, "bookmark", true, now);

  expect((await readCatalog(viewer, {}, now)).items[0].saved).toBe(true);
  expect((await readCatalogEntry(viewer, "bookmark", now))?.saved).toBe(true);
  expect((await readCatalog(otherViewer, {}, now)).items[0].saved).toBe(false);
  expect(
    await readCanonicalFeedback(db, viewer.companyId, "progetto-bookmark"),
  ).toEqual({ saved: true, dismissed: false });
  expect(await db.select().from(schema.matches)).toEqual([]);
  expect(await db.select().from(schema.pilotFeedbackEvents)).toEqual([]);
  expect(await listOpportunities(viewer)).toEqual([]);
  expect(
    (await db.select().from(schema.feedback)).map((row) => ({
      saved: row.saved,
      dismissed: row.dismissed,
      relevant: row.relevant,
    })),
  ).toEqual([{ saved: true, dismissed: false, relevant: null }]);

  const saved = await listOpportunities(viewer, { includeInactive: true });
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    id: "bookmark",
    saved: true,
    catalogOnly: true,
    assessment: "unreviewed",
    score: 0,
    summary: null,
    evidence: [],
  });
  expect(
    await listOpportunities(otherViewer, { includeInactive: true }),
  ).toEqual([]);

  await saveCatalogBookmark(viewer.companyId, "bookmark", false, now);
  expect(await listOpportunities(viewer, { includeInactive: true })).toEqual(
    [],
  );
  expect(await db.select().from(schema.matches)).toEqual([]);
});
it("mantiene il segnalibro sulla nuova edizione dello stesso bando", async () => {
  await publication("bookmark-old", {}, "progetto-versionato");
  await saveCatalogBookmark(viewer.companyId, "bookmark-old", true, now);
  await publication(
    "bookmark-new",
    { publishedAt: "2026-09-16T09:45:00Z", title: "Edizione aggiornata" },
    "progetto-versionato",
  );

  const catalog = await readCatalog(viewer, {}, now);
  expect(catalog.items).toHaveLength(1);
  expect(catalog.items[0]).toMatchObject({
    id: "bookmark-new",
    title: "Edizione aggiornata",
    saved: true,
  });
  expect(
    await listOpportunities(viewer, { includeInactive: true }),
  ).toMatchObject([{ id: "bookmark-new", saved: true, catalogOnly: true }]);

  await saveCatalogBookmark(viewer.companyId, "bookmark-new", false, now);
  expect(await listOpportunities(viewer, { includeInactive: true })).toEqual(
    [],
  );
});
it("rifiuta il salvataggio di una vecchia edizione o di una pubblicazione sotto embargo", async () => {
  await publication("old-bookmark", {}, "same-bookmark");
  await publication(
    "new-bookmark",
    { publishedAt: "2026-09-16T06:00:00Z" },
    "same-bookmark",
  );
  await expect(
    saveCatalogBookmark(viewer.companyId, "old-bookmark", true, now),
  ).rejects.toMatchObject({ status: 404 });
  await publication("future-bookmark", {
    visibleAt: "2026-09-16T10:01:00Z",
  });
  await expect(
    saveCatalogBookmark(viewer.companyId, "future-bookmark", true, now),
  ).rejects.toMatchObject({ status: 404 });
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
  const detail = catalogDetailHref(
    "id con spazi",
    {
      q: "scuole & asili",
      settore: "pulizie",
      stato: "all",
      ordine: "scadenza",
    },
    3,
  );
  expect(detail).toContain("/esplora/id%20con%20spazi?ritorno=");
  expect(
    catalogReturnHref(
      new URL(detail, "https://mandat.invalid").searchParams.get("ritorno")!,
    ),
  ).toBe(
    "/esplora?q=scuole+%26+asili&settore=pulizie&stato=all&ordine=scadenza&pagina=3",
  );
  expect(catalogReturnHref("https://evil.invalid/esplora?q=segreto")).toBe(
    "/esplora",
  );
  expect(catalogReturnHref("/admin")).toBe("/esplora");
  expect(catalogReturnHref("/salvati?ignora=questo")).toBe("/salvati");
  expect(
    collectionReturnHref(
      "/salvati?q=parco&settore=giardinaggio&ordine=scadenza&ignora=1",
      "/",
    ),
  ).toBe("/salvati?q=parco&settore=giardinaggio&ordine=scadenza");
  expect(
    collectionReturnHref(
      "/?q=verde&settore=giardinaggio&ordine=scadenza&vista=escluse",
      "/",
    ),
  ).toBe("/?q=verde&settore=giardinaggio&ordine=scadenza&vista=escluse");
  expect(collectionReturnHref("//evil.invalid/", "/")).toBe("/");
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

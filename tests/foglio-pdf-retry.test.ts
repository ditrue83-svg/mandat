import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../src/db/schema";
import { OfficialHttpError, type SourceAdapter } from "../src/sources/common";

const context = vi.hoisted(() => ({
  db: undefined as unknown,
  summarize: vi.fn(),
  classify: vi.fn(),
  queueChangeNotices: vi.fn(),
  cleanup: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("@/db", () => ({ getDb: () => context.db }));
vi.mock("@/worker/ai", () => ({
  AiUnavailable: class extends Error {},
  summarize: context.summarize,
  classify: context.classify,
}));
vi.mock("@/worker/notifications", () => ({
  queueChangeNotices: context.queueChangeNotices,
}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({
          items: [{ str: "Pulizia ordinaria dei locali comunali inventati." }],
        }),
        cleanup: context.cleanup,
      }),
    }),
    destroy: context.destroy,
  }),
}));

import { normalizeFoglio } from "../src/sources/foglio";
import { ingest } from "../src/worker/pipeline";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const xml = `<publication><meta>
<id>274fc2e7-5586-459b-b3a1-7bc2f79a8721</id>
<publicationNumber>OB-TI10-LOCAL</publicationNumber><subRubric>OB-TI10</subRubric>
<publicationDate>2026-09-10</publicationDate><publicationState>PUBLISHED</publicationState>
<title><it>Bando - Pulizia locali comunali inventati</it></title>
</meta><content><publication><![CDATA[
Pulizia ordinaria dei locali comunali inventati.
Presentazione dell'offerta: 20.10.2026 12:00
Luogo di esecuzione: Lugano
]]></publication></content></publication>`;
const publication = normalizeFoglio(xml);
const adapter: SourceAdapter = {
  id: "foglio-ti",
  list: async () => [{ id: publication.externalId, raw: {} }],
  detail: async () => normalizeFoglio(xml),
};

beforeAll(async () => {
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
}, 20000);
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => pg.close());

it("ritenta il PDF temporaneamente indisponibile senza archiviare come completa la stessa revisione XML", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response("Guasto temporaneo inventato", { status: 503 }),
    )
    .mockResolvedValueOnce(
      new Response("%PDF-1.7 fixture con parser simulato"),
    );
  vi.stubGlobal("fetch", fetchMock);

  await expect(ingest(adapter, new Date("2026-09-01"))).rejects.toThrow(
    "Importazione parziale",
  );
  expect(await db.select().from(schema.publications)).toHaveLength(0);
  expect(await db.select().from(schema.publicationVersions)).toHaveLength(0);
  const failedIssues = await db.select().from(schema.issues);
  expect(failedIssues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: `source-item:foglio-ti:${publication.externalId}`,
        severity: "critical",
        resolvedAt: null,
      }),
      expect.objectContaining({ key: "source:foglio-ti", resolvedAt: null }),
    ]),
  );
  expect((await db.select().from(schema.sourceRuns))[0].status).toBe("partial");

  await expect(ingest(adapter, new Date("2026-09-01"))).resolves.toBe(1);
  const [stored] = await db.select().from(schema.publications);
  expect(stored.revision).toBe(publication.revision);
  expect(stored.data.originalText).toBe(publication.originalText);
  expect(stored.data.reviewRequired).toBe(false);
  expect(stored.data.documentPages).toEqual([
    {
      page: 1,
      text: "Pulizia ordinaria dei locali comunali inventati.",
      url: publication.sourceUrl,
    },
  ]);
  expect(await db.select().from(schema.publicationVersions)).toHaveLength(1);
  expect(
    (await db.select().from(schema.issues)).every((i) => i.resolvedAt),
  ).toBe(true);
  expect(
    (await db.select().from(schema.sourceRuns)).map((r) => r.status).sort(),
  ).toEqual(["partial", "success"]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(context.summarize).not.toHaveBeenCalled();
  expect(context.classify).not.toHaveBeenCalled();
  expect(context.queueChangeNotices).not.toHaveBeenCalled();
  expect(await db.select().from(schema.notifications)).toHaveLength(0);

  await expect(ingest(adapter, new Date("2026-09-01"))).resolves.toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("isola un accesso negato senza ritentare l'intera fonte e continua gli altri bandi", async () => {
  const deniedId = "77777777-7777-4777-8777-777777777777";
  const availableId = "88888888-8888-4888-8888-888888888888";
  const good = normalizeFoglio(
    xml
      .replaceAll(publication.externalId, availableId)
      .replaceAll("OB-TI10-LOCAL", "OB-TI10-SECOND"),
  );
  const mixed: SourceAdapter = {
    id: "foglio-ti",
    list: async () => [
      { id: deniedId, raw: {} },
      { id: availableId, raw: {} },
    ],
    detail: async (entry) => {
      if (entry.id === deniedId)
        throw new OfficialHttpError(
          401,
          `https://amtsblattportal.ch/api/v1/publications/${deniedId}/xml`,
        );
      return good;
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("%PDF-1.7 inventato")),
  );
  await expect(ingest(mixed, new Date("2026-09-01"))).resolves.toBe(1);
  const { eq } = await import("drizzle-orm");
  const [held] = await db
    .select()
    .from(schema.issues)
    .where(eq(schema.issues.key, `source-item:foglio-ti:${deniedId}`));
  expect(held).toMatchObject({ resolvedAt: null, severity: "critical" });
  const runs = await db.select().from(schema.sourceRuns);
  expect(runs.some((r) => r.status === "partial" && r.imported === 1)).toBe(
    true,
  );
  expect(
    (await db.select().from(schema.publications)).some(
      (p) => p.externalId === availableId,
    ),
  ).toBe(true);
});

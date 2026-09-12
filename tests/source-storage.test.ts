import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { getDemoOpportunities } from "../src/lib/demo";
import type { Publication } from "../src/lib/domain";

const context = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => context.db }));
vi.mock("@/worker/notifications", () => ({ queueChangeNotices: vi.fn() }));
import { storePublication } from "../src/worker/pipeline";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const base: Publication = {
  ...getDemoOpportunities(new Date("2026-09-12T12:00:00Z"))[0],
  id: "simap-storage",
  source: "simap",
  externalId: "simap-storage",
  canonicalKey: "simap:100",
  revision: "source-v1",
  sourceUrl: "https://www.simap.ch/it/project-detail/storage",
  sourceUrls: ["https://www.simap.ch/it/project-detail/storage"],
  reviewRequired: false,
  reviewReasons: [],
  publishedAt: "2026-09-10T06:00:00Z",
};

beforeAll(async () => {
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
});
beforeEach(async () => {
  await db.delete(schema.issues);
  await db.delete(schema.publications);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => pg.close());

async function correctAfterCousinsRead(id: string, data: Publication) {
  const original = db.transaction.bind(db);
  // This runs after storePublication has read its cousin snapshots and before
  // its transaction starts: a committed edit, not a two-connection lock test.
  const spy = vi.spyOn(db, "transaction").mockImplementationOnce((async (
    callback,
    config,
  ) => {
    await db
      .update(schema.publications)
      .set({
        data,
        aiRevision: data.revision,
        deadline: data.deadline ? new Date(data.deadline) : null,
        updatedAt: new Date("2026-09-12T12:00:00Z"),
      })
      .where(eq(schema.publications.id, id));
    return original(callback, config);
  }) as typeof db.transaction);
  return spy;
}

it("aggiunge la seconda fonte senza perdere una correzione o nuovi link già salvati", async () => {
  await storePublication(base);
  const additionalUrl = "https://www.simap.ch/it/project-detail/updated-link";
  const corrected = {
    ...base,
    revision: "editorial-v2",
    summary: "Sintesi corretta prima della scrittura dei collegamenti.",
    requirements: ["Requisito verificato sulla fonte."],
    reviewRequired: true,
    reviewReasons: ["Revisione editoriale conservata"],
    sourceUrls: [...base.sourceUrls, additionalUrl],
  };
  const interception = await correctAfterCousinsRead(base.id, corrected);
  const copy = {
    ...base,
    id: "foglio-copy",
    externalId: "foglio-copy",
    source: "foglio-ti" as const,
    sourceUrl: "https://amtsblattportal.ch/api/v1/publications/copy/pdf",
    sourceUrls: ["https://amtsblattportal.ch/api/v1/publications/copy/pdf"],
  };

  expect(await storePublication(copy)).toBe(true);
  expect(interception).toHaveBeenCalledTimes(1);
  const [stored] = await db
    .select()
    .from(schema.publications)
    .where(eq(schema.publications.id, base.id));
  expect(stored.data).toEqual({
    ...corrected,
    sourceUrls: [...corrected.sourceUrls, copy.sourceUrl],
  });
  expect(stored.revision).toBe(base.revision);
  expect(stored.aiRevision).toBe(corrected.revision);
  expect(stored.status).toBe(corrected.status);
  const [newCopy] = await db
    .select()
    .from(schema.publications)
    .where(eq(schema.publications.id, copy.id));
  expect(newCopy.data.sourceUrls).toEqual([
    copy.sourceUrl,
    ...corrected.sourceUrls,
  ]);
});

it("chiude la precedente edizione conservando la correzione concorrente e i suoi link", async () => {
  const previous = {
    ...base,
    id: "foglio-first",
    externalId: "foglio-first",
    source: "foglio-ti" as const,
    projectId: "100-01",
    sourceUrl: "https://amtsblattportal.ch/api/v1/publications/first/pdf",
    sourceUrls: ["https://amtsblattportal.ch/api/v1/publications/first/pdf"],
  };
  await storePublication(previous);
  const corrected = {
    ...previous,
    revision: "editorial-before-successor",
    summary: "Sintesi corretta da conservare nello storico.",
    deadline: "2026-10-20T10:00:00.000Z",
    sourceUrls: [
      ...previous.sourceUrls,
      "https://www.simap.ch/it/project-detail/extra",
    ],
  };
  await correctAfterCousinsRead(previous.id, corrected);
  const successor = {
    ...previous,
    id: "foglio-second",
    externalId: "foglio-second",
    projectId: "100-02",
    revision: "source-v2",
    publishedAt: "2026-09-11T06:00:00Z",
    sourceUrl: "https://amtsblattportal.ch/api/v1/publications/second/pdf",
    sourceUrls: ["https://amtsblattportal.ch/api/v1/publications/second/pdf"],
  };

  expect(await storePublication(successor)).toBe(true);
  const [stored] = await db
    .select()
    .from(schema.publications)
    .where(eq(schema.publications.id, previous.id));
  expect(stored.data).toEqual({
    ...corrected,
    status: "closed",
    sourceUrls: [...corrected.sourceUrls, successor.sourceUrl],
  });
  expect(stored.status).toBe("closed");
  expect(stored.deadline?.toISOString()).toBe(corrected.deadline);
  expect(stored.aiRevision).toBe(corrected.revision);
  const [newEdition] = await db
    .select()
    .from(schema.publications)
    .where(eq(schema.publications.id, successor.id));
  expect(newEdition.data.sourceUrls).toEqual([
    successor.sourceUrl,
    ...corrected.sourceUrls,
  ]);
});

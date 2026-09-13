import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as schema from "../src/db/schema";
import { normalizeSimap } from "../src/sources/simap";
import type { SourceAdapter, SourceEntry } from "../src/sources/common";

const injected = vi.hoisted(() => ({
  db: undefined as unknown,
  summarize: vi.fn(),
  classify: vi.fn(),
  notices: vi.fn(),
}));
vi.mock("@/db", () => ({ getDb: () => injected.db }));
vi.mock("@/worker/ai", () => ({
  AiUnavailable: class extends Error {},
  summarize: injected.summarize,
  classify: injected.classify,
}));
vi.mock("@/worker/notifications", () => ({ queueChangeNotices: injected.notices }));
import { ingest } from "../src/worker/pipeline";

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
const projectId = "11111111-0000-4000-8000-000000000001";
const publicationId = "22222222-0000-4000-8000-000000000002";
const lotId = "33333333-0000-4000-8000-000000000003";
const since = new Date("2030-09-01T00:00:00.000Z");
const options = { documentaryMode: "shadow" as const };
function entry(): SourceEntry {
  return {
    id: projectId,
    raw: {
      id: projectId,
      publicationId,
      publicationDate: "2030-09-10",
      projectNumber: "INVENTED-INGESTION",
      pubType: "tender",
      processType: "open",
      title: { it: "Parco inventato" },
      procOfficeName: { it: "Ente inventato" },
    },
  };
}
function detail() {
  return {
    id: publicationId,
    type: "tender",
    "project-info": { title: { it: "Parco inventato" } },
    procurement: {
      orderDescription: { it: "Servizi nel parco inventato." },
      orderAddress: { city: "Lugano", cantonId: "TI" },
    },
    dates: { offerDeadline: "2030-12-01T12:00:00+01:00" },
    base: { id: publicationId, projectId, lotsType: "with" },
    lots: [{ id: lotId, lotNumber: 1, title: { it: "Cura del verde" }, orderDescription: { it: "Potatura degli alberi." } }],
  };
}
function adapter(): SourceAdapter {
  return {
    id: "simap",
    list: async () => [entry()],
    detail: async (e) => normalizeSimap(e, detail()),
  };
}
beforeEach(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  injected.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
  vi.clearAllMocks();
}, 20000);
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await pg.close();
});

test("Explicit shadow capture enriches an unchanged source without replacing its data or adopting a pointer", async () => {
  const source = adapter();
  const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(detail()))));
  vi.stubGlobal("fetch", fetchMock);
  expect(await ingest(source, since)).toBe(1);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await db.select().from(schema.publicationDocumentarySnapshots)).toHaveLength(0);
  const [before] = await db.select().from(schema.publications);
  const editorial = { ...before.data, summary: "Riassunto già revisionato." };
  await db.update(schema.publications).set({ data: editorial }).where(eq(schema.publications.id, before.id));
  const [preserved] = await db.select().from(schema.publications);
  expect(await ingest(source, since, undefined, options)).toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await db.select().from(schema.publications)).toEqual([preserved]);
  expect(await db.select().from(schema.publicationVersions)).toHaveLength(1);
  const [observation] = await db.select().from(schema.publicationDocumentarySnapshots);
  expect(observation.state).toBe("accepted");
  expect(observation.request.observedPublication).toEqual({ revision: before.revision, documentarySnapshotId: null });
  expect(observation.acquisition.receipt.url).toContain(`/publication-details/${publicationId}`);
  expect(preserved.data).not.toHaveProperty("documentaryAcquisition");
  expect(await db.select().from(schema.notifications)).toHaveLength(0);
  expect(injected.classify).not.toHaveBeenCalled();
  expect(injected.summarize).not.toHaveBeenCalled();
  expect(injected.notices).not.toHaveBeenCalled();
});

test("An unusable detail is retained as a refusal and a source error, with no fabricated publication", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{broken"))));
  await expect(ingest(adapter(), since, undefined, options)).rejects.toThrow("Importazione parziale");
  expect(await db.select().from(schema.publications)).toHaveLength(0);
  expect(await db.select().from(schema.publicationVersions)).toHaveLength(0);
  const [observation] = await db.select().from(schema.publicationDocumentarySnapshots);
  expect(observation).toMatchObject({ state: "refused", publicationId: null });
  expect(observation.acquisition).toMatchObject({ refusal: { stage: "parse", code: "invalid_json" } });
  expect(await db.select().from(schema.issues)).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: `source-item:simap:${projectId}`, severity: "critical", resolvedAt: null }),
  ]));
  expect((await db.select().from(schema.sourceRuns))[0].status).toBe("failed");
  expect(await db.select().from(schema.notifications)).toHaveLength(0);
});

test("Tracked-project refresh captures the detail named by the header, without calling the legacy refresh", async () => {
  await ingest(adapter(), since);
  const header = {
    id: projectId,
    projectNumber: "INVENTED-INGESTION",
    processType: "open",
    latestPublication: { id: publicationId, dates: { publicationDate: "2030-09-10" }, pubType: "tender", title: { it: "Parco inventato" } },
  };
  const refresh = vi.fn().mockRejectedValue(new Error("Legacy refresh must not run in shadow mode"));
  const source = { ...adapter(), list: async () => [], refresh };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(header)))
    .mockResolvedValueOnce(new Response(JSON.stringify(detail())));
  vi.stubGlobal("fetch", fetchMock);
  expect(await ingest(source, since, undefined, options)).toBe(0);
  expect(refresh).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0][0]).toContain("project-header");
  expect(fetchMock.mock.calls[1][0]).toContain(`/publication-details/${publicationId}`);
  expect(await db.select().from(schema.publicationDocumentarySnapshots)).toHaveLength(1);
  expect((await db.select().from(schema.publications))[0].documentarySnapshotId).toBeNull();
});

test("Shadow collection recovers after source storage succeeds but the observation transaction is interrupted", async () => {
  const source = adapter();
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(detail())))));
  const originalTransaction = db.transaction.bind(db);
  let transactions = 0;
  const interrupted = vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => {
    if (++transactions === 3) throw new Error("Simulated interruption before shadow append");
    return originalTransaction(callback, config);
  });
  await expect(ingest(source, since, undefined, options)).rejects.toThrow("Importazione parziale");
  expect(await db.select().from(schema.publications)).toHaveLength(1);
  expect(await db.select().from(schema.publicationDocumentarySnapshots)).toHaveLength(0);
  interrupted.mockRestore();
  expect(await ingest(source, since, undefined, options)).toBe(0);
  expect(await db.select().from(schema.publications)).toHaveLength(1);
  expect(await db.select().from(schema.publicationVersions)).toHaveLength(1);
  expect(await db.select().from(schema.publicationDocumentarySnapshots)).toHaveLength(1);
  expect((await db.select().from(schema.publications))[0].documentarySnapshotId).toBeNull();
  expect(await db.select().from(schema.notifications)).toHaveLength(0);
});

import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { PgBoss, fromPglite } from "pg-boss";
import * as schema from "../src/db/schema";
import { getDemoOpportunities } from "../src/lib/demo";
import type { SourceAdapter } from "../src/sources/common";
import { FOGLIO_REFRESH_CURSOR } from "../src/sources/foglio-discovery";
const ctx = vi.hoisted(() => ({ db: undefined as unknown, notices: vi.fn() }));
vi.mock("@/db", () => ({ getDb: () => ctx.db }));
vi.mock("@/worker/notifications", () => ({ queueChangeNotices: ctx.notices }));
vi.mock("@/sources/foglio", async (original) => ({
  ...(await original<typeof import("../src/sources/foglio")>()),
  attachFoglioPdf: async (p: unknown) => p,
}));
import { ingest, storePublication } from "../src/worker/pipeline";
const pg = new PGlite(),
  db = drizzle(pg, { schema });
const boss = new PgBoss({
  db: fromPglite(pg),
  backend: "pglite",
  schema: "pgboss",
  schedule: false,
  supervise: false,
});
const publication = (n: number) => ({
  ...getDemoOpportunities()[0],
  id: `foglio-ti-${n}`,
  source: "foglio-ti" as const,
  externalId: String(n),
  canonicalKey: undefined,
  projectId: undefined,
  title: `Bando inventato ${n}`,
  revision: `invented-${n}`,
  publishedAt: "2021-01-01T00:00:00.000Z",
  visibleAt: "2021-01-01T00:00:00.000Z",
});
beforeAll(async () => {
  ctx.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
  await boss.start();
  for (const name of ["radar-publication", "notification-work"])
    await boss.createQueue(name, { policy: "stately" });
});
beforeEach(async () => {
  ctx.notices.mockClear();
  await db.delete(schema.publications);
  await db.delete(schema.sourceRuns);
  await db.delete(schema.settings);
  await db.delete(schema.issues);
  await pg.exec("delete from pgboss.job");
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await boss.stop();
  await pg.close();
});
it("commits source and durable follow-ups together, without inline reconciliation; a failed queue write rolls the source back", async () => {
  await storePublication(publication(1), {
    deferNotifications: true,
    lockTimeoutMs: 5000,
  });
  await storePublication(
    {
      ...publication(1),
      revision: "invented-amended",
      originalText: "Nuovo originale pubblico inventato",
    },
    { deferNotifications: true, lockTimeoutMs: 5000 },
  );
  expect(ctx.notices).not.toHaveBeenCalled();
  expect(await db.select().from(schema.publicationVersions)).toHaveLength(2);
  const jobs = await pg.query<{ name: string }>(
    "select distinct name from pgboss.job order by name",
  );
  expect(jobs.rows.map((r) => r.name)).toEqual([
    "notification-work",
    "radar-publication",
  ]);
  await boss.deleteQueue("radar-publication");
  await expect(
    storePublication(publication(2), { deferNotifications: true }),
  ).rejects.toThrow();
  expect(
    (await db.select().from(schema.publications)).map((p) => p.id),
  ).toEqual(["foglio-ti-1"]);
  await boss.createQueue("radar-publication", { policy: "stately" });
});
it("ends historical work between records, keeps partial status and resumes after the actual attempted record", async () => {
  let tick = 0;
  vi.spyOn(performance, "now").mockImplementation(() => tick);
  const adapter: SourceAdapter = {
    id: "foglio-ti",
    list: async () =>
      Array.from({ length: 45 }, (_, i) => ({
        id: String(i),
        raw: {
          meta: {
            publicationDate: "2021-01-01",
            publicationState: "PUBLISHED",
          },
        },
      })),
    detail: async (e) => {
      tick = 70_000;
      return publication(Number(e.id));
    },
  };
  let progress: any;
  await ingest(adapter, new Date("2030-01-01"), undefined, {
    mode: "archive",
    budgetMs: 60_000,
    deferNotifications: true,
    onProgress: (p) => {
      progress = p;
    },
  });
  expect(progress).toMatchObject({
    processed: 1,
    newImported: 1,
    remainingSelected: 4,
    missing: 44,
  });
  const [cursor] = (await db.select().from(schema.settings)).filter(
    (s) => s.key === FOGLIO_REFRESH_CURSOR,
  );
  expect(cursor.value).toMatchObject({ backfill: "40" });
  // Historical recovery must not compete with new publications for urgency.
  expect(
    (
      await pg.query<{ priority: number }>(
        "select priority from pgboss.job where name='radar-publication'",
      )
    ).rows,
  ).toEqual([{ priority: 0 }]);
  expect((await db.select().from(schema.sourceRuns))[0]).toMatchObject({
    source: "foglio-ti:archive",
    status: "partial",
    imported: 1,
  });
});
it("an unchanged original recovering from a hold clears the hold and durably wakes its own matching/notice jobs", async () => {
  await storePublication(publication(1));
  await db.insert(schema.issues).values({
    id: "held-source",
    key: "source-item:foglio-ti:1",
    title: "Fonte temporaneamente non disponibile",
    detail: "Errore inventato",
    severity: "critical",
  });
  const adapter: SourceAdapter = {
    id: "foglio-ti",
    list: async () => [
      {
        id: "1",
        raw: {
          meta: {
            publicationDate: "2021-01-01",
            publicationState: "PUBLISHED",
          },
        },
      },
    ],
    detail: async () => publication(1),
  };
  await expect(
    ingest(adapter, new Date("2030-01-01"), undefined, {
      mode: "current",
      budgetMs: 120000,
      deferNotifications: true,
    }),
  ).resolves.toBe(0);
  const held = (await db.select().from(schema.issues)).find(
    (i) => i.id === "held-source",
  );
  expect(held?.resolvedAt).toBeInstanceOf(Date);
  const jobs = await pg.query<{ name: string }>(
    "select distinct name from pgboss.job order by name",
  );
  expect(jobs.rows.map((r) => r.name)).toEqual([
    "notification-work",
    "radar-publication",
  ]);
  expect(ctx.notices).not.toHaveBeenCalled();
  expect(await db.select().from(schema.publicationVersions)).toHaveLength(1);
});

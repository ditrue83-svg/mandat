import { afterAll, beforeAll, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PgBoss, fromPglite } from "pg-boss";
import {
  SOURCE_INGEST_QUEUE,
  requestSourceIngestions,
  requestSourceIngestion,
} from "../src/worker/ingestion-scheduling";
const pg = new PGlite();
const boss = new PgBoss({
  db: fromPglite(pg),
  backend: "pglite",
  schema: "pgboss",
  schedule: false,
  supervise: false,
});
beforeAll(async () => {
  await boss.start();
  await boss.createQueue(SOURCE_INGEST_QUEUE, { policy: "stately" });
});
afterAll(async () => {
  await boss.stop();
  await pg.close();
});
it("coalesces old refresh intents, prioritizes current sources over archive and keeps one trailing refresh during active work", async () => {
  for (let i = 0; i < 34; i++) await requestSourceIngestions(boss, true);
  let rows = await pg.query<{ n: number }>(
    "select count(*)::int n from pgboss.job where state='created'",
  );
  expect(rows.rows[0].n).toBe(3);
  const [active] = await boss.fetch<{ source: string; mode: string }>(
    SOURCE_INGEST_QUEUE,
  );
  expect(active.data.mode).toBe("current");
  for (let i = 0; i < 34; i++) await requestSourceIngestions(boss, true);
  const states = await pg.query<{ state: string; n: number }>(
    "select state,count(*)::int n from pgboss.job group by state order by state",
  );
  expect(states.rows).toEqual([
    { state: "created", n: 3 },
    { state: "active", n: 1 },
  ]);
  await boss.complete(SOURCE_INGEST_QUEUE, active.id);
  const [next] = await boss.fetch<{ mode: string }>(SOURCE_INGEST_QUEUE);
  expect(next.data.mode).toBe("current");
  await boss.complete(SOURCE_INGEST_QUEUE, next.id);
});
it("does not create an archive collector when Foglio is disabled, and rejects a SIMAP archive intent", async () => {
  await expect(
    requestSourceIngestion(boss, { source: "simap", mode: "archive" }),
  ).rejects.toThrow("Invalid source");
  await requestSourceIngestions(boss, false);
  const rows = await pg.query<{ n: number }>(
    "select count(*)::int n from pgboss.job where state='created' and data->>'source'='simap'",
  );
  expect(rows.rows[0].n).toBeLessThanOrEqual(1);
});

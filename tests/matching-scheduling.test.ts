import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PgBoss, fromPglite } from "pg-boss";
import {
  PUBLICATION_MATCH_QUEUE,
  MATCH_SWEEP_QUEUE,
  requestPublicationMatching,
  requestPublicationMatchingBatch,
  requestMatchingSweep,
  publicationMatchJob,
} from "../src/worker/matching-scheduling";
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
  await boss.createQueue(PUBLICATION_MATCH_QUEUE, { policy: "stately" });
  await boss.createQueue(MATCH_SWEEP_QUEUE, { policy: "stately" });
  await boss.createQueue("match-publication", { policy: "singleton" });
});
beforeEach(async () => {
  await pg.exec("delete from pgboss.job");
});
afterAll(async () => {
  await boss.stop();
  await pg.close();
});
it("keeps current priority, an immutable active request and one trailing refresh when producers repeat and restart", async () => {
  await requestPublicationMatchingBatch(boss, [
    { publicationId: "a" },
    { publicationId: "b" },
  ]);
  await requestPublicationMatching(boss, { publicationId: "b" }, true);
  await requestPublicationMatching(boss, { publicationId: "b" });
  for (let i = 0; i < 10; i++)
    await requestPublicationMatchingBatch(boss, [
      { publicationId: "a" },
      { publicationId: "b" },
    ]);
  const [active] = await boss.fetch<{ publicationId: string }>(
    PUBLICATION_MATCH_QUEUE,
  );
  expect(active.data).toEqual({ publicationId: "b" });
  for (let i = 0; i < 10; i++)
    await requestPublicationMatching(boss, { publicationId: "b" }, true);
  const states = await pg.query<{ state: string; n: number }>(
    "select state,count(*)::int n from pgboss.job group by state order by state",
  );
  expect(states.rows).toEqual([
    { state: "created", n: 2 },
    { state: "active", n: 1 },
  ]);
  expect(
    (await boss.findJobs(PUBLICATION_MATCH_QUEUE, { id: active.id }))[0].data,
  ).toEqual({ publicationId: "b" });
  await boss.stop();
  await boss.start();
  await requestPublicationMatching(boss, { publicationId: "b" }, true);
  expect(
    (
      await pg.query<{ n: number }>(
        "select count(*)::int n from pgboss.job where state='created'",
      )
    ).rows[0].n,
  ).toBe(2);
  await boss.complete(PUBLICATION_MATCH_QUEUE, active.id);
  const [trailing] = await boss.fetch<{ publicationId: string }>(
    PUBLICATION_MATCH_QUEUE,
  );
  expect(trailing.data.publicationId).toBe("b");
});
it("hands a duplicate legacy backlog off durably and idempotently without performing business work or deleting original jobs", async () => {
  const jobs = Array.from({ length: 4000 }, (_, i) => ({
    data: { publicationId: `p-${i % 80}` },
    singletonKey: `p-${i % 80}`,
  }));
  await boss.insert("match-publication", jobs);
  let acknowledged = 0;
  while (true) {
    const batch = await boss.fetch<{ publicationId: string }>(
      "match-publication",
      { batchSize: 5000 },
    );
    if (!batch.length) break;
    await requestPublicationMatchingBatch(
      boss,
      batch.map((x) => x.data),
    );
    // Crash boundary: replaying before acknowledging cannot add a duplicate slot.
    await requestPublicationMatchingBatch(
      boss,
      batch.map((x) => x.data),
    );
    await boss.complete(
      "match-publication",
      batch.map((x) => x.id),
    );
    acknowledged += batch.length;
  }
  expect(acknowledged).toBe(4000);
  const counts = await pg.query<{ name: string; state: string; n: number }>(
    "select name,state,count(*)::int n from pgboss.job group by name,state order by name,state",
  );
  expect(counts.rows).toEqual([
    { name: "match-publication", state: "completed", n: 4000 },
    { name: PUBLICATION_MATCH_QUEUE, state: "created", n: 80 },
  ]);
}, 30000);
it("cannot acknowledge an old batch if replacement persistence fails", async () => {
  await boss.send(
    "match-publication",
    { publicationId: "kept" },
    { singletonKey: "kept" },
  );
  const batch = await boss.fetch<{ publicationId: string }>(
    "match-publication",
  );
  await expect(
    requestPublicationMatchingBatch(
      {
        insert: async () => {
          throw new Error("synthetic storage failure");
        },
      },
      batch.map((x) => x.data),
    ),
  ).rejects.toThrow("synthetic storage failure");
  expect(
    (await boss.findJobs("match-publication", { id: batch[0].id }))[0].state,
  ).toBe("active");
});
it("coalesces global refreshes but retains a trailing refresh during active work", async () => {
  for (let i = 0; i < 50; i++) await requestMatchingSweep(boss);
  const [active] = await boss.fetch(MATCH_SWEEP_QUEUE);
  expect(active).toBeDefined();
  for (let i = 0; i < 50; i++) await requestMatchingSweep(boss);
  expect(
    (
      await pg.query<{ state: string; n: number }>(
        "select state,count(*)::int n from pgboss.job group by state order by state",
      )
    ).rows,
  ).toEqual([
    { state: "created", n: 1 },
    { state: "active", n: 1 },
  ]);
});
it("validates every identity before the bulk handoff and strips untrusted cached verdicts", async () => {
  expect(publicationMatchJob({ publicationId: "p", approved: true })).toEqual({
    publicationId: "p",
  });
  await expect(
    requestPublicationMatchingBatch(boss, [
      { publicationId: "p" },
      { publicationId: " " },
    ]),
  ).rejects.toThrow("Invalid publication");
  expect(
    (await pg.query<{ n: number }>("select count(*)::int n from pgboss.job"))
      .rows[0].n,
  ).toBe(0);
});

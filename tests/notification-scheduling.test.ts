import { afterAll, beforeAll, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PgBoss, fromPglite } from "pg-boss";
import { requestNotificationSweeps } from "../src/worker/notification-scheduling";

const pg = new PGlite();
const boss = new PgBoss({
  db: fromPglite(pg), backend: "pglite", schema: "pgboss",
  schedule: false, supervise: false,
});
beforeAll(async () => {
  await boss.start();
  for (const name of ["digest", "send"])
    await boss.createQueue(name, { policy: "singleton" });
});
afterAll(async () => { await boss.stop(); await pg.close(); });

it("a burst keeps one trailing database job while a sweep is active, including across producer restart", async () => {
  // Freeze PostgreSQL's now() for this burst so running the test near a minute
  // boundary cannot turn one burst into two legitimate scheduling windows.
  await pg.exec("begin");
  await requestNotificationSweeps(boss);
  const active = new Map<string, string>();
  for (const name of ["digest", "send"]) {
    const jobs = await boss.fetch(name);
    expect(jobs).toHaveLength(1);
    active.set(name, jobs[0].id);
  }
  for (let i = 0; i < 100; i++) await requestNotificationSweeps(boss);
  const counts = await pg.query<{name: string; state: string; n: number}>(
    "select name,state,count(*)::int n from pgboss.job group by name,state order by name,state",
  );
  expect(counts.rows).toEqual([
    {name: "digest", state: "created", n: 1},
    {name: "digest", state: "active", n: 1},
    {name: "send", state: "created", n: 1},
    {name: "send", state: "active", n: 1},
  ]);
  await pg.exec("commit");
  await boss.stop();
  await boss.start();
  for (const name of ["digest", "send"]) {
    expect(await boss.fetch(name)).toHaveLength(0);
    await boss.complete(name, active.get(name)!);
  }
  // Make the persisted trailing slot due without a wall-clock sleep. Do not
  // create another signal: recovery must consume the already committed jobs.
  await pg.exec("update pgboss.job set start_after=now() where state='created'");
  for (const name of ["digest", "send"]) {
    const next = await boss.fetch(name);
    expect(next).toHaveLength(1);
    expect(next[0].id).not.toBe(active.get(name));
    await boss.complete(name, next[0].id);
    expect(await boss.fetch(name)).toHaveLength(0);
  }
});

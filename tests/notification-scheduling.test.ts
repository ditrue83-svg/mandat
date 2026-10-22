import { afterAll, beforeAll, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PgBoss, fromPglite } from "pg-boss";
import {
  NOTIFICATION_WORK_QUEUE,
  requestNotificationSweeps,
  notificationWorkJob,
} from "../src/worker/notification-scheduling";

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
  await boss.createQueue(NOTIFICATION_WORK_QUEUE, { policy: "stately" });
});
afterAll(async () => {
  await boss.stop();
  await pg.close();
});

it("keeps one pending request per kind during slow active work, across producer restart, without a minute-window backlog", async () => {
  await requestNotificationSweeps(boss);
  expect(
    (
      await pg.query<{ seconds: number }>(
        "select min(extract(epoch from start_after-created_on))::int seconds from pgboss.job",
      )
    ).rows[0].seconds,
  ).toBeGreaterThanOrEqual(59);
  // Only the synthetic database clock is advanced; production timestamps stay intact.
  await pg.exec(
    "update pgboss.job set start_after=now() where state='created'",
  );
  const [active] = await boss.fetch(NOTIFICATION_WORK_QUEUE);
  const pendingBefore = (
    await pg.query<{ id: string; due: string }>(
      "select id::text,start_after::text due from pgboss.job where state='created'",
    )
  ).rows;
  for (let i = 0; i < 100; i++) await requestNotificationSweeps(boss);
  const counts = await pg.query<{ state: string; n: number }>(
    "select state,count(*)::int n from pgboss.job group by state order by state",
  );
  expect(counts.rows).toEqual([
    { state: "created", n: 2 },
    { state: "active", n: 1 },
  ]);
  for (const pending of pendingBefore) {
    expect(
      (
        await pg.query<{ due: string }>(
          "select start_after::text due from pgboss.job where id=$1",
          [pending.id],
        )
      ).rows[0].due,
    ).toBe(pending.due);
  }
  await boss.stop();
  await boss.start();
  // A fresh producer after a real restart must retain the existing two slots.
  await requestNotificationSweeps(boss);
  expect(
    (
      await pg.query<{ n: number }>(
        "select count(*)::int n from pgboss.job where state='created'",
      )
    ).rows[0].n,
  ).toBe(2);
  await boss.complete(NOTIFICATION_WORK_QUEUE, active.id);
  await pg.exec(
    "update pgboss.job set start_after=now() where state='created'",
  );
  const seen = new Set();
  for (let i = 0; i < 2; i++) {
    const [next] = await boss.fetch<{ kind: string }>(NOTIFICATION_WORK_QUEUE);
    expect(next).toBeDefined();
    seen.add(notificationWorkJob(next.data).kind);
    await boss.complete(NOTIFICATION_WORK_QUEUE, next.id);
  }
  expect(seen).toEqual(new Set(["digest", "send"]));
  expect(await boss.fetch(NOTIFICATION_WORK_QUEUE)).toEqual([]);
});
it("rejects malformed work without silently choosing a delivery or digest", () => {
  expect(() => notificationWorkJob({ kind: "anything" })).toThrow(
    "Invalid notification",
  );
  expect(() => notificationWorkJob(null)).toThrow("Invalid notification");
});

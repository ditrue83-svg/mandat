import { it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PgBoss, fromPglite } from "pg-boss";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("conserva i lavori su disco dopo la chiusura di worker e database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mandat-queue-"));
  let pg = new PGlite(directory);
  const create = () =>
    new PgBoss({
      db: fromPglite(pg),
      backend: "pglite",
      schema: "pgboss_test",
      schedule: false,
      supervise: false,
    });
  let boss = create();
  try {
    await boss.start();
    await boss.createQueue("restart", { retryLimit: 2, expireInSeconds: 1800 });
    const id = await boss.send("restart", { publicationId: "tender-1" });
    await boss.stop();
    await pg.close();
    pg = new PGlite(directory);
    boss = create();
    await boss.start();
    const [job] = await boss.fetch("restart", {
      batchSize: 1,
      includeMetadata: true,
    });
    expect(job.id).toBe(id);
    expect(job.data).toEqual({ publicationId: "tender-1" });
    await boss.complete("restart", job.id);
    const [saved] = await boss.findJobs("restart", { id: job.id });
    expect(saved.state).toBe("completed");
    expect(await boss.fetch("restart")).toEqual([]);
  } finally {
    await boss.stop();
    await pg.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);

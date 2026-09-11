import { PgBoss } from "pg-boss";
import { DateTime } from "luxon";
import { assertProductionConfig } from "@/lib/config";
import { simap } from "@/sources/simap";
import { foglio } from "@/sources/foglio";
import { ingest, enrichAndMatch, recordIssue } from "./pipeline";
import {
  queueDigests,
  sendPending,
  recoverUncertainDeliveries,
} from "./notifications";
import { closeDb, getDb } from "@/db";
import { settings, sourceRuns, publications } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { databaseOptions } from "@/lib/database-config";
async function main() {
  assertProductionConfig();
  const boss = new PgBoss({
    ...databaseOptions(process.env, "queue"),
    schema: "pgboss",
  });
  boss.on("error", (e) => console.error("worker_error", e.message));
  await boss.start();
  for (const name of [
    "ingest",
    "match",
    "match-publication",
    "digest",
    "send",
    "heartbeat",
  ])
    await boss.createQueue(name, {
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      policy: "singleton",
      expireInSeconds: name === "ingest" ? 7200 : 1800,
    });
  await recoverUncertainDeliveries();
  await boss.work("ingest", { batchSize: 1 }, async ([job]) => {
    const adapters = [
      simap,
      ...(process.env.FOGLIO_REUSE_CONFIRMED === "true" ? [foglio] : []),
    ];
    const errors: string[] = [];
    for (const adapter of adapters) {
      const [last] = await getDb()
        .select()
        .from(sourceRuns)
        .where(eq(sourceRuns.source, adapter.id))
        .orderBy(desc(sourceRuns.finishedAt))
        .limit(1);
      const now = DateTime.now().setZone("Europe/Zurich");
      const since = now
        .minus({ days: !last || now.hour === 8 ? 90 : 7 })
        .toJSDate();
      try {
        await ingest(adapter, since, job.signal);
      } catch (e) {
        errors.push(
          e instanceof Error ? e.message : "Importazione non riuscita",
        );
      }
    }
    await boss.send("match", {}, { singletonKey: "all" });
    if (errors.length) throw new Error(errors.join("; "));
  });
  await boss.work("match", { batchSize: 1 }, async () => {
    const rows = await getDb()
      .select({ id: publications.id })
      .from(publications)
      .where(eq(publications.status, "open"));
    for (const p of rows)
      await boss.send(
        "match-publication",
        { publicationId: p.id },
        { singletonKey: p.id },
      );
  });
  await boss.work<{ publicationId: string }>(
    "match-publication",
    { batchSize: 1 },
    async ([job]) => {
      await enrichAndMatch({
        publicationId: job.data.publicationId,
        signal: job.signal,
      });
      await boss.send("digest", {}, { singletonKey: "all" });
    },
  );
  await boss.work("digest", { batchSize: 1 }, async () => {
    await queueDigests();
    await boss.send("send", {}, { singletonKey: "all" });
  });
  await boss.work("send", { batchSize: 1 }, async () => {
    await sendPending();
  });
  const heartbeat = async () => {
    await getDb()
      .insert(settings)
      .values({ key: "worker_heartbeat", value: new Date().toISOString() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: new Date().toISOString() },
      });
  };
  await boss.work("heartbeat", { batchSize: 1 }, heartbeat);
  await heartbeat();
  await boss.schedule("ingest", "5 * * * *", {}, { tz: "Europe/Zurich" });
  await boss.schedule("match", "10 * * * *", {}, { tz: "Europe/Zurich" });
  await boss.schedule("digest", "*/10 9-20 * * *", {}, { tz: "Europe/Zurich" });
  await boss.schedule("send", "*/5 * * * *", {}, { tz: "Europe/Zurich" });
  await boss.schedule("heartbeat", "*/5 * * * *", {}, { tz: "Europe/Zurich" });
  await boss.send("ingest", {}, { singletonKey: "all" });
  console.info("Mandat worker attivo; riepilogo dopo le 09:00 Europe/Zurich");
  const shutdown = async () => {
    await boss.stop({ graceful: true });
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
main().catch((e) => {
  console.error(
    "worker_start_failed",
    e instanceof Error ? e.message : "Errore",
  );
  process.exit(1);
});

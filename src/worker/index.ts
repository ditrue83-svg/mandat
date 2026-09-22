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
import {
  LOT_RECONCILIATION_QUEUE,
  type LotReconciliationJob,
} from "@/lib/lot-reconciliation";
import { reconcileLotNotices } from "./lot-notifications";
import { matchAdoptedPublication } from "./lot-matching";
import { DOCUMENTARY_ADOPTION_CAPABILITY } from "@/lib/documentary-capability";
import { loadDocumentaryRuntimeActivation } from "@/lib/documentary-runtime-config";
import { recoverStaleAiReservations } from "./ai";
import {
  AUTOMATIC_COMPARISON_QUEUE,
  automaticComparisonEnabled,
  type AutomaticComparisonJob,
} from "@/lib/automatic-comparison-queue";
import {
  reconcileAutomaticComparisonLeases,
  runAutomaticComparison,
} from "./automatic-matching";
import {
  requestNotificationDelivery,
  requestNotificationSweeps,
} from "./notification-scheduling";
async function main() {
  assertProductionConfig();
  // Read once before registering consumers. A malformed release file stops
  // startup instead of silently reverting adopted records to legacy processing.
  const documentaryActivation = loadDocumentaryRuntimeActivation();
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
  await boss.createQueue(AUTOMATIC_COMPARISON_QUEUE, {
    retryLimit: 2,
    retryDelay: 300,
    retryBackoff: true,
    expireInSeconds: 3600,
  });
  // Pausing the feature leaves durable jobs untouched for the next enabled
  // worker; consuming and rejecting them would exhaust their retry budget.
  if (automaticComparisonEnabled())
    await boss.work<AutomaticComparisonJob>(
      AUTOMATIC_COMPARISON_QUEUE,
      { batchSize: 1 },
      async ([job]) => {
        await runAutomaticComparison(job.data, { signal: job.signal });
        await requestNotificationSweeps(boss);
      },
    );
  await boss.createQueue(LOT_RECONCILIATION_QUEUE, {
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 1800,
  });
  await boss.work<LotReconciliationJob>(
    LOT_RECONCILIATION_QUEUE,
    { batchSize: 1 },
    async ([job]) => {
      await matchAdoptedPublication({
        publicationId: job.data.publicationId,
        signal: job.signal,
      });
      // digest/send own the global reconciliation, including stale pending
      // content. Do not lock every company's projects once for every source.
      await requestNotificationSweeps(boss);
    },
  );
  await reconcileLotNotices();
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
        await ingest(adapter, since, job.signal, { documentaryActivation });
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
        documentaryActivation,
      });
      await requestNotificationSweeps(boss);
    },
  );
  await boss.work("digest", { batchSize: 1 }, async () => {
    await queueDigests();
    await requestNotificationDelivery(boss);
  });
  await boss.work("send", { batchSize: 1 }, async () => {
    await sendPending();
  });
  const heartbeat = async () => {
    if (automaticComparisonEnabled())
      await reconcileAutomaticComparisonLeases();
    const recoveredAiReservations = await recoverStaleAiReservations();
    if (recoveredAiReservations)
      console.warn("ai_usage_reservations_recovered", recoveredAiReservations);
    await getDb()
      .insert(settings)
      .values({ key: "worker_heartbeat", value: new Date().toISOString() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: new Date().toISOString() },
      });
    const capability = {
      capability: DOCUMENTARY_ADOPTION_CAPABILITY,
      role: "worker",
      buildId: process.env.MANDAT_BUILD_ID ?? "development",
      reportedAt: new Date().toISOString(),
    };
    await getDb()
      .insert(settings)
      .values({ key: "worker_documentary_capability", value: capability })
      .onConflictDoUpdate({ target: settings.key, set: { value: capability } });
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

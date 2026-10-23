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
import { settings, publications } from "@/db/schema";
import { eq } from "drizzle-orm";
import { databaseOptions } from "@/lib/database-config";
import {
  LOT_RECONCILIATION_QUEUE,
  type LotReconciliationJob,
} from "@/lib/lot-reconciliation";
import { DOCUMENTARY_ADOPTION_CAPABILITY } from "@/lib/documentary-capability";
import { loadDocumentaryRuntimeActivation } from "@/lib/documentary-runtime-config";
import { recoverStaleAiReservations } from "./ai";
import { aiBudgetPaused, budgetAwareConsumer } from "./ai-budget-pause";
import { documentaryAccessPaused } from "./ai-access-pause";
import { runDocumentaryJob } from "./documentary-consumer";
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
  NOTIFICATION_WORK_QUEUE,
  notificationWorkJob,
  type NotificationWorkJob,
  requestNotificationDigest,
  requestNotificationDelivery,
  requestNotificationSweeps,
} from "./notification-scheduling";
import {
  SOURCE_INGEST_QUEUE,
  requestSourceIngestion,
  requestSourceIngestions,
  type SourceIngestionJob,
} from "./ingestion-scheduling";
import {
  PUBLICATION_MATCH_QUEUE,
  MATCH_SWEEP_QUEUE,
  publicationMatchJob,
  requestPublicationMatching,
  requestPublicationMatchingBatch,
  requestMatchingSweep,
  type PublicationMatchJob,
} from "./matching-scheduling";
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
  for (const name of [
    PUBLICATION_MATCH_QUEUE,
    MATCH_SWEEP_QUEUE,
    NOTIFICATION_WORK_QUEUE,
  ])
    await boss.createQueue(name, {
      policy: "stately",
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 1800,
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
  const synchronizeComparisonConsumer = budgetAwareConsumer({
    paused: async () =>
      !automaticComparisonEnabled() ||
      (await aiBudgetPaused()) ||
      (await documentaryAccessPaused()),
    start: () =>
      boss.work<AutomaticComparisonJob>(
        AUTOMATIC_COMPARISON_QUEUE,
        { batchSize: 1 },
        async ([job]) => {
          await runDocumentaryJob(
            async () => {
              await runAutomaticComparison(job.data, { signal: job.signal });
              await requestNotificationSweeps(boss);
            },
            () => boss.offWork(AUTOMATIC_COMPARISON_QUEUE, { wait: false }),
          );
        },
      ),
    stop: () => boss.offWork(AUTOMATIC_COMPARISON_QUEUE, { wait: true }),
  });
  await synchronizeComparisonConsumer();
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
      // Preserve the original event job as the handoff receipt. The sole
      // publication consumer reloads all current source/profile/review bindings.
      await requestPublicationMatching(
        boss,
        { publicationId: job.data.publicationId },
        true,
      );
    },
  );
  await requestNotificationSweeps(boss);
  await boss.createQueue(SOURCE_INGEST_QUEUE, {
    policy: "stately",
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 900,
  });
  // Old queued refresh intents are dispatch-only. They coalesce into the same
  // durable source/lane keys rather than replaying hours of identical imports.
  await boss.work("ingest", { batchSize: 1 }, async () => {
    await requestSourceIngestions(
      boss,
      process.env.FOGLIO_REUSE_CONFIRMED === "true",
    );
  });
  // One consumer serializes source writes. Current updates outrank historical
  // slices; neither source has a concurrent collector or mutable snapshot.
  await boss.work<SourceIngestionJob>(
    SOURCE_INGEST_QUEUE,
    { batchSize: 1 },
    async ([job]) => {
      const { source, mode } = job.data;
      if (
        !["simap", "foglio-ti"].includes(source) ||
        !["current", "archive"].includes(mode) ||
        (source === "simap" && mode !== "current")
      )
        throw new Error("Invalid ingestion intent");
      if (
        source === "foglio-ti" &&
        process.env.FOGLIO_REUSE_CONFIRMED !== "true"
      )
        return;
      const adapter = source === "simap" ? simap : foglio;
      let continueArchive = false;
      await ingest(
        adapter,
        DateTime.now().setZone("Europe/Zurich").minus({ days: 7 }).toJSDate(),
        job.signal,
        {
          documentaryActivation,
          mode,
          deferNotifications: true,
          ...(source === "foglio-ti"
            ? { budgetMs: mode === "archive" ? 60_000 : 120_000 }
            : {}),
          onProgress(progress) {
            continueArchive =
              mode === "archive" &&
              progress.newImported > 0 &&
              progress.missing > 0;
          },
        },
      );
      if (continueArchive)
        await requestSourceIngestion(
          boss,
          { source: "foglio-ti", mode: "archive" },
          true,
        );
    },
  );
  // Legacy intent queues are drained through normal pg-boss completion only
  // after their replacement request is durable. A crash before acknowledgement
  // replays an idempotent handoff; no jobs/results/history are deleted or relabelled.
  await boss.work(
    "match",
    { batchSize: 500, pollingIntervalSeconds: 2, burstWhenBatchFull: true },
    async () => {
      await requestMatchingSweep(boss);
    },
  );
  await boss.work<PublicationMatchJob>(
    "match-publication",
    { batchSize: 5000, pollingIntervalSeconds: 2, burstWhenBatchFull: true },
    async (jobs) => {
      await requestPublicationMatchingBatch(
        boss,
        jobs.map((job) => job.data),
      );
    },
  );
  await boss.work(MATCH_SWEEP_QUEUE, { batchSize: 1 }, async () => {
    const rows = await getDb()
      .select({ publicationId: publications.id })
      .from(publications)
      .where(eq(publications.status, "open"));
    await requestPublicationMatchingBatch(boss, rows);
  });
  await boss.work<PublicationMatchJob>(
    PUBLICATION_MATCH_QUEUE,
    { batchSize: 1 },
    async ([job]) => {
      const data = publicationMatchJob(job.data);
      await enrichAndMatch({
        publicationId: data.publicationId,
        signal: job.signal,
        documentaryActivation,
      });
      await requestNotificationSweeps(boss);
    },
  );
  await boss.work(
    "digest",
    { batchSize: 500, pollingIntervalSeconds: 2, burstWhenBatchFull: true },
    async () => {
      await requestNotificationDigest(boss);
    },
  );
  await boss.work(
    "send",
    { batchSize: 500, pollingIntervalSeconds: 2, burstWhenBatchFull: true },
    async () => {
      await requestNotificationDelivery(boss);
    },
  );
  await boss.work<NotificationWorkJob>(
    NOTIFICATION_WORK_QUEUE,
    { batchSize: 1 },
    async ([job]) => {
      const { kind } = notificationWorkJob(job.data);
      if (kind === "digest") {
        await queueDigests();
        await requestNotificationDelivery(boss);
      } else await sendPending();
    },
  );
  const heartbeat = async () => {
    await synchronizeComparisonConsumer();
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
  await boss.schedule("ingest", "*/10 * * * *", {}, { tz: "Europe/Zurich" });
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

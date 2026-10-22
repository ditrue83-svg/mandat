import type { PgBoss } from "pg-boss";
export const SOURCE_INGEST_QUEUE = "source-ingest";
export type SourceIngestionJob = {
  source: "simap" | "foglio-ti";
  mode: "current" | "archive";
};
type Producer = Pick<PgBoss, "send">;
export async function requestSourceIngestion(
  boss: Producer,
  job: SourceIngestionJob,
  delayed = false,
) {
  if (job.source === "simap" && job.mode === "archive")
    throw new Error("Invalid source ingestion lane");
  // Stately retains one active and one trailing job per source/lane. Payloads
  // carry only work intent; there are no source receipts or AI verdicts to merge.
  return boss.send(SOURCE_INGEST_QUEUE, job, {
    singletonKey: `${job.source}:${job.mode}`,
    priority: job.mode === "current" ? 10 : 0,
    ...(delayed ? { startAfter: 20 } : {}),
  });
}
export async function requestSourceIngestions(
  boss: Producer,
  foglioEnabled: boolean,
) {
  await requestSourceIngestion(boss, { source: "simap", mode: "current" });
  if (foglioEnabled) {
    await requestSourceIngestion(boss, {
      source: "foglio-ti",
      mode: "current",
    });
    await requestSourceIngestion(boss, {
      source: "foglio-ti",
      mode: "archive",
    });
  }
}

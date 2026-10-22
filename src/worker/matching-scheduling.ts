import type { PgBoss } from "pg-boss";

export const PUBLICATION_MATCH_QUEUE = "radar-publication";
export const MATCH_SWEEP_QUEUE = "radar-refresh";
export type PublicationMatchJob = { publicationId: string };
type Producer = Pick<PgBoss, "send" | "insert" | "upsert">;

export function publicationMatchJob(value: unknown): PublicationMatchJob {
  const id = (value as { publicationId?: unknown } | null)?.publicationId;
  if (typeof id !== "string" || !id || id.trim() !== id || id.length > 256)
    throw new Error("Invalid publication matching intent");
  // Only a refresh intent crosses queues, never a cached verdict or AI input.
  return { publicationId: id };
}

export async function requestPublicationMatching(
  boss: Producer,
  input: PublicationMatchJob,
  urgent = false,
) {
  const data = publicationMatchJob(input);
  if (urgent) {
    // A fresh source/review raises an already pending request's priority. The
    // native upsert only edits pending jobs; an active payload stays immutable.
    // Stately's unique pending key also protects concurrent producers.
    return boss.upsert(PUBLICATION_MATCH_QUEUE, data, {
      singletonKey: data.publicationId,
      priority: 10,
    });
  }
  return boss.send(PUBLICATION_MATCH_QUEUE, data, {
    singletonKey: data.publicationId,
    priority: 0,
  });
}

export async function requestPublicationMatchingBatch(
  boss: Pick<PgBoss, "insert">,
  inputs: readonly unknown[],
) {
  const ids = [
    ...new Set(inputs.map((x) => publicationMatchJob(x).publicationId)),
  ];
  if (!ids.length) return;
  // Bulk historical/global work never lowers an urgent pending priority.
  await boss.insert(
    PUBLICATION_MATCH_QUEUE,
    ids.map((publicationId) => ({
      data: { publicationId },
      singletonKey: publicationId,
      priority: 0,
    })),
  );
}

export async function requestMatchingSweep(boss: Pick<PgBoss, "send">) {
  return boss.send(MATCH_SWEEP_QUEUE, {}, { singletonKey: "all" });
}

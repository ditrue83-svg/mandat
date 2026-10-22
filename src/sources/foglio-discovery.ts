import type { SourceEntry } from "./common";
export type FoglioCollected = {
  externalId: string;
  status: string;
  deadline?: Date | null;
};
export const FOGLIO_REFRESH_CURSOR = "foglio-public-history-refresh-v1";
export function planFoglioDetails(
  entries: readonly SourceEntry[],
  collected: readonly FoglioCollected[],
  previousCursor: unknown,
  now = new Date(),
) {
  const known = new Map(collected.map((p) => [p.externalId, p]));
  const candidates = entries.filter((e) => !known.has(e.id));
  // Backfill is bounded so old archives cannot postpone new notices, updates
  // and the other source. All metadata is still discovered on every run.
  const stored =
    previousCursor && typeof previousCursor === "object"
      ? (previousCursor as { archive?: unknown; backfill?: unknown })
      : { archive: previousCursor };
  const newest = candidates.slice(0, 20);
  const older = candidates.slice(20);
  const missingStart = Math.max(
    0,
    older.findIndex((e) => e.id === stored.backfill) + 1,
  );
  const backfill = [
    ...older.slice(missingStart),
    ...older.slice(0, missingStart),
  ].slice(0, 80);
  const newEntries = [...newest, ...backfill];
  const present = entries.filter((e) => known.has(e.id));
  const priority = present.filter(
    (e, index) =>
      index < 40 ||
      (known.get(e.id)?.status === "open" &&
        (!known.get(e.id)?.deadline || known.get(e.id)!.deadline! > now)) ||
      (e.raw.meta as Record<string, unknown>)?.publicationState === "CANCELLED",
  );
  const remaining = present.filter((e) => !priority.includes(e));
  const cursor = typeof stored.archive === "string" ? stored.archive : "";
  const start = Math.max(0, remaining.findIndex((e) => e.id === cursor) + 1);
  const rotated = [
    ...remaining.slice(start),
    ...remaining.slice(0, start),
  ].slice(0, 60);
  const selected = new Map(
    [...newest, ...priority, ...backfill, ...rotated].map((e) => [e.id, e]),
  );
  return {
    entries: [...selected.values()],
    missingCount: candidates.length,
    deferredCount: Math.max(0, candidates.length - newEntries.length),
    nextCursor: {
      archive: rotated.at(-1)?.id ?? null,
      backfill: backfill.at(-1)?.id ?? null,
    },
    discovered: entries.length,
    collected: present.length,
  };
}

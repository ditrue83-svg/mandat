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

export type FoglioIngestionMode = "complete" | "current" | "archive";
// Current polling is independent of historical backfill. The first entries are
// ordered by UPDATE_DATE, so an old publication corrected today is current too.
export function planFoglioLane(
  entries: readonly SourceEntry[],
  collected: readonly FoglioCollected[],
  previousCursor: unknown,
  mode: FoglioIngestionMode,
  now = new Date(),
) {
  const known = new Map(collected.map((p) => [p.externalId, p]));
  const currentIds = new Set(
    entries
      .filter((e, i) => {
        const m = e.raw.meta as Record<string, unknown> | undefined;
        const published =
          typeof m?.publicationDate === "string"
            ? Date.parse(m.publicationDate)
            : NaN;
        const prior = known.get(e.id);
        return (
          i < 40 ||
          m?.publicationState === "CANCELLED" ||
          (!prior && published >= now.getTime() - 7 * 86400000) ||
          (prior?.status === "open" &&
            (prior.deadline
              ? prior.deadline > now
              : published >= now.getTime() - 90 * 86400000))
        );
      })
      .map((e) => e.id),
  );
  const stored =
    previousCursor && typeof previousCursor === "object"
      ? (previousCursor as {
          archive?: unknown;
          backfill?: unknown;
          current?: unknown;
        })
      : { archive: previousCursor };
  const rotate = (rows: SourceEntry[], cursor: unknown) => {
    const start = Math.max(0, rows.findIndex((e) => e.id === cursor) + 1);
    return [...rows.slice(start), ...rows.slice(0, start)];
  };
  const missing = entries.filter((e) => !known.has(e.id));
  const oldMissing = rotate(
    missing.filter((e) => !currentIds.has(e.id)),
    stored.backfill,
  ).slice(0, 80);
  const oldKnown = rotate(
    entries.filter((e) => known.has(e.id) && !currentIds.has(e.id)),
    stored.archive,
  ).slice(0, 20);
  const currentMissing = entries.filter(
    (e) => currentIds.has(e.id) && !known.has(e.id),
  );
  const currentKnown = rotate(
    entries.filter((e) => currentIds.has(e.id) && known.has(e.id)),
    stored.current,
  );
  const selected =
    mode === "complete"
      ? planFoglioDetails(entries, collected, previousCursor, now).entries
      : mode === "current"
        ? [...currentMissing, ...currentKnown]
        : [...oldMissing, ...oldKnown];
  const processed = new Set<string>();
  return {
    entries: selected,
    missingIds: new Set(missing.map((e) => e.id)),
    missingCount: missing.length,
    completeEntry(id: string) {
      processed.add(id);
    },
    progress() {
      const processedMissing = selected.filter(
        (e) => processed.has(e.id) && !known.has(e.id),
      );
      const processedOldMissing = oldMissing.filter((e) => processed.has(e.id));
      const processedOldKnown = oldKnown.filter((e) => processed.has(e.id));
      return {
        deferredCount: Math.max(0, missing.length - processedMissing.length),
        remainingSelected: selected.filter((e) => !processed.has(e.id)).length,
        // Advance only past attempted entries. Never checkpoint an unvisited range
        // merely because the wall-clock slice ended.
        nextCursor: {
          archive:
            mode === "current"
              ? (stored.archive ?? null)
              : (processedOldKnown.at(-1)?.id ?? stored.archive ?? null),
          backfill:
            mode === "current"
              ? (stored.backfill ?? null)
              : (processedOldMissing.at(-1)?.id ?? stored.backfill ?? null),
          current:
            mode === "current"
              ? (currentKnown.filter((e) => processed.has(e.id)).at(-1)?.id ??
                stored.current ??
                null)
              : (stored.current ?? null),
        },
      };
    },
  };
}

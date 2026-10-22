import type { SourceEntry } from "./common";

export type CollectedSimapEdition = {
  sourcePublicationId: string | null;
  status: string;
  deadline: Date | null;
};
// Discovery is complete on every run. Only detail refresh is incremental:
// missing notices, a new official edition and every still-open notice are read.
export function needsSimapDetail(
  entry: SourceEntry,
  previous: CollectedSimapEdition | undefined,
  since: Date,
  now = new Date(),
) {
  const raw = entry.raw as {
    publicationId?: unknown;
    publicationDate?: unknown;
    corrected?: unknown;
    lots?: unknown;
  };
  // A correction can retain the publication UUID/date. And a lot can change
  // while the project-level edition still looks identical. Neither condition
  // may be skipped because an old deadline has already passed.
  if (
    raw.corrected === true ||
    (Array.isArray(raw.lots) && raw.lots.length > 0)
  )
    return true;
  if (
    !previous?.sourcePublicationId ||
    previous.sourcePublicationId !== raw.publicationId
  )
    return true;
  const date =
    typeof raw.publicationDate === "string"
      ? Date.parse(raw.publicationDate)
      : NaN;
  if (!Number.isFinite(date) || date >= since.getTime()) return true;
  if (
    previous.status === "open" &&
    (!previous.deadline || previous.deadline > now)
  )
    return true;
  return false;
}

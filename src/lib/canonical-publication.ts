// Shared by Radar, quality accounting and notifications. Choose a source before
// inspecting its decision; a favourable copy must never win by its score.
export type CanonicalPublication = {
  id: string;
  canonicalId: string;
  source: string;
  updatedAt: Date;
  data: { publishedAt: string; projectId?: string };
  documentarySnapshotId: string | null;
};
const publishedTime = (value: string) =>
  Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
// Same tie-break as source ingestion: a later edition on the same official date
// remains current even if merging source links updates its predecessor later.
const edition = (value: CanonicalPublication) =>
  Number(value.data.projectId?.split("-").at(-1)) || 0;
export function compareCanonicalPublications(
  a: CanonicalPublication,
  b: CanonicalPublication,
) {
  return (
    Number(!a.documentarySnapshotId) - Number(!b.documentarySnapshotId) ||
    Number(a.source !== "simap") - Number(b.source !== "simap") ||
    publishedTime(b.data.publishedAt) - publishedTime(a.data.publishedAt) ||
    edition(b) - edition(a) ||
    b.updatedAt.getTime() - a.updatedAt.getTime() ||
    a.id.localeCompare(b.id)
  );
}
export function sourceAvailable(source: string) {
  return (
    source === "simap" ||
    (source === "foglio-ti" && process.env.FOGLIO_REUSE_CONFIRMED === "true")
  );
}

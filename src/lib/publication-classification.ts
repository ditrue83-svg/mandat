import { inArray, sql } from "drizzle-orm";
import type { getDb } from "@/db";
import { publicationDocumentarySnapshots } from "@/db/schema";
import type { Publication } from "./domain";
import {
  withClassification,
  type ClassificationArchive,
} from "./sector-classification";

type Row = {
  id: string;
  revision: string;
  data: Publication;
  documentarySnapshotId: string | null;
};
type Reader = Pick<ReturnType<typeof getDb>, "select">;
// Classification is a versioned read model. Existing source copies and source
// revisions remain immutable; a rules update applies to the whole catalogue at
// the next read, without a migration, import, write, job or notification.
export async function classifyPublicationRows<T extends Row>(
  reader: Reader,
  rows: readonly T[],
): Promise<T[]> {
  const ids = [
    ...new Set(
      rows.flatMap((row) =>
        row.documentarySnapshotId ? [row.documentarySnapshotId] : [],
      ),
    ),
  ];
  const s = publicationDocumentarySnapshots;
  const snapshots = ids.length
    ? await reader
        .select({
          id: s.id,
          publicationId: s.publicationId,
          state: s.state,
          sourceRevision: sql<string>`${s.acquisition}->>'sourceRevision'`,
          // Fetch only public subject fields, not criteria, contacts or the archive's
          // other sections. This projection also keeps catalogue reads inexpensive.
          archive: sql<ClassificationArchive>`jsonb_build_object(
      'projectSections',jsonb_build_object(
        'base',jsonb_build_object('title',${s.acquisition}#>'{archive,projectSections,base,title}','cpvCode',${s.acquisition}#>'{archive,projectSections,base,cpvCode}'),
        'project-info',jsonb_build_object('title',${s.acquisition}#>'{archive,projectSections,project-info,title}'),
        'procurement',jsonb_build_object('orderDescription',${s.acquisition}#>'{archive,projectSections,procurement,orderDescription}','cpvCode',${s.acquisition}#>'{archive,projectSections,procurement,cpvCode}','additionalCpvCodes',${s.acquisition}#>'{archive,projectSections,procurement,additionalCpvCodes}')
      ),
      'directory',coalesce(${s.acquisition}#>'{archive,directory}','[]'::jsonb),
      'lotField',jsonb_build_object('lots',coalesce((select jsonb_agg(jsonb_build_object('id',v->'id','title',v->'title','orderDescription',v->'orderDescription','cpvCode',v->'cpvCode','additionalCpvCodes',v->'additionalCpvCodes')) from jsonb_array_elements(case when jsonb_typeof(${s.acquisition}#>'{archive,lotField,lots}')='array' then ${s.acquisition}#>'{archive,lotField,lots}' else '[]'::jsonb end) as v),'[]'::jsonb))
    )`,
        })
        .from(s)
        .where(inArray(s.id, ids))
    : [];
  const indexed = new Map(snapshots.map((s) => [s.id, s]));
  return rows.map((row) => {
    const snapshot = row.documentarySnapshotId
      ? indexed.get(row.documentarySnapshotId)
      : null;
    const valid =
      snapshot?.publicationId === row.id &&
      snapshot.state === "accepted" &&
      snapshot.sourceRevision === row.revision;
    return {
      ...row,
      data: withClassification(
        row.data,
        valid ? snapshot.archive : null,
        !!row.documentarySnapshotId && !valid,
      ),
    };
  });
}

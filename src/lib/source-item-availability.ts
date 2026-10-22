import { and, eq, isNull, like } from "drizzle-orm";
import { getDb } from "@/db";
import { issues } from "@/db/schema";
type Reader = Pick<ReturnType<typeof getDb>, "select">;
type SourceIdentity = { source: string; externalId: string };
export const sourceItemKey = (p: SourceIdentity) =>
  `source-item:${p.source}:${p.externalId}`;
export async function readBlockedSourceItems(db: Reader) {
  const rows = await db
    .select({ key: issues.key })
    .from(issues)
    .where(and(isNull(issues.resolvedAt), like(issues.key, "source-item:%")));
  return new Set(rows.map((row) => row.key));
}
export async function sourceItemBlocked(db: Reader, p: SourceIdentity) {
  const rows = await db
    .select({ key: issues.key })
    .from(issues)
    .where(and(isNull(issues.resolvedAt), eq(issues.key, sourceItemKey(p))))
    .limit(1);
  return rows.length > 0;
}

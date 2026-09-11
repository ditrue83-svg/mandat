import { and, eq, lte, gt, isNull, or, desc, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { matches, publications, feedback, settings } from "@/db/schema";
import { fingerprint } from "@/sources/common";
import { getDemoOpportunities } from "./demo";
import type { Opportunity, RadarStatus, Viewer } from "./domain";
import { presentMatch } from "./match-presentation";

export async function getRadarStatus(
  viewer: Viewer,
  now = new Date(),
): Promise<RadarStatus> {
  if (viewer.demo) return { state: "ready", pendingCount: 0 };
  const db = getDb();
  const rows = await db
    .select({
      publicationRevision: publications.revision,
      matchRevision: matches.revision,
    })
    .from(publications)
    .leftJoin(
      matches,
      and(
        eq(matches.publicationId, publications.id),
        eq(matches.companyId, viewer.companyId),
      ),
    )
    .where(
      and(
        eq(publications.status, "open"),
        lte(publications.visibleAt, now),
        or(isNull(publications.deadline), gt(publications.deadline, now)),
        inArray(
          publications.source,
          process.env.FOGLIO_REUSE_CONFIRMED === "true"
            ? ["simap", "foglio-ti"]
            : ["simap"],
        ),
      ),
    );
  const profileRevision = fingerprint(viewer.profile);
  // A pending/retry AI result has been assessed, even though it still needs
  // review. Only missing or invalidated assessments count as waiting here.
  const pendingCount = rows.filter(
    (row) =>
      !row.matchRevision?.startsWith(
        `${row.publicationRevision}:${profileRevision}:`,
      ) || row.matchRevision.endsWith(":profile-update"),
  ).length;
  if (!pendingCount) return { state: "ready", pendingCount };
  const [heartbeat] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "worker_heartbeat"));
  const at =
    typeof heartbeat?.value === "string" ? Date.parse(heartbeat.value) : NaN;
  const age = now.getTime() - at;
  return {
    state:
      Number.isFinite(age) && age >= -60_000 && age < 15 * 60_000
        ? "processing"
        : "delayed",
    pendingCount,
  };
}

export async function listOpportunities(
  viewer: Viewer,
  options: { includeInactive?: boolean } = {},
): Promise<Opportunity[]> {
  if (viewer.demo) return getDemoOpportunities();
  const rows = await getDb()
    .select({ publication: publications, match: matches, feedback })
    .from(matches)
    .innerJoin(publications, eq(matches.publicationId, publications.id))
    .leftJoin(
      feedback,
      and(
        eq(feedback.companyId, viewer.companyId),
        eq(feedback.publicationId, publications.id),
      ),
    )
    .where(
      and(
        eq(matches.companyId, viewer.companyId),
        options.includeInactive
          ? eq(feedback.saved, true)
          : eq(matches.eligible, true),
        options.includeInactive ? undefined : eq(publications.status, "open"),
        lte(publications.visibleAt, new Date()),
        options.includeInactive
          ? undefined
          : or(
              isNull(publications.deadline),
              gt(publications.deadline, new Date()),
            ),
      ),
    )
    .orderBy(desc(matches.score));
  const seen = new Set<string>();
  return rows
    .sort(
      (a, b) =>
        Number(a.publication.source !== "simap") -
          Number(b.publication.source !== "simap") ||
        b.publication.updatedAt.getTime() - a.publication.updatedAt.getTime(),
    )
    .flatMap((r) => {
      if (seen.has(r.publication.canonicalId)) return [];
      if (
        r.publication.source === "foglio-ti" &&
        process.env.FOGLIO_REUSE_CONFIRMED !== "true"
      )
        return [];
      seen.add(r.publication.canonicalId);
      return [
        {
          ...r.publication.data,
          id: r.publication.id,
          score: r.match.score,
          ...presentMatch({
            match: r.match,
            publication: r.publication.data,
            aiRevision: r.publication.aiRevision,
            profileRevision: fingerprint(viewer.profile),
          }),
          saved: r.feedback?.saved ?? false,
          dismissed: r.feedback?.dismissed ?? false,
          feedback:
            r.feedback?.relevant === null || r.feedback?.relevant === undefined
              ? null
              : r.feedback.relevant
                ? "relevant"
                : "irrelevant",
        },
      ];
    });
}
export async function getOpportunity(
  viewer: Viewer,
  id: string,
): Promise<Opportunity | null> {
  if (viewer.demo)
    return getDemoOpportunities().find((o) => o.id === id) ?? null;
  const [row] = await getDb()
    .select({ p: publications, m: matches, f: feedback })
    .from(matches)
    .innerJoin(publications, eq(matches.publicationId, publications.id))
    .leftJoin(
      feedback,
      and(
        eq(feedback.companyId, viewer.companyId),
        eq(feedback.publicationId, publications.id),
      ),
    )
    .where(
      and(
        eq(matches.companyId, viewer.companyId),
        eq(publications.id, id),
        lte(publications.visibleAt, new Date()),
      ),
    )
    .limit(1);
  if (
    !row ||
    (row.p.source === "foglio-ti" &&
      process.env.FOGLIO_REUSE_CONFIRMED !== "true")
  )
    return null;
  return {
    ...row.p.data,
    id: row.p.id,
    score: row.m.score,
    ...presentMatch({
      match: row.m,
      publication: row.p.data,
      aiRevision: row.p.aiRevision,
      profileRevision: fingerprint(viewer.profile),
    }),
    saved: row.f?.saved ?? false,
    dismissed: row.f?.dismissed ?? false,
    feedback:
      row.f?.relevant == null
        ? null
        : row.f.relevant
          ? "relevant"
          : "irrelevant",
  };
}

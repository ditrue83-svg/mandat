import { and, eq, lte, gt, isNull, or, desc, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  matches,
  publications,
  feedback,
  settings,
  sourceReviewEvents,
} from "@/db/schema";
import { fingerprint } from "@/sources/common";
import { getDemoOpportunities } from "./demo";
import type { Opportunity, RadarStatus, Viewer } from "./domain";
import { presentMatch } from "./match-presentation";
import { preliminaryMatch } from "./matching";
import {
  CPV_ACTIVITY_REVIEW_MARKER,
  CPV_ACTIVITY_REVIEW_VERSION,
  hasActivityReviewRevision,
} from "./cpv-service-signals";
import {
  readSourceReviewContexts,
  readSourceReviewContext,
} from "./source-reviews";
import {
  sourceReviewBindingState,
  sourceReviewBlocksComparison,
} from "./source-review-policy";
import {
  hasSourceScopeReview,
  isMatchContentCurrent,
  isMatchRevisionCurrent,
} from "./source-scope-review";

export async function getRadarStatus(
  viewer: Viewer,
  now = new Date(),
): Promise<RadarStatus> {
  if (viewer.demo) return { state: "ready", pendingCount: 0 };
  const db = getDb();
  const rows = await db
    .select({
      // Matches follow corrected content; the column retains the source revision.
      publication: publications.data,
      matchRevision: matches.revision,
      approved: matches.approved,
      reviewedAt: matches.reviewedAt,
      sourceReviewDependency: matches.sourceReviewDependency,
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
  const sourceReviews = await readSourceReviewContexts(
    db,
    rows.map((row) => row.publication),
  );
  // A pending/retry AI result has been assessed, even though it still needs
  // review. Only missing or invalidated assessments count as waiting here.
  const pendingCount = rows.filter((row) => {
    const context = sourceReviews.get(row.publication.id) ?? null;
    const manual =
      row.approved === false || (row.approved === true && !!row.reviewedAt);
    const activityReview = preliminaryMatch(
      row.publication,
      viewer.profile,
      now,
    ).activityReview;
    if (
      !manual &&
      activityReview &&
      !row.matchRevision?.includes(
        `${CPV_ACTIVITY_REVIEW_MARKER}${CPV_ACTIVITY_REVIEW_VERSION}:`,
      )
    )
      return true;
    // A preserved manual decision waits for a person, never for a worker job.
    // Presentation suspends an old positive until it is explicitly reviewed.
    if (manual && (context || row.sourceReviewDependency)) return false;
    if (
      !manual &&
      !sourceReviewBlocksComparison(context) &&
      sourceReviewBindingState(context, row.sourceReviewDependency) === "stale"
    )
      return true;
    return !(
      hasSourceScopeReview(row.publication) ||
        sourceReviewBlocksComparison(context) ||
        (manual && context)
        ? isMatchContentCurrent
        : isMatchRevisionCurrent
    )({
      revision: row.matchRevision,
      publication: row.publication,
      profileRevision,
      manuallyReviewed: manual,
    });
  }).length;
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
  const now = new Date();
  const profileRevision = fingerprint(viewer.profile);
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
          : or(
              eq(matches.eligible, true),
              sql`${publications.data}->'sourceScopeReview'->>'status' = 'required'`,
              sql`exists (select 1 from ${sourceReviewEvents} where ${sourceReviewEvents.publicationId} = ${publications.id})`,
            ),
        options.includeInactive ? undefined : eq(publications.status, "open"),
        lte(publications.visibleAt, now),
        options.includeInactive
          ? undefined
          : or(isNull(publications.deadline), gt(publications.deadline, now)),
      ),
    )
    .orderBy(desc(matches.score));
  const seen = new Set<string>();
  const sourceReviews = await readSourceReviewContexts(
    getDb(),
    rows.map((row) => row.publication),
  );
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
      const sourceReview = sourceReviews.get(r.publication.id) ?? null;
      const enforceFilters =
        hasSourceScopeReview(r.publication.data) ||
        sourceReview ||
        r.match.sourceReviewDependency ||
        hasActivityReviewRevision(r.match.revision);
      const preliminary = preliminaryMatch(
        r.publication.data,
        viewer.profile,
        now,
      );
      if (
        !options.includeInactive &&
        (r.match.approved === false ||
          (enforceFilters && !preliminary.eligible))
      )
        return [];
      const bindingState = sourceReviewBindingState(
        sourceReview,
        r.match.sourceReviewDependency,
      );
      if (
        !options.includeInactive &&
        !sourceReview &&
        !r.match.eligible &&
        !hasSourceScopeReview(r.publication.data) &&
        bindingState !== "blocked" &&
        bindingState !== "stale"
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
            profileRevision,
            preliminary,
            sourceReview,
          }),
          saved: r.feedback?.saved ?? false,
          dismissed: r.feedback?.dismissed ?? false,
          feedback:
            r.feedback?.relevant === null || r.feedback?.relevant === undefined
              ? null
              : r.feedback.relevant
                ? ("relevant" as const)
                : ("irrelevant" as const),
        },
      ];
    })
    .sort((a, b) => b.score - a.score);
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
  const sourceReview = await readSourceReviewContext(getDb(), row.p);
  return {
    ...row.p.data,
    id: row.p.id,
    score: row.m.score,
    ...presentMatch({
      match: row.m,
      publication: row.p.data,
      aiRevision: row.p.aiRevision,
      profileRevision: fingerprint(viewer.profile),
      sourceReview,
      preliminary: preliminaryMatch(row.p.data, viewer.profile),
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

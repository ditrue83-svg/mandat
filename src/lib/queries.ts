import { and, eq, lte, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { matches, publications, settings } from "@/db/schema";
import {
  readCanonicalMatch,
  presentLotOpportunity,
  lotOpportunityVisible,
} from "./lot-readers";
import { fingerprint } from "@/sources/common";
import { getDemoOpportunities } from "./demo";
import type { Opportunity, RadarStatus, Viewer } from "./domain";
import { presentMatch } from "./match-presentation";
import { preliminaryMatch } from "./matching";
import {
  CPV_ACTIVITY_REVIEW_MARKER,
  hasActivityReviewRevision,
} from "./cpv-service-signals";
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
    .select({ id: publications.id })
    .from(publications)
    .where(
      and(
        eq(publications.status, "open"),
        lte(publications.visibleAt, now),
        inArray(
          publications.source,
          process.env.FOGLIO_REUSE_CONFIRMED === "true"
            ? ["simap", "foglio-ti"]
            : ["simap"],
        ),
      ),
    );
  const seen = new Set<string>();
  let pendingCount = 0;
  for (const item of rows) {
    const row = await readCanonicalMatch(viewer.companyId, item.id, now);
    if (!row || seen.has(row.publication.canonicalId)) continue;
    seen.add(row.publication.canonicalId);
    if (row.publication.visibleAt > now || row.publication.status !== "open")
      continue;
    if (row.publication.documentarySnapshotId) {
      if (!row.match) pendingCount++;
      continue;
    }
    if (row.publication.deadline && row.publication.deadline <= now) continue;
    const publication = row.publication.data;
    const match = row.match;
    const profileRevision = fingerprint(row.company.profile);
    const context = row.sourceReview;
    const manual =
      match?.approved === false ||
      (match?.approved === true && !!match.reviewedAt);
    const activityReview = preliminaryMatch(
      publication,
      row.company.profile,
      now,
    ).activityReview;
    let pending = false;
    if (
      !manual &&
      activityReview &&
      !match?.revision.includes(
        `${CPV_ACTIVITY_REVIEW_MARKER}${activityReview.version}:${fingerprint(activityReview.signals)}`,
      )
    )
      pending = true;
    else if (manual && (context || match?.sourceReviewDependency))
      pending = false;
    else if (
      !manual &&
      !sourceReviewBlocksComparison(context) &&
      sourceReviewBindingState(context, match?.sourceReviewDependency) ===
        "stale"
    )
      pending = true;
    else
      pending = !(
        hasSourceScopeReview(publication) ||
          sourceReviewBlocksComparison(context) ||
          (manual && context)
          ? isMatchContentCurrent
          : isMatchRevisionCurrent
      )({
        revision: match?.revision,
        publication,
        profileRevision,
        manuallyReviewed: manual,
      });
    if (pending) pendingCount++;
  }
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
  const groups = await getDb()
    .select({ id: publications.id, canonicalId: publications.canonicalId })
    .from(matches)
    .innerJoin(publications, eq(matches.publicationId, publications.id))
    .where(eq(matches.companyId, viewer.companyId));
  const seen = new Set<string>();
  const result: Opportunity[] = [];
  for (const group of groups) {
    if (seen.has(group.canonicalId)) continue;
    const row = await readCanonicalMatch(viewer.companyId, group.id, now);
    if (!row) continue;
    seen.add(row.publication.canonicalId);
    const item = canonicalOpportunity(
      row,
      now,
      !!options.includeInactive,
      true,
    );
    if (item) result.push(item);
  }
  return result.sort((a, b) => b.score - a.score);
}
function canonicalOpportunity(
  row: NonNullable<Awaited<ReturnType<typeof readCanonicalMatch>>>,
  now: Date,
  includeInactive: boolean,
  filterRadar: boolean,
): Opportunity | null {
  const { publication, match, feedback: f, loaded, sourceReview } = row;
  if (!match || publication.visibleAt > now) return null;
  if (publication.documentarySnapshotId) {
    if (
      !loaded ||
      (filterRadar && !lotOpportunityVisible(loaded, includeInactive, now))
    )
      return null;
    return presentLotOpportunity(loaded);
  }
  const preliminary = preliminaryMatch(
    publication.data,
    row.company.profile,
    now,
  );
  if (filterRadar) {
    if (includeInactive) {
      if (!f?.saved) return null;
    } else {
      if (
        publication.status !== "open" ||
        (publication.deadline && publication.deadline <= now) ||
        match.approved === false
      )
        return null;
      const enforce =
        hasSourceScopeReview(publication.data) ||
        sourceReview ||
        match.sourceReviewDependency ||
        hasActivityReviewRevision(match.revision);
      if (enforce && !preliminary.eligible) return null;
      const binding = sourceReviewBindingState(
        sourceReview,
        match.sourceReviewDependency,
      );
      if (
        !sourceReview &&
        !match.eligible &&
        !hasSourceScopeReview(publication.data) &&
        binding !== "blocked" &&
        binding !== "stale"
      )
        return null;
    }
  }
  return {
    ...publication.data,
    id: publication.id,
    score: match.score,
    ...presentMatch({
      match,
      publication: publication.data,
      aiRevision: publication.aiRevision,
      profileRevision: fingerprint(row.company.profile),
      sourceReview,
      preliminary,
    }),
    saved: f?.saved ?? false,
    dismissed: f?.dismissed ?? false,
    feedback:
      f?.relevant == null ? null : f.relevant ? "relevant" : "irrelevant",
  };
}
export async function getOpportunity(
  viewer: Viewer,
  id: string,
): Promise<Opportunity | null> {
  if (viewer.demo)
    return getDemoOpportunities().find((o) => o.id === id) ?? null;
  // An old saved URL may resolve to a newer official copy, but never to another
  // tenant's match. The canonical reader independently verifies the selected row.
  const now = new Date();
  const row = await readCanonicalMatch(viewer.companyId, id, now, {
    legacyDetail: true,
  });
  return row ? canonicalOpportunity(row, now, true, false) : null;
}

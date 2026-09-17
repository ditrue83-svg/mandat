import { and, eq, lte, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { feedback, matches, publications, settings } from "@/db/schema";
import {
  readCanonicalMatch,
  presentLotOpportunity,
  lotOpportunityVisible,
} from "./lot-readers";
import {
  compareCanonicalPublications,
  sourceAvailable,
} from "./canonical-publication";
import { readCanonicalFeedbackBatch } from "./canonical-feedback";
import { readSourceReviewContexts } from "./source-reviews";
import { fingerprint } from "@/sources/common";
import { getDemoOpportunities } from "./demo";
import type { Opportunity, RadarStatus, Viewer } from "./domain";
import { presentCatalogEntry } from "./catalog";
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

type QueryExecutor = Pick<ReturnType<typeof getDb>, "select">;

async function readCanonicalRepresentatives(
  executor: QueryExecutor,
  canonicalIds: readonly string[],
) {
  const ids = [...new Set(canonicalIds)];
  if (!ids.length) return [];
  const rows = await executor
    .select()
    .from(publications)
    .where(inArray(publications.canonicalId, ids));
  const groups = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    if (!sourceAvailable(row.source)) continue;
    const group = groups.get(row.canonicalId) ?? [];
    group.push(row);
    groups.set(row.canonicalId, group);
  }
  return ids.flatMap((canonicalId) => {
    const group = groups.get(canonicalId);
    return group?.length ? [group.sort(compareCanonicalPublications)[0]!] : [];
  });
}

export async function getRadarStatus(
  viewer: Viewer,
  now = new Date(),
): Promise<RadarStatus> {
  if (viewer.demo) return { state: "ready", pendingCount: 0 };
  const db = getDb();
  const { pendingCount, heartbeat } = await db.transaction(async (tx) => {
    const candidates = await tx
      .select({ canonicalId: publications.canonicalId })
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
    const representatives = await readCanonicalRepresentatives(
      tx,
      candidates.map((row) => row.canonicalId),
    );
    const visible = representatives.filter(
      (row) => row.visibleAt <= now && row.status === "open",
    );
    const matchRows = visible.length
      ? await tx
          .select()
          .from(matches)
          .where(
            and(
              eq(matches.companyId, viewer.companyId),
              inArray(
                matches.publicationId,
                visible.map((row) => row.id),
              ),
            ),
          )
      : [];
    const matchesByPublication = new Map(
      matchRows.map((match) => [match.publicationId, match]),
    );
    const legacy = visible.filter(
      (publication) => !publication.documentarySnapshotId,
    );
    const contexts = await readSourceReviewContexts(tx, legacy);
    let count = 0;
    const profileRevision = fingerprint(viewer.profile);
    for (const row of visible) {
      const match = matchesByPublication.get(row.id);
      if (row.documentarySnapshotId) {
        if (!match) count++;
        continue;
      }
      if (row.deadline && row.deadline <= now) continue;
      const publication = row.data;
      const context = contexts.get(row.id) ?? null;
      const manual =
        match?.approved === false ||
        (match?.approved === true && !!match.reviewedAt);
      const activityReview = preliminaryMatch(
        publication,
        viewer.profile,
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
      if (pending) count++;
    }
    if (!count) return { pendingCount: 0, heartbeat: undefined };
    const [heartbeatRow] = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, "worker_heartbeat"));
    return { pendingCount: count, heartbeat: heartbeatRow };
  });
  if (!pendingCount) return { state: "ready", pendingCount };
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
  const db = getDb();
  const [matchedGroups, savedGroups] = await Promise.all([
    db
      .select({ canonicalId: publications.canonicalId })
      .from(matches)
      .innerJoin(publications, eq(matches.publicationId, publications.id))
      .where(eq(matches.companyId, viewer.companyId)),
    options.includeInactive
      ? db
          .select({ canonicalId: publications.canonicalId })
          .from(feedback)
          .innerJoin(publications, eq(feedback.publicationId, publications.id))
          .where(
            and(
              eq(feedback.companyId, viewer.companyId),
              eq(feedback.saved, true),
            ),
          )
      : Promise.resolve([]),
  ]);
  const representatives = await readCanonicalRepresentatives(
    db,
    [...matchedGroups, ...savedGroups].map((row) => row.canonicalId),
  );
  const representativeMatches = representatives.length
    ? await db
        .select()
        .from(matches)
        .where(
          and(
            eq(matches.companyId, viewer.companyId),
            inArray(
              matches.publicationId,
              representatives.map((row) => row.id),
            ),
          ),
        )
    : [];
  const matchByPublication = new Map(
    representativeMatches.map((match) => [match.publicationId, match]),
  );
  const canonicalFeedback = await readCanonicalFeedbackBatch(
    db,
    viewer.companyId,
    representatives.map((publication) => publication.canonicalId),
  );
  const candidates = representatives.filter((publication) => {
    const match = matchByPublication.get(publication.id);
    const state = canonicalFeedback.get(publication.canonicalId);
    if (options.includeInactive) return !!state?.saved;
    if (!match) return false;
    if (!publication.documentarySnapshotId) return true;
    return match.lotEvaluations !== null || !!state?.dismissed;
  });
  const result: Opportunity[] = [];
  for (const publication of candidates) {
    if (publication.visibleAt > now) continue;
    const state = canonicalFeedback.get(publication.canonicalId);
    if (!matchByPublication.has(publication.id)) {
      if (options.includeInactive && state?.saved)
        result.push(catalogSavedOpportunity(publication, now));
      continue;
    }
    const row = await readCanonicalMatch(viewer.companyId, publication.id, now);
    if (!row) {
      if (options.includeInactive && state?.saved)
        result.push(catalogSavedOpportunity(publication, now));
      continue;
    }
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

function catalogSavedOpportunity(
  publication: Awaited<ReturnType<typeof readCanonicalRepresentatives>>[number],
  now: Date,
): Opportunity {
  const source = {
    ...publication.data,
    id: publication.id,
    source: publication.source as Opportunity["source"],
    status: publication.status as Opportunity["status"],
    deadline: publication.deadline?.toISOString() ?? null,
  };
  const item = presentCatalogEntry(source, now, true);
  return {
    id: item.id,
    source: item.source,
    externalId: source.externalId,
    ...(source.projectId ? { projectId: source.projectId } : {}),
    title: item.title,
    buyer: item.buyer,
    location: item.location,
    canton: source.canton,
    zone: source.zone,
    publishedAt: item.publishedAt,
    updatedAt: source.updatedAt,
    visibleAt: source.visibleAt,
    deadline: item.deadline,
    valueChf: item.valueChf,
    procedure: source.procedure,
    status: source.status,
    sectors: item.sectors,
    cpv: [],
    sourceUrl: item.sourceUrl,
    sourceUrls: item.sourceUrl ? [item.sourceUrl] : [],
    originalText: item.originalText,
    summary: null,
    requirements: [],
    evidence: [],
    documents: item.documents,
    reviewRequired: false,
    reviewReasons: [],
    revision: source.revision,
    score: 0,
    reason:
      "Hai salvato questo bando da Esplora. La pertinenza per la tua ditta non è ancora stata valutata.",
    assessment: "unreviewed",
    saved: true,
    dismissed: false,
    feedback: null,
    catalogOnly: true,
  };
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
    return presentLotOpportunity(loaded, !filterRadar);
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

import { eq, lte } from "drizzle-orm";
import { getDb } from "@/db";
import {
  administrators,
  companies,
  matches,
  publications,
  matchLotReviewEvents,
} from "@/db/schema";
import {
  compareCanonicalPublications,
  sourceAvailable,
} from "./canonical-publication";
import { readCanonicalMatch } from "./lot-readers";
import { fingerprint } from "@/sources/common";
import {
  isMatchRevisionCurrent,
  hasSourceScopeReview,
} from "./source-scope-review";
import {
  sourceReviewBindingState,
  sourceReviewBlocksComparison,
} from "./source-review-policy";
import { preliminaryMatch } from "./matching";

export type ProjectQuality = "approved" | "rejected" | "unresolved";
export function summarizeProjectQuality(
  rows: { key: string; quality: ProjectQuality }[],
  historical: { key: string; approved: boolean; rejected: boolean }[],
) {
  const current = new Map(rows.map((row) => [row.key, row.quality]));
  return {
    version: "project-quality-v2" as const,
    reviewed: [...current.values()].filter((v) => v !== "unresolved").length,
    approved: [...current.values()].filter((v) => v === "approved").length,
    rejected: [...current.values()].filter((v) => v === "rejected").length,
    unresolved: [...current.values()].filter((v) => v === "unresolved").length,
    historical: {
      approved: new Set(
        historical.filter((row) => row.approved).map((row) => row.key),
      ).size,
      rejected: new Set(
        historical.filter((row) => row.rejected).map((row) => row.key),
      ).size,
    },
  };
}
export async function readProjectQuality(
  now = new Date(),
  options: {
    excludeAdministratorCompanies?: boolean;
    includeCompanyIds?: readonly string[];
    reviewedSince?: Date | null;
  } = {},
) {
  const db = getDb();
  const includedCompanyIds = options.includeCompanyIds
    ? new Set(options.includeCompanyIds)
    : null;
  const excludedCompanyIds = options.excludeAdministratorCompanies
    ? new Set(
        (
          await db
            .select({ companyId: companies.id })
            .from(companies)
            .innerJoin(
              administrators,
              eq(administrators.userId, companies.ownerId),
            )
        ).map((row) => row.companyId),
      )
    : new Set<string>();
  const hasReviewWindow = Object.hasOwn(options, "reviewedSince");
  const reviewQualifies = (at: Date | string | null | undefined) => {
    if (!at) return false;
    if (!hasReviewWindow) return true;
    if (!options.reviewedSince) return false;
    const date = at instanceof Date ? at : new Date(at);
    return Number.isFinite(date.getTime()) && date >= options.reviewedSince;
  };
  const rows = (
    await db
      .select({ publication: publications, match: matches, company: companies })
      .from(matches)
      .innerJoin(publications, eq(publications.id, matches.publicationId))
      .innerJoin(companies, eq(companies.id, matches.companyId))
      .where(lte(publications.visibleAt, now))
  )
    .filter(
      (row) =>
        sourceAvailable(row.publication.source) &&
        (!includedCompanyIds || includedCompanyIds.has(row.company.id)) &&
        !excludedCompanyIds.has(row.company.id),
    )
    .sort((a, b) => compareCanonicalPublications(a.publication, b.publication));
  const historical: { key: string; approved: boolean; rejected: boolean }[] =
    rows.map((row) => ({
      key: JSON.stringify([row.company.id, row.publication.canonicalId]),
      approved:
        reviewQualifies(row.match.reviewedAt) && row.match.approved === true,
      rejected:
        reviewQualifies(row.match.reviewedAt) && row.match.approved === false,
    }));
  const events = await db
    .select({
      event: matchLotReviewEvents.event,
      companyId: matchLotReviewEvents.companyId,
      canonicalId: publications.canonicalId,
    })
    .from(matchLotReviewEvents)
    .innerJoin(
      publications,
      eq(publications.id, matchLotReviewEvents.publicationId),
    );
  const currentEventKeys = new Set<string>();
  for (const row of events) {
    if (
      (includedCompanyIds && !includedCompanyIds.has(row.companyId)) ||
      excludedCompanyIds.has(row.companyId) ||
      !reviewQualifies(row.event.at)
    )
      continue;
    const key = JSON.stringify([row.companyId, row.canonicalId]);
    currentEventKeys.add(key);
    const entries = row.event.after.evaluations?.entries ?? [];
    historical.push({
      key,
      approved: entries.some((entry) => entry.result === "direct"),
      rejected:
        row.event.action === "veto_project" ||
        entries.some((entry) => entry.result === "different"),
    });
  }
  const seen = new Set<string>();
  const potentiallyReviewed = new Set([
    ...historical
      .filter((row) => row.approved || row.rejected)
      .map((row) => row.key),
    ...currentEventKeys,
  ]);
  const current: { key: string; quality: ProjectQuality }[] = [];
  for (const row of rows) {
    const key = JSON.stringify([row.company.id, row.publication.canonicalId]);
    if (seen.has(key)) continue;
    seen.add(key);
    let quality: ProjectQuality = "unresolved";
    // An unreviewed group cannot contribute to the approval gate. Avoid loading
    // its document tree; potentially reviewed groups still get a locked reread.
    if (!potentiallyReviewed.has(key)) {
      current.push({ key, quality });
      continue;
    }
    const selected = await readCanonicalMatch(
      row.company.id,
      row.publication.id,
      now,
    );
    if (selected?.match && selected.publication.visibleAt <= now) {
      if (selected.publication.documentarySnapshotId)
        quality = currentEventKeys.has(key)
          ? (selected.loaded?.project.quality ?? "unresolved")
          : "unresolved";
      else {
        const { publication, company, match, sourceReview: context } = selected;
        const binding = sourceReviewBindingState(
          context,
          match.sourceReviewDependency,
        );
        const isCurrent =
          reviewQualifies(match.reviewedAt) &&
          match.approved !== null &&
          isMatchRevisionCurrent({
            revision: match.revision,
            publication: publication.data,
            profileRevision: fingerprint(company.profile),
            manuallyReviewed: true,
          }) &&
          !hasSourceScopeReview(publication.data) &&
          !sourceReviewBlocksComparison(context) &&
          binding !== "stale" &&
          binding !== "blocked";
        if (isCurrent && match.approved === false) quality = "rejected";
        if (
          isCurrent &&
          match.approved === true &&
          preliminaryMatch(publication.data, company.profile, now).eligible
        )
          quality = "approved";
      }
    }
    current.push({ key, quality });
  }
  return summarizeProjectQuality(current, historical);
}

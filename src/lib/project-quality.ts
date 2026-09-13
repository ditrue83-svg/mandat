import { eq, lte } from "drizzle-orm";
import { getDb } from "@/db";
import {
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
export async function readProjectQuality(now = new Date()) {
  const db = getDb();
  const rows = (
    await db
      .select({ publication: publications, match: matches, company: companies })
      .from(matches)
      .innerJoin(publications, eq(publications.id, matches.publicationId))
      .innerJoin(companies, eq(companies.id, matches.companyId))
      .where(lte(publications.visibleAt, now))
  )
    .filter((row) => sourceAvailable(row.publication.source))
    .sort((a, b) => compareCanonicalPublications(a.publication, b.publication));
  const historical: { key: string; approved: boolean; rejected: boolean }[] =
    rows.map((row) => ({
      key: JSON.stringify([row.company.id, row.publication.canonicalId]),
      approved: !!row.match.reviewedAt && row.match.approved === true,
      rejected: !!row.match.reviewedAt && row.match.approved === false,
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
  for (const row of events) {
    const entries = row.event.after.evaluations?.entries ?? [];
    historical.push({
      key: JSON.stringify([row.companyId, row.canonicalId]),
      approved: entries.some((entry) => entry.result === "direct"),
      rejected:
        row.event.action === "veto_project" ||
        entries.some((entry) => entry.result === "different"),
    });
  }
  const seen = new Set<string>();
  const current: { key: string; quality: ProjectQuality }[] = [];
  for (const row of rows) {
    const key = JSON.stringify([row.company.id, row.publication.canonicalId]);
    if (seen.has(key)) continue;
    seen.add(key);
    let quality: ProjectQuality = "unresolved";
    const selected = await readCanonicalMatch(
      row.company.id,
      row.publication.id,
      now,
    );
    if (selected?.match && selected.publication.visibleAt <= now) {
      if (selected.publication.documentarySnapshotId)
        quality = selected.loaded?.project.quality ?? "unresolved";
      else {
        const { publication, company, match, sourceReview: context } = selected;
        const binding = sourceReviewBindingState(
          context,
          match.sourceReviewDependency,
        );
        const isCurrent =
          !!match.reviewedAt &&
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

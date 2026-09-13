import { readCanonicalFeedback } from "./canonical-feedback";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { companies, matches, feedback } from "@/db/schema";
import {
  compareCanonicalPublications,
  sourceAvailable,
} from "./canonical-publication";
import { readSourceReviewContext } from "./source-reviews";
import { lockCanonicalPublications } from "./canonical-lock";
import {
  readLotMatchReview,
  type LoadedLotMatchReview,
} from "./lot-match-reviews";
import { projectLotAssessmentDto } from "./lot-assessment";
import type { Opportunity } from "./domain";

// Internal server reader: callers supply the authenticated company ID, never a
// browser-selected tenant. Re-read every dependency after the canonical lock.
export async function readCurrentLotMatch(
  companyId: string,
  publicationId: string,
  now = new Date(),
) {
  return getDb().transaction(async (tx) => {
    const group = await lockCanonicalPublications(tx, publicationId);
    if (!group?.publication.documentarySnapshotId) return null;
    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .for("share");
    const [match] = await tx
      .select()
      .from(matches)
      .where(
        and(
          eq(matches.companyId, companyId),
          eq(matches.publicationId, publicationId),
        ),
      )
      .for("share");
    if (!company || !match) return null;
    return readLotMatchReview(tx, group.publication, company, match, now);
  });
}

export function presentLotOpportunity(
  loaded: LoadedLotMatchReview,
): Opportunity {
  const project = loaded.project;
  const dto = projectLotAssessmentDto(project);
  const operational = dto.targets.filter(
    (lot) => lot.state !== "removed-or-unresolved" && lot.operational,
  );
  const zones = [
    ...new Set(operational.map((lot) => lot.operational!.zone).filter(Boolean)),
  ];
  return {
    ...loaded.publication.data,
    id: loaded.publication.id,
    // Only the current target's operational evidence is projected. Parent AI
    // text never substitutes a human assessment, including without lots.
    summary: null,
    sectors: [
      ...new Set(
        project.targets
          .filter(
            (lot) =>
              lot.state !== "removed-or-unresolved" &&
              lot.preliminary?.eligible,
          )
          .flatMap((lot) => [...(lot.preliminary?.signals.sectors ?? [])]),
      ),
    ],
    cpv: [...new Set(operational.flatMap((lot) => lot.operational!.cpv))],
    canton: [
      ...new Set(
        operational.map((lot) => lot.operational!.canton).filter(Boolean),
      ),
    ].join(" · "),
    zone: zones.length === 1 ? zones[0]! : null,
    requirements: [],
    evidence: [],
    deadline:
      project.shape.kind === "project"
        ? (project.projectAssessment?.preliminary?.operational.deadline ?? null)
        : null,
    valueChf: null,
    location: zones.join(" · ") || "Non indicato",
    score: project.signalEligible ? 100 : 0,
    assessment:
      project.quality === "approved"
        ? "reviewed"
        : project.quality === "rejected"
          ? "rejected"
          : "uncertain",
    reason: project.reason,
    reviewRequired:
      dto.targets.some(
        (lot) =>
          lot.state !== "current" ||
          lot.result === "review" ||
          lot.reviewReasons.length > 0,
      ) ||
      project.shape.kind === "unresolved" ||
      project.state === "input_refused",
    reviewReasons: [
      ...new Set([
        ...(project.shape.kind === "unresolved"
          ? ["La struttura della gara richiede una verifica della fonte."]
          : []),
        ...dto.targets.flatMap((lot) => lot.reviewReasons),
      ]),
    ],
    saved: project.saved,
    dismissed: project.dismissed,
    feedback:
      loaded.feedback?.relevant == null
        ? null
        : loaded.feedback.relevant
          ? "relevant"
          : "irrelevant",
    lotReview: dto,
  };
}
export function lotOpportunityVisible(
  loaded: LoadedLotMatchReview,
  includeInactive: boolean,
  now: Date,
) {
  if (loaded.publication.visibleAt > now) return false;
  if (includeInactive) return loaded.project.saved;
  return (
    loaded.publication.status === "open" &&
    !loaded.project.suppressed &&
    loaded.project.state !== "different" &&
    (loaded.project.state === "input_refused" ||
      loaded.project.shape.kind === "unresolved" ||
      loaded.project.targets.some(
        (lot) =>
          lot.state !== "removed-or-unresolved" &&
          lot.preliminary?.eligible !== false,
      ))
  );
}

// Canonical reads inspect ALL group members before matching/visibility filters.
// A closed, refused or not-yet-matched adopted representative blocks fallback.
export async function readCanonicalMatch(
  companyId: string,
  publicationId: string,
  now = new Date(),
  options: { legacyDetail?: boolean } = {},
) {
  return getDb().transaction(async (tx) => {
    const group = await lockCanonicalPublications(tx, publicationId);
    if (!group) return null;
    const available = group.publications.filter((p) =>
      sourceAvailable(p.source),
    );
    const publication =
      options.legacyDetail && !available.some((p) => p.documentarySnapshotId)
        ? available.find((p) => p.id === publicationId)
        : available.sort(compareCanonicalPublications)[0];
    if (!publication) return null;
    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .for("share");
    if (!company) return null;
    const [match] = await tx
      .select()
      .from(matches)
      .where(
        and(
          eq(matches.companyId, companyId),
          eq(matches.publicationId, publication.id),
        ),
      )
      .for("share");
    if (!match)
      return {
        publication,
        company,
        match: null,
        loaded: null,
        sourceReview: null,
        feedback: null,
      };
    if (publication.documentarySnapshotId) {
      const loaded = await readLotMatchReview(
        tx,
        publication,
        company,
        match,
        now,
      );
      return {
        publication,
        company,
        match,
        loaded,
        sourceReview: null,
        feedback: loaded.feedback,
      };
    }
    const [currentFeedback] = await tx
      .select()
      .from(feedback)
      .where(
        and(
          eq(feedback.companyId, companyId),
          eq(feedback.publicationId, publication.id),
        ),
      )
      .for("share");
    return {
      publication,
      company,
      match,
      loaded: null,
      sourceReview: await readSourceReviewContext(tx, publication),
      feedback: {
        ...(await readCanonicalFeedback(
          tx,
          companyId,
          publication.canonicalId,
        )),
        relevant: currentFeedback?.relevant ?? null,
      },
    };
  });
}

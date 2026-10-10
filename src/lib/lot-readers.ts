import {
  readCanonicalFeedback,
  readCanonicalFeedbackBatch,
} from "./canonical-feedback";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { companies, matches, feedback, publications } from "@/db/schema";
import {
  compareCanonicalPublications,
  sourceAvailable,
} from "./canonical-publication";
import {
  readSourceReviewContext,
  readSourceReviewContexts,
} from "./source-reviews";
import {
  lockCanonicalPublications,
  lockCanonicalPublicationGroups,
  CanonicalMembershipConflict,
} from "./canonical-lock";
import {
  readLotMatchReview,
  type LoadedLotMatchReview,
} from "./lot-match-reviews";
import { projectLotAssessmentDto } from "./lot-assessment";
import type { Opportunity } from "./domain";
import { buildTenderBrief } from "./tender-brief";
import { withClassification } from "./sector-classification";

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

// A verified relationship in a different professional role can be explored by
// the customer. Missing/stale judgments and source problems stay in review.
// This never changes signalEligible, approvals or notification eligibility.
export function relatedReviewTargets(loaded: LoadedLotMatchReview) {
  const project = loaded.project;
  if (
    project.state !== "review" ||
    project.signalEligible ||
    project.suppressed ||
    project.dismissed ||
    loaded.input.snapshot.acquisition.state !== "accepted"
  )
    return [];
  return project.targets.filter(
    (target) =>
      target.state === "current" &&
      !target.issue &&
      !target.evaluation &&
      target.preliminary?.eligible &&
      target.automatic?.result === "review" &&
      target.automatic.basis === "related_activity" &&
      target.automatic.response?.facts.relatedActivity ===
        "shared_professional_function" &&
      !target.automatic.sourceBlocked &&
      target.automatic.sourceReview?.accepted,
  );
}

export function presentLotOpportunity(
  loaded: LoadedLotMatchReview,
  includeBrief = false,
): Opportunity {
  const project = loaded.project;
  const acquisition = loaded.input.snapshot.acquisition;
  const classified = withClassification(
    loaded.publication.data,
    acquisition.state === "accepted" ? acquisition.archive : null,
    acquisition.state === "refused",
  );
  const dto = projectLotAssessmentDto(project);
  const related = relatedReviewTargets(loaded);
  const operational = dto.targets.filter(
    (lot) => lot.state !== "removed-or-unresolved" && lot.operational,
  );
  const zones = [
    ...new Set(operational.map((lot) => lot.operational!.zone).filter(Boolean)),
  ];
  return {
    ...classified,
    id: loaded.publication.id,
    ...(includeBrief
      ? {
          tenderBrief: buildTenderBrief(
            loaded.publication.data,
            loaded.input.snapshot.acquisition.state === "accepted"
              ? loaded.input.snapshot.acquisition.archive
              : null,
            loaded.input.snapshot.acquisition.state === "refused",
          ),
        }
      : {}),
    // Only the current target's operational evidence is projected. Parent AI
    // text never substitutes a human assessment, including without lots.
    summary: null,
    sectors: classified.sectors,
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
    location:
      [...new Set(operational.map((lot) => lot.operational!.location))].join(
        " / ",
      ) || "Non indicato",
    score: project.signalEligible ? 100 : 0,
    reviewCandidate: related.length > 0,
    assessment:
      project.quality === "approved"
        ? "reviewed"
        : project.quality === "rejected"
          ? "rejected"
          : project.state === "different"
            ? "excluded"
            : project.signalEligible
              ? "ai"
              : "uncertain",
    reason:
      project.signalEligible && project.shape.kind === "project"
        ? (dto.targets.find(
            (target) =>
              target.state === "current" && target.result === "direct",
          )?.reason ?? project.reason)
        : related.length
          ? `${related[0]!.automatic!.response!.comparison}${related.length > 1 ? " Anche altri lotti presentano attività collegate: verifica le singole valutazioni nella scheda." : ""}`
          : project.reason,
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
  includeRelatedReview = false,
) {
  if (loaded.publication.visibleAt > now) return false;
  if (includeInactive) return loaded.project.saved;
  return (
    loaded.publication.status === "open" &&
    !loaded.project.suppressed &&
    // Pending, stale and refused assessments belong in the founder queue.
    // The customer may separately explore current, verified related roles.
    // Explicit customer dismissals remain available under the Excluse filter;
    // they are never displayed among the selected opportunities or emailed.
    (loaded.project.signalEligible ||
      loaded.project.dismissed ||
      (includeRelatedReview && relatedReviewTargets(loaded).length > 0))
  );
}

// The founder queue lists individual publications, including duplicate copies.
// Select its legacy/documentary branch only after locking and re-reading it.
export async function readCurrentMatch(
  companyId: string,
  publicationId: string,
  now = new Date(),
) {
  return getDb().transaction(async (tx) => {
    const group = await lockCanonicalPublications(tx, publicationId);
    return group
      ? readPublicationMatch(tx, group.publication, companyId, now)
      : null;
  });
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
    return readPublicationMatch(tx, publication, companyId, now);
  });
}

// List-only batch reader: keep the canonical -> company -> match lock order,
// reselect the representative under the lock, and batch legacy dependencies.
// A source adopted during loading still uses the full documentary reader.
export async function readCanonicalLegacyMatches(
  companyId: string,
  publicationIds: readonly string[],
  now = new Date(),
) {
  return getDb().transaction(async (tx) => {
    const ids = [...new Set(publicationIds)];
    const result = new Map<
      string,
      NonNullable<Awaited<ReturnType<typeof readCanonicalMatch>>>
    >();
    if (!ids.length) return result;
    const observed = await tx
      .select({ id: publications.id, canonicalId: publications.canonicalId })
      .from(publications)
      .where(inArray(publications.id, ids));
    const members = await lockCanonicalPublicationGroups(
      tx,
      observed.map((p) => p.canonicalId),
    );
    const byGroup = new Map<string, typeof members>();
    for (const member of members) {
      const group = byGroup.get(member.canonicalId) ?? [];
      group.push(member);
      byGroup.set(member.canonicalId, group);
    }
    const selected = observed.flatMap((row) => {
      const group = byGroup.get(row.canonicalId) ?? [];
      if (!group.some((p) => p.id === row.id))
        throw new CanonicalMembershipConflict(
          "Il gruppo della pubblicazione è cambiato: ripetere la transazione.",
        );
      const representative = group
        .filter((p) => sourceAvailable(p.source))
        .sort(compareCanonicalPublications)[0];
      return representative
        ? [{ requestedId: row.id, publication: representative }]
        : [];
    });
    if (!selected.length) return result;
    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .for("share");
    if (!company) return result;
    const selectedIds = [...new Set(selected.map((r) => r.publication.id))];
    const matched = await tx
      .select()
      .from(matches)
      .where(
        and(
          eq(matches.companyId, companyId),
          inArray(matches.publicationId, selectedIds),
        ),
      )
      .for("share");
    const byPublication = new Map(matched.map((m) => [m.publicationId, m]));
    const legacy = selected.filter((r) => !r.publication.documentarySnapshotId);
    const contexts = await readSourceReviewContexts(
      tx,
      legacy.map((r) => r.publication),
    );
    const canonicalFeedback = await readCanonicalFeedbackBatch(
      tx,
      companyId,
      legacy.map((r) => r.publication.canonicalId),
    );
    const feedbackRows = legacy.length
      ? await tx
          .select()
          .from(feedback)
          .where(
            and(
              eq(feedback.companyId, companyId),
              inArray(
                feedback.publicationId,
                legacy.map((r) => r.publication.id),
              ),
            ),
          )
          .for("share")
      : [];
    const feedbackByPublication = new Map(
      feedbackRows.map((f) => [f.publicationId, f]),
    );
    for (const { requestedId, publication } of selected) {
      if (publication.documentarySnapshotId) {
        const row = await readPublicationMatch(tx, publication, companyId, now);
        if (row) result.set(requestedId, row);
        continue;
      }
      const match = byPublication.get(publication.id) ?? null;
      const f = feedbackByPublication.get(publication.id);
      if (!match) {
        result.set(requestedId, {
          publication,
          company,
          match: null,
          loaded: null,
          sourceReview: null,
          feedback: null,
        });
      } else {
        result.set(requestedId, {
          publication,
          company,
          match,
          loaded: null,
          sourceReview: contexts.get(publication.id) ?? null,
          feedback: {
            ...canonicalFeedback.get(publication.canonicalId)!,
            relevant: f?.relevant ?? null,
          },
        });
      }
    }
    return result;
  });
}

async function readPublicationMatch(
  tx: Parameters<typeof readLotMatchReview>[0],
  publication: typeof publications.$inferSelect,
  companyId: string,
  now: Date,
) {
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
      ...(await readCanonicalFeedback(tx, companyId, publication.canonicalId)),
      relevant: currentFeedback?.relevant ?? null,
    },
  };
}

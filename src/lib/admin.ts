import { and, eq, isNull, desc, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  user,
  companies,
  invitations,
  administrators,
  matches,
  publications,
  notifications,
  sourceRuns,
  settings,
  issues,
  aiUsage,
  feedback,
  session,
} from "@/db/schema";
import { readProjectQuality } from "./project-quality";
import {
  readCurrentMatch,
  presentLotOpportunity,
  lotOpportunityVisible,
} from "./lot-readers";
import { automationGate, preliminaryMatch } from "./matching";
import type { CompanyProfile } from "./domain";
import { emailLayout, escapeHtml, sendMail } from "./mail";
import { appUrl } from "./config";
import { HttpError } from "./viewer";
import { DateTime } from "luxon";
import { fingerprint } from "@/sources/common";
import { presentMatch } from "./match-presentation";
import { matchReviewToken } from "./match-review-token";
import { hasSourceScopeReview } from "./source-scope-review";
import {
  sourceReviewBindingState,
  sourceReviewBlocksComparison,
} from "./source-review-policy";
export async function provisionInvite(
  email: string,
  name: string,
  admin = false,
) {
  const db = getDb();
  const [exists] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email));
  if (exists)
    throw new HttpError(409, "Questo indirizzo ha già un invito o un account.");
  const userId = crypto.randomUUID(),
    companyId = crypto.randomUUID(),
    inviteId = crypto.randomUUID();
  const profile: CompanyProfile = {
    name,
    activities: "",
    employees: 1,
    sectors: [],
    zones: ["Tutto il Ticino"],
    keywords: [],
    exclusions: [],
    minValue: null,
    maxValue: null,
    emailEnabled: true,
  };
  await db.transaction(async (tx) => {
    await tx
      .insert(user)
      .values({ id: userId, email, name, emailVerified: false });
    await tx
      .insert(companies)
      .values({ id: companyId, ownerId: userId, profile });
    await tx.insert(invitations).values({
      id: inviteId,
      email,
      companyId,
      expiresAt: new Date(Date.now() + 14 * 86400000),
      acceptedAt: admin ? new Date() : null,
    });
    if (admin) await tx.insert(administrators).values({ userId });
    if (!admin)
      await tx
        .insert(settings)
        .values({ key: "pilot_started_at", value: new Date().toISOString() })
        .onConflictDoNothing();
  });
  return { userId, companyId, inviteId };
}
export async function notifyInvitation(email: string, name: string) {
  return sendMail({
    to: email,
    subject: "La tua ditta è invitata a provare Mandat",
    text: `Ciao ${name}, la tua ditta è invitata alla beta gratuita di Mandat. Accedi con questa email entro 14 giorni: ${appUrl()}/accedi`,
    html: emailLayout(
      `<h2>Benvenuto nella beta Radar</h2><p>Ciao ${escapeHtml(name)}, la tua ditta è invitata a provare Mandat gratuitamente.</p><p><a href="${appUrl()}/accedi">Accedi al tuo Radar</a></p><p>Usa questo indirizzo email entro 14 giorni. Non serve una carta di credito.</p>`,
    ),
  });
}
export async function getGate() {
  const db = getDb();
  const quality = await readProjectQuality();
  const [critical] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(issues)
    .where(and(eq(issues.severity, "critical"), isNull(issues.resolvedAt)));
  const [started] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "pilot_started_at"));
  return {
    ...quality,
    ...automationGate({
      reviewed: quality.reviewed,
      approved: quality.approved,
      criticalIssues: critical.total,
      startedAt:
        typeof started?.value === "string" ? new Date(started.value) : null,
    }),
  };
}
export async function adminSnapshot(demo: boolean) {
  if (demo)
    return {
      demo: true,
      gate: {
        allowed: false,
        reviewed: 0,
        approved: 0,
        criticalIssues: 0,
        elapsedDays: 0,
        precision: 0,
      },
      automatic: false,
      spend: 0,
      runs: [],
      invites: [],
      matches: [],
      issues: [],
      notifications: [],
      feedback: [],
      sourceEnabled: { simap: false, foglio: false },
    };
  const db = getDb();
  const [
    gate,
    runs,
    invites,
    reviewInventory,
    problem,
    mail,
    auto,
    usage,
    feedbackRows,
  ] = await Promise.all([
    getGate(),
    db.select().from(sourceRuns).orderBy(desc(sourceRuns.startedAt)).limit(10),
    db
      .select({
        id: invitations.id,
        email: invitations.email,
        name: user.name,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
        revokedAt: invitations.revokedAt,
      })
      .from(invitations)
      .innerJoin(companies, eq(companies.id, invitations.companyId))
      .innerJoin(user, eq(user.id, companies.ownerId)),
    db
      .select({
        id: matches.id,
        companyId: companies.id,
        publicationId: publications.id,
      })
      .from(matches)
      .innerJoin(publications, eq(publications.id, matches.publicationId))
      .innerJoin(companies, eq(companies.id, matches.companyId))
      .where(eq(publications.status, "open"))
      .orderBy(desc(matches.updatedAt))
      .limit(500),
    db
      .select()
      .from(issues)
      .where(isNull(issues.resolvedAt))
      .orderBy(desc(issues.createdAt))
      .limit(100),
    db
      .select({
        id: notifications.id,
        status: notifications.status,
        subject: notifications.subject,
        kind: notifications.kind,
        error: notifications.error,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .orderBy(desc(notifications.createdAt))
      .limit(30),
    db.select().from(settings).where(eq(settings.key, "automation_enabled")),
    db
      .select({
        total: sql<string>`coalesce(sum(coalesce(${aiUsage.costChf},${aiUsage.reservedChf})),0)`,
      })
      .from(aiUsage)
      .where(
        eq(
          aiUsage.month,
          DateTime.now().setZone("Europe/Zurich").toFormat("yyyy-MM"),
        ),
      ),
    db
      .select({
        companyId: feedback.companyId,
        canonicalId: publications.canonicalId,
        relevant: feedback.relevant,
        sector: publications.data,
      })
      .from(feedback)
      .innerJoin(publications, eq(publications.id, feedback.publicationId))
      .where(sql`${feedback.relevant} is not null`)
      .orderBy(desc(feedback.updatedAt)),
  ]);
  const review = [];
  for (const item of reviewInventory) {
    const current = await readCurrentMatch(item.companyId, item.publicationId);
    if (!current?.match || current.publication.status !== "open") continue;
    const { publication, company, match, loaded, sourceReview } = current;
    review.push({
      ...match,
      documentarySnapshotId: publication.documentarySnapshotId,
      title: publication.title,
      company: company.profile,
      aiRevision: publication.aiRevision,
      sourceRevision: publication.revision,
      reviewRequired: publication.data,
      loaded,
      sourceReview,
    });
  }

  return {
    demo: false,
    gate: {
      allowed: gate.allowed,
      reviewed: gate.reviewed,
      approved: gate.approved,
      criticalIssues: gate.criticalIssues,
      elapsedDays: gate.elapsedDays,
      precision: gate.precision,
      rejected: gate.rejected,
      unresolved: gate.unresolved,
      historical: gate.historical,
      version: gate.version,
    },
    automatic: auto[0]?.value === true,
    spend: Number(usage[0].total),
    runs: runs.map((r) => ({
      ...r,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    })),
    invites: invites.map((i) => ({
      ...i,
      expiresAt: i.expiresAt.toISOString(),
      acceptedAt: i.acceptedAt?.toISOString() ?? null,
      revokedAt: i.revokedAt?.toISOString() ?? null,
    })),
    matches: review.map((r) => {
      const { sourceReview, loaded } = r;
      const lot = loaded ? presentLotOpportunity(loaded) : null;
      const documentary = !!r.documentarySnapshotId;
      return {
        id: r.id,
        lotReview: lot?.lotReview ?? null,
        lotReviewUrl: r.documentarySnapshotId
          ? `/admin/valutazioni/${encodeURIComponent(r.companyId)}/${encodeURIComponent(r.publicationId)}`
          : null,
        publicationId: r.publicationId,
        title: r.title,
        company: r.company.name,
        companyActivities: r.company.activities,
        profileRevision: fingerprint(r.company),
        score: documentary ? (lot?.score ?? 0) : r.score,
        eligible: loaded
          ? lotOpportunityVisible(loaded, false, new Date())
          : documentary
            ? false
            : r.eligible,
        ...(lot
          ? { assessment: lot.assessment, reason: lot.reason }
          : documentary
            ? {
                assessment: "uncertain" as const,
                reason:
                  "La fonte adottata richiede una valutazione corrente della pertinenza.",
              }
            : presentMatch({
                match: r,
                publication: r.reviewRequired,
                aiRevision: r.aiRevision,
                profileRevision: fingerprint(r.company),
                sourceReview,
                preliminary: preliminaryMatch(r.reviewRequired, r.company),
              })),
        approved: loaded
          ? loaded.project.quality === "approved"
            ? true
            : loaded.project.quality === "rejected"
              ? false
              : null
          : documentary
            ? null
            : r.approved,
        reviewed: loaded
          ? loaded.project.quality !== "unresolved"
          : documentary
            ? false
            : !!r.reviewedAt,
        evaluationRevision: r.revision,
        evaluationToken: matchReviewToken(r),
        sourceReviewState: sourceReviewBindingState(
          sourceReview,
          r.sourceReviewDependency,
        ),
        sourceReviewDependency: sourceReview?.dependency ?? null,
        reviewRequired:
          !!r.documentarySnapshotId ||
          r.reviewRequired.reviewRequired ||
          hasSourceScopeReview(r.reviewRequired) ||
          sourceReviewBlocksComparison(sourceReview) ||
          (!!sourceReview &&
            !preliminaryMatch(r.reviewRequired, r.company).eligible),
        sourceScopeReview: r.reviewRequired.sourceScopeReview,
        sourceRevision: r.sourceRevision,
        contentRevision: r.reviewRequired.revision,
        reviewReasons: documentary
          ? (lot?.reviewReasons ?? [])
          : r.reviewRequired.reviewReasons,
        summary: documentary ? null : r.reviewRequired.summary,
        deadline: documentary
          ? (lot?.deadline ?? null)
          : r.reviewRequired.deadline,
        valueChf: documentary
          ? (lot?.valueChf ?? null)
          : r.reviewRequired.valueChf,
        location: documentary
          ? (lot?.location ?? "Non indicato")
          : r.reviewRequired.location,
        sourceUrl: r.reviewRequired.sourceUrl,
        sourceConditions: r.reviewRequired.sourceConditions ?? [],
        originalTitles: r.reviewRequired.originalTitles ?? [],
      };
    }),
    issues: problem.map((i) => ({
      id: i.id,
      key: i.key,
      title: i.title,
      detail: i.detail,
      severity: i.severity,
      publicationId: i.publicationId,
    })),
    notifications: mail.map((n) => ({
      ...n,
      createdAt: n.createdAt.toISOString(),
    })),
    feedback: feedbackRows
      .filter(
        (f, i, rows) =>
          rows.findIndex(
            (other) =>
              other.companyId === f.companyId &&
              other.canonicalId === f.canonicalId,
          ) === i,
      )
      .map((f) => ({
        relevant: f.relevant,
        sectors: f.sector.sectors,
      })),
    sourceEnabled: {
      simap: !!process.env.DATABASE_URL,
      foglio: process.env.FOGLIO_REUSE_CONFIRMED === "true",
    },
  };
}
export type AdminSnapshot = Awaited<ReturnType<typeof adminSnapshot>>;

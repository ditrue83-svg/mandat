import { DateTime } from "luxon";
import { and, eq, isNull, lte, sql, desc, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  companies,
  publications,
  publicationVersions,
  matches,
  feedback,
  notifications,
  settings,
  issues,
  sourceRuns,
} from "@/db/schema";
import { sendMail } from "@/lib/mail";
import {
  renderChangeContent,
  renderDigestContent,
} from "@/lib/notification-content";
import { presentMatch } from "@/lib/match-presentation";
import { appUrl } from "@/lib/config";
import type { Publication } from "@/lib/domain";
import {
  digestDue,
  zurichDigestDay,
  materialChange,
  preliminaryMatch,
} from "@/lib/matching";
import { HttpError } from "@/lib/viewer";
import { activityReviewBlocksAutomatic } from "@/lib/cpv-service-signals";
import { fingerprint } from "@/sources/common";
import { readSourceReviewContexts } from "@/lib/source-reviews";
import { sourceReviewBindingState } from "@/lib/source-review-policy";
import {
  hasSourceScopeReview,
  isMatchRevisionCurrent,
} from "@/lib/source-scope-review";
import { claimLotNotification, reconcileLotNotices } from "./lot-notifications";
import { readCanonicalFeedback } from "@/lib/canonical-feedback";
import {
  compareCanonicalPublications,
  sourceAvailable,
} from "@/lib/canonical-publication";
import { companyAllowsPilotProcessingSql } from "@/lib/pilot-processing";
import {
  MANUAL_REVIEW_WINDOW,
  automationForCompany,
} from "@/lib/manual-review-window";
export function deliveryFailureKind(error: unknown): "failed" | "uncertain" {
  const e = error as { code?: string; command?: string; responseCode?: number };
  if (e.responseCode && e.responseCode >= 400) return "failed";
  if (
    ["EDNS", "ECONNREFUSED", "EAUTH"].includes(e.code ?? "") ||
    e.command === "CONN"
  )
    return "failed";
  return "uncertain";
}
async function deliverLotNotification(
  claimed: typeof notifications.$inferSelect,
  to: string,
) {
  const db = getDb();
  try {
    const result = await sendMail({
      to,
      subject: claimed.subject,
      html: claimed.html,
      text: claimed.textBody,
      messageId: claimed.messageId!,
    });
    if (!result.accepted.length)
      throw Object.assign(
        new Error("Il server SMTP ha rifiutato il destinatario"),
        { responseCode: 550 },
      );
    await db
      .update(notifications)
      .set({ status: "sent", sentAt: new Date(), error: null })
      .where(
        and(
          eq(notifications.id, claimed.id),
          eq(notifications.status, "sending"),
        ),
      );
  } catch (error) {
    const state = deliveryFailureKind(error);
    const permanent =
      (error as { responseCode?: number }).responseCode! >= 500 ||
      (error as { code?: string }).code === "EAUTH";
    const retry = state === "failed" && !permanent && claimed.attempts < 3;
    await db
      .update(notifications)
      .set({
        status: retry ? "pending" : state,
        error:
          error instanceof Error ? error.message.slice(0, 300) : "Errore SMTP",
      })
      .where(
        and(
          eq(notifications.id, claimed.id),
          eq(notifications.status, "sending"),
        ),
      );
    if (!retry)
      await db
        .insert(issues)
        .values({
          id: crypto.randomUUID(),
          key: `email:${claimed.id}`,
          title:
            state === "uncertain" ? "Esito email incerto" : "Email non inviata",
          detail:
            "Controllare il registro SMTP prima di autorizzare un nuovo invio.",
          severity: "critical",
        })
        .onConflictDoNothing();
  }
}
export async function queueChangeNotices(
  before: Publication,
  after: Publication,
  onlyCompanyId?: string,
) {
  const db = getDb();
  const [currentSource] = await db
    .select()
    .from(publications)
    .where(eq(publications.id, after.id));
  const currentGroup = currentSource
    ? await db
        .select()
        .from(publications)
        .where(eq(publications.canonicalId, currentSource.canonicalId))
    : [];
  const representative = currentGroup
    .filter((p) => sourceAvailable(p.source))
    .sort(compareCanonicalPublications)[0];
  if (representative?.documentarySnapshotId) {
    await reconcileLotNotices({
      companyId: onlyCompanyId,
      canonicalId: representative.canonicalId,
    });
    return;
  }
  if (representative && representative.id !== after.id) return;
  const previously = await db
    .select()
    .from(notifications)
    .where(eq(notifications.status, "sent"));
  const sameProject = await db
    .select({ id: publications.id, source: publications.source })
    .from(publications)
    .where(eq(publications.canonicalId, after.canonicalKey ?? after.id));
  // Prefer simap for updates to a project also published in the Foglio.
  if (
    after.source === "foglio-ti" &&
    sameProject.some((p) => p.source === "simap")
  )
    return;
  const relatedIds = new Set([
    before.id,
    after.id,
    ...sameProject.map((p) => p.id),
  ]);
  const companyIds = new Set(
    previously
      .filter(
        (n) =>
          (!onlyCompanyId || n.companyId === onlyCompanyId) &&
          n.items.some((i) => relatedIds.has(i.id)),
      )
      .map((n) => n.companyId),
  );
  for (const companyId of companyIds) {
    const [firm] = await db
      .select()
      .from(companies)
      .where(
        and(eq(companies.id, companyId), companyAllowsPilotProcessingSql()),
      );
    if (!firm || firm.disabledAt || !firm.profile.emailEnabled) continue;
    const subject =
      after.status === "cancelled"
        ? `Bando annullato: ${after.title}`
        : `Aggiornamento: ${after.title}`;
    await db
      .insert(notifications)
      .values({
        id: crypto.randomUUID(),
        companyId,
        dedupeKey: `change:${companyId}:${after.canonicalKey ?? after.id}:${after.revision}`,
        kind: "change",
        subject,
        ...renderChangeContent(after),
        items: [{ id: after.id, revision: after.revision }],
      })
      .onConflictDoNothing();
  }
}
// Rebuild missed change notices from committed history, including after a restart
// between saving a publication and inserting its outbox record.
export async function queueOutstandingChanges(companyId?: string) {
  await reconcileLotNotices({ companyId });
  const db = getDb();
  const sent = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.status, "sent"),
        companyId ? eq(notifications.companyId, companyId) : undefined,
      ),
    )
    .orderBy(desc(notifications.createdAt));
  if (!sent.length) return;
  const all = await db.select().from(publications);
  const byId = new Map(all.map((p) => [p.id, p]));
  const seen = new Set<string>();
  for (const notification of sent)
    for (const item of notification.items) {
      const publication = byId.get(item.id);
      if (!publication) continue;
      if (item.lotNotice || publication.documentarySnapshotId) continue;
      const key = `${notification.companyId}:${publication.canonicalId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const current = all
        .filter(
          (p) =>
            p.canonicalId === publication.canonicalId &&
            sourceAvailable(p.source),
        )
        .sort(compareCanonicalPublications)[0];
      if (
        !current ||
        current.status === "closed" ||
        current.data.revision === item.revision
      )
        continue;
      if (current.documentarySnapshotId) continue;
      const [prior] = await db
        .select()
        .from(publicationVersions)
        .where(
          and(
            eq(publicationVersions.publicationId, item.id),
            eq(publicationVersions.revision, item.revision),
          ),
        )
        .limit(1);
      if (!prior) {
        await db
          .insert(issues)
          .values({
            id: crypto.randomUUID(),
            key: `missing-history:${notification.id}:${item.id}`,
            title: "Storico dell’alert da verificare",
            detail:
              "Manca la versione associata a un invio confermato. Confrontare la pubblicazione corrente con il registro SMTP.",
            severity: "critical",
            publicationId: current.id,
          })
          .onConflictDoNothing();
        continue;
      }
      if (materialChange(prior.data, current.data))
        await queueChangeNotices(
          prior.data,
          current.data,
          notification.companyId,
        );
    }
}
export async function reconcileDelivery(
  id: string,
  outcome: "sent" | "retry" | "cancelled",
  note: string,
  actor: string,
) {
  const db = getDb();
  const companyId = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(notifications)
      .set({
        status:
          outcome === "retry"
            ? "pending"
            : outcome === "cancelled"
              ? "discarded"
              : "sent",
        ...(outcome === "sent" ? { sentAt: new Date() } : {}),
        error: `Verifica manuale ${actor}: ${note}`,
      })
      .where(
        and(
          eq(notifications.id, id),
          inArray(notifications.status, ["uncertain", "failed"]),
        ),
      )
      .returning({ companyId: notifications.companyId });
    if (!updated)
      throw new HttpError(
        409,
        "Questa email è già stata riconciliata o non richiede una verifica.",
      );
    await tx
      .update(issues)
      .set({ resolvedAt: new Date() })
      .where(eq(issues.key, `email:${id}`));
    return updated.companyId;
  });
  if (outcome === "sent") await queueOutstandingChanges(companyId);
  else await reconcileLotNotices({ companyId });
}
export async function queueDigests(now = new Date()) {
  if (!digestDue(now)) return;
  const db = getDb();
  const autoSettings = await db
    .select()
    .from(settings)
    .where(
      inArray(settings.key, [
        "automation_enabled",
        "pilot_started_at",
        MANUAL_REVIEW_WINDOW,
      ]),
    );
  const automaticConfiguration = new Map(
    autoSettings.map((row) => [row.key, row.value]),
  );
  const critical = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.severity, "critical"), isNull(issues.resolvedAt)))
    .limit(1);
  if (critical.length) return;
  for (const source of [
    "simap",
    ...(process.env.FOGLIO_REUSE_CONFIRMED === "true" ? ["foglio-ti"] : []),
  ]) {
    const [run] = await db
      .select()
      .from(sourceRuns)
      .where(
        and(eq(sourceRuns.source, source), eq(sourceRuns.status, "success")),
      )
      .orderBy(desc(sourceRuns.finishedAt))
      .limit(1);
    if (
      !run?.finishedAt ||
      now.getTime() - run.finishedAt.getTime() > 3 * 3600000
    )
      return;
  }
  const firms = await db
    .select()
    .from(companies)
    .where(
      and(isNull(companies.disabledAt), companyAllowsPilotProcessingSql()),
    );
  const representativeSources = (await db.select().from(publications))
    .filter((p) => sourceAvailable(p.source))
    .sort(compareCanonicalPublications);
  const representatives = new Map<string, string>();
  for (const source of representativeSources)
    if (!representatives.has(source.canonicalId))
      representatives.set(source.canonicalId, source.id);
  for (const firm of firms) {
    const automatic = automationForCompany(automaticConfiguration, firm, now);
    if (!firm.profile.emailEnabled || !firm.onboardedAt) continue;
    const all = await db
      .select({ p: publications, m: matches, f: feedback })
      .from(matches)
      .innerJoin(publications, eq(publications.id, matches.publicationId))
      .leftJoin(
        feedback,
        and(
          eq(feedback.companyId, firm.id),
          eq(feedback.publicationId, publications.id),
        ),
      )
      .where(
        and(
          eq(matches.companyId, firm.id),
          isNull(publications.documentarySnapshotId),
          sql`not exists (select 1 from publications adopted where adopted.canonical_id=${publications.canonicalId} and adopted.documentary_snapshot_id is not null)`,
          eq(matches.eligible, true),
          eq(publications.status, "open"),
          lte(publications.visibleAt, now),
        ),
      )
      .orderBy(desc(matches.score));
    const previous = await db
      .select()
      .from(notifications)
      .where(eq(notifications.companyId, firm.id));
    const sent = new Set(
      previous
        .filter((n) =>
          ["sent", "sending", "uncertain", "pending", "discarded"].includes(
            n.status,
          ),
        )
        .flatMap((n) => n.items.map((i) => i.id)),
    );
    const sentPublications = sent.size
      ? await db
          .select({ canonicalId: publications.canonicalId })
          .from(publications)
          .where(
            sql`${publications.id} in (${sql.join(
              [...sent].map((id) => sql`${id}`),
              sql`,`,
            )})`,
          )
      : [];
    const seen = new Set<string>(sentPublications.map((p) => p.canonicalId));
    const sourceReviews = await readSourceReviewContexts(
      db,
      all.map((r) => r.p),
    );
    const canonicalFeedback = new Map<
      string,
      { saved: boolean; dismissed: boolean }
    >();
    for (const key of new Set(all.map((r) => r.p.canonicalId)))
      canonicalFeedback.set(key, await readCanonicalFeedback(db, firm.id, key));
    const selected = all.filter((r) => {
      if (representatives.get(r.p.canonicalId) !== r.p.id) return false;
      if (
        activityReviewBlocksAutomatic(
          r.m,
          preliminaryMatch(r.p.data, firm.profile, now),
          { publication: r.p.data, profileRevision: fingerprint(firm.profile) },
        )
      )
        return false;
      const sourceReview = sourceReviews.get(r.p.id) ?? null;
      const sourceState = sourceReviewBindingState(
        sourceReview,
        r.m.sourceReviewDependency,
      );
      if (sourceState === "blocked" || sourceState === "stale") return false;
      if (sourceReview && (r.m.approved !== true || !r.m.reviewedAt))
        return false;
      if (
        sourceReview &&
        !preliminaryMatch(r.p.data, firm.profile, now).eligible
      )
        return false;
      if (
        sent.has(r.p.id) ||
        seen.has(r.p.canonicalId) ||
        canonicalFeedback.get(r.p.canonicalId)?.dismissed
      )
        return false;
      if (r.p.deadline && r.p.deadline <= now) return false;
      if (
        r.p.source === "foglio-ti" &&
        process.env.FOGLIO_REUSE_CONFIRMED !== "true"
      )
        return false;
      if (
        r.p.data.reviewRequired ||
        hasSourceScopeReview(r.p.data) ||
        r.m.approved === false ||
        ((r.p.data.sourceScopeReview || sourceReview) &&
          !isMatchRevisionCurrent({
            revision: r.m.revision,
            publication: r.p.data,
            profileRevision: fingerprint(firm.profile),
            manuallyReviewed: Boolean(r.m.reviewedAt),
          }))
      )
        return false;
      if (
        r.m.approved !== true &&
        (!automatic || r.m.score < 80 || r.m.reviewNotes || !r.p.aiRevision)
      )
        return false;
      seen.add(r.p.canonicalId);
      return true;
    });
    if (!selected.length) continue;
    const day = zurichDigestDay(now);
    const rendered = renderDigestContent(
      selected.map((r) => ({
        id: r.p.id,
        title: r.p.title,
        deadline: r.p.data.deadline,
        sourceUrl: r.p.data.sourceUrl,
        ...presentMatch({
          match: r.m,
          publication: r.p.data,
          aiRevision: r.p.aiRevision,
          profileRevision: fingerprint(firm.profile),
          sourceReview: sourceReviews.get(r.p.id) ?? null,
        }),
      })),
      appUrl(),
    );
    const content = {
      id: crypto.randomUUID(),
      companyId: firm.id,
      dedupeKey: `digest:${firm.id}:${day}`,
      kind: "digest",
      subject: `Il tuo Radar: ${selected.length} ${selected.length === 1 ? "opportunità" : "opportunità"} da scoprire`,
      ...rendered,
      items: selected.map((r) => ({
        id: r.p.id,
        revision: r.p.data.revision,
        ...(r.p.data.sourceScopeReview
          ? { sourceScopeToken: r.p.data.sourceScopeReview.token }
          : {}),
        ...(sourceReviews.get(r.p.id)
          ? { sourceReviewDependency: sourceReviews.get(r.p.id)!.dependency }
          : {}),
      })),
    };
    await db
      .insert(notifications)
      .values(content)
      .onConflictDoUpdate({
        target: notifications.dedupeKey,
        set: {
          subject: content.subject,
          html: content.html,
          textBody: content.textBody,
          items: content.items,
          status: "pending",
          attempts: 0,
          messageId: null,
          error: null,
          sentAt: null,
        },
        setWhere: eq(notifications.status, "cancelled"),
      });
  }
  await reconcileLotNotices({ now, includeFirstDigest: true });
}
export async function sendPending() {
  await queueOutstandingChanges();
  const db = getDb();
  const pending = await db
    .select()
    .from(notifications)
    .where(eq(notifications.status, "pending"));
  for (const notification of pending) {
    if (!notification.items.length) {
      await db
        .update(notifications)
        .set({ status: "cancelled", error: "Riepilogo privo di pubblicazioni" })
        .where(
          and(
            eq(notifications.id, notification.id),
            eq(notifications.status, "pending"),
          ),
        );
      continue;
    }
    const claim = await claimLotNotification(notification.id);
    if (claim) await deliverLotNotification(claim.notification, claim.to);
  }
}
export async function recoverUncertainDeliveries() {
  const recovered = await getDb()
    .update(notifications)
    .set({
      status: "uncertain",
      error:
        "Processo interrotto durante l’invio. Verificare SMTP prima di riprovare.",
    })
    .where(eq(notifications.status, "sending"))
    .returning();
  for (const n of recovered)
    await getDb()
      .insert(issues)
      .values({
        id: crypto.randomUUID(),
        key: `email:${n.id}`,
        title: "Esito email incerto dopo una ripartenza",
        detail:
          "Confrontare il registro SMTP prima di autorizzare un altro invio.",
        severity: "critical",
      })
      .onConflictDoNothing();
}

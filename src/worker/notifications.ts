import { DateTime } from "luxon";
import { and, eq, isNull, lte, sql, desc, inArray, or } from "drizzle-orm";
import { getDb } from "@/db";
import {
  companies,
  invitations,
  user,
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
import {
  sameSourceReviewDependency,
  sourceReviewBindingState,
  sourceReviewBlocksComparison,
} from "@/lib/source-review-policy";
import {
  hasSourceScopeReview,
  isMatchRevisionCurrent,
} from "@/lib/source-scope-review";
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
export async function queueChangeNotices(
  before: Publication,
  after: Publication,
  onlyCompanyId?: string,
) {
  const db = getDb();
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
      .where(eq(companies.id, companyId));
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
  const all = await db.select().from(publications);
  const byId = new Map(all.map((p) => [p.id, p]));
  const seen = new Set<string>();
  for (const notification of sent)
    for (const item of notification.items) {
      const publication = byId.get(item.id);
      if (!publication) continue;
      const key = `${notification.companyId}:${publication.canonicalId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const current = all
        .filter(
          (p) =>
            p.canonicalId === publication.canonicalId && p.status !== "closed",
        )
        .sort(
          (a, b) =>
            Number(a.source !== "simap") - Number(b.source !== "simap") ||
            new Date(b.data.publishedAt).getTime() -
              new Date(a.data.publishedAt).getTime() ||
            b.updatedAt.getTime() - a.updatedAt.getTime(),
        )[0];
      if (!current || current.data.revision === item.revision) continue;
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
}
export async function queueDigests(now = new Date()) {
  if (!digestDue(now)) return;
  const db = getDb();
  const [autoSetting] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "automation_enabled"));
  const automatic = autoSetting?.value === true;
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
    .where(isNull(companies.disabledAt));
  for (const firm of firms) {
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
    const selected = all.filter((r) => {
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
      if (sent.has(r.p.id) || seen.has(r.p.canonicalId) || r.f?.dismissed)
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
}
export async function sendPending() {
  await queueOutstandingChanges();
  const db = getDb();
  const pending = await db
    .select()
    .from(notifications)
    .where(eq(notifications.status, "pending"));
  for (const n of pending) {
    if (!n.items.length) {
      await db
        .update(notifications)
        .set({ status: "cancelled", error: "Riepilogo privo di pubblicazioni" })
        .where(eq(notifications.id, n.id));
      continue;
    }
    const [owner] = await db
      .select({ company: companies, user, invite: invitations })
      .from(companies)
      .innerJoin(user, eq(user.id, companies.ownerId))
      .innerJoin(invitations, eq(invitations.companyId, companies.id))
      .where(eq(companies.id, n.companyId));
    if (
      !owner ||
      owner.company.disabledAt ||
      owner.invite.revokedAt ||
      !owner.company.profile.emailEnabled
    ) {
      await db
        .update(notifications)
        .set({ status: "cancelled" })
        .where(eq(notifications.id, n.id));
      continue;
    }
    const referenced = await db
      .select()
      .from(publications)
      .where(
        sql`${publications.id} in (${sql.join(
          n.items.map((i) => sql`${i.id}`),
          sql`,`,
        )})`,
      );
    const referencedReviews = await readSourceReviewContexts(db, referenced);
    if (n.kind === "change") {
      const relatedIssue = await db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            isNull(issues.resolvedAt),
            eq(issues.severity, "critical"),
            or(
              inArray(
                issues.publicationId,
                n.items.map((i) => i.id),
              ),
              inArray(
                issues.key,
                referenced.map((p) => `conflict:${p.canonicalId}`),
              ),
            ),
          ),
        )
        .limit(1);
      if (
        referenced.some(
          (p) =>
            p.data.reviewRequired ||
            hasSourceScopeReview(p.data) ||
            sourceReviewBlocksComparison(referencedReviews.get(p.id) ?? null),
        ) ||
        relatedIssue.length
      )
        continue;
    }
    if (n.kind === "digest") {
      const dismissed = await db
        .select({ id: feedback.id })
        .from(feedback)
        .where(
          and(
            eq(feedback.companyId, n.companyId),
            eq(feedback.dismissed, true),
            sql`${feedback.publicationId} in (${sql.join(
              n.items.map((i) => sql`${i.id}`),
              sql`,`,
            )})`,
          ),
        )
        .limit(1);
      if (dismissed.length) {
        await db
          .update(notifications)
          .set({
            status: "cancelled",
            error: "Opportunità esclusa prima dell’invio",
          })
          .where(eq(notifications.id, n.id));
        continue;
      }
      const blocking = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.severity, "critical"), isNull(issues.resolvedAt)))
        .limit(1);
      if (blocking.length) continue;
      const [auto] = await db
        .select()
        .from(settings)
        .where(eq(settings.key, "automation_enabled"));
      const currentMatches = await db
        .select()
        .from(matches)
        .where(
          and(
            eq(matches.companyId, n.companyId),
            sql`${matches.publicationId} in (${sql.join(
              n.items.map((i) => sql`${i.id}`),
              sql`,`,
            )})`,
          ),
        );
      const withdrawn =
        currentMatches.length !== n.items.length ||
        currentMatches.some(
          (m) =>
            ["blocked", "stale"].includes(
              sourceReviewBindingState(
                referencedReviews.get(m.publicationId) ?? null,
                m.sourceReviewDependency,
              ),
            ) ||
            !m.eligible ||
            referenced.some(
              (p) =>
                p.id === m.publicationId &&
                activityReviewBlocksAutomatic(
                  m,
                  preliminaryMatch(p.data, owner.company.profile),
                  {
                    publication: p.data,
                    profileRevision: fingerprint(owner.company.profile),
                  },
                ),
            ) ||
            (!!referencedReviews.get(m.publicationId) &&
              (m.approved !== true || !m.reviewedAt)) ||
            referenced.some(
              (p) =>
                p.id === m.publicationId &&
                referencedReviews.get(p.id) &&
                !preliminaryMatch(p.data, owner.company.profile).eligible,
            ) ||
            m.approved === false ||
            (m.approved !== true &&
              (!auto?.value || m.score < 80 || m.reviewNotes)) ||
            referenced.some(
              (p) =>
                p.id === m.publicationId &&
                (p.data.sourceScopeReview || referencedReviews.get(p.id)) &&
                !isMatchRevisionCurrent({
                  revision: m.revision,
                  publication: p.data,
                  profileRevision: fingerprint(owner.company.profile),
                  manuallyReviewed: Boolean(m.reviewedAt),
                }),
            ),
        );
      if (withdrawn) {
        await db
          .update(notifications)
          .set({
            status: "cancelled",
            error: "Approvazione ritirata prima dell’invio",
          })
          .where(eq(notifications.id, n.id));
        continue;
      }
    }
    if (referenced.some((p) => new Date(p.visibleAt) > new Date())) continue;
    if (
      referenced.length !== n.items.length ||
      referenced.some(
        (p) =>
          (p.source === "foglio-ti" &&
            process.env.FOGLIO_REUSE_CONFIRMED !== "true") ||
          p.status === "closed" ||
          (n.kind === "digest" &&
            (p.status !== "open" ||
              (p.deadline && p.deadline <= new Date()) ||
              p.data.reviewRequired ||
              hasSourceScopeReview(p.data) ||
              sourceReviewBlocksComparison(
                referencedReviews.get(p.id) ?? null,
              ) ||
              !sameSourceReviewDependency(
                n.items.find((i) => i.id === p.id)?.sourceReviewDependency,
                referencedReviews.get(p.id)?.dependency,
              ) ||
              n.items.find((i) => i.id === p.id)?.sourceScopeToken !==
                p.data.sourceScopeReview?.token)) ||
          !n.items.some((i) => i.id === p.id && i.revision === p.data.revision),
      )
    ) {
      await db
        .update(notifications)
        .set({
          status: "cancelled",
          error: "Bando modificato prima dell’invio: riepilogo da ricalcolare",
        })
        .where(eq(notifications.id, n.id));
      continue;
    }
    const claimed = await db.transaction(async (tx) => {
      // Marking a source review takes an update lock on these same rows.
      // Recheck under the lock: the preliminary reads above may be stale.
      // Once this transaction claims an email, its SMTP delivery has started
      // and a later review cannot recall it.
      const currentSources = await tx
        .select()
        .from(publications)
        .where(
          inArray(
            publications.id,
            n.items.map((i) => i.id),
          ),
        )
        .orderBy(publications.id)
        .for("share");
      const currentReviews = await readSourceReviewContexts(tx, currentSources);
      if (
        currentSources.length !== n.items.length ||
        currentSources.some((p) => {
          const item = n.items.find((i) => i.id === p.id);
          return (
            !item ||
            p.data.revision !== item.revision ||
            p.data.reviewRequired ||
            hasSourceScopeReview(p.data) ||
            sourceReviewBlocksComparison(currentReviews.get(p.id) ?? null) ||
            (n.kind === "digest" &&
              (item.sourceScopeToken !== p.data.sourceScopeReview?.token ||
                !sameSourceReviewDependency(
                  item.sourceReviewDependency,
                  currentReviews.get(p.id)?.dependency,
                )))
          );
        })
      )
        return null;
      if (n.kind === "digest") {
        // Manual review uses the same source → match lock order. A rejection
        // committed before this claim must also stop the prepared digest.
        const finalMatches = await tx
          .select()
          .from(matches)
          .where(
            and(
              eq(matches.companyId, n.companyId),
              inArray(
                matches.publicationId,
                n.items.map((i) => i.id),
              ),
            ),
          )
          .orderBy(matches.id)
          .for("share");
        const [finalAutomation] = await tx
          .select()
          .from(settings)
          .where(eq(settings.key, "automation_enabled"))
          .for("share");
        if (
          finalMatches.length !== n.items.length ||
          finalMatches.some(
            (m) =>
              ["blocked", "stale"].includes(
                sourceReviewBindingState(
                  currentReviews.get(m.publicationId) ?? null,
                  m.sourceReviewDependency,
                ),
              ) ||
              !m.eligible ||
              currentSources.some(
                (p) =>
                  p.id === m.publicationId &&
                  activityReviewBlocksAutomatic(
                    m,
                    preliminaryMatch(p.data, owner.company.profile),
                    {
                      publication: p.data,
                      profileRevision: fingerprint(owner.company.profile),
                    },
                  ),
              ) ||
              (!!currentReviews.get(m.publicationId) &&
                (m.approved !== true || !m.reviewedAt)) ||
              currentSources.some(
                (p) =>
                  p.id === m.publicationId &&
                  currentReviews.get(p.id) &&
                  !preliminaryMatch(p.data, owner.company.profile).eligible,
              ) ||
              m.approved === false ||
              (m.approved !== true &&
                (finalAutomation?.value !== true ||
                  m.score < 80 ||
                  m.reviewNotes)) ||
              currentSources.some(
                (p) =>
                  p.id === m.publicationId &&
                  (p.data.sourceScopeReview || currentReviews.get(p.id)) &&
                  !isMatchRevisionCurrent({
                    revision: m.revision,
                    publication: p.data,
                    profileRevision: fingerprint(owner.company.profile),
                    manuallyReviewed: Boolean(m.reviewedAt),
                  }),
              ),
          )
        )
          return null;
      }
      const [claimed] = await tx
        .update(notifications)
        .set({
          status: "sending",
          attempts: sql`${notifications.attempts}+1`,
          messageId: `<${n.id}@${new URL(appUrl()).hostname}>`,
        })
        .where(
          and(eq(notifications.id, n.id), eq(notifications.status, "pending")),
        )
        .returning();
      return claimed ?? null;
    });
    if (!claimed) continue;
    try {
      const result = await sendMail({
        to: owner.user.email,
        subject: n.subject,
        html: n.html,
        text: n.textBody,
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
        .where(eq(notifications.id, n.id));
    } catch (e) {
      const state = deliveryFailureKind(e);
      const permanent =
        (e as { responseCode?: number }).responseCode! >= 500 ||
        (e as { code?: string }).code === "EAUTH";
      const retry = state === "failed" && !permanent && claimed.attempts < 3;
      await db
        .update(notifications)
        .set({
          status: retry ? "pending" : state,
          error: e instanceof Error ? e.message.slice(0, 300) : "Errore SMTP",
        })
        .where(eq(notifications.id, n.id));
      if (!retry)
        await db
          .insert(issues)
          .values({
            id: crypto.randomUUID(),
            key: `email:${n.id}`,
            title:
              state === "uncertain"
                ? "Esito email incerto"
                : "Email non inviata",
            detail:
              "Controllare il registro SMTP prima di autorizzare un nuovo invio.",
            severity: "critical",
          })
          .onConflictDoNothing();
    }
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

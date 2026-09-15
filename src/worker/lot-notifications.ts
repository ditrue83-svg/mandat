import { and, eq, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  companies,
  feedback,
  invitations,
  issues,
  matches,
  notifications,
  publications,
  publicationDocumentarySnapshots,
  settings,
  user,
} from "@/db/schema";
import {
  readLotMatchReview,
  type LoadedLotMatchReview,
} from "@/lib/lot-match-reviews";
import { captureLotSourceSnapshot } from "@/lib/lot-source-context";
import {
  assessmentTargetKey,
  sameAssessmentTarget,
} from "@/lib/lot-assessment";
import { decodeDocumentarySnapshotRow } from "@/lib/documentary-store";
import {
  buildLotNotice,
  lotNoticeHash,
  lotNoticeScope,
  lotNoticeScopeShape,
  requireLotNoticeHistory,
  validateLotNotice,
  type LotNotice,
  type LotNoticeScope,
} from "@/lib/lot-notice";
import {
  renderLotNoticeContent,
  renderDigestContent,
  renderChangeContent,
} from "@/lib/notification-content";
import { appUrl } from "@/lib/config";
import { zurichDigestDay, preliminaryMatch } from "@/lib/matching";
import {
  compareCanonicalPublications,
  sourceAvailable,
} from "@/lib/canonical-publication";
import { readSourceReviewContexts } from "@/lib/source-reviews";
import {
  sourceReviewBindingState,
  sameSourceReviewDependency,
  sourceReviewBlocksComparison,
} from "@/lib/source-review-policy";
import { activityReviewBlocksAutomatic } from "@/lib/cpv-service-signals";
import { fingerprint } from "@/sources/common";
import {
  hasSourceScopeReview,
  isMatchRevisionCurrent,
} from "@/lib/source-scope-review";
import { presentMatch } from "@/lib/match-presentation";
import { readCanonicalFeedback } from "@/lib/canonical-feedback";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
type Notification = typeof notifications.$inferSelect;
type Source = typeof publications.$inferSelect;
const reserved = new Set([
  "pending",
  "sending",
  "sent",
  "uncertain",
  "failed",
  "discarded",
]);
const targetKey = (scope: LotNoticeScope) => assessmentTargetKey(scope.target);
const inFlight = new Set(["pending", "sending", "uncertain", "failed"]);
// Delivery order is metadata used to locate the last communicated state; it
// never enters factHash or the content transition chain. UUID is only a final
// deterministic tie-break when both recorded delivery/creation times coincide.
function lastCommunicatedTargets(rows: Notification[], canonicalId: string) {
  const last = new Map<string, LotNoticeScope>();
  const sent = rows
    .filter((row) => row.status === "sent")
    .sort(
      (a, b) =>
        (a.sentAt ?? a.createdAt).getTime() -
          (b.sentAt ?? b.createdAt).getTime() ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
  for (const row of sent)
    for (const item of row.items) {
      const notice = item.lotNotice;
      if (!notice || notice.canonicalId !== canonicalId) continue;
      validateLotNotice(notice);
      for (const scope of notice.scope) {
        const prior = last.get(targetKey(scope));
        if (scope.transition.predecessor !== (prior?.transition.hash ?? null))
          throw new Error(
            "Historical lot notification transition chain is inconsistent",
          );
        last.set(targetKey(scope), scope);
      }
    }
  return last;
}
const subjectFor = (notices: LotNotice[], count = notices.length) =>
  notices.some((n) => n.kind === "update")
    ? `Aggiornamento: ${notices[0].renderSnapshot.title}`
    : `Il tuo Radar: ${count} opportunità da scoprire`;

// Lock every observed group before any source, company, match or outbox row.
// Membership is re-read after the advisory locks; a moved source aborts rather
// than adding another lock out of order. Import/feedback/reviews use this key.
async function lockContext(tx: Tx, companyId: string, referenceIds?: string[]) {
  const observed = await tx
    .select({ id: publications.id, canonicalId: publications.canonicalId })
    .from(publications)
    .innerJoin(matches, eq(matches.publicationId, publications.id))
    .where(
      and(
        eq(matches.companyId, companyId),
        referenceIds ? inArray(publications.id, referenceIds) : undefined,
      ),
    );
  const keys = [...new Set(observed.map((p) => p.canonicalId))].sort();
  for (const key of keys)
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`mandat-canonical:${key}`},0))`,
    );
  const sources = keys.length
    ? await tx
        .select()
        .from(publications)
        .where(inArray(publications.canonicalId, keys))
        .orderBy(publications.id)
        .for("share")
    : [];
  if (
    observed.some(
      (p) =>
        !sources.some((s) => s.id === p.id && s.canonicalId === p.canonicalId),
    )
  )
    throw new Error("Canonical notice membership changed");
  const [company] = await tx
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
    .for("share");
  const matchRows = sources.length
    ? await tx
        .select()
        .from(matches)
        .where(
          and(
            eq(matches.companyId, companyId),
            inArray(
              matches.publicationId,
              sources.map((p) => p.id),
            ),
          ),
        )
        .orderBy(matches.id)
        .for("share")
    : [];
  const feedbackRows = sources.length
    ? await tx
        .select()
        .from(feedback)
        .where(
          and(
            eq(feedback.companyId, companyId),
            inArray(
              feedback.publicationId,
              sources.map((p) => p.id),
            ),
          ),
        )
        .orderBy(feedback.id)
        .for("share")
    : [];
  const [automatic] = await tx
    .select()
    .from(settings)
    .where(eq(settings.key, "automation_enabled"))
    .for("share");
  const canonicalFeedback = new Map<
    string,
    { saved: boolean; dismissed: boolean }
  >();
  for (const key of keys)
    canonicalFeedback.set(key, await readCanonicalFeedback(tx, companyId, key));
  const critical = await tx
    .select({
      id: issues.id,
      key: issues.key,
      publicationId: issues.publicationId,
    })
    .from(issues)
    .where(and(eq(issues.severity, "critical"), isNull(issues.resolvedAt)));
  return {
    sources,
    company,
    matchRows,
    feedbackRows,
    automatic: automatic?.value === true,
    canonicalFeedback,
    critical: critical.length > 0,
    criticalIssues: critical,
  };
}
type Context = Awaited<ReturnType<typeof lockContext>>;
function dismissed(context: Context, canonicalId: string) {
  return context.canonicalFeedback.get(canonicalId)?.dismissed ?? false;
}
async function loadAll(tx: Tx, context: Context, now: Date) {
  const loaded = new Map<string, LoadedLotMatchReview>();
  if (!context.company) return loaded;
  for (const source of context.sources) {
    const match = context.matchRows.find((m) => m.publicationId === source.id);
    if (source.documentarySnapshotId && match)
      loaded.set(
        source.id,
        await readLotMatchReview(tx, source, context.company, match, now),
      );
  }
  return loaded;
}
async function attachHistory(
  tx: Tx,
  loaded: LoadedLotMatchReview,
  notices: LotNotice[],
) {
  const ids = [
    ...new Set(
      notices.flatMap((n) =>
        n.scope.flatMap((s) => [
          s.immutableEvidenceSnapshotId,
          ...(s.structure ? [s.structure.previousEvidenceSnapshotId] : []),
        ]),
      ),
    ),
  ];
  const rows = ids.length
    ? await tx
        .select()
        .from(publicationDocumentarySnapshots)
        .where(inArray(publicationDocumentarySnapshots.id, ids))
    : [];
  const additional = rows.map((row) => {
    const decoded = decodeDocumentarySnapshotRow(row, loaded.publication.id);
    if (decoded.acquisition.state !== "accepted")
      throw new Error("Historical notice archive was refused");
    return captureLotSourceSnapshot({
      publicationId: loaded.publication.id,
      observationId: row.id,
      sourceScopeReview: null,
      acquisition: { state: "accepted", archive: decoded.acquisition.archive },
    });
  });
  const withHistory = {
    ...loaded,
    input: {
      ...loaded.input,
      evidenceSnapshots: [
        ...(loaded.input.evidenceSnapshots ?? []),
        ...additional,
      ],
    },
  };
  for (const notice of notices) requireLotNoticeHistory(withHistory, notice);
  return withHistory;
}
function relatedItems(
  rows: Notification[],
  sources: Source[],
  canonicalId: string,
) {
  const members = new Set(
    sources.filter((p) => p.canonicalId === canonicalId).map((p) => p.id),
  );
  return rows.flatMap((row) =>
    row.items
      .filter(
        (item) =>
          members.has(item.id) || item.lotNotice?.canonicalId === canonicalId,
      )
      .map((item) => ({ row, item })),
  );
}
async function recordHistoryIssue(
  tx: Tx,
  companyId: string,
  publicationId: string,
  detail: string,
) {
  await tx
    .insert(issues)
    .values({
      id: crypto.randomUUID(),
      key: `lot-notice-history:${companyId}:${publicationId}`,
      title: "Storico dei lotti da verificare",
      detail: detail.slice(0, 500),
      publicationId,
      severity: "critical",
    })
    .onConflictDoNothing();
}
function canNotify(loaded: LoadedLotMatchReview, context: Context, now: Date) {
  return (
    loaded.input.snapshot.acquisition.state === "accepted" &&
    !loaded.input.shapeState.error &&
    !loaded.project.suppressed &&
    !dismissed(context, loaded.publication.canonicalId) &&
    new Date(loaded.publication.visibleAt) <= now
  );
}
function rebuildNotice(
  loaded: LoadedLotMatchReview,
  original: LotNotice,
  automatic: boolean,
): LotNotice {
  validateLotNotice(original);
  if (
    original.binding.companyId !== loaded.company.id ||
    original.canonicalId !== loaded.publication.canonicalId
  )
    throw new Error("Notice belongs to another company or project");
  return buildLotNotice(
    loaded,
    original.scope.map((s) =>
      lotNoticeScope(
        loaded,
        s.target,
        s.kind,
        s.transition.predecessor,
        s.structure?.previousEvidenceSnapshotId ?? null,
      ),
    ),
    original.kind,
    automatic,
  );
}
async function legacyCurrent(
  tx: Tx,
  context: Context,
  item: Notification["items"][number],
  now: Date,
  kind = "digest",
) {
  const source = context.sources.find((p) => p.id === item.id),
    match = context.matchRows.find((m) => m.publicationId === item.id);
  if (
    !source ||
    !context.company ||
    context.sources
      .filter(
        (p) =>
          p.canonicalId === source.canonicalId && sourceAvailable(p.source),
      )
      .sort(compareCanonicalPublications)[0]?.id !== source.id
  )
    return false;
  if (kind === "change") {
    if (
      source.documentarySnapshotId ||
      !sourceAvailable(source.source) ||
      source.status === "closed" ||
      source.visibleAt > now ||
      source.data.revision !== item.revision ||
      source.data.reviewRequired ||
      hasSourceScopeReview(source.data) ||
      dismissed(context, source.canonicalId) ||
      match?.approved === false
    )
      return false;
    const review =
      (await readSourceReviewContexts(tx, [source])).get(source.id) ?? null;
    return !sourceReviewBlocksComparison(review);
  }
  if (
    !source ||
    !match ||
    !context.company ||
    source.documentarySnapshotId ||
    context.sources.some(
      (p) => p.canonicalId === source.canonicalId && p.documentarySnapshotId,
    ) ||
    !sourceAvailable(source.source) ||
    source.status !== "open" ||
    !match.eligible ||
    source.visibleAt > now ||
    (source.deadline && source.deadline <= now) ||
    source.data.revision !== item.revision ||
    source.data.reviewRequired ||
    hasSourceScopeReview(source.data) ||
    dismissed(context, source.canonicalId) ||
    match.approved === false
  )
    return false;
  const review =
    (await readSourceReviewContexts(tx, [source])).get(source.id) ?? null;
  const preliminary = preliminaryMatch(
    source.data,
    context.company.profile,
    now,
  );
  if (
    ["blocked", "stale"].includes(
      sourceReviewBindingState(review, match.sourceReviewDependency),
    ) ||
    activityReviewBlocksAutomatic(match, preliminary, {
      publication: source.data,
      profileRevision: fingerprint(context.company.profile),
    })
  )
    return false;
  if (
    review &&
    (match.approved !== true || !match.reviewedAt || !preliminary.eligible)
  )
    return false;
  if (
    (review || source.data.sourceScopeReview) &&
    !isMatchRevisionCurrent({
      revision: match.revision,
      publication: source.data,
      profileRevision: fingerprint(context.company.profile),
      manuallyReviewed: !!match.reviewedAt,
    })
  )
    return false;
  if (
    !sameSourceReviewDependency(
      item.sourceReviewDependency,
      review?.dependency,
    ) ||
    item.sourceScopeToken !== source.data.sourceScopeReview?.token
  )
    return false;
  return (
    match.approved === true ||
    (context.automatic &&
      match.score >= 80 &&
      !match.reviewNotes &&
      !!source.aiRevision)
  );
}
// A source waiting for clarification remains pending. Once its facts/dependency
// are resolved, the usual current-content check either permits it or cancels it.
async function legacyAwaitingReview(
  tx: Tx,
  context: Context,
  item: Notification["items"][number],
  now: Date,
) {
  const source = context.sources.find((p) => p.id === item.id);
  const match = context.matchRows.find((m) => m.publicationId === item.id);
  if (
    !source ||
    source.documentarySnapshotId ||
    !context.company ||
    dismissed(context, source.canonicalId) ||
    match?.approved === false
  )
    return false;
  if (
    source.visibleAt > now ||
    source.data.reviewRequired ||
    hasSourceScopeReview(source.data)
  )
    return true;
  const review =
    (await readSourceReviewContexts(tx, [source])).get(source.id) ?? null;
  return (
    sourceReviewBlocksComparison(review) ||
    (!!match &&
      activityReviewBlocksAutomatic(
        match,
        preliminaryMatch(source.data, context.company.profile, now),
        {
          publication: source.data,
          profileRevision: fingerprint(context.company.profile),
        },
      ))
  );
}
async function renderItems(
  tx: Tx,
  context: Context,
  items: Notification["items"],
  kind: string,
) {
  if (kind === "change") {
    if (items.length === 1 && !items[0].lotNotice)
      return renderChangeContent(
        context.sources.find((p) => p.id === items[0].id)!.data,
      );
    if (items.some((i) => !i.lotNotice))
      throw new Error("Unsupported mixed change notice");
    return renderLotNoticeContent(
      items.map((i) => i.lotNotice!),
      appUrl(),
    );
  }
  const reviews = await readSourceReviewContexts(
    tx,
    context.sources.filter(
      (p) =>
        !p.documentarySnapshotId &&
        items.some((i) => i.id === p.id && !i.lotNotice),
    ),
  );
  return renderDigestContent(
    items.map((item) => {
      if (item.lotNotice)
        return {
          id: item.id,
          title: item.lotNotice.renderSnapshot.title,
          deadline: null,
          sourceUrl: item.lotNotice.renderSnapshot.sourceUrl,
          reason: "",
          assessment: "reviewed" as const,
          lotNotice: item.lotNotice,
        };
      const source = context.sources.find((p) => p.id === item.id)!,
        match = context.matchRows.find((m) => m.publicationId === item.id)!;
      return {
        id: item.id,
        title: source.title,
        deadline: source.data.deadline,
        sourceUrl: source.data.sourceUrl,
        ...presentMatch({
          match,
          publication: source.data,
          aiRevision: source.aiRevision,
          profileRevision: fingerprint(context.company!.profile),
          sourceReview: reviews.get(item.id) ?? null,
        }),
      };
    }),
    appUrl(),
  );
}
async function storeNotice(
  tx: Tx,
  context: Context,
  companyId: string,
  dedupeKey: string,
  notices: LotNotice[],
  kind: "digest" | "change",
  legacyItems: Notification["items"] = [],
) {
  const items = [
    ...legacyItems,
    ...notices.map((notice) => ({
      id: notice.renderSnapshot.publicationId,
      revision: notice.binding.sourceSnapshotHash,
      lotNotice: notice,
    })),
  ];
  const rendered = await renderItems(tx, context, items, kind);
  const content = {
    companyId,
    dedupeKey,
    kind,
    subject: subjectFor(notices, items.length),
    ...rendered,
    items,
  };
  await tx
    .insert(notifications)
    .values({ id: crypto.randomUUID(), ...content })
    .onConflictDoUpdate({
      target: notifications.dedupeKey,
      set: { ...content, status: "pending", error: null },
      setWhere: eq(notifications.status, "cancelled"),
    });
}

// Durable-job and recovery entrypoint. First opportunities join one company/day
// digest; further relevant lots on a reported project are explicit updates.
export async function reconcileLotNotices(
  options: {
    companyId?: string;
    canonicalId?: string;
    now?: Date;
    includeFirstDigest?: boolean;
  } = {},
) {
  const now = options.now ?? new Date(),
    db = getDb();
  const firms = await db
    .select({ id: companies.id })
    .from(companies)
    .where(
      and(
        isNull(companies.disabledAt),
        options.companyId ? eq(companies.id, options.companyId) : undefined,
      ),
    );
  for (const { id: companyId } of firms) {
    // With neither a documentary evaluation nor any notification history there
    // is nothing to prepare or invalidate. Avoid locking/loading every source
    // during initial adoption. A later review commits its own durable job.
    // Any history (even without remaining evaluations) keeps recovery active.
    const [adopted] = await db
      .select({ id: publications.id })
      .from(publications)
      .innerJoin(matches, eq(matches.publicationId, publications.id))
      .where(
        and(
          eq(matches.companyId, companyId),
          sql`${publications.documentarySnapshotId} is not null`,
          or(
            isNotNull(matches.lotEvaluations),
            sql`exists (select 1 from ${notifications} where ${notifications.companyId} = ${companyId})`,
          ),
        ),
      )
      .limit(1);
    if (!adopted) continue;
    await db.transaction(async (tx) => {
      const context = await lockContext(tx, companyId);
      if (
        !context.company?.profile.emailEnabled ||
        !context.company.onboardedAt
      )
        return;
      const all = await loadAll(tx, context, now);
      let previous = await tx
        .select()
        .from(notifications)
        .where(eq(notifications.companyId, companyId))
        .orderBy(notifications.id)
        .for("update");
      // A stale pending email cannot reserve A forever. Cancel without replacing
      // its rendered scope; the same content key may be rebuilt below if eligible.
      for (const row of previous.filter(
        (n) => n.status === "pending" && n.items.some((i) => i.lotNotice),
      )) {
        let current = true;
        for (const item of row.items) {
          if (!item.lotNotice) {
            if (!(await legacyCurrent(tx, context, item, now))) current = false;
            continue;
          }
          let loaded = all.get(item.id);
          try {
            if (loaded)
              loaded = await attachHistory(tx, loaded, [item.lotNotice]);
            const communicated = lastCommunicatedTargets(
              previous,
              item.lotNotice.canonicalId,
            );
            if (
              !item.lotNotice ||
              !loaded ||
              !canNotify(loaded, context, now) ||
              item.lotNotice.scope.some(
                (scope) =>
                  scope.transition.predecessor !==
                  (communicated.get(targetKey(scope))?.transition.hash ?? null),
              ) ||
              lotNoticeHash(
                rebuildNotice(loaded, item.lotNotice, context.automatic),
              ) !== lotNoticeHash(item.lotNotice)
            )
              current = false;
          } catch {
            current = false;
          }
        }
        if (!current) {
          await tx
            .update(notifications)
            .set({
              status: "cancelled",
              error:
                "Fonte, profilo o lotti cambiati: contenuto da ripreparare.",
            })
            .where(
              and(
                eq(notifications.id, row.id),
                eq(notifications.status, "pending"),
              ),
            );
          row.status = "cancelled";
        }
      }
      const first: LotNotice[] = [];
      const groups = [
        ...new Set(
          context.sources
            .filter((p) => p.documentarySnapshotId)
            .map((p) => p.canonicalId),
        ),
      ].sort();
      for (const canonicalId of groups) {
        const representativeSource = context.sources
          .filter(
            (p) => p.canonicalId === canonicalId && sourceAvailable(p.source),
          )
          .sort(compareCanonicalPublications)[0];
        let representative = representativeSource
          ? all.get(representativeSource.id)
          : null;
        if (!representative || !canNotify(representative, context, now))
          continue;
        if (
          context.criticalIssues.some(
            (issue) =>
              issue.key === `conflict:${canonicalId}` ||
              context.sources.some(
                (source) =>
                  source.canonicalId === canonicalId &&
                  issue.publicationId === source.id,
              ),
          )
        )
          continue;
        const related = relatedItems(previous, context.sources, canonicalId);
        let previouslySentTargets: Map<string, LotNoticeScope>;
        try {
          for (const loaded of [...all.values()]) {
            const old = related
              .filter(
                ({ item }) =>
                  item.id === loaded.publication.id && item.lotNotice,
              )
              .map(({ item }) => item.lotNotice!);
            if (old.length)
              all.set(
                loaded.publication.id,
                await attachHistory(tx, loaded, old),
              );
          }
          representative = all.get(representative.publication.id)!;
          previouslySentTargets = lastCommunicatedTargets(
            previous,
            canonicalId,
          );
        } catch (error) {
          await recordHistoryIssue(
            tx,
            companyId,
            representative.publication.id,
            error instanceof Error ? error.message : "Storico incompleto",
          );
          continue;
        }
        const reservedTargets = new Set(
          related
            .filter(({ row }) => inFlight.has(row.status))
            .flatMap(({ item }) => item.lotNotice?.scope ?? [])
            .map(targetKey),
        );
        const discardedTransitions = new Set(
          related
            .filter(({ row }) => row.status === "discarded")
            .flatMap(({ item }) => item.lotNotice?.scope ?? [])
            .map((scope) => scope.transition.hash),
        );
        const communicated = related.filter(({ row }) => row.status === "sent");
        const alreadyProject = related.some(({ row }) =>
          reserved.has(row.status),
        );
        const newScopes = representative.project.targets
          .filter((l) => l.signalEligible)
          .map((l) =>
            lotNoticeScope(
              representative,
              l.target,
              "positive",
              previouslySentTargets.get(assessmentTargetKey(l.target))
                ?.transition.hash ?? null,
            ),
          )
          .filter(
            (scope) =>
              !reservedTargets.has(targetKey(scope)) &&
              !discardedTransitions.has(scope.transition.hash) &&
              (previouslySentTargets.get(targetKey(scope))?.factHash !==
                scope.factHash ||
                previouslySentTargets.get(targetKey(scope))?.kind !==
                  "positive"),
          );
        // Only previously sent targets receive source-change alerts. A v1 sent
        // item establishes the project, never an invented list of reported lots.
        for (const prior of previouslySentTargets.values()) {
          if (
            prior.target.publicationId !== representative.publication.id ||
            newScopes.some((s) => targetKey(s) === targetKey(prior))
          )
            continue;
          const existing = representative.project.targets.find(
            (l) =>
              sameAssessmentTarget(l.target, prior.target) &&
              l.state !== "removed-or-unresolved",
          );
          const structureChanged =
            representative.project.shape.kind !==
            lotNoticeScopeShape(representative, prior);
          // The earlier target has already been reported as replaced by this
          // structure. Unrelated edits do not create a second removal notice.
          if (
            !structureChanged &&
            !existing &&
            prior.kind === "structure_changed"
          )
            continue;
          const current = lotNoticeScope(
            representative,
            prior.target,
            structureChanged
              ? "structure_changed"
              : existing
                ? "changed"
                : "removed",
            prior.transition.hash,
            structureChanged ? prior.immutableEvidenceSnapshotId : null,
          );
          if (
            current.factHash !== prior.factHash &&
            !reservedTargets.has(targetKey(current)) &&
            !discardedTransitions.has(current.transition.hash)
          )
            newScopes.push(current);
        }
        if (!newScopes.length) continue;
        if (!alreadyProject) {
          if (options.includeFirstDigest && !context.critical)
            first.push(
              buildLotNotice(
                representative,
                newScopes.filter((s) => s.kind === "positive"),
                "opportunity",
                context.automatic,
              ),
            );
        } else if (communicated.length) {
          const notice = buildLotNotice(
            representative,
            newScopes,
            "update",
            context.automatic,
          );
          await storeNotice(
            tx,
            context,
            companyId,
            `lot-change-v1:${companyId}:${canonicalId}:${notice.noveltyHash}`,
            [notice],
            "change",
          );
        }
      }
      if (options.includeFirstDigest) {
        const key = `digest:${companyId}:${zurichDigestDay(now)}`;
        const daily = previous.find((n) => n.dedupeKey === key);
        if (daily?.status === "pending") {
          // Retain projects already reserved in this pending daily digest while
          // adding another new project. Both old and new groups are locked above.
          const combined = [
            ...daily.items,
            ...first.map((lotNotice) => ({
              id: lotNotice.renderSnapshot.publicationId,
              revision: lotNotice.binding.sourceSnapshotHash,
              lotNotice,
            })),
          ];
          if (first.length) {
            const content = await renderItems(tx, context, combined, "digest");
            await tx
              .update(notifications)
              .set({
                ...content,
                subject: subjectFor([], combined.length),
                items: combined,
              })
              .where(
                and(
                  eq(notifications.id, daily.id),
                  eq(notifications.status, "pending"),
                ),
              );
          }
        } else if (first.length && (!daily || daily.status === "cancelled")) {
          const retained: Notification["items"] = [];
          for (const item of daily?.items ?? [])
            if (
              !item.lotNotice &&
              (await legacyCurrent(tx, context, item, now))
            )
              retained.push(item);
          await storeNotice(
            tx,
            context,
            companyId,
            key,
            first,
            "digest",
            retained,
          );
        }
      }
    });
  }
}

export async function claimLotNotification(id: string, now = new Date()) {
  const db = getDb();
  const [observed] = await db
    .select()
    .from(notifications)
    .where(eq(notifications.id, id));
  if (!observed?.items.length) return null;
  // Keep the existing distinction between a known withdrawn activity judgment
  // and one that changed during the final locked claim: the latter is held.
  const legacyIds = observed.items.filter((i) => !i.lotNotice).map((i) => i.id);
  if (observed.kind === "digest" && legacyIds.length) {
    const initial = await db
      .select({ source: publications, match: matches, company: companies })
      .from(publications)
      .innerJoin(
        matches,
        and(
          eq(matches.publicationId, publications.id),
          eq(matches.companyId, observed.companyId),
        ),
      )
      .innerJoin(companies, eq(companies.id, matches.companyId))
      .where(inArray(publications.id, legacyIds));
    if (
      initial.some(
        ({ source, match, company }) =>
          !source.documentarySnapshotId &&
          activityReviewBlocksAutomatic(
            match,
            preliminaryMatch(source.data, company.profile, now),
            {
              publication: source.data,
              profileRevision: fingerprint(company.profile),
            },
          ),
      )
    ) {
      await db
        .update(notifications)
        .set({
          status: "cancelled",
          error: "Valutazione dell’attività da aggiornare prima dell’invio.",
        })
        .where(
          and(eq(notifications.id, id), eq(notifications.status, "pending")),
        );
      return null;
    }
  }
  return db.transaction(async (tx) => {
    const context = await lockContext(
      tx,
      observed.companyId,
      observed.items.map((i) => i.id),
    );
    const all = await loadAll(tx, context, now);
    const [owner] = context.company
      ? await tx
          .select()
          .from(user)
          .where(eq(user.id, context.company.ownerId))
          .for("share")
      : [];
    const [invite] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.companyId, observed.companyId))
      .for("share");
    const companyNotices = await tx
      .select()
      .from(notifications)
      .where(eq(notifications.companyId, observed.companyId))
      .orderBy(notifications.id)
      .for("update");
    const notification = companyNotices.find((row) => row.id === id);
    if (!notification || notification.status !== "pending") return null;
    if (
      notification.kind === "digest"
        ? context.critical
        : context.criticalIssues.some((issue) =>
            context.sources.some(
              (source) =>
                issue.publicationId === source.id ||
                issue.key === `conflict:${source.canonicalId}`,
            ),
          )
    )
      return null;
    let valid =
      !!owner &&
      !!invite &&
      !invite.revokedAt &&
      !!context.company?.profile.emailEnabled &&
      !context.company.disabledAt;
    const current: LotNotice[] = [];
    try {
      if (
        notification.companyId !== observed.companyId ||
        notification.items.length !== observed.items.length
      )
        valid = false;
      for (const item of notification.items) {
        if (!item.lotNotice) {
          if (await legacyAwaitingReview(tx, context, item, now)) return null;
          if (!(await legacyCurrent(tx, context, item, now, notification.kind)))
            valid = false;
          continue;
        }
        let loaded = all.get(item.id);
        if (!item.lotNotice || !loaded || !canNotify(loaded, context, now)) {
          valid = false;
          break;
        }
        const representative = context.sources
          .filter(
            (p) =>
              p.canonicalId === item.lotNotice!.canonicalId &&
              sourceAvailable(p.source),
          )
          .sort(compareCanonicalPublications)[0];
        if (representative?.id !== item.id) {
          valid = false;
          break;
        }
        loaded = await attachHistory(tx, loaded, [item.lotNotice]);
        const communicated = lastCommunicatedTargets(
          companyNotices,
          item.lotNotice.canonicalId,
        );
        if (
          item.lotNotice.scope.some(
            (scope) =>
              scope.transition.predecessor !==
              (communicated.get(targetKey(scope))?.transition.hash ?? null),
          )
        )
          valid = false;
        // An unresolved older delivery reserves the target even if the current
        // source has moved on. Only its explicit outcome may advance the chain.
        if (
          companyNotices.some(
            (row) =>
              row.id !== id &&
              inFlight.has(row.status) &&
              row.items.some((other) =>
                other.lotNotice?.scope.some((scope) =>
                  item.lotNotice!.scope.some(
                    (current) => targetKey(current) === targetKey(scope),
                  ),
                ),
              ),
          )
        )
          return null;
        const rebuilt = rebuildNotice(
          loaded,
          item.lotNotice,
          context.automatic,
        );
        if (lotNoticeHash(rebuilt) !== lotNoticeHash(item.lotNotice))
          valid = false;
        current.push(rebuilt);
      }
      if (current.length) {
        const rendered = await renderItems(
          tx,
          context,
          notification.items,
          notification.kind,
        );
        if (
          rendered.html !== notification.html ||
          rendered.textBody !== notification.textBody ||
          subjectFor(current, notification.items.length) !==
            notification.subject
        )
          valid = false;
      }
    } catch (error) {
      valid = false;
      if (
        error instanceof Error &&
        /historical|archive|Historical|Missing immutable/i.test(error.message)
      )
        await recordHistoryIssue(
          tx,
          observed.companyId,
          notification.items[0].id,
          error.message,
        );
    }
    if (!valid) {
      await tx
        .update(notifications)
        .set({
          status: "cancelled",
          error:
            "Invio sospeso: fonte, lotti, profilo, consenso o contenuto non più correnti.",
        })
        .where(eq(notifications.id, id));
      return null;
    }
    const [claimed] = await tx
      .update(notifications)
      .set({
        status: "sending",
        attempts: sql`${notifications.attempts}+1`,
        messageId: `<${id}@${new URL(appUrl()).hostname}>`,
      })
      .where(and(eq(notifications.id, id), eq(notifications.status, "pending")))
      .returning();
    return claimed ? { notification: claimed, to: owner!.email } : null;
  });
}

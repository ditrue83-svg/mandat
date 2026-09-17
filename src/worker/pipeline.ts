import { classificationChanged } from "@/lib/sector-classification";
import {
  and,
  or,
  eq,
  ne,
  isNull,
  isNotNull,
  sql,
  desc,
  getTableColumns,
} from "drizzle-orm";
import { getDb } from "@/db";
import {
  publications,
  publicationVersions,
  sourceRuns,
  issues,
  matches,
  companies,
  feedback,
} from "@/db/schema";
import type { Publication } from "@/lib/domain";
import type { SourceAdapter } from "@/sources/common";
import { fingerprint } from "@/sources/common";
import {
  preliminaryMatch,
  materialChange,
  possibleDuplicate,
} from "@/lib/matching";
import { AiUnavailable, classify, summarize } from "./ai";
import {
  activityReviewForMatch,
  CPV_ACTIVITY_REVIEW_MARKER,
} from "@/lib/cpv-service-signals";
import { queueChangeNotices } from "./notifications";
import { attachFoglioPdf } from "@/sources/foglio";
import { legacySimapRevision, readSimapRefreshEntry } from "@/sources/simap";
import {
  collectSimapDocumentary,
  collectAndAdoptSimapDocumentary,
} from "./documentary-ingestion";
import {
  assertDocumentaryAdoptionActivation,
  type DocumentaryAdoptionActivation,
} from "@/lib/documentary-adoption";
import type { DocumentaryRefreshExpectation } from "@/lib/documentary-store";
import { matchAdoptedPublication } from "./lot-matching";
import { CanonicalMembershipConflict } from "@/lib/canonical-lock";
import {
  hasSourceScopeReview,
  isMatchRevisionCurrent,
  sourceScopeReviewReason,
  sourceScopeReviewSuffix,
} from "@/lib/source-scope-review";
import { readSourceReviewContext } from "@/lib/source-reviews";
import {
  sameSourceReviewDependency,
  sourceReviewReason,
} from "@/lib/source-review-policy";
import { companyAllowsPilotProcessingSql } from "@/lib/pilot-processing";
import { sourceEdition } from "@/lib/source-edition";
// A human source judgment is not an automatic company comparison. Version
// this completed manual-review path so an earlier automatic cache cannot win
// merely because it happens to carry the same documentary dependency.
const HUMAN_SOURCE_REVIEW_VERSION = "human-source-review-v1";
export async function recordIssue(
  key: string,
  title: string,
  detail: string,
  severity = "warning",
  publicationId?: string,
) {
  await getDb()
    .insert(issues)
    .values({
      id: crypto.randomUUID(),
      key,
      title,
      detail: detail.slice(0, 1500),
      severity,
      publicationId,
    })
    .onConflictDoUpdate({
      target: issues.key,
      set: { title, detail: detail.slice(0, 1500), severity, resolvedAt: null },
    });
}
export async function resolveIssue(key: string) {
  await getDb()
    .update(issues)
    .set({ resolvedAt: new Date() })
    .where(eq(issues.key, key));
}
export async function storePublication(
  p: Publication,
  options: { extractDocuments?: boolean } = {},
) {
  const db = getDb();
  const [previous] = await db
    .select()
    .from(publications)
    .where(
      and(
        eq(publications.source, p.source),
        eq(publications.externalId, p.externalId),
      ),
    )
    .limit(1);
  if (previous?.revision === p.revision) return false;
  // A legacy detail response cannot advance an adopted documentary source:
  // it has no matching immutable observation to install with the new content.
  if (previous?.documentarySnapshotId)
    throw new Error(
      "La fonte adottata richiede un aggiornamento documentario completo.",
    );
  if (
    previous &&
    p.source === "simap" &&
    p.revision.startsWith("simap-v2:") &&
    legacySimapRevision(p) === previous.revision
  ) {
    // Exact equality with the old raw-response hash proves this is a format
    // migration, not a source update. Preserve editorial/AI content and matches.
    await db.transaction(async (tx) => {
      const adopted = await tx
        .update(publications)
        .set({ revision: p.revision })
        .where(
          and(
            eq(publications.id, previous.id),
            eq(publications.revision, previous.revision),
            isNull(publications.documentarySnapshotId),
          ),
        )
        .returning({ id: publications.id });
      if (!adopted.length) return;
      await tx
        .insert(publicationVersions)
        .values({
          id: crypto.randomUUID(),
          publicationId: previous.id,
          revision: p.revision,
          data: p,
        })
        .onConflictDoNothing();
    });
    return false;
  }
  if (options.extractDocuments && p.source === "foglio-ti")
    p = await attachFoglioPdf(p);
  const canonicalId = p.canonicalKey || p.id;
  if (p.status === "open") {
    const otherSource = await db
      .select()
      .from(publications)
      .where(
        and(
          ne(publications.source, p.source),
          eq(publications.status, "open"),
          ne(publications.canonicalId, canonicalId),
        ),
      );
    const candidate = otherSource.find((other) =>
      possibleDuplicate(p, other.data),
    );
    if (candidate) {
      p = {
        ...p,
        reviewRequired: true,
        reviewReasons: [
          ...p.reviewReasons,
          "Possibile duplicato: identità della gara da verificare",
        ],
      };
      await recordIssue(
        `duplicate:${p.id}`,
        "Possibile doppia pubblicazione",
        `Confrontare la gara con ${candidate.data.sourceUrl}. Le schede restano separate finché l’identità non è certa.`,
        "warning",
        p.id,
      );
    }
  }
  const cousins = await db
    .select()
    .from(publications)
    .where(
      and(eq(publications.canonicalId, canonicalId), ne(publications.id, p.id)),
    );
  const edition = (value: Publication) => [
    new Date(value.publishedAt).getTime(),
    sourceEdition(value),
  ];
  const newer = (a: Publication, b: Publication) => {
    const x = edition(a),
      y = edition(b);
    return x[0] > y[0] || (x[0] === y[0] && x[1] > y[1]);
  };
  const sameSource = cousins.filter((c) => c.source === p.source);
  const predecessor =
    previous ??
    [...sameSource].sort((a, b) => (newer(a.data, b.data) ? -1 : 1))[0] ??
    cousins[0];
  // Older notices remain inspectable in history, never revive an open opportunity.
  if (sameSource.some((c) => newer(c.data, p))) p = { ...p, status: "closed" };
  const sourceUrls = [
    ...new Set([p.sourceUrl, ...cousins.flatMap((c) => c.data.sourceUrls)]),
  ];
  p = { ...p, sourceUrls };
  if (
    p.status !== "closed" &&
    cousins
      .filter((c) => c.source !== p.source && c.status !== "closed")
      .some(
        (c) =>
          c.status !== p.status ||
          (c.deadline && p.deadline && c.deadline.toISOString() !== p.deadline),
      )
  ) {
    p.reviewRequired = true;
    p.reviewReasons = [
      ...p.reviewReasons,
      "Le fonti riportano stati o scadenze differenti",
    ];
    await recordIssue(
      `conflict:${canonicalId}`,
      "Fonti discordanti",
      p.title,
      "critical",
      p.id,
    );
  }
  await db.transaction(async (tx) => {
    // New publications have no row to lock yet. Serialize their membership and
    // inherited feedback with canonical veto/reopen/claim, including the first
    // member. If an existing publication moves, acquire both groups in order.
    const groups = [
      ...new Set([canonicalId, ...(previous ? [previous.canonicalId] : [])]),
    ].sort();
    for (const group of groups)
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`mandat-canonical:${group}`}, 0))`,
      );
    const currentCousins = await tx
      .select()
      .from(publications)
      .where(
        and(
          eq(publications.canonicalId, canonicalId),
          ne(publications.id, p.id),
        ),
      )
      .orderBy(publications.id)
      .for("update");
    const [currentPublication] = await tx
      .select()
      .from(publications)
      .where(
        and(
          eq(publications.source, p.source),
          eq(publications.externalId, p.externalId),
        ),
      )
      .for("update");
    if (currentPublication && !groups.includes(currentPublication.canonicalId))
      throw new CanonicalMembershipConflict(
        "Il gruppo della pubblicazione è cambiato durante l'importazione.",
      );
    if (currentPublication?.documentarySnapshotId)
      throw new Error(
        "La fonte adottata richiede un aggiornamento documentario completo.",
      );
    // A source update does not prove that a recorded scope doubt is resolved.
    // Read under the lock so a concurrent founder action is not overwritten.
    // Carry it to a newer notice of the same source/project as well. The
    // original sourceRevision remains visible as historical evidence.
    const currentPredecessor =
      currentPublication ??
      [...currentCousins.filter((c) => c.source === p.source)].sort((a, b) =>
        newer(a.data, b.data) ? -1 : 1,
      )[0] ??
      currentCousins[0];
    const priorScope = currentPredecessor?.data.sourceScopeReview;
    if (priorScope?.status === "required")
      p = { ...p, sourceScopeReview: priorScope };
    const currentSourceUrls = [
      ...new Set([
        p.sourceUrl,
        ...currentCousins.flatMap((c) => c.data.sourceUrls),
      ]),
    ];
    p = { ...p, sourceUrls: currentSourceUrls };
    const currentSameSource = currentCousins.filter(
      (c) => c.source === p.source,
    );
    if (currentSameSource.some((c) => newer(c.data, p)))
      p = { ...p, status: "closed" };
    // Another source update or an editorial correction may have committed
    // since cousins were read. Merge links into the current row, never copy
    // its old JSON back over the newer publication or its source links.
    const withSourceUrls = sql<Publication>`${publications.data} || jsonb_build_object(
      'sourceUrls', (
        select jsonb_agg(url order by first_seen)
        from (
          select url, min(position) as first_seen
          from jsonb_array_elements(
            coalesce(${publications.data}->'sourceUrls', '[]'::jsonb)
            || ${JSON.stringify(currentSourceUrls)}::jsonb
          ) with ordinality as links(url, position)
          group by url
        ) as distinct_links
      )
    )`;
    for (const cousin of currentCousins) {
      await tx
        .update(publications)
        .set({ data: withSourceUrls, updatedAt: new Date() })
        .where(eq(publications.id, cousin.id));
    }
    for (const old of currentSameSource.filter((c) => newer(p, c.data))) {
      await tx
        .update(publications)
        .set({
          status: "closed",
          data: sql<Publication>`jsonb_set(${publications.data}, '{status}', '"closed"'::jsonb)`,
        })
        .where(eq(publications.id, old.id));
    }
    await tx
      .insert(publications)
      .values({
        id: p.id,
        canonicalId,
        source: p.source,
        externalId: p.externalId,
        projectId: p.projectId,
        title: p.title,
        status: p.status,
        visibleAt: new Date(p.visibleAt),
        deadline: p.deadline ? new Date(p.deadline) : null,
        data: p,
        revision: p.revision,
      })
      .onConflictDoUpdate({
        target: [publications.source, publications.externalId],
        set: {
          canonicalId,
          title: p.title,
          status: p.status,
          data: p,
          revision: p.revision,
          aiRevision: null,
          deadline: p.deadline ? new Date(p.deadline) : null,
          visibleAt: new Date(p.visibleAt),
          updatedAt: new Date(),
        },
      });
    if (!currentPublication && currentPredecessor) {
      const oldMatches = await tx
        .select()
        .from(matches)
        .where(eq(matches.publicationId, currentPredecessor.id));
      for (const match of oldMatches)
        await tx
          .insert(matches)
          .values({
            ...match,
            id: crypto.randomUUID(),
            publicationId: p.id,
            revision: p.revision,
            eligible: false,
            approved: null,
            reviewedAt: null,
            sourceReviewDependency: null,
            ...(currentPredecessor.documentarySnapshotId ||
            match.lotEvaluations !== null
              ? {
                  score: 0,
                  reason:
                    "La nuova pubblicazione richiede una valutazione propria: i giudizi dei lotti precedenti restano storici.",
                  reviewNotes: "Richiesta revisione della nuova pubblicazione",
                }
              : {}),
            // A new publication is not the target of an earlier lot judgment.
            // The project veto is resolved centrally for the canonical group.
            lotEvaluations: null,
            lotSuppression: null,
            updatedAt: new Date(),
          })
          .onConflictDoNothing();
      const oldFeedback = await tx
        .select()
        .from(feedback)
        .where(eq(feedback.publicationId, currentPredecessor.id));
      for (const f of oldFeedback)
        await tx
          .insert(feedback)
          .values({
            ...f,
            id: crypto.randomUUID(),
            publicationId: p.id,
            relevant: null,
          })
          .onConflictDoNothing();
    }
    await tx
      .insert(publicationVersions)
      .values({
        id: crypto.randomUUID(),
        publicationId: p.id,
        revision: p.revision,
        data: p,
      })
      .onConflictDoNothing();
    await tx
      .update(matches)
      .set({ approved: null, reviewedAt: null, revision: p.revision })
      .where(
        and(
          eq(matches.publicationId, p.id),
          isNull(matches.lotEvaluations),
          isNull(matches.lotSuppression),
        ),
      );
  });
  if (p.reviewRequired)
    await recordIssue(
      `review:${p.id}`,
      "Bando da verificare",
      p.reviewReasons.join("; "),
      "warning",
      p.id,
    );
  const prior = predecessor?.data;
  if (prior && materialChange(prior, p) && p.status !== "closed")
    await queueChangeNotices(prior, p);
  return true;
}
export async function ingest(
  adapter: SourceAdapter,
  since: Date,
  signal?: AbortSignal,
  options: {
    documentaryMode?: "shadow";
    documentaryActivation?: DocumentaryAdoptionActivation;
  } = {},
) {
  const activation = options.documentaryActivation?.enabled
    ? assertDocumentaryAdoptionActivation(options.documentaryActivation)
    : null;
  if (activation && options.documentaryMode === "shadow")
    throw new Error("Raccolta shadow e adozione sono modalità distinte.");
  const id = crypto.randomUUID();
  await getDb()
    .insert(sourceRuns)
    .values({ id, source: adapter.id, status: "running" });
  let imported = 0,
    errors = 0;
  // Activation comes only from protected server configuration. Job payloads and
  // source content never select a rollout; missing configuration stays legacy.
  const documentaryShadow =
    adapter.id === "simap" && options.documentaryMode === "shadow";
  const documentaryEnabled = adapter.id === "simap" && activation !== null;
  const collect = async (
    entry: Parameters<SourceAdapter["detail"]>[0],
    expectedRefresh?: DocumentaryRefreshExpectation | null,
  ) => {
    if (documentaryEnabled) {
      const result = await collectAndAdoptSimapDocumentary(entry, activation!, {
        expectedRefresh,
        signal,
      });
      if (result.requiresReview)
        throw new Error(`Dettaglio simap da verificare: ${result.refusalCode}`);
      return result.imported;
    }
    const [adopted] = await getDb()
      .select({ pointer: publications.documentarySnapshotId })
      .from(publications)
      .where(
        and(
          eq(publications.source, adapter.id),
          eq(publications.externalId, entry.id),
          isNotNull(publications.documentarySnapshotId),
        ),
      );
    if (adopted)
      throw new Error(
        "Aggiornamento documentario sospeso: configurazione di adozione assente.",
      );
    if (!documentaryShadow)
      return storePublication(await adapter.detail(entry), {
        extractDocuments: true,
      });
    const result = await collectSimapDocumentary(entry, (p) =>
      storePublication(p, { extractDocuments: true }),
    );
    if (result.requiresReview)
      throw new Error(`Dettaglio simap da verificare: ${result.refusalCode}`);
    return result.imported;
  };
  try {
    // Bind list results to database state captured BEFORE the list request.
    // Otherwise an older publication UUID returned by a slow list could be
    // rebased onto a newer concurrent import by beginDocumentaryRequest.
    const observedForList = documentaryEnabled
      ? new Map(
          (
            await getDb()
              .select({
                externalId: publications.externalId,
                revision: publications.revision,
                documentarySnapshotId: publications.documentarySnapshotId,
                buyer: sql<string>`${publications.data}->>'buyer'`,
              })
              .from(publications)
              .where(eq(publications.source, "simap"))
          ).map(({ externalId, ...expected }) => [externalId, expected]),
        )
      : null;
    const entries = await adapter.list(since);
    const fetched = new Set(entries.map((e) => e.id));
    if (adapter.refresh) {
      const tracked = await getDb()
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.source, adapter.id),
            or(
              eq(publications.status, "open"),
              documentaryEnabled
                ? isNotNull(publications.documentarySnapshotId)
                : undefined,
            ),
          ),
        );
      for (const old of tracked) {
        signal?.throwIfAborted();
        if (fetched.has(old.externalId)) continue;
        try {
          if (old.documentarySnapshotId && !documentaryEnabled)
            throw new Error(
              "Aggiornamento documentario sospeso: configurazione di adozione assente.",
            );
          const updated =
            documentaryShadow || documentaryEnabled
              ? await collect(await readSimapRefreshEntry(old.data), {
                  revision: old.revision,
                  documentarySnapshotId: old.documentarySnapshotId,
                  buyer: old.data.buyer,
                })
              : await storePublication(await adapter.refresh(old.data), {
                  extractDocuments: true,
                });
          if (updated) imported++;
          await resolveIssue(`source-item:${adapter.id}:${old.externalId}`);
        } catch (error) {
          errors++;
          await recordIssue(
            `source-item:${adapter.id}:${old.externalId}`,
            "Bando aperto non aggiornato",
            error instanceof Error ? error.message : "Errore",
            "critical",
          );
        }
      }
    }
    for (const e of entries) {
      signal?.throwIfAborted();
      try {
        if (
          await collect(
            e,
            observedForList ? (observedForList.get(e.id) ?? null) : undefined,
          )
        )
          imported++;
        await resolveIssue(`source-item:${adapter.id}:${e.id}`);
      } catch (err) {
        errors++;
        await recordIssue(
          `source-item:${adapter.id}:${e.id}`,
          "Pubblicazione non importata",
          err instanceof Error ? err.message : "Errore di parsing",
          "critical",
        );
      }
    }
    await getDb()
      .update(sourceRuns)
      .set({
        status: errors ? "partial" : "success",
        finishedAt: new Date(),
        imported,
        error: errors
          ? `${errors} pubblicazioni richiedono un controllo`
          : null,
      })
      .where(eq(sourceRuns.id, id));
    if (errors) throw new Error(`Importazione parziale: ${errors} errori`);
    await resolveIssue(`source:${adapter.id}`);
  } catch (err) {
    await getDb()
      .update(sourceRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        imported,
        error: err instanceof Error ? err.message : "Fonte indisponibile",
      })
      .where(eq(sourceRuns.id, id));
    await recordIssue(
      `source:${adapter.id}`,
      "Fonte non aggiornata",
      err instanceof Error ? err.message : "Errore sconosciuto",
      "critical",
    );
    throw err;
  }
  return imported;
}
export async function enrichAndMatch(
  options: {
    publicationId?: string;
    signal?: AbortSignal;
    now?: Date;
    documentaryActivation?: DocumentaryAdoptionActivation;
  } = {},
) {
  const documentaryEnabled = options.documentaryActivation?.enabled
    ? Boolean(
        assertDocumentaryAdoptionActivation(options.documentaryActivation),
      )
    : false;
  const db = getDb();
  const rows = await db
    .select({
      ...getTableColumns(publications),
      // Keep PostgreSQL's microseconds: a JavaScript Date truncates them and
      // would reject an unchanged row inserted with the database default now().
      updatedToken: sql<string>`${publications.updatedAt}::text`,
    })
    .from(publications)
    .where(
      and(
        or(
          eq(publications.status, "open"),
          isNotNull(publications.documentarySnapshotId),
        ),
        options.publicationId
          ? eq(publications.id, options.publicationId)
          : undefined,
      ),
    );
  const firms = await db
    .select()
    .from(companies)
    .where(
      and(isNull(companies.disabledAt), companyAllowsPilotProcessingSql()),
    );
  let failedAnalyses = 0;
  for (const row of rows) {
    options.signal?.throwIfAborted();
    // Check the current pointer before legacy processing, without introducing
    // a legacy transaction before its own source/CAS read. Adoption drains old
    // requests; the write guards below still reject every in-flight AI result.
    const [currentPointer] = await db
      .select({ adopted: publications.documentarySnapshotId })
      .from(publications)
      .where(eq(publications.id, row.id));
    if (currentPointer?.adopted) {
      await matchAdoptedPublication({
        publicationId: row.id,
        now: options.now,
        signal: options.signal,
      });
      continue;
    }
    // During a coordinated adoption rollout, a simap row still awaiting its
    // immutable acquisition must not start a new legacy AI request. Existing
    // judgments remain historical until the pointer is adopted; no ready match
    // or positive decision is manufactured here.
    if (documentaryEnabled && row.source === "simap") continue;
    if (
      row.source === "foglio-ti" &&
      process.env.FOGLIO_REUSE_CONFIRMED !== "true"
    )
      continue;
    let p = row.data;
    const initialActivityReviews = new Map(
      firms
        .filter((firm) => firm.onboardedAt)
        .map((firm) => [
          firm.id,
          preliminaryMatch(p, firm.profile, options.now).activityReview,
        ]),
    );
    const sourceContext = await readSourceReviewContext(db, row);
    const sourceDependency = sourceContext?.dependency ?? null;
    let aiReady = Boolean(p.summary && row.aiRevision === p.revision);
    if (
      !hasSourceScopeReview(p) &&
      !sourceContext &&
      (!p.summary || row.aiRevision !== p.revision) &&
      !classificationChanged(p)
    ) {
      try {
        const result = await summarize(p);
        options.signal?.throwIfAborted();
        p = {
          ...p,
          summary: result.summary,
          // Catalogue classification comes from source rules, not summary AI.
          sectors: p.sectors,
          requirements: result.requirements.map((r) => r.text),
          evidence: [
            ...p.evidence,
            ...result.evidence,
            ...result.requirements.map((r) => ({
              field: "Requisito",
              quote: r.quote,
              url: r.url,
              ...(r.page === undefined ? {} : { page: r.page }),
            })),
          ],
        };
        const updated = await db.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(publications)
            .where(eq(publications.id, p.id))
            .for("update");
          if (
            !current ||
            current.documentarySnapshotId ||
            !sameSourceReviewDependency(
              sourceDependency,
              (await readSourceReviewContext(tx, current))?.dependency,
            )
          )
            return [];
          return tx
            .update(publications)
            .set({ data: p, aiRevision: p.revision })
            .where(
              and(
                eq(publications.id, p.id),
                sql`${publications.updatedAt} = ${row.updatedToken}::timestamptz`,
                eq(publications.revision, row.revision),
                sql`${publications.data}->>'revision' = ${p.revision}`,
                sql`${publications.data}->'sourceScopeReview'->>'token' IS NOT DISTINCT FROM ${p.sourceScopeReview?.token ?? null}::text`,
              ),
            )
            .returning({ id: publications.id });
        });
        if (!updated.length) {
          await matchAdoptedPublication({
            publicationId: p.id,
            now: options.now,
            signal: options.signal,
          });
          continue;
        }
        aiReady = true;
        await resolveIssue(`ai:${p.id}`);
      } catch (e) {
        options.signal?.throwIfAborted();
        if (!(e instanceof AiUnavailable)) failedAnalyses++;
        await recordIssue(
          `ai:${p.id}`,
          "Analisi AI sospesa",
          e instanceof Error ? e.message : "Errore AI",
          "warning",
          p.id,
        );
      }
    }
    for (const firm of firms) {
      if (!firm.onboardedAt) continue;
      const [sourceState] = await db
        .select({ adopted: publications.documentarySnapshotId })
        .from(publications)
        .where(eq(publications.id, p.id));
      if (sourceState?.adopted) {
        await matchAdoptedPublication({
          publicationId: p.id,
          now: options.now,
          signal: options.signal,
        });
        break;
      }
      const profileRevision = fingerprint(firm.profile);
      options.signal?.throwIfAborted();
      let preliminary = preliminaryMatch(p, firm.profile, options.now);
      const [existing] = await db
        .select({
          ...getTableColumns(matches),
          updatedToken: sql<string>`${matches.updatedAt}::text`,
          reviewedToken: sql<string | null>`${matches.reviewedAt}::text`,
        })
        .from(matches)
        .where(
          and(eq(matches.companyId, firm.id), eq(matches.publicationId, p.id)),
        )
        .limit(1);
      const activityReview = preliminary.eligible
        ? (initialActivityReviews.get(firm.id) ??
          activityReviewForMatch({
            publication: p,
            sectors: firm.profile.sectors,
            activities: firm.profile.activities,
            preliminary,
            revision: existing?.revision,
            profileRevision,
          }))
        : undefined;
      if (activityReview)
        preliminary = {
          eligible: true,
          score: 0,
          uncertain: true,
          reason: activityReview.reason,
          activityReview,
        };
      const activitySuffix = activityReview
        ? `${CPV_ACTIVITY_REVIEW_MARKER}${activityReview.version}:${fingerprint(activityReview.signals)}`
        : "";
      const classificationSuffix =
        preliminary.classificationReview?.replace(
          ":sector-review:",
          ":sector-pending:",
        ) ?? "";
      const revision = `${p.revision}:${profileRevision}:${aiReady ? "ready" : "pending"}:${sourceContext ? HUMAN_SOURCE_REVIEW_VERSION : (process.env.LLM_MODEL ?? "default")}:${preliminary.eligible}${activitySuffix}${classificationSuffix}${sourceScopeReviewSuffix(p)}`;
      if (
        (existing?.revision === revision &&
          sameSourceReviewDependency(
            existing.sourceReviewDependency,
            sourceDependency,
          )) ||
        // A source event must not relabel an earlier human company decision.
        // Readers separately mask its stale positive binding until a new review.
        ((sourceContext || classificationChanged(p)) &&
          existing &&
          (existing.reviewedAt || existing.approved === false)) ||
        (existing &&
          (existing.reviewedAt || existing.approved === false) &&
          isMatchRevisionCurrent({
            revision: existing.revision,
            publication: p,
            profileRevision,
            manuallyReviewed: true,
          }))
      )
        continue;
      let score = preliminary.score,
        reason = preliminary.reason;
      let approved: boolean | null = null;
      let uncertain = preliminary.uncertain;
      let needsReview = false;
      let retry = false;
      if (preliminary.eligible && preliminary.classificationReview) {
        score = 0;
        reason = preliminary.reason;
        uncertain = true;
        needsReview = true;
      } else if (preliminary.eligible && sourceContext) {
        score = 0;
        reason =
          sourceContext.state === "manual_source" &&
          sourceContext.form === "defined_service"
            ? "È stato registrato un giudizio umano sull’oggetto della fonte. La pertinenza per la ditta richiede una revisione manuale separata."
            : sourceReviewReason(sourceContext);
        uncertain = true;
        needsReview = true;
      } else if (preliminary.eligible && hasSourceScopeReview(p)) {
        score = 0;
        reason = sourceScopeReviewReason;
        uncertain = true;
        needsReview = true;
      } else if (preliminary.eligible && activityReview) {
        score = 0;
        reason = activityReview.reason;
        uncertain = true;
        needsReview = true;
      } else if (preliminary.eligible && aiReady) {
        try {
          const ai = await classify(p, firm.profile);
          options.signal?.throwIfAborted();
          score = ai.score;
          reason = ai.reason;
          uncertain = uncertain || ai.uncertain;
          needsReview = ai.needsReview;
          await resolveIssue(`match-ai:${firm.id}:${p.id}`);
        } catch (e) {
          options.signal?.throwIfAborted();
          if (!(e instanceof AiUnavailable)) failedAnalyses++;
          uncertain = true;
          retry = true;
          await recordIssue(
            `match-ai:${firm.id}:${p.id}`,
            "Pertinenza da verificare",
            e instanceof Error ? e.message : "AI non disponibile",
            "warning",
            p.id,
          );
        }
      } else if (preliminary.eligible) uncertain = true;
      // Insufficient evidence is a completed assessment to review, not proof
      // of irrelevance. Keep it visible; reviewNotes blocks automatic emails.
      const eligible = preliminary.eligible && (score >= 60 || needsReview);
      const set = {
        revision: retry ? `${revision}:retry` : revision,
        score,
        reason,
        eligible,
        approved,
        reviewedAt: null,
        reviewNotes: uncertain ? "Richiesta revisione della pertinenza" : null,
        sourceReviewDependency: sourceDependency,
        updatedAt: new Date(),
      };
      let sourceChangedDuringAssessment = false;
      await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(publications)
          .where(eq(publications.id, p.id))
          .for("share");
        const [currentFirm] = await tx
          .select()
          .from(companies)
          .where(
            and(eq(companies.id, firm.id), companyAllowsPilotProcessingSql()),
          )
          .for("share");
        if (
          !current ||
          current.documentarySnapshotId ||
          current.data.revision !== p.revision ||
          current.data.sourceScopeReview?.token !==
            p.sourceScopeReview?.token ||
          current.status !== "open"
        ) {
          sourceChangedDuringAssessment = true;
          return;
        }
        if (
          !currentFirm ||
          currentFirm.disabledAt ||
          fingerprint(currentFirm.profile) !== profileRevision
        )
          return;
        // The event writer locks this publication too, including the first
        // event. Read history under the same lock before committing any score.
        if (
          !sameSourceReviewDependency(
            sourceDependency,
            (await readSourceReviewContext(tx, current))?.dependency,
          )
        ) {
          sourceChangedDuringAssessment = true;
          return;
        }
        const insert = tx.insert(matches).values({
          id: crypto.randomUUID(),
          companyId: firm.id,
          publicationId: p.id,
          ...set,
        });
        // A review or another assessment may have committed while AI ran.
        // The deployed review route does not bump updatedAt or revision.
        // Compare its fields too, retaining exact nullable review timestamps.
        if (existing)
          await insert.onConflictDoUpdate({
            target: [matches.companyId, matches.publicationId],
            set,
            setWhere: and(
              eq(matches.revision, existing.revision),
              sql`${matches.updatedAt} = ${existing.updatedToken}::timestamptz`,
              sql`${matches.reviewedAt} IS NOT DISTINCT FROM ${existing.reviewedToken}::timestamptz`,
              sql`${matches.approved} IS NOT DISTINCT FROM ${existing.approved}::boolean`,
              eq(matches.eligible, existing.eligible),
              eq(matches.score, existing.score),
              sql`${matches.reviewNotes} IS NOT DISTINCT FROM ${existing.reviewNotes}::text`,
              sql`${matches.sourceReviewDependency} IS NOT DISTINCT FROM ${existing.sourceReviewDependency ? JSON.stringify(existing.sourceReviewDependency) : null}::jsonb`,
            ),
          });
        else await insert.onConflictDoNothing();
      });
      // Once a changed source is observed, later companies must not start
      // another request from this already invalidated source snapshot.
      if (sourceChangedDuringAssessment) {
        await matchAdoptedPublication({
          publicationId: p.id,
          now: options.now,
          signal: options.signal,
        });
        break;
      }
    }
  }
  // Persist successful assessments and review states before failing the job.
  // pg-boss can then retry only uncached work with its configured backoff.
  // Budget/configuration/input suspensions remain pending for a later sweep.
  if (failedAnalyses)
    throw new Error(
      `Analisi AI da ritentare: ${failedAnalyses} elaborazioni non riuscite.`,
    );
}

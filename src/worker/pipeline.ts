import { and, eq, ne, isNull, sql, desc } from "drizzle-orm";
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
import { classify, summarize } from "./ai";
import { queueChangeNotices } from "./notifications";
import { attachFoglioPdf } from "@/sources/foglio";
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
    Number(value.projectId?.split("-").at(-1)) || 0,
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
    for (const cousin of cousins) {
      await tx
        .update(publications)
        .set({ data: { ...cousin.data, sourceUrls }, updatedAt: new Date() })
        .where(eq(publications.id, cousin.id));
    }
    for (const old of sameSource.filter((c) => newer(p, c.data))) {
      await tx
        .update(publications)
        .set({
          status: "closed",
          data: { ...old.data, status: "closed", sourceUrls },
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
    if (!previous && predecessor) {
      const oldMatches = await tx
        .select()
        .from(matches)
        .where(eq(matches.publicationId, predecessor.id));
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
            updatedAt: new Date(),
          })
          .onConflictDoNothing();
      const oldFeedback = await tx
        .select()
        .from(feedback)
        .where(eq(feedback.publicationId, predecessor.id));
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
      .where(eq(matches.publicationId, p.id));
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
) {
  const id = crypto.randomUUID();
  await getDb()
    .insert(sourceRuns)
    .values({ id, source: adapter.id, status: "running" });
  let imported = 0,
    errors = 0;
  try {
    const entries = await adapter.list(since);
    const fetched = new Set(entries.map((e) => e.id));
    if (adapter.refresh) {
      const tracked = await getDb()
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.source, adapter.id),
            eq(publications.status, "open"),
          ),
        );
      for (const old of tracked) {
        signal?.throwIfAborted();
        if (fetched.has(old.externalId)) continue;
        try {
          if (
            await storePublication(await adapter.refresh(old.data), {
              extractDocuments: true,
            })
          )
            imported++;
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
        const p = await adapter.detail(e);
        if (await storePublication(p, { extractDocuments: true })) imported++;
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
  options: { publicationId?: string; signal?: AbortSignal; now?: Date } = {},
) {
  const db = getDb();
  const rows = await db
    .select()
    .from(publications)
    .where(
      and(
        eq(publications.status, "open"),
        options.publicationId
          ? eq(publications.id, options.publicationId)
          : undefined,
      ),
    );
  const firms = await db
    .select()
    .from(companies)
    .where(isNull(companies.disabledAt));
  for (const row of rows) {
    options.signal?.throwIfAborted();
    if (
      row.source === "foglio-ti" &&
      process.env.FOGLIO_REUSE_CONFIRMED !== "true"
    )
      continue;
    let p = row.data;
    let aiReady = Boolean(p.summary && row.aiRevision === p.revision);
    if (!p.summary || row.aiRevision !== p.revision) {
      try {
        const result = await summarize(p);
        options.signal?.throwIfAborted();
        p = {
          ...p,
          summary: result.summary,
          sectors: [...new Set([...p.sectors, ...result.sectors])],
          requirements: result.requirements.map((r) => r.text),
          evidence: [
            ...p.evidence,
            ...result.evidence.map((e) => ({
              ...e,
              ...evidenceLocation(p, e.quote),
            })),
            ...result.requirements.map((r) => ({
              field: "Requisito",
              quote: r.quote,
              ...evidenceLocation(p, r.quote),
            })),
          ],
        };
        const updated = await db
          .update(publications)
          .set({ data: p, aiRevision: p.revision })
          .where(
            and(
              eq(publications.id, p.id),
              eq(publications.updatedAt, row.updatedAt),
              eq(publications.revision, row.revision),
            ),
          )
          .returning({ id: publications.id });
        if (!updated.length) continue;
        aiReady = true;
        await resolveIssue(`ai:${p.id}`);
      } catch (e) {
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
      const profileRevision = fingerprint(firm.profile);
      options.signal?.throwIfAborted();
      const preliminary = preliminaryMatch(p, firm.profile, options.now);
      const revision = `${p.revision}:${profileRevision}:${aiReady ? "ready" : "pending"}:${process.env.LLM_MODEL ?? "default"}:${preliminary.eligible}`;
      const [existing] = await db
        .select()
        .from(matches)
        .where(
          and(eq(matches.companyId, firm.id), eq(matches.publicationId, p.id)),
        )
        .limit(1);
      if (
        existing?.revision === revision ||
        (existing?.reviewedAt && existing.revision === `${revision}:retry`)
      )
        continue;
      let score = preliminary.score,
        reason = preliminary.reason;
      let approved: boolean | null = null;
      let uncertain = preliminary.uncertain;
      let retry = false;
      if (preliminary.eligible && aiReady) {
        try {
          const ai = await classify(p, firm.profile);
          options.signal?.throwIfAborted();
          score = ai.score;
          reason = ai.reason;
          uncertain = uncertain || ai.uncertain;
          await resolveIssue(`match-ai:${firm.id}:${p.id}`);
        } catch (e) {
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
      const eligible = preliminary.eligible && score >= 60;
      const set = {
        revision: retry ? `${revision}:retry` : revision,
        score,
        reason,
        eligible,
        approved,
        reviewedAt: null,
        reviewNotes: uncertain ? "Richiesta revisione della pertinenza" : null,
        updatedAt: new Date(),
      };
      await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(publications)
          .where(eq(publications.id, p.id))
          .for("share");
        const [currentFirm] = await tx
          .select()
          .from(companies)
          .where(eq(companies.id, firm.id))
          .for("share");
        if (
          !current ||
          current.data.revision !== p.revision ||
          current.status !== "open" ||
          !currentFirm ||
          currentFirm.disabledAt ||
          fingerprint(currentFirm.profile) !== profileRevision
        )
          return;
        await tx
          .insert(matches)
          .values({
            id: crypto.randomUUID(),
            companyId: firm.id,
            publicationId: p.id,
            ...set,
          })
          .onConflictDoUpdate({
            target: [matches.companyId, matches.publicationId],
            set,
          });
      });
    }
  }
}
function evidenceLocation(p: Publication, quote: string) {
  const page = p.documentPages?.find((page) => page.text.includes(quote));
  return page ? { url: page.url, page: page.page } : { url: p.sourceUrl };
}

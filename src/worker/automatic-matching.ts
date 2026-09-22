import { and, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { getDb } from "@/db";
import { automaticMatchRuns, companies, matches, issues } from "@/db/schema";
import { lockCanonicalPublications } from "@/lib/canonical-lock";
import { readLotMatchReview } from "@/lib/lot-match-reviews";
import { companyAllowsPilotProcessingSql } from "@/lib/pilot-processing";
import { sameAssessmentTarget } from "@/lib/lot-assessment";
import {
  buildAutomaticComparisonRequest,
  readAutomaticComparison,
} from "@/lib/automatic-comparison";
import {
  automaticComparisonEnabled,
  type AutomaticComparisonJob,
} from "@/lib/automatic-comparison-queue";
import { compareDocumentaryTarget } from "./documentary-comparison";
import type { AiTransport } from "./ai";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
class ComparisonInputsChanged extends Error {}
const expiredLease = (now: Date) =>
  or(
    isNull(automaticMatchRuns.leaseUntil),
    lte(automaticMatchRuns.leaseUntil, now),
  );
const hasLiveLease = (run: typeof automaticMatchRuns.$inferSelect, now: Date) =>
  run.status === "running" && run.leaseUntil !== null && run.leaseUntil > now;

async function recordExhaustedComparison(
  tx: Pick<Tx, "insert">,
  job: AutomaticComparisonJob,
) {
  await tx
    .insert(issues)
    .values({
      id: crypto.randomUUID(),
      key: `automatic-comparison:${job.runId}`,
      title: "Confronto automatico non riuscito",
      severity: "warning",
      publicationId: job.publicationId,
      detail:
        "Tre tentativi non hanno prodotto una valutazione utilizzabile. La proposta resta da verificare nell’area fondatore.",
    })
    .onConflictDoNothing();
}

async function supersedeUnavailable(
  tx: Tx,
  job: AutomaticComparisonJob,
  now: Date,
) {
  return tx
    .update(automaticMatchRuns)
    .set({
      status: "superseded",
      result: null,
      issue: "inputs_changed",
      leaseUntil: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(automaticMatchRuns.id, job.runId),
        eq(automaticMatchRuns.companyId, job.companyId),
        eq(automaticMatchRuns.publicationId, job.publicationId),
        or(
          inArray(automaticMatchRuns.status, ["queued", "failed"]),
          and(eq(automaticMatchRuns.status, "running"), expiredLease(now)),
        ),
      ),
    )
    .returning({ id: automaticMatchRuns.id });
}

async function failExhaustedComparison(
  tx: Tx,
  job: AutomaticComparisonJob,
  run: typeof automaticMatchRuns.$inferSelect,
  now: Date,
) {
  const changed = await tx
    .update(automaticMatchRuns)
    .set({
      status: "failed",
      result: null,
      issue: "comparison_failed",
      leaseUntil: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(automaticMatchRuns.id, job.runId),
        eq(automaticMatchRuns.companyId, job.companyId),
        eq(automaticMatchRuns.publicationId, job.publicationId),
        eq(automaticMatchRuns.attempts, run.attempts),
        inArray(automaticMatchRuns.status, ["queued", "running"]),
        expiredLease(now),
      ),
    )
    .returning({ id: automaticMatchRuns.id });
  if (changed.length) await recordExhaustedComparison(tx, job);
  return changed.length;
}

async function current(tx: Tx, job: AutomaticComparisonJob, now: Date) {
  const locked = await lockCanonicalPublications(tx, job.publicationId);
  if (!locked?.publication.documentarySnapshotId) return null;
  const [company] = await tx
    .select()
    .from(companies)
    .where(
      and(
        eq(companies.id, job.companyId),
        isNull(companies.disabledAt),
        isNotNull(companies.onboardedAt),
        companyAllowsPilotProcessingSql(),
      ),
    )
    .for("share");
  if (!company) return null;
  const [match] = await tx
    .select()
    .from(matches)
    .where(
      and(
        eq(matches.companyId, company.id),
        eq(matches.publicationId, job.publicationId),
      ),
    )
    .for("update");
  if (!match) return null;
  const [run] = await tx
    .select()
    .from(automaticMatchRuns)
    .where(
      and(
        eq(automaticMatchRuns.id, job.runId),
        eq(automaticMatchRuns.matchId, match.id),
        eq(automaticMatchRuns.companyId, company.id),
        eq(automaticMatchRuns.publicationId, job.publicationId),
      ),
    )
    .for("update");
  if (!run) return null;
  const loaded = await readLotMatchReview(
    tx,
    locked.publication,
    company,
    match,
    now,
  );
  const target = loaded.project.targets.find((item) =>
    sameAssessmentTarget(item.target, run.target),
  );
  if (
    !target?.preliminary?.eligible ||
    target.evaluation ||
    loaded.project.suppressed ||
    loaded.project.dismissed
  )
    return { run, input: null };
  const input = {
    ...loaded.input,
    target: run.target,
    preliminary: target.preliminary,
  };
  try {
    const request = buildAutomaticComparisonRequest(input);
    if (request.sourceBlocked || request.inputHash !== run.inputHash)
      return { run, input: null };
  } catch {
    return { run, input: null };
  }
  return { run, input };
}

// pg-boss cannot retry a job after its final delivery is interrupted. Reconcile
// abandoned application leases independently, without issuing provider calls.
export async function reconcileAutomaticComparisonLeases(now = new Date()) {
  if (!Number.isFinite(now.getTime()))
    throw new Error("Invalid comparison clock");
  if (!automaticComparisonEnabled()) return 0;
  const candidates = await getDb()
    .select({
      runId: automaticMatchRuns.id,
      companyId: automaticMatchRuns.companyId,
      publicationId: automaticMatchRuns.publicationId,
    })
    .from(automaticMatchRuns)
    .where(and(eq(automaticMatchRuns.status, "running"), expiredLease(now)));
  let changed = 0;
  for (const job of candidates) {
    changed += await getDb().transaction(async (tx) => {
      const loaded = await current(tx, job, now);
      if (!loaded) return (await supersedeUnavailable(tx, job, now)).length;
      if (loaded.run.status !== "running" || hasLiveLease(loaded.run, now))
        return 0;
      if (!loaded.input)
        return (await supersedeUnavailable(tx, job, now)).length;
      if (loaded.run.attempts >= 3)
        return failExhaustedComparison(tx, job, loaded.run, now);
      // Remaining attempts still belong to the durable pg-boss retry schedule.
      return 0;
    });
  }
  return changed;
}

// Only the claim and commit hold application locks. The provider runs outside
// a transaction; a fresh source/profile/human decision is checked on commit.
export async function runAutomaticComparison(
  job: AutomaticComparisonJob,
  options: {
    transport?: AiTransport;
    signal?: AbortSignal;
    now?: () => Date;
  } = {},
) {
  const clock = options.now ?? (() => new Date());
  options.signal?.throwIfAborted();
  if (!automaticComparisonEnabled())
    throw new Error("Confronto automatico disattivato");
  const claimed = await getDb().transaction(async (tx) => {
    const loaded = await current(tx, job, clock());
    if (!loaded) {
      await supersedeUnavailable(tx, job, clock());
      return null;
    }
    if (["completed", "superseded"].includes(loaded.run.status)) return null;
    if (hasLiveLease(loaded.run, clock()))
      throw new Error("Confronto già in elaborazione");
    if (!loaded.input) {
      await supersedeUnavailable(tx, job, clock());
      return null;
    }
    if (loaded.run.attempts >= 3) {
      await failExhaustedComparison(tx, job, loaded.run, clock());
      return null;
    }
    const attempt = loaded.run.attempts + 1;
    await tx
      .update(automaticMatchRuns)
      .set({
        status: "running",
        attempts: attempt,
        issue: null,
        leaseUntil: new Date(clock().getTime() + 5 * 60_000),
        updatedAt: clock(),
      })
      .where(eq(automaticMatchRuns.id, job.runId));
    return { input: loaded.input, attempt };
  });
  if (!claimed) return { status: "skipped" as const };
  const owned = () =>
    and(
      eq(automaticMatchRuns.id, job.runId),
      eq(automaticMatchRuns.companyId, job.companyId),
      eq(automaticMatchRuns.publicationId, job.publicationId),
      eq(automaticMatchRuns.attempts, claimed.attempt),
      eq(automaticMatchRuns.status, "running"),
    );
  try {
    const result = await compareDocumentaryTarget(
      claimed.input,
      options.transport,
      async () => {
        options.signal?.throwIfAborted();
        if (!automaticComparisonEnabled())
          throw new Error("Confronto automatico disattivato");
        const currentInput = await getDb().transaction(async (tx) => {
          const latest = await current(tx, job, clock());
          if (
            !latest?.input ||
            latest.run.attempts !== claimed.attempt ||
            latest.run.status !== "running"
          ) {
            await tx
              .update(automaticMatchRuns)
              .set({
                status: "superseded",
                issue: "inputs_changed",
                leaseUntil: null,
                updatedAt: clock(),
              })
              .where(owned());
            return false;
          }
          await tx
            .update(automaticMatchRuns)
            .set({
              leaseUntil: new Date(clock().getTime() + 5 * 60_000),
              updatedAt: clock(),
            })
            .where(owned());
          return true;
        });
        if (!currentInput) throw new ComparisonInputsChanged();
      },
    );
    options.signal?.throwIfAborted();
    return await getDb().transaction(async (tx) => {
      const latest = await current(tx, job, clock());
      if (!latest) {
        await tx
          .update(automaticMatchRuns)
          .set({
            status: "superseded",
            result: null,
            issue: "inputs_changed",
            leaseUntil: null,
            updatedAt: clock(),
          })
          .where(owned());
        return { status: "superseded" as const };
      }
      if (
        latest.run.attempts !== claimed.attempt ||
        latest.run.status !== "running"
      )
        return { status: "superseded" as const };
      const valid =
        latest.input &&
        readAutomaticComparison(
          result,
          buildAutomaticComparisonRequest(latest.input),
        );
      await tx
        .update(automaticMatchRuns)
        .set({
          status: valid ? "completed" : "superseded",
          result: valid ? result : null,
          issue: valid ? null : "inputs_changed",
          leaseUntil: null,
          updatedAt: clock(),
        })
        .where(owned());
      return {
        status: valid ? ("completed" as const) : ("superseded" as const),
      };
    });
  } catch (error) {
    if (error instanceof ComparisonInputsChanged)
      return { status: "superseded" as const };
    const changed = await getDb()
      .update(automaticMatchRuns)
      .set({
        status: "failed",
        leaseUntil: null,
        issue: "comparison_failed",
        updatedAt: clock(),
      })
      .where(owned())
      .returning({ id: automaticMatchRuns.id });
    if (changed.length && claimed.attempt >= 3)
      await recordExhaustedComparison(getDb(), job);
    // pg-boss owns bounded retry. Provider messages and private prompt text are
    // never copied into product diagnostics; actual/uncertain spend is ledgered.
    throw error;
  }
}

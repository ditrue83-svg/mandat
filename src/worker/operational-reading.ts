import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { operationalReadingRuns, aiUsage } from "@/db/schema";
import {
  assessmentTargetKey,
  type LotAssessmentInput,
} from "@/lib/lot-assessment";
import type { LotSourceTarget } from "@/lib/lot-source-context";
import {
  buildOperationalRuntimePlan,
  wrapOperationalRecord,
  type StoredOperationalReading,
  readOperationalGrant,
  readOperationalRuntimeRecord,
} from "@/lib/operational-reading-runtime";
import {
  readOperationalEvidence,
} from "@/lib/lot-operational-evidence";
import { infer, type AiTransport } from "./ai";
export class OperationalInputsChanged extends Error {}
// One durable owner/source/config claim, before any reservation or provider work.
// A delivered/uncertain/rejected request is never automatically sent again.
export async function ensureOperationalReading(
  input: LotAssessmentInput,
  target: LotSourceTarget,
  matchId: string,
  grantId: string,
  options: {
    transport?: AiTransport;
    beforeRequest: () => Promise<void>;
    commitRecord: (
      id: string,
      result: StoredOperationalReading,
    ) => Promise<void>;
    now?: () => Date;
  },
) {
  const clock = options.now ?? (() => new Date()),
    plan = buildOperationalRuntimePlan(input, target),
    db = getDb(),
    targetKey = assessmentTargetKey(target);
  if((await readOperationalGrant(db,input.companyId))!==grantId)throw new Error("Operational processing permission unavailable");
  await options.beforeRequest();
  const older = await db
    .select()
    .from(operationalReadingRuns)
    .where(
      and(
        eq(operationalReadingRuns.matchId, matchId),
        eq(operationalReadingRuns.targetKey, targetKey),
        eq(operationalReadingRuns.requestHash, plan.requestHash),
      ),
    )
    .orderBy(operationalReadingRuns.createdAt, operationalReadingRuns.id);
  // A tariff/grant change does not justify repeating an identical semantic request.
  for (const row of older) {
    if (row.status === "completed") {
      const value = row.result as StoredOperationalReading | undefined,
        record = readOperationalRuntimeRecord(value, plan);
      if (
        record?.model === plan.configuration.model &&
        readOperationalEvidence([record], plan.context)
      ) {
        const result = value!; // Raw proofs and their hash remain bound during adoption.
        await options.beforeRequest();
        const adoptionId = randomUUID();
        const [adopted] = await db
          .insert(operationalReadingRuns)
          .values({
            id: adoptionId,
            matchId,
            companyId: input.companyId,
            publicationId: input.publication.id,
            target,
            targetKey,
            inputHash: plan.inputHash,
            requestHash: plan.requestHash,
            configHash: plan.configHash,
            grantId,
            status: "running",
            receiptIds: row.receiptIds,
          })
          .onConflictDoNothing()
          .returning({ id: operationalReadingRuns.id });
        if (adopted) {
          try {
            await options.commitRecord(adoptionId, result);
          } catch (error) {
            await db
              .update(operationalReadingRuns)
              .set({
                status: "superseded",
                result: null,
                issue: "adoption_inputs_changed",
                updatedAt: clock(),
              })
              .where(eq(operationalReadingRuns.id, adoptionId));
            throw error;
          }
        }
        return { status: "completed" as const, record };
      }
    }
    if (
      row.receiptIds.length ||
      ["rejected", "running", "uncertain"].includes(row.status)
    )
      return { status: "held" as const };
  }
  let id: string = randomUUID();
  const [claim] = await db
    .insert(operationalReadingRuns)
    .values({
      id,
      matchId,
      companyId: input.companyId,
      publicationId: input.publication.id,
      target,
      targetKey,
      inputHash: plan.inputHash,
      requestHash: plan.requestHash,
      configHash: plan.configHash,
      grantId,
      status: "running",
    })
    .onConflictDoUpdate({
      target: [
        operationalReadingRuns.matchId,
        operationalReadingRuns.targetKey,
        operationalReadingRuns.inputHash,
      ],
      set: { status: "running", grantId, updatedAt: clock() },
      setWhere: and(
        eq(operationalReadingRuns.status, "ready"),
        sql`jsonb_array_length(${operationalReadingRuns.receiptIds})=0`,
        sql`${operationalReadingRuns.reading} is null`,
        sql`${operationalReadingRuns.review} is null`,
      ),
    })
    .returning({ id: operationalReadingRuns.id });
  if (!claim) return { status: "held" as const };
  id = claim.id;
  const receipts: string[] = [];
  let validation = false,
    cancelled = false;
  const guard = async () => {
    try {
      if((await readOperationalGrant(db,input.companyId))!==grantId)throw new Error("Operational processing permission changed");
      await options.beforeRequest();
    } catch (e) {
      cancelled = true;
      throw e;
    }
  };
  async function call(
    stage: "reading" | "review",
    task: typeof plan.task,
  ) {
    await guard();
    const purpose = `documentary-operational-${stage}:${id}`;
    try {
      return await infer(
        input.publication,
        purpose,
        task.prompt,
        task.maxTokens,
        options.transport,
        task.system,
        task.responseFormat,
        plan.configuration,
      );
    } finally {
      const rows = await db
        .select({ id: aiUsage.id })
        .from(aiUsage)
        .where(
          and(
            eq(aiUsage.publicationId, input.publication.id),
            eq(aiUsage.purpose, purpose),
          ),
        );
      if (rows.length > 1)
        throw new Error("Operational usage receipt ambiguous");
      receipts.push(...rows.map((r) => r.id));
      await db
        .update(operationalReadingRuns)
        .set({ receiptIds: [...receipts], updatedAt: clock() })
        .where(eq(operationalReadingRuns.id, id));
    }
  }
  try {
    const reading = await call("reading", plan.task);
    await db
      .update(operationalReadingRuns)
      .set({ reading, updatedAt: clock() })
      .where(eq(operationalReadingRuns.id, id));
    await guard();
    validation = true;
    const checked = {answer:plan.protocol.decodeReading(reading)};
    if (checked.answer.issues.length)
      throw new Error("Operational reading has unresolved issues");
    const task = plan.protocol.reviewTask(reading);
    validation = false;
    const review = await call("review", task);
    await db
      .update(operationalReadingRuns)
      .set({ review, updatedAt: clock() })
      .where(eq(operationalReadingRuns.id, id));
    await guard();
    validation = true;
    const record = plan.protocol.record(reading, review, {
        id,
        at: clock().toISOString(),
        model: plan.configuration.model,
      }),
      result = wrapOperationalRecord(record, plan, {reading, review});
    validation = false;
    // Authorization/source/config is rechecked inside the commit lock as well.
    await guard();
    try {
      await options.commitRecord(id, result);
    } catch (e) {
      cancelled = true;
      throw e;
    }
    return { status: "completed" as const, record };
  } catch (error) {
    await db
      .update(operationalReadingRuns)
      .set({
        status: cancelled
          ? "superseded"
          : validation
            ? "rejected"
            : receipts.length
              ? "failed"
              : "blocked",
        issue: cancelled
          ? "inputs_or_permission_changed"
          : validation
            ? "operational_semantics_rejected"
            : receipts.length
              ? "operational_transport_failed"
              : "operational_not_sent",
        result: null,
        updatedAt: clock(),
      })
      .where(eq(operationalReadingRuns.id, id));
    if (cancelled) throw new OperationalInputsChanged();
    return { status: "held" as const };
  }
}

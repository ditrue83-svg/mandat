import { createHash } from "node:crypto";
import { and, desc, eq, isNull, sql, getTableColumns } from "drizzle-orm";
import {
  aiProcessingReceipts,
  companies,
  operationalReadingRuns,
} from "@/db/schema";
import {
  AI_PROCESSING_NOTICE_HASH,
  companyAllowsAiProcessingSql,
} from "./ai-processing-permission";
import {
  AI_PROCESSING_NOTICE_VERSION,
  AI_PROCESSING_RECIPIENT,
} from "./ai-processing-notice";
import { documentaryAiConfiguration } from "./documentary-ai-config";
import { resolveAssessmentSourceContext } from "./assessment-shape";
import {
  preliminaryAssessmentMatch,
  type LotAssessmentInput,
} from "./lot-assessment";
import type { LotSourceTarget } from "./lot-source-context";
import {
  buildOperationalEvidenceRequest,
  buildOperationalReadingTask,
  readOperationalEvidence,
  type OperationalEvidenceRecord,
} from "./lot-operational-evidence";
import { stableDocumentaryJson } from "./documentary-observation";
import type { SourceReviewExecutor } from "./source-reviews";
export const OPERATIONAL_RUNTIME_VERSION = "operational-reading-runtime-v1";
export const operationalReadingEnabled = () =>
  process.env.DOCUMENTARY_OPERATIONAL_READING_ENABLED === "true" &&
  process.env.DOCUMENTARY_COMPARISON_ENABLED === "true";
const digest = (v: unknown) =>
  createHash("sha256").update(stableDocumentaryJson(v)).digest("hex");
export function operationalRuntimeConfiguration() {
  return {
    ...documentaryAiConfiguration(),
    timeoutMs: 300_000,
    endpoint: process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1",
  };
}
export function buildOperationalRuntimePlan(
  input: LotAssessmentInput,
  target: LotSourceTarget,
) {
  const context = resolveAssessmentSourceContext(
    input.snapshot,
    target,
    input.history,
    input.shapeState,
  );
  const request = buildOperationalEvidenceRequest(context),
    configuration = operationalRuntimeConfiguration(),
    task = buildOperationalReadingTask(request);
  const configHash = digest(configuration),
    requestHash = digest({
      version: OPERATIONAL_RUNTIME_VERSION,
      request: request.inputHash,
      task,
      provider: configuration.provider,
      model: configuration.model,
      effort: configuration.reasoningEffort,
      endpoint: configuration.endpoint,
    });
  return {
    context,
    request,
    task,
    configuration,
    configHash,
    requestHash,
    inputHash: digest({ requestHash, configHash }),
  };
}
export type OperationalRuntimePlan = ReturnType<
  typeof buildOperationalRuntimePlan
>;
export type StoredOperationalReading = {
  version: typeof OPERATIONAL_RUNTIME_VERSION;
  inputHash: string;
  configHash: string;
  requestHash: string;
  record: OperationalEvidenceRecord;
};
export function readOperationalRuntimeRecord(
  value: unknown,
  plan: OperationalRuntimePlan,
): OperationalEvidenceRecord | null {
  try {
    const v = value as StoredOperationalReading;
    if (
      v.version !== OPERATIONAL_RUNTIME_VERSION ||
      v.inputHash !== plan.inputHash ||
      v.configHash !== plan.configHash ||
      v.requestHash !== plan.requestHash ||
      v.record.model !== plan.configuration.model
    )
      return null;
    return readOperationalEvidence([v.record], plan.context);
  } catch {
    return null;
  }
}
export function wrapOperationalRecord(
  record: OperationalEvidenceRecord,
  plan: OperationalRuntimePlan,
): StoredOperationalReading {
  if (
    record.model !== plan.configuration.model ||
    !readOperationalEvidence([record], plan.context)
  )
    throw new Error("Operational record not current");
  return {
    version: OPERATIONAL_RUNTIME_VERSION,
    inputHash: plan.inputHash,
    configHash: plan.configHash,
    requestHash: plan.requestHash,
    record,
  };
}
export function needsOperationalReading(
  input: LotAssessmentInput,
  target: LotSourceTarget,
) {
  if (!operationalReadingEnabled() || target.kind !== "lot") return false;
  try {
    const plan = buildOperationalRuntimePlan(input, target);
    if (
      readOperationalEvidence(input.operationalReadings ?? [], plan.context) ||
      (input.operationalAttemptKeys ?? []).includes(plan.requestHash)
    )
      return false;
    const preliminary = preliminaryAssessmentMatch({
      publication: input.publication,
      profile: input.profile,
      context: plan.context,
      now: input.now,
    });
    return (
      preliminary.eligible &&
      (preliminary.operational.country === null ||
        preliminary.operational.canton === null ||
        preliminary.operational.deadline === null ||
        (!input.profile.zones.includes("Tutto il Ticino") &&
          preliminary.operational.zone === null))
    );
  } catch {
    return false;
  }
}
export function operationalBootstrapHash(
  comparisonHash: string,
  plan: OperationalRuntimePlan,
) {
  return digest({
    version: OPERATIONAL_RUNTIME_VERSION,
    comparisonHash,
    operational: plan.inputHash,
  });
}
// No cache consumption after revocation, disabled rollout or recipient change.
export async function readOperationalGrant(
  tx: SourceReviewExecutor,
  companyId: string,
) {
  if (!operationalReadingEnabled()) return null;
  const [allowed] = await tx
    .select({ id: companies.id, ownerId: companies.ownerId })
    .from(companies)
    .where(
      and(
        eq(companies.id, companyId),
        isNull(companies.disabledAt),
        companyAllowsAiProcessingSql("documentary"),
      ),
    )
    .limit(1);
  if (!allowed) return null;
  const [grant] = await tx
    .select({ id: aiProcessingReceipts.id })
    .from(aiProcessingReceipts)
    .where(
      and(
        eq(aiProcessingReceipts.companyId, companyId),
        eq(aiProcessingReceipts.userId, allowed.ownerId),
        eq(aiProcessingReceipts.recipient, AI_PROCESSING_RECIPIENT),
        eq(aiProcessingReceipts.noticeVersion, AI_PROCESSING_NOTICE_VERSION),
        eq(aiProcessingReceipts.noticeHash, AI_PROCESSING_NOTICE_HASH),
        isNull(aiProcessingReceipts.revokedAt),
        sql`${aiProcessingReceipts.acceptedAt}<=now()`,
      ),
    )
    .orderBy(desc(aiProcessingReceipts.acceptedAt), aiProcessingReceipts.id)
    .limit(1);
  return grant?.id ?? null;
}
export async function loadOperationalState(
  tx: SourceReviewExecutor,
  input: LotAssessmentInput,
  matchId: string,
  grantId: string | null,
) {
  const records: OperationalEvidenceRecord[] = [],
    attemptedKeys: string[] = [];
  if (!grantId || !operationalReadingEnabled())
    return { records, attemptedKeys };
  const rows = await tx
    .select({...getTableColumns(operationalReadingRuns),abandoned:sql<boolean>`${operationalReadingRuns.status}='running' and ${operationalReadingRuns.updatedAt}<now()-interval '10 minutes'`})
    .from(operationalReadingRuns)
    .where(
      and(
        eq(operationalReadingRuns.matchId, matchId),
        eq(operationalReadingRuns.companyId, input.companyId),
        eq(operationalReadingRuns.publicationId, input.publication.id),
      ),
    )
    .orderBy(operationalReadingRuns.createdAt, operationalReadingRuns.id);
  for (const row of rows) {
    try {
      const plan = buildOperationalRuntimePlan(input, row.target);
      if (row.status === "completed") {
        const record = readOperationalRuntimeRecord(row.result, plan);
        if (record) records.push(record);
        else if (row.inputHash === plan.inputHash)
          attemptedKeys.push(plan.requestHash);
      }
      if (
        row.requestHash === plan.requestHash &&
        (row.abandoned || ["rejected", "failed", "blocked", "superseded", "uncertain"].includes(row.status))
      )
        attemptedKeys.push(plan.requestHash);
    } catch {
      /* Stale source/configuration remains historical. */
    }
  }
  return { records, attemptedKeys: [...new Set(attemptedKeys)] };
}
export async function loadOperationalReadings(
  tx: SourceReviewExecutor,
  input: LotAssessmentInput,
  matchId: string,
  grantId: string | null,
) {
  return (await loadOperationalState(tx, input, matchId, grantId)).records;
}

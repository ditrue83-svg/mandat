import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { aiProcessingReceipts, companies } from "@/db/schema";
import {
  aiProvider,
  aiProviderConfiguration,
  type AiEnvironment,
} from "./ai-provider-config";
import { documentaryAiProvider } from "./documentary-ai-config";
import { companyAllowsPilotProcessingSql } from "./pilot-processing";
import { enqueueProfileMatching } from "./profile-matching";
import { HttpError } from "./viewer";
import {
  AI_PROCESSING_NOTICE,
  AI_PROCESSING_NOTICE_VERSION,
  AI_PROCESSING_RECIPIENT,
  type AiProcessingStatus,
} from "./ai-processing-notice";

export type CompanyAiPurpose = "documentary" | "legacy";
const noticeText = AI_PROCESSING_NOTICE.join("\n\n");
export const AI_PROCESSING_NOTICE_HASH = createHash("sha256")
  .update(
    JSON.stringify([
      AI_PROCESSING_NOTICE_VERSION,
      AI_PROCESSING_RECIPIENT,
      noticeText,
    ]),
  )
  .digest("hex");

// An OpenAI receipt must never authorize a differently configured recipient.
// Public-source processing has no company receipt requirement.
export function companyAiRecipient(
  purpose: CompanyAiPurpose,
  env: AiEnvironment = process.env,
) {
  const provider =
    purpose === "documentary"
      ? documentaryAiProvider(env)
      : aiProvider(env.LLM_PROVIDER);
  if (provider !== "openai") return null;
  aiProviderConfiguration(env, provider);
  return AI_PROCESSING_RECIPIENT;
}

const available = () => {
  try {
    return Boolean(
      companyAiRecipient("documentary") || companyAiRecipient("legacy"),
    );
  } catch {
    // A broken provider configuration must not prevent reading the profile
    // or revoking an existing permission. Worker checks still fail closed.
    return false;
  }
};
const currentReceipt = () =>
  and(
    eq(aiProcessingReceipts.recipient, AI_PROCESSING_RECIPIENT),
    eq(aiProcessingReceipts.noticeVersion, AI_PROCESSING_NOTICE_VERSION),
    eq(aiProcessingReceipts.noticeHash, AI_PROCESSING_NOTICE_HASH),
    isNull(aiProcessingReceipts.revokedAt),
    sql`${aiProcessingReceipts.acceptedAt} <= now()`,
  );

export function companyAllowsAiProcessingSql(purpose: CompanyAiPurpose) {
  if (!companyAiRecipient(purpose)) return sql<boolean>`false`;
  return sql<boolean>`exists (
    select 1 from ${aiProcessingReceipts}
    where ${aiProcessingReceipts.companyId} = ${companies.id}
      and ${aiProcessingReceipts.userId} = ${companies.ownerId}
      and ${currentReceipt()}
  )`;
}

export class CompanyAiProcessingBlocked extends Error {
  constructor() {
    super(
      "I nuovi confronti AI sono disattivati. Puoi attivarli dal profilo della ditta dopo aver letto l’informativa.",
    );
  }
}

export async function companyAllowsAiProcessing(
  companyId: string,
  purpose: CompanyAiPurpose,
) {
  const [row] = await getDb()
    .select({ id: companies.id })
    .from(companies)
    .where(
      and(
        eq(companies.id, companyId),
        isNull(companies.disabledAt),
        companyAllowsPilotProcessingSql(),
        companyAllowsAiProcessingSql(purpose),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function assertCompanyAiProcessing(
  companyId: string,
  purpose: CompanyAiPurpose,
) {
  if (!(await companyAllowsAiProcessing(companyId, purpose)))
    throw new CompanyAiProcessingBlocked();
}

export async function readAiProcessingStatus(
  companyId: string,
  userId: string,
): Promise<AiProcessingStatus> {
  const [receipt] = await getDb()
    .select({ acceptedAt: aiProcessingReceipts.acceptedAt })
    .from(aiProcessingReceipts)
    .where(
      and(
        eq(aiProcessingReceipts.companyId, companyId),
        eq(aiProcessingReceipts.userId, userId),
        currentReceipt(),
      ),
    )
    .limit(1);
  const configured = available();
  return {
    available: configured,
    active: Boolean(receipt),
    acceptedAt: receipt?.acceptedAt.toISOString() ?? null,
    noticeVersion: AI_PROCESSING_NOTICE_VERSION,
    noticeHash: AI_PROCESSING_NOTICE_HASH,
  };
}

export async function setCompanyAiProcessing(input: {
  companyId: string;
  userId: string;
  enabled: boolean;
  noticeVersion?: string;
  noticeHash?: string;
  confirmed?: boolean;
}) {
  if (
    input.enabled &&
    (input.confirmed !== true ||
      input.noticeVersion !== AI_PROCESSING_NOTICE_VERSION ||
      input.noticeHash !== AI_PROCESSING_NOTICE_HASH)
  )
    throw new HttpError(
      409,
      "L’informativa è cambiata. Ricarica la pagina e leggila prima di attivare l’AI.",
    );
  if (input.enabled && !available())
    throw new HttpError(409, "Il servizio AI non è ancora disponibile.");
  await getDb().transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(
          eq(companies.id, input.companyId),
          eq(companies.ownerId, input.userId),
          isNull(companies.disabledAt),
          companyAllowsPilotProcessingSql(),
        ),
      )
      .for("update");
    if (!owner) throw new HttpError(404, "Ditta non disponibile.");
    const owned = and(
      eq(aiProcessingReceipts.companyId, owner.id),
      eq(aiProcessingReceipts.userId, input.userId),
    );
    if (!input.enabled) {
      await tx
        .update(aiProcessingReceipts)
        .set({ revokedAt: new Date() })
        .where(and(owned, isNull(aiProcessingReceipts.revokedAt)));
      return;
    }
    const [existing] = await tx
      .select({ id: aiProcessingReceipts.id })
      .from(aiProcessingReceipts)
      .where(and(owned, currentReceipt()))
      .limit(1);
    if (existing) return;
    await tx.insert(aiProcessingReceipts).values({
      id: randomUUID(),
      companyId: owner.id,
      userId: input.userId,
      recipient: AI_PROCESSING_RECIPIENT,
      noticeVersion: AI_PROCESSING_NOTICE_VERSION,
      noticeHash: AI_PROCESSING_NOTICE_HASH,
      noticeText,
    });
    await enqueueProfileMatching(tx);
  });
  return readAiProcessingStatus(input.companyId, input.userId);
}

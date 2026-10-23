import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { settings } from "@/db/schema";
import {
  aiProviderConfiguration,
  type AiProvider,
} from "@/lib/ai-provider-config";
import { documentaryAiProvider } from "@/lib/documentary-ai-config";

function credentialFingerprint(provider: AiProvider) {
  const config = aiProviderConfiguration(process.env, provider);
  const key = process.env[config.apiKeyEnv];
  return key?.trim()
    ? createHash("sha256")
        .update("mandat-provider-admission\0" + provider + "\0" + key)
        .digest("hex")
    : null;
}
export async function providerAccessPaused(provider: AiProvider) {
  const fingerprint = credentialFingerprint(provider);
  if (!fingerprint) return true;
  const [row] = await getDb()
    .select()
    .from(settings)
    .where(eq(settings.key, `ai_access_blocked:${provider}`));
  if (!row) return false;
  if (!row.value || typeof row.value !== "object" || Array.isArray(row.value))
    throw new Error("Invalid provider admission record");
  const value = row.value as { credentialFingerprint?: unknown };
  if (
    typeof value.credentialFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.credentialFingerprint)
  )
    throw new Error("Invalid provider admission record");
  // Key rotation is explicit configuration; model/effort/rate changes do not
  // bypass the block. The record and all uncertainty reserves remain intact.
  return value.credentialFingerprint === fingerprint;
}
export const documentaryAccessPaused = () =>
  providerAccessPaused(documentaryAiProvider());

export async function recordProviderAccessBlock(
  provider: AiProvider,
  status: 401 | 403,
) {
  const fingerprint = credentialFingerprint(provider);
  if (!fingerprint) throw new Error("Provider credential unavailable");
  const value = {
    reason: "authentication_or_permission",
    httpStatus: status,
    credentialFingerprint: fingerprint,
    at: new Date().toISOString(),
  };
  await getDb()
    .insert(settings)
    .values({ key: `ai_access_blocked:${provider}`, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

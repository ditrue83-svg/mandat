export type AiProvider = "infomaniak" | "mistral-eu" | "anthropic";
export type AiEnvironment = Record<string, string | undefined>;

export const MISTRAL_EU_BASE_URL = "https://api.eu.mistral.ai/v1";
export const MISTRAL_LARGE_3_MODEL = "mistral-large-2512";
export const MISTRAL_MEDIUM_3_5_MODEL = "mistral-medium-2604";
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
export const CLAUDE_OPUS_5_5_MODEL = "claude-opus-5-5";
const legacyDefaultModel = "mistralai/Ministral-3-14B-Instruct-2512";

export function aiProvider(value?: string): AiProvider {
  if (!value || value === "infomaniak") return "infomaniak";
  if (value === "mistral-eu" || value === "anthropic") return value;
  throw new Error("Fornitore AI non supportato");
}

export function aiModel(
  env: AiEnvironment = process.env,
  provider = aiProvider(env.LLM_PROVIDER),
) {
  // A documentary provider override must not inherit another provider's model.
  return (
    (provider === aiProvider(env.LLM_PROVIDER) ? env.LLM_MODEL : undefined) ||
    (provider === "mistral-eu"
      ? MISTRAL_LARGE_3_MODEL
      : provider === "anthropic"
        ? CLAUDE_OPUS_5_5_MODEL
        : legacyDefaultModel)
  );
}

export function validateAiModel(provider: AiProvider, model: string) {
  // This ID is a pinned snapshot in Anthropic's current versioning scheme.
  if (provider === "anthropic" && model !== CLAUDE_OPUS_5_5_MODEL)
    throw new Error("Per Anthropic configurare claude-opus-5-5");
  // Dated ID only: aliases can change weights and invalidate quality checks.
  if (
    provider === "mistral-eu" &&
    ![MISTRAL_LARGE_3_MODEL, MISTRAL_MEDIUM_3_5_MODEL].includes(model)
  )
    throw new Error(
      "Per Mistral UE configurare mistral-large-2512 oppure mistral-medium-2604",
    );
}

export function anthropicReasoningEffort(value?: string) {
  if (!value) return "medium" as const;
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new Error(
    "Claude Opus 5.5 richiede ragionamento low, medium oppure high",
  );
}

export function mistralReasoningEffort(model: string, value?: string) {
  validateAiModel("mistral-eu", model);
  if (model === MISTRAL_LARGE_3_MODEL) {
    if (value && value !== "none")
      throw new Error("Mistral Large 3 non usa il ragionamento configurabile");
    return undefined;
  }
  if (!value || value === "none") return "none" as const;
  if (value === "high") return "high" as const;
  throw new Error("Mistral Medium 3.5 richiede ragionamento none oppure high");
}

// Contains configuration identifiers only, never credential values. Mistral
// has a separate key and endpoint; legacy Infomaniak settings cannot route it.
export function aiProviderConfiguration(
  env: AiEnvironment = process.env,
  provider = aiProvider(env.LLM_PROVIDER),
) {
  provider = aiProvider(provider);
  const base =
    provider === "anthropic"
      ? env.ANTHROPIC_API_BASE_URL || ANTHROPIC_BASE_URL
      : provider === "mistral-eu"
        ? env.MISTRAL_API_BASE_URL || MISTRAL_EU_BASE_URL
        : env.LLM_API_BASE_URL ||
          `https://api.infomaniak.com/2/ai/${env.INFOMANIAK_AI_PRODUCT_ID}/openai/v1`;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error("Endpoint AI non valido");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "L’endpoint AI deve usare HTTPS senza credenziali o parametri",
    );
  const baseUrl = url.href.replace(/\/$/, "");
  if (provider === "anthropic" && baseUrl !== ANTHROPIC_BASE_URL)
    throw new Error("Anthropic richiede l’endpoint api.anthropic.com/v1");
  if (provider === "mistral-eu" && baseUrl !== MISTRAL_EU_BASE_URL)
    throw new Error(
      "Mistral richiede l’endpoint regionale UE api.eu.mistral.ai/v1",
    );
  return {
    provider,
    baseUrl,
    apiKeyEnv:
      provider === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : provider === "mistral-eu"
          ? "MISTRAL_API_KEY"
          : "LLM_API_KEY",
  } as const;
}

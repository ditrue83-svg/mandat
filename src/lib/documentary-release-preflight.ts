import {
  aiProviderConfiguration,
  type AiEnvironment,
} from "./ai-provider-config";
import {
  documentaryAiConfiguration,
  documentarySourceReasoningEffort,
} from "./documentary-ai-config";
import {
  assertDocumentaryAdoptionActivation,
  DOCUMENTARY_ADOPTION_CONSUMERS,
} from "./documentary-adoption";

// Operator preflight for a coordinated, single-build Luna rollout. This does
// not certify image identity, process drain, credential lifetime or AI quality.
export function assertLunaReleaseConfiguration(
  env: AiEnvironment,
  attestation: unknown,
  expectedBuild: string,
) {
  function require(condition: boolean, code: string): asserts condition {
    if (!condition) throw new Error(code);
  }
  require(/^[a-f0-9]{40}$/.test(expectedBuild), "EXPECTED_BUILD_INVALID");
  require(env.MANDAT_BUILD_ID === expectedBuild, "BUILD_MISMATCH");
  require(env.APP_MODE === "live", "LIVE_MODE_REQUIRED");
  require(env.DOCUMENTARY_COMPARISON_ENABLED === "true", "COMPARISON_DISABLED");
  require(env.DOCUMENTARY_OPERATIONAL_READING_ENABLED === "true", "OPERATIONAL_READING_DISABLED");
  require(Boolean(
    env.MANDAT_DOCUMENTARY_RELEASE_FILE?.trim(),
  ), "ATTESTATION_PATH_REQUIRED");
  require(env.DOCUMENTARY_LLM_PROVIDER ===
    "openai", "EXPLICIT_OPENAI_REQUIRED");
  require(env.DOCUMENTARY_LLM_MODEL === "gpt-6-luna", "EXPLICIT_LUNA_REQUIRED");
  require(env.DOCUMENTARY_LLM_REASONING_EFFORT ===
    "high", "COMPARISON_REVIEW_EFFORT_MISMATCH");
  require(env.DOCUMENTARY_SOURCE_REASONING_EFFORT ===
    "medium", "SOURCE_EFFORT_MISMATCH");
  const configuration = documentaryAiConfiguration(env);
  const endpoint = aiProviderConfiguration(env, configuration.provider);
  require(endpoint.baseUrl ===
    "https://api.openai.com/v1", "ENDPOINT_MISMATCH");
  require(Boolean(env.OPENAI_API_KEY?.trim()), "RUNTIME_CREDENTIAL_MISSING");
  require(configuration.rates.input === 0.15 &&
    configuration.rates.output === 0.75, "BASELINE_RATES_MISMATCH");
  require(Number(env.AI_MONTHLY_BUDGET_CHF) === 10, "MONTHLY_CAP_MISMATCH");
  const activation = assertDocumentaryAdoptionActivation({
    enabled: true,
    attestation,
  });
  for (const consumer of DOCUMENTARY_ADOPTION_CONSUMERS)
    require(activation.attestation.consumers[consumer].buildId ===
      expectedBuild, "CONSUMER_BUILD_MISMATCH");
  return {
    status: "configuration_valid" as const,
    buildId: expectedBuild,
    provider: configuration.provider,
    model: configuration.model,
    comparisonAndReviewEffort: configuration.reasoningEffort,
    sourceEffort: documentarySourceReasoningEffort(env),
    mapEffort: "none" as const,
    endpoint: `${endpoint.baseUrl}/responses`,
    rates: configuration.rates,
    monthlyCapChf: 10,
    attestationReleaseId: activation.attestation.releaseId,
    // No credential values or full environment are returned.
    runtimeCredentialPresent: true,
    providerCalls: 0,
    releaseReady: false,
  };
}

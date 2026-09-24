import {
  aiModel,
  aiProvider,
  validateAiModel,
  mistralReasoningEffort,
  type AiEnvironment,
} from "./ai-provider-config";

// A dedicated comparison provider must not change legacy summaries or prices.
export function documentaryAiProvider(env: AiEnvironment = process.env) {
  return aiProvider(env.DOCUMENTARY_LLM_PROVIDER || env.LLM_PROVIDER);
}
export function documentaryAiModel(env: AiEnvironment = process.env) {
  const provider = documentaryAiProvider(env);
  const model = env.DOCUMENTARY_LLM_MODEL || aiModel(env, provider);
  validateAiModel(provider, model);
  return model;
}
export function documentaryAiReasoningEffort(
  env: AiEnvironment = process.env,
): "none" | "low" | "medium" | "high" | undefined {
  const provider = documentaryAiProvider(env);
  const value =
    env.DOCUMENTARY_LLM_REASONING_EFFORT ||
    (provider === aiProvider(env.LLM_PROVIDER)
      ? env.LLM_REASONING_EFFORT
      : undefined);
  if (provider === "mistral-eu") {
    return mistralReasoningEffort(documentaryAiModel(env), value) ?? "none";
  }
  if (!value) return undefined;
  if (
    value !== "none" &&
    value !== "low" &&
    value !== "medium" &&
    value !== "high"
  )
    throw new Error("Modalità di ragionamento del confronto non valida");
  return value;
}
// Source extraction has its own setting: it must never inherit thinking from
// the final company comparison or from the legacy summary configuration.
export function documentarySourceReasoningEffort(
  env: AiEnvironment = process.env,
): "none" | "low" | "medium" | "high" {
  const value = env.DOCUMENTARY_SOURCE_REASONING_EFFORT || "none";
  if (documentaryAiProvider(env) === "mistral-eu")
    return mistralReasoningEffort(documentaryAiModel(env), value) ?? "none";
  if (
    value !== "none" &&
    value !== "low" &&
    value !== "medium" &&
    value !== "high"
  )
    throw new Error("Modalità di ragionamento della fonte non valida");
  return value;
}
export function documentaryAiConfiguration(env: AiEnvironment = process.env) {
  const dedicated = Boolean(
    env.DOCUMENTARY_LLM_MODEL || env.DOCUMENTARY_LLM_PROVIDER,
  );
  const input = Number(
    dedicated
      ? env.DOCUMENTARY_LLM_INPUT_CHF_PER_MILLION
      : env.LLM_INPUT_CHF_PER_MILLION,
  );
  const output = Number(
    dedicated
      ? env.DOCUMENTARY_LLM_OUTPUT_CHF_PER_MILLION
      : env.LLM_OUTPUT_CHF_PER_MILLION,
  );
  if (
    !Number.isFinite(input) ||
    input <= 0 ||
    !Number.isFinite(output) ||
    output <= 0
  )
    throw new Error("Configurare le tariffe del modello di confronto");
  return {
    provider: documentaryAiProvider(env),
    model: documentaryAiModel(env),
    reasoningEffort: documentaryAiReasoningEffort(env),
    rates: { input, output },
  };
}

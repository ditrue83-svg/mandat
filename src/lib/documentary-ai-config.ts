// A larger comparison model must not silently change the existing summary
// and legacy classification paths, their output limits, or their prices.
export function documentaryAiModel() {
  return (
    process.env.DOCUMENTARY_LLM_MODEL ||
    process.env.LLM_MODEL ||
    "mistralai/Ministral-3-14B-Instruct-2512"
  );
}
export function documentaryAiReasoningEffort():
  "none" | "low" | "medium" | "high" | undefined {
  const value =
    process.env.DOCUMENTARY_LLM_REASONING_EFFORT ||
    process.env.LLM_REASONING_EFFORT;
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
export function documentaryAiConfiguration() {
  const dedicated = Boolean(process.env.DOCUMENTARY_LLM_MODEL);
  const input = Number(
    dedicated
      ? process.env.DOCUMENTARY_LLM_INPUT_CHF_PER_MILLION
      : process.env.LLM_INPUT_CHF_PER_MILLION,
  );
  const output = Number(
    dedicated
      ? process.env.DOCUMENTARY_LLM_OUTPUT_CHF_PER_MILLION
      : process.env.LLM_OUTPUT_CHF_PER_MILLION,
  );
  if (
    !Number.isFinite(input) ||
    input <= 0 ||
    !Number.isFinite(output) ||
    output <= 0
  )
    throw new Error("Configurare le tariffe del modello di confronto");
  return {
    model: documentaryAiModel(),
    reasoningEffort: documentaryAiReasoningEffort(),
    rates: { input, output },
  };
}

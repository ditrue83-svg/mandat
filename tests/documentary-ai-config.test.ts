import { afterEach, expect, it, vi } from "vitest";
import { documentaryAiConfiguration } from "../src/lib/documentary-ai-config";
afterEach(() => vi.unstubAllEnvs());
it("requires dedicated prices and preserves the legacy model configuration", () => {
  vi.stubEnv("LLM_MODEL", "legacy-model");
  vi.stubEnv("LLM_INPUT_CHF_PER_MILLION", "1");
  vi.stubEnv("LLM_OUTPUT_CHF_PER_MILLION", "2");
  vi.stubEnv("DOCUMENTARY_LLM_MODEL", "comparison-model");
  vi.stubEnv("DOCUMENTARY_LLM_REASONING_EFFORT", "high");
  vi.stubEnv("DOCUMENTARY_LLM_INPUT_CHF_PER_MILLION", "");
  vi.stubEnv("DOCUMENTARY_LLM_OUTPUT_CHF_PER_MILLION", "");
  expect(() => documentaryAiConfiguration()).toThrow("tariffe");
  vi.stubEnv("DOCUMENTARY_LLM_INPUT_CHF_PER_MILLION", "0.4");
  vi.stubEnv("DOCUMENTARY_LLM_OUTPUT_CHF_PER_MILLION", "3.2");
  expect(documentaryAiConfiguration()).toEqual({
    model: "comparison-model",
    reasoningEffort: "high",
    rates: { input: 0.4, output: 3.2 },
  });
  expect(process.env.LLM_MODEL).toBe("legacy-model");
  expect(process.env.LLM_OUTPUT_CHF_PER_MILLION).toBe("2");
});

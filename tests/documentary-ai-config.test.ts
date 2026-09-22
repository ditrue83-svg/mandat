import { afterEach, expect, it, vi } from "vitest";
import {
  documentaryAiConfiguration,
  documentarySourceReasoningEffort,
} from "../src/lib/documentary-ai-config";
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

it("keeps source thinking off independently of comparison and legacy settings", () => {
  vi.stubEnv("DOCUMENTARY_SOURCE_REASONING_EFFORT", "");
  vi.stubEnv("DOCUMENTARY_LLM_REASONING_EFFORT", "high");
  vi.stubEnv("LLM_REASONING_EFFORT", "high");
  expect(documentarySourceReasoningEffort()).toBe("none");
  vi.stubEnv("DOCUMENTARY_LLM_REASONING_EFFORT", "low");
  expect(documentarySourceReasoningEffort()).toBe("none");
  vi.stubEnv("DOCUMENTARY_SOURCE_REASONING_EFFORT", "high");
  expect(documentarySourceReasoningEffort()).toBe("high");
  expect(process.env.DOCUMENTARY_LLM_REASONING_EFFORT).toBe("low");
  expect(process.env.LLM_REASONING_EFFORT).toBe("high");
});

it("rejects invalid source settings without treating them as provider defaults", () => {
  vi.stubEnv("DOCUMENTARY_SOURCE_REASONING_EFFORT", "disabled");
  expect(() => documentarySourceReasoningEffort()).toThrow("fonte non valida");
});

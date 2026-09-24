import { afterEach, expect, it, vi } from "vitest";
import {
  documentaryAiConfiguration,
  documentarySourceReasoningEffort,
} from "../src/lib/documentary-ai-config";
afterEach(() => vi.unstubAllEnvs());
it("configures Claude reasoning independently and requires its own prices", () => {
  const env = {
    LLM_REASONING_EFFORT: "none",
    DOCUMENTARY_LLM_PROVIDER: "anthropic",
  };
  expect(() => documentaryAiConfiguration(env)).toThrow("tariffe");
  expect(documentarySourceReasoningEffort(env)).toBe("medium");
  expect(
    documentaryAiConfiguration({
      ...env,
      DOCUMENTARY_LLM_INPUT_CHF_PER_MILLION: "5",
      DOCUMENTARY_LLM_OUTPUT_CHF_PER_MILLION: "25",
      DOCUMENTARY_LLM_REASONING_EFFORT: "high",
    }),
  ).toEqual({
    provider: "anthropic",
    model: "claude-opus-5-5",
    reasoningEffort: "high",
    rates: { input: 5, output: 25 },
  });
  expect(() =>
    documentarySourceReasoningEffort({
      ...env,
      DOCUMENTARY_SOURCE_REASONING_EFFORT: "none",
    }),
  ).toThrow();
});
it("keeps Medium source and comparison reasoning independently configurable", () => {
  const env = {
    DOCUMENTARY_LLM_PROVIDER: "mistral-eu",
    DOCUMENTARY_LLM_MODEL: "mistral-medium-2604",
    DOCUMENTARY_LLM_INPUT_CHF_PER_MILLION: "2",
    DOCUMENTARY_LLM_OUTPUT_CHF_PER_MILLION: "10",
    DOCUMENTARY_LLM_REASONING_EFFORT: "high",
  };
  expect(documentaryAiConfiguration(env)).toEqual({
    provider: "mistral-eu",
    model: "mistral-medium-2604",
    reasoningEffort: "high",
    rates: { input: 2, output: 10 },
  });
  expect(documentarySourceReasoningEffort(env)).toBe("none");
  expect(
    documentarySourceReasoningEffort({
      ...env,
      DOCUMENTARY_SOURCE_REASONING_EFFORT: "high",
    }),
  ).toBe("high");
  expect(() =>
    documentarySourceReasoningEffort({
      ...env,
      DOCUMENTARY_SOURCE_REASONING_EFFORT: "low",
    }),
  ).toThrow();
});
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
    provider: "infomaniak",
    model: "comparison-model",
    reasoningEffort: "high",
    rates: { input: 0.4, output: 3.2 },
  });
  expect(process.env.LLM_MODEL).toBe("legacy-model");
  expect(process.env.LLM_OUTPUT_CHF_PER_MILLION).toBe("2");
});

it("uses Mistral UE for the documentary path without inheriting Qwen settings or prices", () => {
  const env = {
    LLM_MODEL: "legacy-qwen-model",
    LLM_REASONING_EFFORT: "high",
    LLM_INPUT_CHF_PER_MILLION: "1",
    LLM_OUTPUT_CHF_PER_MILLION: "8",
    DOCUMENTARY_LLM_PROVIDER: "mistral-eu",
  };
  expect(() => documentaryAiConfiguration(env)).toThrow("tariffe");
  expect(
    documentaryAiConfiguration({
      ...env,
      DOCUMENTARY_LLM_INPUT_CHF_PER_MILLION: "0.6",
      DOCUMENTARY_LLM_OUTPUT_CHF_PER_MILLION: "1.8",
    }),
  ).toEqual({
    provider: "mistral-eu",
    model: "mistral-large-2512",
    reasoningEffort: "none",
    rates: { input: 0.6, output: 1.8 },
  });
  expect(documentarySourceReasoningEffort(env)).toBe("none");
});

it("rejects stale documentary models and thinking settings for Mistral", () => {
  const env = {
    DOCUMENTARY_LLM_PROVIDER: "mistral-eu",
    DOCUMENTARY_LLM_INPUT_CHF_PER_MILLION: "1",
    DOCUMENTARY_LLM_OUTPUT_CHF_PER_MILLION: "2",
  };
  for (const model of ["mistral-large-latest", "previous-qwen-model"])
    expect(() =>
      documentaryAiConfiguration({ ...env, DOCUMENTARY_LLM_MODEL: model }),
    ).toThrow("mistral-large-2512");
  expect(() =>
    documentaryAiConfiguration({
      ...env,
      DOCUMENTARY_LLM_REASONING_EFFORT: "high",
    }),
  ).toThrow("ragionamento");
  expect(() =>
    documentarySourceReasoningEffort({
      ...env,
      DOCUMENTARY_SOURCE_REASONING_EFFORT: "high",
    }),
  ).toThrow("ragionamento");
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

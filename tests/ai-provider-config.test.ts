import { expect, it } from "vitest";
import {
  aiModel,
  aiProvider,
  aiProviderConfiguration,
  MISTRAL_EU_BASE_URL,
  MISTRAL_LARGE_3_MODEL,
  MISTRAL_MEDIUM_3_5_MODEL,
  validateAiModel,
  mistralReasoningEffort,
} from "../src/lib/ai-provider-config";

const legacy = {
  LLM_MODEL: "legacy-model",
  LLM_API_KEY: "legacy-secret-never-print",
  LLM_API_BASE_URL: "https://api.infomaniak.com/2/ai/123/openai/v1",
  MISTRAL_API_KEY: "mistral-secret-never-print",
};

it("pins Medium 3.5 and permits only its documented reasoning levels", () => {
  expect(() =>
    validateAiModel("mistral-eu", MISTRAL_MEDIUM_3_5_MODEL),
  ).not.toThrow();
  expect(mistralReasoningEffort(MISTRAL_MEDIUM_3_5_MODEL, "high")).toBe("high");
  expect(mistralReasoningEffort(MISTRAL_MEDIUM_3_5_MODEL)).toBe("none");
  for (const level of ["low", "medium", "invalid"])
    expect(() =>
      mistralReasoningEffort(MISTRAL_MEDIUM_3_5_MODEL, level),
    ).toThrow();
  for (const model of ["mistral-medium-latest", "mistral-medium-3-5"])
    expect(() => validateAiModel("mistral-eu", model)).toThrow();
  expect(() => mistralReasoningEffort(MISTRAL_LARGE_3_MODEL, "high")).toThrow();
  expect(mistralReasoningEffort(MISTRAL_LARGE_3_MODEL, "none")).toBeUndefined();
});

it("isolates a Mistral override from the legacy endpoint, model and credential", () => {
  expect(aiProviderConfiguration(legacy, "mistral-eu")).toEqual({
    provider: "mistral-eu",
    baseUrl: MISTRAL_EU_BASE_URL,
    apiKeyEnv: "MISTRAL_API_KEY",
  });
  expect(aiModel(legacy, "mistral-eu")).toBe(MISTRAL_LARGE_3_MODEL);
  expect(aiProviderConfiguration(legacy).baseUrl).toBe(legacy.LLM_API_BASE_URL);
  const output = JSON.stringify(aiProviderConfiguration(legacy, "mistral-eu"));
  expect(output).not.toContain(legacy.LLM_API_KEY);
  expect(output).not.toContain(legacy.MISTRAL_API_KEY);
});

it.each([
  "https://api.mistral.ai/v1",
  "https://api.us.mistral.ai/v1",
  "http://api.eu.mistral.ai/v1",
  "https://api.eu.mistral.ai.evil.example/v1",
  "https://api.eu.mistral.ai:8443/v1",
  "https://api.eu.mistral.ai/v1/other",
  "https://user:secret@api.eu.mistral.ai/v1",
  "https://api.eu.mistral.ai/v1?key=secret",
  "https://api.eu.mistral.ai/v1#fragment",
])(
  "rejects a Mistral endpoint outside the approved regional API: %s",
  (base) => {
    expect(() =>
      aiProviderConfiguration({ MISTRAL_API_BASE_URL: base }, "mistral-eu"),
    ).toThrow();
  },
);

it("does not fall back when the provider name is invalid", () => {
  expect(() => aiProvider("mistral-global")).toThrow("Fornitore AI");
});

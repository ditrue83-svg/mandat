import { expect, test, vi } from "vitest";
vi.mock("@/db", () => ({
  getDb: () => {
    throw new Error("DB forbidden");
  },
}));
import { assertLunaReleaseConfiguration } from "../src/lib/documentary-release-preflight";
import {
  DOCUMENTARY_ADOPTION_CONSUMERS,
  DOCUMENTARY_ADOPTION_CAPABILITY,
  DOCUMENTARY_RELEASE_ATTESTATION_VERSION,
} from "../src/lib/documentary-capability";
const build = "a".repeat(40);
function env() {
  return {
    APP_MODE: "live",
    MANDAT_BUILD_ID: build,
    MANDAT_DOCUMENTARY_RELEASE_FILE: "/invented/release.json",
    DOCUMENTARY_COMPARISON_ENABLED: "true",
    DOCUMENTARY_OPERATIONAL_READING_ENABLED: "true",
    DOCUMENTARY_LLM_PROVIDER: "openai",
    DOCUMENTARY_LLM_MODEL: "gpt-6-luna",
    DOCUMENTARY_LLM_REASONING_EFFORT: "high",
    DOCUMENTARY_SOURCE_REASONING_EFFORT: "medium",
    DOCUMENTARY_LLM_INPUT_CHF_PER_MILLION: "0.15",
    DOCUMENTARY_LLM_OUTPUT_CHF_PER_MILLION: "0.75",
    OPENAI_API_KEY: "invented-test-value-not-a-credential",
    AI_MONTHLY_BUDGET_CHF: "10",
  };
}
function attestation() {
  return {
    version: DOCUMENTARY_RELEASE_ATTESTATION_VERSION,
    releaseId: "invented-test-release",
    verifiedAt: "2026-10-10T08:00:00Z",
    evidenceId: "invented-drain-record",
    previousProcessesDrained: true,
    consumers: Object.fromEntries(
      DOCUMENTARY_ADOPTION_CONSUMERS.map((c) => [
        c,
        { capability: DOCUMENTARY_ADOPTION_CAPABILITY, buildId: build },
      ]),
    ),
  };
}
test("explicit baseline passes offline without leaking a credential or claiming release readiness", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Network forbidden");
  });
  try {
    const result = assertLunaReleaseConfiguration(env(), attestation(), build);
    expect(result).toMatchObject({
      provider: "openai",
      model: "gpt-6-luna",
      sourceEffort: "medium",
      comparisonAndReviewEffort: "high",
      mapEffort: "none",
      releaseReady: false,
      providerCalls: 0,
    });
    expect(JSON.stringify(result)).not.toContain(env().OPENAI_API_KEY);
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
});
test.each([
  ["APP_MODE", "demo"],
  ["MANDAT_BUILD_ID", "development"],
  ["DOCUMENTARY_COMPARISON_ENABLED", "false"],
  ["DOCUMENTARY_OPERATIONAL_READING_ENABLED", "false"],
  ["DOCUMENTARY_OPERATIONAL_READING_ENABLED", ""],
  ["DOCUMENTARY_COMPARISON_ENABLED", ""],
  ["MANDAT_DOCUMENTARY_RELEASE_FILE", ""],
  ["DOCUMENTARY_LLM_PROVIDER", ""],
  ["DOCUMENTARY_LLM_PROVIDER", "infomaniak"],
  ["DOCUMENTARY_LLM_MODEL", "gpt-6-luna-latest"],
  ["DOCUMENTARY_LLM_REASONING_EFFORT", "medium"],
  ["DOCUMENTARY_SOURCE_REASONING_EFFORT", "none"],
  ["OPENAI_API_KEY", ""],
  ["OPENAI_API_BASE_URL", "https://example.invalid/v1"],
  ["DOCUMENTARY_LLM_INPUT_CHF_PER_MILLION", "0"],
  ["DOCUMENTARY_LLM_OUTPUT_CHF_PER_MILLION", "0.5"],
  ["AI_MONTHLY_BUDGET_CHF", "11"],
])("blocks configuration drift: %s=%s", (key, value) => {
  expect(() =>
    assertLunaReleaseConfiguration(
      { ...env(), [key]: value },
      attestation(),
      build,
    ),
  ).toThrow();
});
test.each(DOCUMENTARY_ADOPTION_CONSUMERS)(
  "checks the coordinated build of %s, including web consumers",
  (consumer) => {
    const record = attestation();
    record.consumers[consumer].buildId = "b".repeat(40);
    expect(() => assertLunaReleaseConfiguration(env(), record, build)).toThrow(
      "CONSUMER_BUILD_MISMATCH",
    );
  },
);
test("rejects missing/malformed attestation and absent expected build even if health would be 200", () => {
  for (const record of [
    undefined,
    {},
    { ...attestation(), previousProcessesDrained: false },
  ])
    expect(() =>
      assertLunaReleaseConfiguration(env(), record, build),
    ).toThrow();
  expect(() =>
    assertLunaReleaseConfiguration(env(), attestation(), ""),
  ).toThrow("EXPECTED_BUILD_INVALID");
});

import { expect, it } from "vitest";
import { z } from "zod";
import {
  anthropicJsonSchema,
  anthropicMessageBody,
  anthropicMessageProjection,
} from "../src/lib/anthropic-messages";

it("translates unsupported constraints without mutating local validation or field names", () => {
  const validator = z
    .object({
      maxLength: z.string().min(3).max(8),
      values: z.array(z.number().min(2).max(7)).min(2).max(4),
    })
    .strict();
  const schema = z.toJSONSchema(validator);
  const original = structuredClone(schema);
  const wire = anthropicJsonSchema(schema);
  const properties = wire.properties as Record<string, Record<string, unknown>>;
  expect(properties.maxLength).toMatchObject({
    type: "string",
    description: expect.stringContaining("maxLength=8"),
  });
  expect(properties.maxLength.minLength).toBeUndefined();
  expect(properties.values).toMatchObject({
    minItems: 1,
    description: expect.stringContaining("minItems=2"),
  });
  expect(properties.values.maxItems).toBeUndefined();
  expect(schema).toEqual(original);
  expect(validator.safeParse({ maxLength: "x", values: [1] }).success).toBe(
    false,
  );
});

it("preserves exact references, enums and required properties", () => {
  const schema = {
    type: "object",
    properties: { answer: { $ref: "#/$defs/answer" } },
    required: ["answer"],
    additionalProperties: false,
    $defs: { answer: { type: "string", enum: ["s1", "f0"], maxLength: 12 } },
  };
  const wire = anthropicJsonSchema(schema);
  expect(wire.properties).toEqual(schema.properties);
  expect(wire.required).toEqual(["answer"]);
  expect(
    (wire.$defs as Record<string, Record<string, unknown>>).answer.enum,
  ).toEqual(["s1", "f0"]);
});

it.each([
  { $ref: "https://elsewhere.example/schema" },
  { $ref: "#/$defs/absent" },
  {
    type: "object",
    properties: { next: { $ref: "#/$defs/node" } },
    additionalProperties: false,
    $defs: { node: { $ref: "#/$defs/node" } },
  },
  { type: "object", additionalProperties: true },
  { type: "array", contains: { type: "string" } },
  { type: "string", pattern: "(?=x)" },
])("rejects unsupported schemas before transmission: %j", (schema) => {
  expect(() => anthropicJsonSchema(schema)).toThrow();
});

it("builds native structured output requests without sampling, cache or tools", () => {
  const body = anthropicMessageBody(
    "claude-opus-5-5",
    "instructions",
    "source",
    8192,
    {
      type: "json_schema",
      json_schema: {
        name: "reading",
        strict: true,
        schema: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    "high",
  );
  expect(body).toMatchObject({
    system: "instructions",
    messages: [{ role: "user", content: "source" }],
    thinking: { type: "adaptive", display: "omitted" },
    output_config: { effort: "high", format: { type: "json_schema" } },
    inference_geo: "global",
    service_tier: "standard_only",
    max_tokens: 8192,
  });
  for (const key of [
    "temperature",
    "top_p",
    "tools",
    "cache_control",
    "response_format",
  ])
    expect(body).not.toHaveProperty(key);
  expect(() =>
    anthropicMessageBody("claude-opus-5-5", "s", "p", 8192, undefined, "none"),
  ).toThrow();
  expect(() => anthropicMessageBody("claude-opus-5-5", "s", "p", 0)).toThrow();
});

it("discards reasoning, signatures and refusal prose while preserving reported usage", () => {
  const projection = anthropicMessageProjection({
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    stop_reason: "refusal",
    content: [
      {
        type: "thinking",
        thinking: "private-thought",
        signature: "private-signature",
      },
      { type: "text", text: "{}" },
    ],
    stop_details: { type: "refusal", explanation: "private-refusal" },
    usage: {
      input_tokens: 12,
      output_tokens: 100,
      cache_read_input_tokens: 50,
    },
  });
  expect(projection.usage).toEqual({
    prompt_tokens: 62,
    completion_tokens: 100,
  });
  expect(JSON.stringify(projection)).not.toContain("private-");
  expect(projection.choices).toEqual([
    { finish_reason: "stop", message: { content: "{}", refusal: "" } },
  ]);
});

it("does not under-account unexpected cache writes or overflowing usage", () => {
  for (const usage of [
    { input_tokens: 12, output_tokens: 100, cache_creation_input_tokens: 1 },
    { input_tokens: 2147483647, cache_read_input_tokens: 1, output_tokens: 10 },
  ])
    expect(anthropicMessageProjection({ usage }).usage).toBeUndefined();
});

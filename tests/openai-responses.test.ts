import { expect, it } from "vitest";
import {
  openaiResponseBody,
  openaiResponseProjection,
  openaiJsonSchema,
} from "../src/lib/openai-responses";
import { z } from "zod";

function response() {
  return {
    object: "response",
    model: "gpt-6-luna",
    service_tier: "default",
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [
      { type: "reasoning", summary: [{ text: "private-reasoning" }] },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        phase: "final_answer",
        content: [
          {
            type: "output_text",
            text: '{"accepted":true}',
            annotations: [{ private: "annotation" }],
          },
        ],
      },
    ],
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 60 },
      output_tokens: 500,
      output_tokens_details: { reasoning_tokens: 400 },
      total_tokens: 600,
    },
  };
}

it("keeps instructions and source separate with the original local constraints", () => {
  const schema = {
    type: "object",
    properties: { text: { type: "string", minLength: 4, maxLength: 40 } },
    required: ["text"],
    additionalProperties: false,
  };
  const before = structuredClone(schema);
  const body = openaiResponseBody(
    "gpt-6-luna",
    "instructions",
    "untrusted source",
    8192,
    {
      type: "json_schema",
      json_schema: { name: "reading", strict: true, schema },
    },
    "high",
  );
  expect(body).toMatchObject({
    input: [
      { role: "developer", content: "instructions" },
      { role: "user", content: "untrusted source" },
    ],
    reasoning: { effort: "high" },
    max_output_tokens: 8192,
    text: {
      format: {
        type: "json_schema",
        name: "reading",
        strict: true,
        schema: {
          ...before,
          properties: {
            text: {
              type: "string",
              description: "Required constraints: minLength=4; maxLength=40.",
            },
          },
        },
      },
    },
    service_tier: "default",
    store: false,
    background: false,
    truncation: "disabled",
    prompt_cache_options: { mode: "explicit" },
  });
  expect(schema).toEqual(before);
  for (const key of [
    "temperature",
    "top_p",
    "tools",
    "previous_response_id",
    "include",
  ])
    expect(body).not.toHaveProperty(key);
});

it("preserves local validation and rejects unsupported schemas before spending", () => {
  const validator = z.object({ minLength: z.string().min(4).max(40) }).strict();
  const schema = z.toJSONSchema(validator);
  const original = structuredClone(schema);
  const result = openaiJsonSchema(schema);
  expect(result.properties).toHaveProperty("minLength");
  expect(validator.safeParse({ minLength: "x" }).success).toBe(false);
  expect(schema).toEqual(original);
  for (const invalid of [
    {
      type: "object",
      properties: { x: { type: "string" } },
      required: [],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: true,
    },
    { ...schema, allOf: [] },
    {
      ...schema,
      properties: { minLength: { $ref: "https://external.example/schema" } },
    },
  ])
    expect(() => openaiJsonSchema(invalid)).toThrow();
});

it("refuses long-input pricing, other models and invalid output limits before transmission", () => {
  expect(() =>
    openaiResponseBody("gpt-6-luna", "s", "è".repeat(100_000), 8192),
  ).toThrow("grande");
  expect(() => openaiResponseBody("other-model", "s", "p", 8192)).toThrow();
  for (const limit of [0, 15, 128_001, 16.5, Infinity])
    expect(() => openaiResponseBody("gpt-6-luna", "s", "p", limit)).toThrow();
});

it("returns only final text with literal usage inclusive of reasoning and cache", () => {
  const projected = openaiResponseProjection(response());
  expect(projected).toEqual({
    model: "gpt-6-luna",
    usage: { prompt_tokens: 100, completion_tokens: 500 },
    choices: [
      { finish_reason: "stop", message: { content: '{"accepted":true}' } },
    ],
  });
  expect(JSON.stringify(projected)).not.toContain("private");
});

it.each([
  ["incomplete", "max_output_tokens", "length"],
  ["incomplete", "content_filter", "content_filter"],
  ["failed", null, "other"],
  ["in_progress", null, "other"],
])(
  "rejects %s responses while retaining known usage",
  (status, reason, finish) => {
    const projected = openaiResponseProjection({
      ...response(),
      status,
      incomplete_details: reason ? { reason } : null,
    });
    expect(projected).toMatchObject({
      usage: { prompt_tokens: 100, completion_tokens: 500 },
      choices: [{ finish_reason: finish }],
    });
  },
);

it("rejects refusals without copying their prose", () => {
  const body = response();
  const message = body.output[1];
  const projected = openaiResponseProjection({
    ...body,
    output: [
      {
        ...message,
        content: [{ type: "refusal", refusal: "private-refusal" }],
      },
    ],
  });
  expect(projected.choices).toEqual([
    { finish_reason: "stop", message: { content: "", refusal: "" } },
  ]);
  expect(JSON.stringify(projected)).not.toContain("private");
});

it("rejects tools, multiple messages, commentary and reasoning after final text", () => {
  const body = response();
  for (const output of [
    [...body.output, { type: "function_call", arguments: "private-tool" }],
    [body.output[1], body.output[1]],
    [{ ...body.output[1], phase: "commentary" }],
    [body.output[1], body.output[0]],
  ]) {
    const result = openaiResponseProjection({ ...body, output });
    expect(result).toMatchObject({
      usage: { prompt_tokens: 100 },
      choices: [{ message: { content: null } }],
    });
    expect(JSON.stringify(result)).not.toContain("private");
  }
});

it("keeps the reservation when billing counters or service tiers cannot be priced", () => {
  const body = response();
  for (const change of [
    { service_tier: "priority" },
    { usage: { ...body.usage, total_tokens: 599 } },
    {
      usage: {
        ...body.usage,
        input_tokens_details: { cached_tokens: 60, cache_write_tokens: 60 },
      },
    },
    { usage: { ...body.usage, input_tokens_details: { cached_tokens: 20 } } },
    {
      usage: {
        ...body.usage,
        output_tokens_details: { reasoning_tokens: 501 },
      },
    },
    { usage: { ...body.usage, input_tokens: 272_001, total_tokens: 272_501 } },
  ])
    expect(
      openaiResponseProjection({ ...body, ...change }).usage,
    ).toBeUndefined();
});

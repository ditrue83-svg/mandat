import { expect, it } from "vitest";
import {
  openaiResponseBody,
  openaiResponseProjection,
  openaiJsonSchema,
  openaiErrorDiagnostic,
} from "../src/lib/openai-responses";
import { z } from "zod";
import Ajv2020 from "ajv/dist/2020.js";

it("classifies native schema errors without retaining provider prose or unknown values", () => {
  const privateText = "private-source-and-credential";
  const diagnostic = openaiErrorDiagnostic({
    error: {
      code: "invalid_json_schema",
      type: "invalid_request_error",
      param: "text.format.schema",
      message: `${privateText}: Objects provided via 'anyOf' must not share identical first keys.`,
      details: { source: privateText },
    },
  });
  expect(diagnostic).toEqual({
    code: "invalid_json_schema",
    type: "invalid_request_error",
    parameter: "text.format.schema",
    schemaMessageCategory: "any_of_first_key",
  });
  expect(Object.isFrozen(diagnostic)).toBe(true);
  expect(JSON.stringify(diagnostic)).not.toContain(privateText);
  expect(
    openaiErrorDiagnostic({
      error: {
        code: privateText,
        type: privateText,
        param: privateText,
        message: privateText,
      },
    }),
  ).toEqual({
    code: "other",
    type: "other",
    parameter: "other",
    schemaMessageCategory: null,
  });
  expect(openaiErrorDiagnostic({ error: null })).toBeNull();
  expect(openaiErrorDiagnostic({ error: [privateText] })).toBeNull();
  expect(openaiErrorDiagnostic(null)).toBeNull();
});

it.each([
  [
    "additional properties",
    "'additionalProperties' must be false",
    "additional_properties",
  ],
  [
    "required fields",
    "'required' is required to be supplied",
    "required_fields",
  ],
  ["reference", "Invalid $ref", "schema_reference"],
  [
    "unsupported keyword",
    "'oneOf' is not permitted",
    "unsupported_schema_keyword",
  ],
  ["size limit", "too many enum values", "schema_limit"],
  ["unknown", "unrecognized provider explanation", "other"],
  ["oversized message", "private".repeat(3000), "other"],
])(
  "keeps only a bounded category for schema error %s",
  (_name, message, expected) => {
    expect(
      openaiErrorDiagnostic({
        error: { code: "invalid_json_schema", message },
      }),
    ).toEqual({
      code: "invalid_json_schema",
      type: null,
      parameter: null,
      schemaMessageCategory: expected,
    });
  },
);

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

it("wraps root unions while preserving branch requirements and recursive local references", () => {
  const original = {
    $defs: { "label/~": { type: "string", enum: ["known"] } },
    anyOf: [
      {
        type: "object",
        properties: {
          status: { const: "leaf", type: "string" },
          label: { $ref: "#/$defs/label~1~0" },
        },
        required: ["status", "label"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          status: { const: "branch", type: "string" },
          children: { type: "array", items: { $ref: "#" } },
        },
        required: ["status", "children"],
        additionalProperties: false,
      },
    ],
  };
  const before = structuredClone(original);
  const wire = openaiJsonSchema(original);
  expect(wire.type).toBe("object");
  expect(wire).not.toHaveProperty("anyOf");
  assertRootDefinitions(wire);
  const accepts = new Ajv2020({ strict: false }).compile(wire);
  expect(
    accepts({
      result: {
        status: "branch",
        children: [{ status: "leaf", label: "known" }],
      },
    }),
  ).toBe(true);
  for (const invalid of [
    { result: { status: "leaf" } },
    { result: { status: "leaf", label: "unknown" } },
    { result: { status: "leaf", children: [] } },
    { result: { status: "branch", children: [{ status: "leaf" }] } },
    { result: { status: "leaf", label: "known" }, extra: true },
  ])
    expect(accepts(invalid)).toBe(false);
  expect(original).toEqual(before);
});

function assertRootDefinitions(wire: Record<string, unknown>) {
  const definitions = wire.$defs as Record<string, unknown>;
  expect(Object.keys(definitions).length).toBeGreaterThan(0);
  const check = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(check);
    const schema = value as Record<string, unknown>;
    if (value !== wire) expect(schema).not.toHaveProperty("$defs");
    expect(schema).not.toHaveProperty("definitions");
    if (typeof schema.$ref === "string") {
      expect(schema.$ref).toMatch(/^#\/\$defs\/[^/]+$/);
      expect(definitions).toHaveProperty(schema.$ref.slice(8));
    }
    Object.values(schema).forEach(check);
  };
  check(wire);
}

it("hoists distinct nested definitions and preserves references through converted oneOf paths", () => {
  const branch = (index: number, tag: string, value: string) => ({
    type: "object",
    properties: {
      status: { type: "string", const: tag },
      value: {
        $defs: { item: { type: "string", enum: [value] } },
        $ref: `#/oneOf/${index}/properties/value/$defs/item`,
      },
    },
    required: ["status", "value"],
    additionalProperties: false,
  });
  const original = {
    oneOf: [branch(0, "left", "first"), branch(1, "right", "second")],
  };
  const before = structuredClone(original);
  const wire = openaiJsonSchema(original);
  assertRootDefinitions(wire);
  const originalAccepts = new Ajv2020({ strict: false }).compile(original);
  const wireAccepts = new Ajv2020({ strict: false }).compile(wire);
  for (const [value, accepted] of [
    [{ status: "left", value: "first" }, true],
    [{ status: "right", value: "second" }, true],
    [{ status: "left", value: "second" }, false],
    [{ status: "right", value: "first" }, false],
    [{ status: "left" }, false],
  ] as const) {
    expect(originalAccepts(value)).toBe(accepted);
    expect(wireAccepts({ result: value })).toBe(accepted);
  }
  expect(original).toEqual(before);
});

it("unwraps only the requested union envelope and rejects malformed envelopes without losing usage", () => {
  const schema = z.toJSONSchema(
    z.union([
      z.strictObject({ accepted: z.literal(true) }),
      z.strictObject({ accepted: z.literal(false), reason: z.string() }),
    ]),
  );
  const format = {
    type: "json_schema" as const,
    json_schema: { name: "union", strict: true as const, schema },
  };
  const body = response();
  const withText = (text: string) => ({
    ...body,
    output: [{ ...body.output[1], content: [{ type: "output_text", text }] }],
  });
  const projected = openaiResponseProjection(
    withText('{"result":{"accepted":true}}'),
    format,
  );
  expect(projected).toMatchObject({
    usage: { prompt_tokens: 100, completion_tokens: 500 },
    choices: [{ message: { content: '{"accepted":true}' } }],
  });
  for (const text of [
    '{"accepted":true}',
    '{"result":{},"extra":"private"}',
    "[]",
    "private-invalid-json",
  ]) {
    const rejected = openaiResponseProjection(withText(text), format);
    expect(rejected).toMatchObject({
      usage: { prompt_tokens: 100 },
      choices: [{ message: { content: null } }],
    });
    expect(JSON.stringify(rejected)).not.toContain("private");
  }
  // A business field named result must remain a business field for plain objects.
  expect(
    openaiResponseProjection(withText('{"result":{"accepted":true}}')),
  ).toMatchObject({
    choices: [{ message: { content: '{"result":{"accepted":true}}' } }],
  });
});

it("rejects overlapping or optional oneOf discriminators instead of broadening them", () => {
  const branch = {
    type: "object",
    properties: { status: { type: "string", const: "same" } },
    required: ["status"],
    additionalProperties: false,
  };
  expect(() =>
    openaiJsonSchema({ oneOf: [branch, structuredClone(branch)] }),
  ).toThrow("discriminante");
  const optional = { ...branch, required: [] };
  expect(() => openaiJsonSchema({ oneOf: [branch, optional] })).toThrow(
    "discriminante",
  );
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

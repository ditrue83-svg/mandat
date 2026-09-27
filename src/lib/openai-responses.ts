import { z } from "zod";
import { openaiReasoningEffort, validateAiModel } from "./ai-provider-config";
import type { AiResponseFormat } from "../worker/ai";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

// Reserve and account every input token at the worst standard cache-write
// rate, including cache hits. Token counts stay literal; costs are prudential.
// https://developers.openai.com/api/docs/guides/prompt-caching
export const OPENAI_INPUT_COST_MULTIPLIER = 1.25;

// Restrict the wire schema to the documented Structured Outputs subset.
// Length/uniqueness rules stay explicit descriptions and remain mandatory in
// the original application validator; no answer is repaired or relaxed.
export function openaiJsonSchema(original: JsonObject): JsonObject {
  const simple = new Set([
    "type",
    "enum",
    "const",
    "title",
    "description",
    "required",
    "pattern",
    "format",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minItems",
    "maxItems",
    "additionalProperties",
  ]);
  const hints = new Set(["minLength", "maxLength", "uniqueItems"]);
  const resolve = (ref: unknown): JsonObject => {
    if (typeof ref !== "string" || (ref !== "#" && !ref.startsWith("#/")))
      throw new Error("Riferimento schema OpenAI non locale");
    let target: unknown = original;
    for (const part of ref === "#" ? [] : ref.slice(2).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!target || typeof target !== "object" || !Object.hasOwn(target, key))
        throw new Error("Riferimento schema OpenAI assente");
      target = (target as JsonObject)[key];
    }
    const schema = object(target);
    if (!schema) throw new Error("Riferimento schema OpenAI assente");
    return schema;
  };
  const dereference = (value: unknown): JsonObject => {
    let schema = object(value);
    const seen = new Set<JsonObject>();
    while (schema?.$ref) {
      if (seen.has(schema)) throw new Error("Discriminante OpenAI ricorsivo");
      seen.add(schema);
      schema = resolve(schema.$ref);
    }
    if (!schema) throw new Error("Discriminante OpenAI non valido");
    return schema;
  };
  const disjoint = (branches: unknown[]): boolean => {
    const schemas = branches.map(dereference);
    return Object.keys(object(schemas[0]?.properties) ?? {}).some((key) => {
      const values = schemas.map((schema) => {
        if (
          schema.type !== "object" ||
          !Array.isArray(schema.required) ||
          !schema.required.includes(key)
        )
          return null;
        const tag = dereference(object(schema.properties)?.[key]);
        return tag.type === "string" && typeof tag.const === "string"
          ? tag.const
          : null;
      });
      return (
        values.every((value) => value !== null) &&
        new Set(values).size === branches.length
      );
    });
  };
  const visit = (value: unknown): JsonObject => {
    const schema = object(value);
    if (!schema) throw new Error("Schema OpenAI non valido");
    if (schema.type === "object") {
      const properties = object(schema.properties);
      if (
        !properties ||
        schema.additionalProperties !== false ||
        !Array.isArray(schema.required) ||
        schema.required.length !== Object.keys(properties).length ||
        new Set(schema.required).size !== schema.required.length ||
        schema.required.some(
          (k) => typeof k !== "string" || !Object.hasOwn(properties, k),
        )
      )
        throw new Error(
          "OpenAI richiede tutti i campi obbligatori e nessun campo aggiuntivo",
        );
    }
    const result: JsonObject = {};
    const descriptions: string[] = [];
    for (const [key, entry] of Object.entries(schema)) {
      if (key === "$schema") continue;
      if (key === "properties" || key === "$defs" || key === "definitions") {
        const fields = object(entry);
        if (!fields) throw new Error("Campi schema OpenAI non validi");
        result[key] = Object.fromEntries(
          Object.entries(fields).map(([name, child]) => [name, visit(child)]),
        );
      } else if (key === "items") result[key] = visit(entry);
      else if (key === "anyOf" && Array.isArray(entry))
        result[key] = entry.map(visit);
      else if (key === "oneOf" && Array.isArray(entry) && entry.length > 0) {
        // Only convert exclusive unions when a required literal discriminator
        // proves the alternatives cannot overlap. Other oneOf schemas fail.
        if (schema.anyOf || !disjoint(entry))
          throw new Error("Unione OpenAI senza discriminante esclusivo");
        result.anyOf = entry.map(visit);
      } else if (key === "$ref") {
        resolve(entry);
        result[key] = entry;
      } else if (hints.has(key))
        descriptions.push(`${key}=${JSON.stringify(entry)}`);
      else if (simple.has(key)) result[key] = structuredClone(entry);
      else throw new Error("Vincolo schema OpenAI non supportato");
    }
    if (descriptions.length)
      result.description = [
        schema.description,
        `Required constraints: ${descriptions.join("; ")}.`,
      ]
        .filter(Boolean)
        .join(" ");
    return result;
  };
  if (
    (Array.isArray(original.anyOf) && original.anyOf.length > 0) ||
    (Array.isArray(original.oneOf) && original.oneOf.length > 0)
  ) {
    // Structured Outputs allows unions below an object, but not at its root.
    // Keep the complete original schema (including branch-specific required
    // fields) under one property, rebasing every local reference with it.
    // https://developers.openai.com/api/docs/guides/structured-outputs
    const nested = visit(original);
    const rebase = (schema: JsonObject): JsonObject => {
      const result = { ...schema };
      if (typeof result.$ref === "string")
        result.$ref = `#/$defs/result${result.$ref.slice(1)}`;
      for (const key of ["properties", "$defs", "definitions"]) {
        const fields = object(result[key]);
        if (fields)
          result[key] = Object.fromEntries(
            Object.entries(fields).map(([name, child]) => [
              name,
              rebase(child as JsonObject),
            ]),
          );
      }
      if (object(result.items))
        result.items = rebase(result.items as JsonObject);
      if (Array.isArray(result.anyOf))
        result.anyOf = result.anyOf.map((child) => rebase(child as JsonObject));
      return result;
    };
    return {
      type: "object",
      properties: { result: { $ref: "#/$defs/result" } },
      required: ["result"],
      additionalProperties: false,
      $defs: { result: rebase(nested) },
    };
  }
  if (original.type !== "object" || original.anyOf)
    throw new Error("OpenAI richiede uno schema radice oggetto");
  return visit(original);
}

export function openaiResponseBody(
  model: string,
  system: string,
  prompt: string,
  maxTokens: number,
  format?: AiResponseFormat,
  effort?: string,
) {
  validateAiModel("openai", model);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 16 || maxTokens > 128_000)
    throw new Error("Limite output OpenAI non valido");
  const body = {
    model,
    input: [
      { role: "developer", content: system },
      { role: "user", content: prompt },
    ],
    max_output_tokens: maxTokens,
    reasoning: { effort: openaiReasoningEffort(effort) },
    // No cache breakpoints: one-shot changing sources need no cache writes.
    prompt_cache_options: { mode: "explicit" },
    service_tier: "default",
    store: false,
    background: false,
    stream: false,
    truncation: "disabled",
    ...(format
      ? {
          text: {
            format: {
              type: "json_schema",
              ...format.json_schema,
              schema: openaiJsonSchema(format.json_schema.schema),
            },
          },
        }
      : {}),
  };
  // A conservative byte bound keeps input well below the 272K-token premium
  // threshold. Oversized sources require an explicit separate workflow.
  if (Buffer.byteLength(JSON.stringify(body), "utf8") + 1000 > 200_000)
    throw new Error("Fonte OpenAI troppo grande per la tariffa configurata");
  return body;
}

const count = z.number().int().min(0).max(2_147_483_647);
const usageSchema = z
  .object({
    input_tokens: count.max(272_000),
    output_tokens: count.max(128_000),
    total_tokens: count,
    input_tokens_details: z.object({
      cached_tokens: count,
      cache_write_tokens: count,
    }),
    output_tokens_details: z.object({ reasoning_tokens: count }),
  })
  .refine(
    (v) =>
      v.total_tokens === v.input_tokens + v.output_tokens &&
      v.input_tokens_details.cached_tokens +
        v.input_tokens_details.cache_write_tokens <=
        v.input_tokens &&
      v.output_tokens_details.reasoning_tokens <= v.output_tokens,
  );

// Only final assistant text enters the existing validation gate. Reasoning,
// tool arguments, annotations and error/refusal prose never enter our records.
export function openaiResponseProjection(
  value: unknown,
  format?: AiResponseFormat,
): JsonObject {
  const body = object(value);
  const parsed = usageSchema.safeParse(body?.usage);
  const usage =
    parsed.success && body?.service_tier === "default"
      ? {
          prompt_tokens: parsed.data.input_tokens,
          completion_tokens: parsed.data.output_tokens,
        }
      : undefined;
  const base = { model: body?.model, usage };
  if (
    body?.object !== "response" ||
    !Array.isArray(body.output) ||
    body.output.length > 256
  )
    return { ...base, choices: [] };
  const texts: string[] = [];
  let messages = 0;
  let valid = true;
  let refusal = false;
  let tool = false;
  for (const raw of body.output) {
    const item = object(raw);
    if (item?.type === "reasoning" && messages === 0) continue;
    if (item?.type !== "message") {
      valid = false;
      tool ||= typeof item?.type === "string" && item.type.endsWith("_call");
      continue;
    }
    messages++;
    if (
      item.role !== "assistant" ||
      item.status !== "completed" ||
      (item.phase != null && item.phase !== "final_answer") ||
      !Array.isArray(item.content) ||
      !item.content.length ||
      item.content.length > 64
    ) {
      valid = false;
      continue;
    }
    for (const rawPart of item.content) {
      const part = object(rawPart);
      if (part?.type === "output_text" && typeof part.text === "string")
        texts.push(part.text);
      else if (part?.type === "refusal") refusal = true;
      else valid = false;
    }
  }
  const incompleteReason = object(body.incomplete_details)?.reason;
  const finish = tool
    ? "tool_calls"
    : body.status === "incomplete" && incompleteReason === "max_output_tokens"
      ? "length"
      : body.status === "incomplete" && incompleteReason === "content_filter"
        ? "content_filter"
        : body.status === "completed" &&
            body.error == null &&
            body.incomplete_details == null
          ? "stop"
          : "other";
  let content = valid && messages === 1 ? texts.join("") : null;
  if (
    content &&
    (Array.isArray(format?.json_schema.schema.anyOf) ||
      Array.isArray(format?.json_schema.schema.oneOf))
  ) {
    // Unwrap only when the requested schema required the wire envelope.
    // Invalid wrappers remain rejected while the original usage is retained.
    try {
      const envelope = object(JSON.parse(content));
      content =
        envelope &&
        Object.keys(envelope).length === 1 &&
        Object.hasOwn(envelope, "result")
          ? JSON.stringify(envelope.result)
          : null;
    } catch {
      content = null;
    }
  }
  return {
    ...base,
    choices: [
      {
        finish_reason: finish,
        message: {
          content,
          ...(refusal ? { refusal: "" } : {}),
        },
      },
    ],
  };
}

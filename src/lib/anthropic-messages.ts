import { z } from "zod";
import { anthropicReasoningEffort } from "./ai-provider-config";
import type { AiResponseFormat } from "../worker/ai";

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

// Anthropic's grammar does not implement bounds on strings/numbers/arrays.
// Keep them in descriptions on the wire, as its SDK does. The original schema
// and all application validators remain untouched and must validate the result.
export function anthropicJsonSchema(original: JsonObject): JsonObject {
  const constraints = new Set([
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "maxItems",
    "uniqueItems",
  ]);
  const simple = new Set([
    "type",
    "enum",
    "const",
    "required",
    "description",
    "title",
    "default",
    "format",
    "pattern",
    "additionalProperties",
  ]);
  const resolve = (ref: unknown): JsonObject => {
    if (typeof ref !== "string" || !ref.startsWith("#/"))
      throw new Error("Riferimento schema Anthropic non locale");
    let value: unknown = original;
    for (const part of ref.slice(2).split("/")) {
      const container = object(value);
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!container || !Object.hasOwn(container, key))
        throw new Error("Riferimento schema Anthropic assente");
      value = container[key];
    }
    const result = object(value);
    if (!result) throw new Error("Riferimento schema Anthropic non valido");
    return result;
  };
  const visit = (
    value: unknown,
    ancestors = new Set<JsonObject>(),
  ): JsonObject => {
    const schema = object(value);
    if (!schema || ancestors.has(schema))
      throw new Error("Schema Anthropic non valido o ricorsivo");
    const next = new Set(ancestors).add(schema);
    if (schema.type === "object" && schema.additionalProperties !== false)
      throw new Error("Gli oggetti Anthropic devono vietare campi aggiuntivi");
    const result: JsonObject = {};
    const hints: string[] = [];
    for (const [key, entry] of Object.entries(schema)) {
      if (key === "$schema") continue;
      if (key === "$ref") {
        visit(resolve(entry), next);
        result[key] = entry;
      } else if (
        key === "properties" ||
        key === "$defs" ||
        key === "definitions"
      ) {
        const fields = object(entry);
        if (!fields) throw new Error("Campi schema Anthropic non validi");
        result[key] = Object.fromEntries(
          Object.entries(fields).map(([name, child]) => [
            name,
            visit(child, next),
          ]),
        );
      } else if (key === "items") {
        result[key] = visit(entry, next);
      } else if (key === "anyOf" || key === "allOf") {
        if (
          !Array.isArray(entry) ||
          (key === "allOf" && entry.some((v) => object(v)?.$ref))
        )
          throw new Error("Composizione schema Anthropic non supportata");
        result[key] = entry.map((child) => visit(child, next));
      } else if (
        constraints.has(key) ||
        (key === "minItems" && entry !== 0 && entry !== 1)
      ) {
        hints.push(`${key}=${JSON.stringify(entry)}`);
        if (key === "minItems" && typeof entry === "number" && entry > 1)
          result.minItems = 1;
      } else if (key === "minItems" || simple.has(key)) {
        if (key === "additionalProperties" && entry !== false)
          throw new Error("Campi aggiuntivi Anthropic non supportati");
        if (
          key === "pattern" &&
          (typeof entry !== "string" || /\(\?|\\[1-9bB]/.test(entry))
        )
          throw new Error("Pattern schema Anthropic non supportato");
        result[key] = structuredClone(entry);
      } else {
        throw new Error("Vincolo schema Anthropic non supportato");
      }
    }
    if (hints.length)
      result.description = [
        schema.description,
        `Required constraints: ${hints.join("; ")}.`,
      ]
        .filter(Boolean)
        .join(" ");
    return result;
  };
  return visit(original);
}

export function anthropicMessageBody(
  model: string,
  system: string,
  prompt: string,
  maxTokens: number,
  format?: AiResponseFormat,
  effort?: string,
) {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 128_000)
    throw new Error("Limite output Anthropic non valido");
  return {
    model,
    system,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
    stream: false,
    inference_geo: "global",
    service_tier: "standard_only",
    thinking: { type: "adaptive", display: "omitted" },
    output_config: {
      effort: anthropicReasoningEffort(effort),
      ...(format
        ? {
            format: {
              type: "json_schema",
              schema: anthropicJsonSchema(format.json_schema.schema),
            },
          }
        : {}),
    },
  };
}

const count = z.number().int().min(0).max(2_147_483_647);
const usageSchema = z.object({
  input_tokens: count,
  output_tokens: count,
  cache_read_input_tokens: count.optional().default(0),
  // This adapter never requests prompt-cache writes. Refuse unexpected billing
  // modes instead of accounting for them at an incorrect base-input rate.
  cache_creation_input_tokens: z.literal(0).optional().default(0),
});

// Project native messages into the existing strict acceptance/diagnostic gate.
// Retain consumption independently of content validity; never retain thinking,
// signatures, refusal prose, provider error bodies or unexpected tool payloads.
export function anthropicMessageProjection(value: unknown): JsonObject {
  const body = object(value);
  const parsed = usageSchema.safeParse(body?.usage);
  const totalInput = parsed.success
    ? parsed.data.input_tokens + parsed.data.cache_read_input_tokens
    : null;
  const usage =
    parsed.success && count.safeParse(totalInput).success
      ? {
          prompt_tokens: totalInput,
          completion_tokens: parsed.data.output_tokens,
        }
      : undefined;
  const base = { model: body?.model, usage };
  if (body?.type !== "message" || body.role !== "assistant")
    return { ...base, choices: [] };
  const blocks = body.content;
  const texts: string[] = [];
  let valid =
    Array.isArray(blocks) && blocks.length > 0 && blocks.length <= 256;
  let tool = false;
  if (valid)
    for (const raw of blocks as unknown[]) {
      const block = object(raw);
      if (block?.type === "text" && typeof block.text === "string")
        texts.push(block.text);
      else if (
        !texts.length &&
        block?.type === "thinking" &&
        typeof block.thinking === "string" &&
        typeof block.signature === "string"
      )
        continue;
      else if (
        !texts.length &&
        block?.type === "redacted_thinking" &&
        typeof block.data === "string"
      )
        continue;
      else {
        valid = false;
        if (block?.type === "tool_use" || block?.type === "server_tool_use")
          tool = true;
      }
    }
  const refusal =
    body.stop_reason === "refusal" ||
    object(body.stop_details)?.type === "refusal";
  const finish = tool
    ? "tool_calls"
    : body.stop_reason === "end_turn" || refusal
      ? "stop"
      : body.stop_reason === "max_tokens"
        ? "length"
        : body.stop_reason === "tool_use"
          ? "tool_calls"
          : "other";
  return {
    ...base,
    choices: [
      {
        finish_reason: finish,
        message: {
          content: valid ? texts.join("") : null,
          ...(refusal ? { refusal: "" } : {}),
        },
      },
    ],
  };
}

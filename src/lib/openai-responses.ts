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
      else if (key === "$ref") {
        if (
          typeof entry !== "string" ||
          (entry !== "#" && !entry.startsWith("#/"))
        )
          throw new Error("Riferimento schema OpenAI non locale");
        let target: unknown = original;
        for (const part of entry === "#" ? [] : entry.slice(2).split("/"))
          target =
            object(target)?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
        if (!object(target))
          throw new Error("Riferimento schema OpenAI assente");
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
export function openaiResponseProjection(value: unknown): JsonObject {
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
  return {
    ...base,
    choices: [
      {
        finish_reason: finish,
        message: {
          content: valid && messages === 1 ? texts.join("") : null,
          ...(refusal ? { refusal: "" } : {}),
        },
      },
    ],
  };
}

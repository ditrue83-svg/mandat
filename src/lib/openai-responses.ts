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

const errorCodes = [
  "invalid_json_schema",
  "unsupported_parameter",
  "unsupported_value",
  "invalid_value",
  "missing_required_parameter",
  "model_not_found",
  "context_length_exceeded",
  "insufficient_quota",
  "project_spend_limit_exceeded",
  "organization_spend_limit_exceeded",
  "rate_limit_exceeded",
] as const;
const errorTypes = [
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "rate_limit_error",
  "server_error",
] as const;
const errorParameters = [
  "text.format.schema",
  "text.format",
  "model",
  "input",
  "max_output_tokens",
  "reasoning.effort",
  "prompt_cache_options",
  "prompt_cache_options.mode",
  "service_tier",
] as const;
function allowedErrorValue<T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | "other" | null {
  return value == null
    ? null
    : typeof value === "string" && allowed.includes(value)
      ? (value as T[number])
      : "other";
}

// Inspect before projecting a native response, which drops the error object.
// Return only fixed categories: provider messages can echo source or secrets.
// These observations never authorize retries or imply zero billable usage.
export function openaiErrorDiagnostic(value: unknown) {
  const error = object(object(value)?.error);
  if (!error) return null;
  const code = allowedErrorValue(error.code, errorCodes);
  const parameter = allowedErrorValue(error.param, errorParameters);
  const message =
    typeof error.message === "string" && error.message.length <= 16_384
      ? error.message.toLowerCase()
      : "";
  const schemaMessageCategory =
    code !== "invalid_json_schema" && parameter !== "text.format.schema"
      ? null
      : message.includes("anyof") && message.includes("identical first keys")
        ? "any_of_first_key"
        : message.includes("additionalproperties")
          ? "additional_properties"
          : message.includes("required")
            ? "required_fields"
            : message.includes("$ref") || message.includes("reference")
              ? "schema_reference"
              : message.includes("not supported") ||
                  message.includes("not permitted")
                ? "unsupported_schema_keyword"
                : message.includes("limit") || message.includes("too many")
                  ? "schema_limit"
                  : "other";
  return Object.freeze({
    code,
    type: allowedErrorValue(error.type, errorTypes),
    parameter,
    schemaMessageCategory,
  });
}

// Restrict the wire schema to the documented Structured Outputs subset.
// Bound free text with the supported pattern keyword as well as explicit
// descriptions. Original local length/uniqueness checks still apply;
// the provider pattern never replaces application validation.
// No answer is repaired or relaxed.
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
    // Preserve existing patterns and literal domains. Do not replace their
    // meaning with a length pattern or attempt an unsupported intersection.
    if (
      schema.type === "string" &&
      schema.pattern === undefined &&
      schema.enum === undefined &&
      schema.const === undefined &&
      (schema.minLength !== undefined || schema.maxLength !== undefined)
    ) {
      const minimum = schema.minLength ?? 0;
      const maximum = schema.maxLength;
      if (
        !Number.isSafeInteger(minimum) ||
        Number(minimum) < 0 ||
        (maximum !== undefined &&
          (!Number.isSafeInteger(maximum) || Number(maximum) < Number(minimum)))
      )
        throw new Error("Limite testo schema OpenAI non valido");
      result.pattern = `^[\\s\\S]{${minimum},${maximum ?? ""}}$`;
    }
    return result;
  };
  const wrapped =
    (Array.isArray(original.anyOf) && original.anyOf.length > 0) ||
    (Array.isArray(original.oneOf) && original.oneOf.length > 0);
  if (!wrapped && original.type !== "object")
    throw new Error("OpenAI richiede uno schema radice oggetto");

  // Resolve against the original schema, then emit all referenced schemas in
  // root $defs. Moving the whole union under a nested $defs preserved JSON
  // Schema semantics but the provider rejected those deeper reference paths.
  // Index by target identity before visiting to preserve recursion and sharing.
  // This also preserves pointers into oneOf after its conversion to anyOf.
  // https://developers.openai.com/api/docs/guides/structured-outputs
  const targets = new Map<JsonObject, string>();
  const definitions: JsonObject = {};
  const annotatedTargets = new Map<JsonObject, Map<string, JsonObject>>();
  const referenceTarget = (schema: JsonObject): JsonObject => {
    const annotations = { description: [] as string[], title: [] as string[] };
    const seen = new Set<JsonObject>();
    let alias = schema;
    let target: JsonObject;
    // The provider rejects siblings of $ref, even annotation keywords. Move
    // annotations onto a shared specialization of the concrete target instead.
    // Do not merge validation siblings: that could weaken an intersection.
    while (true) {
      for (const key of Object.keys(alias)) {
        if (
          !["$ref", "$defs", "definitions", "description", "title"].includes(
            key,
          )
        )
          throw new Error(
            "Vincolo accanto a riferimento OpenAI non supportato",
          );
      }
      for (const key of ["description", "title"] as const) {
        if (alias[key] !== undefined) {
          if (typeof alias[key] !== "string")
            throw new Error("Annotazione schema OpenAI non valida");
          annotations[key].unshift(alias[key]);
        }
      }
      target = resolve(alias.$ref);
      if (!target.$ref) break;
      if (seen.has(target))
        throw new Error("Catena di riferimenti OpenAI senza schema concreto");
      seen.add(target);
      alias = visit(target);
    }
    if (!annotations.description.length && !annotations.title.length)
      return target;
    const key = JSON.stringify(annotations);
    let variants = annotatedTargets.get(target);
    if (!variants) annotatedTargets.set(target, (variants = new Map()));
    let annotated = variants.get(key);
    if (!annotated) {
      annotated = { ...target };
      for (const key of ["description", "title"] as const) {
        if (annotations[key].length)
          annotated[key] = [...new Set([target[key], ...annotations[key]])]
            .filter((value) => value !== undefined)
            .join("\n");
      }
      // Cache before traversal so annotated recursive references remain finite.
      variants.set(key, annotated);
    }
    return annotated;
  };
  const flatten = (schema: JsonObject): JsonObject => {
    if (schema.$ref) {
      const target = referenceTarget(schema);
      if (!wrapped && target === original) return { $ref: "#" };
      let name = targets.get(target);
      if (!name) {
        name = `schema${targets.size}`;
        targets.set(target, name);
      }
      return { $ref: `#/$defs/${name}` };
    }
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(schema)) {
      if (key === "$defs" || key === "definitions") continue;
      if (key === "properties") {
        result[key] = Object.fromEntries(
          Object.entries(entry as JsonObject).map(([name, child]) => [
            name,
            flatten(child as JsonObject),
          ]),
        );
      } else if (key === "items") result[key] = flatten(entry as JsonObject);
      else if (key === "anyOf")
        result[key] = (entry as JsonObject[]).map(flatten);
      else result[key] = entry;
    }
    return result;
  };
  const converted = flatten(visit(original));
  // Map iteration includes newly discovered targets, without expanding cycles.
  for (const [target, name] of targets)
    definitions[name] = flatten(visit(target));
  const result: JsonObject = wrapped
    ? {
        type: "object",
        properties: { result: converted },
        required: ["result"],
        additionalProperties: false,
      }
    : converted;
  if (targets.size) result.$defs = definitions;
  return result;
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
    // Large reasoning outputs can spend minutes before returning JSON.
    // Receive lifecycle events immediately without enabling stored responses.
    stream: maxTokens >= 16_384,
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

// Accept only a complete terminal Response object, never accumulated deltas.
// If the connection breaks, the caller retains an uncertain usage reservation
// rather than using partial text or issuing another generation automatically.
export async function readOpenaiResponseStream(response: Response) {
  if (!response.body) throw new Error("OpenAI stream body missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let totalBytes = 0;
  let responseId: string | null = null;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > 8_000_000) throw new Error("OpenAI stream size limit");
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 2_000_000)
        throw new Error("OpenAI stream frame limit");
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue; // Includes keepalive comments.
        let event: any;
        try {
          event = JSON.parse(data);
        } catch {
          throw new Error("OpenAI stream event unreadable");
        }
        if (!event || typeof event !== "object" || Array.isArray(event))
          throw new Error("OpenAI stream event invalid");
        if (event.type === "error") throw new Error("OpenAI stream error");
        if (event.type === "response.created") {
          if (
            responseId !== null ||
            typeof event.response?.id !== "string" ||
            !/^resp_[A-Za-z0-9_-]{1,200}$/.test(event.response.id)
          )
            throw new Error("OpenAI stream response identity invalid");
          responseId = event.response.id;
        }
        if (
          [
            "response.completed",
            "response.incomplete",
            "response.failed",
          ].includes(event.type)
        ) {
          if (!responseId || event.response?.id !== responseId)
            throw new Error("OpenAI stream terminal identity mismatch");
          // Existing projection validates status, output, model and usage.
          return event.response as unknown;
        }
      }
    }
    throw new Error("OpenAI stream ended without terminal response");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
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

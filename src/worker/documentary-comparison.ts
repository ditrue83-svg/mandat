import { randomUUID } from "node:crypto";
import {
  buildAutomaticComparisonRequest,
  buildAutomaticReductionRequest,
  recordAutomaticComparison,
  automaticComparisonModel,
  type AutomaticComparisonInput,
} from "@/lib/automatic-comparison";
import { infer, type AiTransport } from "./ai";
import { documentaryAiConfiguration } from "@/lib/documentary-ai-config";

// Uses the same persistent CHF reservation and actual-usage settlement as the
// existing provider path. No direct unmetered transport is used in production.
export async function compareDocumentaryTarget(
  input: AutomaticComparisonInput,
  transport?: AiTransport,
  beforeRequest?: () => Promise<void>,
) {
  const request = buildAutomaticComparisonRequest(input);
  const configuration = documentaryAiConfiguration();
  const readings: unknown[] = [];
  for (const chunk of request.readingRequests) {
    await beforeRequest?.();
    readings.push(
      await infer(
        input.publication,
        "documentary-source-reading",
        chunk.prompt,
        2_400,
        transport,
        chunk.system,
        chunk.responseFormat,
        { ...configuration, reasoningEffort: chunk.reasoningEffort },
      ),
    );
  }
  const finalRequest = readings.length
    ? buildAutomaticReductionRequest(readings, request)
    : request;
  await beforeRequest?.();
  const response = await infer(
    input.publication,
    "documentary-service-comparison",
    finalRequest.prompt,
    finalRequest.maxTokens,
    transport,
    request.system,
    finalRequest.responseFormat,
    configuration,
  );
  return recordAutomaticComparison(response, request, {
    id: randomUUID(),
    at: new Date().toISOString(),
    model: automaticComparisonModel(),
    readings,
  });
}

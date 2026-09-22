import { randomUUID } from "node:crypto";
import {
  buildAutomaticComparisonRequest,
  buildAutomaticSourceRequest,
  readAutomaticSourceInterpretation,
  buildInterpretedComparisonRequest,
  recordAutomaticComparison,
  automaticComparisonModel,
  type AutomaticComparisonInput,
} from "@/lib/automatic-comparison";
import {
  recordSourceInterpretation,
  type SourceInterpretationRecord,
} from "@/lib/source-interpretation";
import { infer, type AiTransport } from "./ai";
import { documentaryAiConfiguration } from "@/lib/documentary-ai-config";

// Uses the same persistent CHF reservation and actual-usage settlement as the
// existing provider path. No direct unmetered transport is used in production.
export async function compareDocumentaryTarget(
  input: AutomaticComparisonInput,
  transport?: AiTransport,
  beforeRequest?: () => Promise<void>,
  options: {
    loadSourceInterpretations?: (sourceKey: string) => Promise<unknown[]>;
  } = {},
) {
  const request = buildAutomaticComparisonRequest(input);
  const configuration = documentaryAiConfiguration();
  let sourceInterpretation: SourceInterpretationRecord | null = null;
  if (options.loadSourceInterpretations) {
    await beforeRequest?.();
    const candidates = await options.loadSourceInterpretations(
      request.sourceKey,
    );
    // The loader returns only public source envelopes, never another company's
    // comparison. Invalid current records fail closed; stale versions are null.
    // Keep database order, without preferring a particular semantic result.
    for (const candidate of candidates) {
      const valid = readAutomaticSourceInterpretation(candidate, request);
      sourceInterpretation ??= valid;
    }
  }
  if (!sourceInterpretation) {
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
    const sourceRequest = buildAutomaticSourceRequest(request, readings);
    await beforeRequest?.();
    const sourceResponse = await infer(
      input.publication,
      "documentary-source-interpretation",
      sourceRequest.prompt,
      sourceRequest.maxTokens,
      transport,
      sourceRequest.system,
      sourceRequest.responseFormat,
      {
        ...configuration,
        model: sourceRequest.model,
        reasoningEffort: sourceRequest.binding.reasoningEffort,
      },
    );
    sourceInterpretation = recordSourceInterpretation(
      sourceResponse,
      sourceRequest,
      {
        id: randomUUID(),
        at: new Date().toISOString(),
        model: sourceRequest.model,
      },
    );
  }
  let response: unknown = null;
  await beforeRequest?.();
  if (sourceInterpretation.response.status === "resolved") {
    const finalRequest = buildInterpretedComparisonRequest(
      request,
      sourceInterpretation,
    );
    response = await infer(
      input.publication,
      "documentary-service-comparison",
      finalRequest.prompt,
      finalRequest.maxTokens,
      transport,
      finalRequest.system,
      finalRequest.responseFormat,
      configuration,
    );
  }
  return recordAutomaticComparison(response, request, {
    id: randomUUID(),
    at: new Date().toISOString(),
    model: automaticComparisonModel(),
    sourceInterpretation,
  });
}

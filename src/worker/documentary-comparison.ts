import { randomUUID } from "node:crypto";
import {
  buildAutomaticComparisonRequest,
  buildAutomaticSourceRequest,
  readAutomaticSourceInterpretation,
  buildAutomaticSourceSemanticReviewRequest,
  readAutomaticSourceSemanticReview,
  buildInterpretedComparisonRequest,
  recordAutomaticComparison,
  automaticComparisonModel,
  type AutomaticComparisonInput,
} from "@/lib/automatic-comparison";
import {
  recordSourceInterpretation,
  type SourceInterpretationRecord,
} from "@/lib/source-interpretation";
import {
  recordSourceSemanticReview,
  readSourceSemanticReview,
  buildGroundedSourceReviewRequests,
  type SourceSemanticReviewRecord,
} from "@/lib/source-semantic-review";
import {
  recordSourceEvidenceReading,
  readSourceEvidenceReading,
} from "@/lib/source-evidence-reading";
import { infer, type AiTransport } from "./ai";
import { documentaryAiConfiguration } from "@/lib/documentary-ai-config";

// Uses the same persistent CHF reservation and actual-usage settlement as the
// existing provider path. No direct unmetered transport is used in production.
export async function compareDocumentaryTarget(
  input: AutomaticComparisonInput,
  transport?: AiTransport,
  beforeRequest?: () => Promise<void>,
  options: {
    loadSourceInterpretations?: (sourceKey: string) => Promise<
      readonly {
        sourceInterpretation: unknown;
        sourceReview: unknown | null;
      }[]
    >;
    loadSourceSemanticReviews?: (reviewInputHash: string) => Promise<unknown[]>;
  } = {},
) {
  const request = buildAutomaticComparisonRequest(input);
  const configuration = documentaryAiConfiguration();
  let sourceInterpretation: SourceInterpretationRecord | null = null;
  let sourceReview: SourceSemanticReviewRecord | null = null;
  if (options.loadSourceInterpretations) {
    await beforeRequest?.();
    const candidates = await options.loadSourceInterpretations(
      request.sourceKey,
    );
    // The loader projects only the public source and its semantic review,
    // never another company's comparison. Invalid current records fail closed.
    // Keep the first valid source in database order, including a rejected
    // review. A missing/stale review does not invalidate or regenerate its draft.
    for (const candidate of candidates) {
      const valid = readAutomaticSourceInterpretation(
        candidate.sourceInterpretation,
        request,
      );
      if (!valid) continue;
      const review =
        candidate.sourceReview == null
          ? null
          : readAutomaticSourceSemanticReview(
              candidate.sourceReview,
              valid,
              request,
            );
      if (!sourceInterpretation) {
        sourceInterpretation = valid;
        sourceReview = review;
      } else if (
        !sourceReview &&
        valid.hash === sourceInterpretation.hash &&
        review
      ) {
        // An older comparison can have the same draft but no review. Reuse
        // the first current review for that exact draft, including rejection.
        sourceReview = review;
      }
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
  if (sourceInterpretation.response.status === "resolved") {
    const reviewPlan = buildAutomaticSourceSemanticReviewRequest(
      request,
      sourceInterpretation,
    );
    if (!sourceReview && options.loadSourceSemanticReviews) {
      await beforeRequest?.();
      const candidates = await options.loadSourceSemanticReviews(
        reviewPlan.inputHash,
      );
      for (const candidate of candidates) {
        const valid = readAutomaticSourceSemanticReview(
          candidate,
          sourceInterpretation,
          request,
        );
        if (!valid)
          throw new Error("Cached semantic review does not match its lookup");
        sourceReview ??= valid;
      }
    }
    if (!sourceReview) {
      const evidenceResponses: unknown[] = [];
      for (const part of reviewPlan.evidencePlan.requests) {
        await beforeRequest?.();
        evidenceResponses.push(
          await infer(
            input.publication,
            "documentary-source-evidence",
            part.prompt,
            part.maxTokens,
            transport,
            part.system,
            part.responseFormat,
            {
              ...configuration,
              model: reviewPlan.model,
              reasoningEffort: reviewPlan.reasoningEffort,
            },
          ),
        );
      }
      const sourceEvidence = recordSourceEvidenceReading(
        evidenceResponses,
        reviewPlan.evidencePlan,
        {
          id: randomUUID(),
          at: new Date().toISOString(),
          model: reviewPlan.model,
        },
      );
      const independent = readSourceEvidenceReading(
        sourceEvidence,
        reviewPlan.evidencePlan,
      )!;
      const responses: unknown[] = [];
      for (const part of independent.accepted
        ? buildGroundedSourceReviewRequests(reviewPlan, sourceEvidence)
        : []) {
        await beforeRequest?.();
        responses.push(
          await infer(
            input.publication,
            "documentary-source-semantic-review",
            part.prompt,
            part.maxTokens,
            transport,
            part.system,
            part.responseFormat,
            {
              ...configuration,
              model: reviewPlan.model,
              reasoningEffort: reviewPlan.reasoningEffort,
            },
          ),
        );
      }
      sourceReview = recordSourceSemanticReview(responses, reviewPlan, {
        id: randomUUID(),
        at: new Date().toISOString(),
        model: reviewPlan.model,
        sourceEvidence,
      });
    }
    const review = readSourceSemanticReview(sourceReview, reviewPlan);
    if (!review) throw new Error("Stale source semantic review");
    await beforeRequest?.();
    if (review.accepted) {
      const finalRequest = buildInterpretedComparisonRequest(
        request,
        sourceInterpretation,
        sourceReview,
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
  } else await beforeRequest?.();
  return recordAutomaticComparison(response, request, {
    id: randomUUID(),
    at: new Date().toISOString(),
    model: automaticComparisonModel(),
    sourceInterpretation,
    sourceReview,
  });
}

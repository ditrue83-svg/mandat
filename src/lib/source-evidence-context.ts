import { stableDocumentaryJson } from "./documentary-observation";
import type { ComparisonPassage } from "./automatic-comparison";
import type { SourceInterpretationContext } from "./source-interpretation";

// Text passages retain their original IDs. Non-string values receive a
// separate namespace: their citation is the exact canonical JSON value at
// rawPath, not a model-generated paraphrase or a fabricated text passage.
export function sourceEvidencePassages(
  context: SourceInterpretationContext,
): ComparisonPassage[] {
  return [
    ...context.body.passages,
    ...context.body.fields.map((field, index) => {
      const text = stableDocumentaryJson(field.value);
      return {
        id: `f${index}`,
        scope: field.scope,
        role: "context" as const,
        rawPath: field.rawPath,
        startUtf16: 0,
        endUtf16: text.length,
        text,
        url: context.body.passages[0].url,
      };
    }),
  ];
}

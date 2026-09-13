import type { SourceReviewEditorData } from "@/components/source-review-editor";

// The validated source context contains finite, acyclic data, including
// null-prototype documentary records. Flight needs ordinary objects instead.
// Copy only for display: preserve undefined, keys and values without rebuilding
// the authoritative snapshot, corpus, history or CAS hashes.
function clientValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clientValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, clientValue(child)]),
    );
  return value;
}

export function sourceReviewEditorData(
  data: SourceReviewEditorData,
): SourceReviewEditorData {
  return clientValue(data) as SourceReviewEditorData;
}

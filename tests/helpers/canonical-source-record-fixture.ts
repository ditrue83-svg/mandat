import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stableDocumentaryJson } from "../../src/lib/documentary-observation";
import {
  SOURCE_INTERPRETATION_VERSION,
  sourceInterpretationRecordSchema,
  validateSourceInterpretation,
  readSourceInterpretation,
  type SourceInterpretationRequest,
  type SourceInterpretationRecord,
} from "../../src/lib/source-interpretation";

// Test-only construction of an invented, already saved canonical record.
// Never use for provider answers, qualification evidence or historical outputs.
// No decoding, protocol override, input rebinding, inferred evidence or repair.
export function createInventedCanonicalSourceRecord(
  response: unknown,
  request: SourceInterpretationRequest,
  metadata: { id: string; at: string; model: string },
): SourceInterpretationRecord {
  if (metadata.model !== request.model)
    throw new Error("Invented canonical record model differs from its request");
  const validated = validateSourceInterpretation(response, request);
  const unsigned = {
    version: SOURCE_INTERPRETATION_VERSION,
    sourceKey: request.sourceKey,
    inputHash: request.inputHash,
    ...metadata,
    response: validated.response,
    classificationContext: request.classificationContext,
    readings: request.readings,
  };
  const record = sourceInterpretationRecordSchema.parse({
    ...unsigned,
    hash: createHash("sha256")
      .update(stableDocumentaryJson(unsigned))
      .digest("hex"),
  });
  assert(readSourceInterpretation(record, request), "Invented saved record must verify on its unchanged request");
  return record;
}

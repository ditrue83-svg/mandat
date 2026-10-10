import type * as Native from "./lot-operational-evidence";
import type { z } from "zod";
export class OperationalFieldReferenceError extends Error {}
export function isFieldBoundRejection(
  e: unknown,
): e is OperationalFieldReferenceError;
export const PROTOCOL_VERSION: "operational-field-bound-v3-direct-date";
export type ProtocolTask = ReturnType<
  typeof Native.buildOperationalReadingTask
>;
export interface FieldBoundProtocol {
  readonly version: typeof PROTOCOL_VERSION;
  readonly binding: string;
  readonly catalog: readonly {
    fieldId: string;
    scope: "selected_lot" | "project_context";
    path: string;
    quote: string;
  }[];
  readonly readingSchema: z.ZodType;
  readonly reviewSchema: z.ZodType;
  readingTask(): ProtocolTask;
  reviewTask(raw: unknown): ProtocolTask;
  decodeReading(raw: unknown): Native.OperationalAnswer;
  decodeReview(raw: unknown): Native.OperationalEvidenceRecord["review"];
  record(
    rawReading: unknown,
    rawReview: unknown,
    metadata: Parameters<typeof Native.recordOperationalEvidence>[3],
  ): Native.OperationalEvidenceRecord;
}
export function createFieldBoundProtocol(
  native: typeof Native,
  request: Native.OperationalRequest,
): FieldBoundProtocol;

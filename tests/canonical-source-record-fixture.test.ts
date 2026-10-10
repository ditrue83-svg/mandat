import assert from "node:assert/strict";
import { test } from "vitest";
import { buildSourceInterpretationRequest, readSourceInterpretation, recordSourceInterpretation, type SourceInterpretationContext } from "../src/lib/source-interpretation";
import { createInventedCanonicalSourceRecord } from "./helpers/canonical-source-record-fixture";
function fixture() {
  const text = "Fornitura di oggetti inventati.";
  const context: SourceInterpretationContext = {
    binding: { target: { kind: "project", publicationId: "invented-saved-fixture" }, source: { original: "invented" }, fieldsHash: "a".repeat(64), shapeEpochToken: "invented", model: "invented-model", reasoningEffort: "medium", maxTokens: 8192 },
    targetScope: "project_context", coverage: { completeProvidedSource: true, linkedDocumentsRead: false, sourceUtf16: text.length, fields: 1, chunks: 1 }, readings: [],
    body: { target: { kind: "project", lot: null }, fields: [], classifications: [], passages: [{ id: "s1", text, scope: "project_context", role: "service", rawPath: "/procurement/orderDescription/it", startUtf16: 0, endUtf16: text.length, url: "https://example.invalid/invented-saved" }] },
  };
  const request = buildSourceInterpretationRequest(context);
  const canonical = { status: "resolved", summary: text, summarySourceRefs: ["s1"], targetRef: "s1", details: [{ kind: "technical_specification", explanation: text, sourceRefs: ["s1"], scope: "project_context" }], classificationReadings: [], issues: [], components: [{ description: text, importance: "not_stated", role: "supply", sourceRefs: ["s1"], roleEvidence: { state: "identified", scope: "project_context", actionText: "Fornitura", sourceRefs: ["s1"] }, meaning: { state: "identified", statement: "Oggetti inventati.", objectText: "oggetti inventati", objectRefs: ["s1"], classificationContextIds: [], basis: "explicit_text" } }] };
  const metadata = { id: "invented-saved-canonical", at: "2030-01-01T00:00:00Z", model: context.binding.model };
  return { context, request, canonical, metadata };
}
test("Invented saved canonical fixture verifies without altering the request or becoming a raw provider answer", () => {
  const { context, request, canonical, metadata } = fixture();
  const before = JSON.stringify({ context, request, canonical });
  const record = createInventedCanonicalSourceRecord(canonical, request, metadata);
  assert(readSourceInterpretation(record, request));
  assert.equal(record.inputHash, request.inputHash);
  assert.equal(JSON.stringify({ context, request, canonical }), before);
  assert.throws(() => recordSourceInterpretation(canonical, request, metadata), /requires its explicit request protocol/);
});
test("Canonical fixture construction preserves missing-clause and foreign-original negatives", () => {
  const { request, canonical, metadata } = fixture();
  assert.throws(() => createInventedCanonicalSourceRecord({ ...canonical, details: [] }, request, metadata), /Incomplete.*contract clauses/);
  const invalid = structuredClone(canonical); invalid.components[0].sourceRefs = ["s999"];
  assert.throws(() => createInventedCanonicalSourceRecord(invalid, request, metadata));
});
test("Saved fixture does not admit raw owned shapes, changed model or forged saved hashes", () => {
  const { request, canonical, metadata } = fixture();
  assert.throws(() => createInventedCanonicalSourceRecord({ ...canonical, evidenceFormat: request.providerFormat }, request, metadata));
  assert.throws(() => createInventedCanonicalSourceRecord(canonical, request, { ...metadata, model: "foreign-model" }));
  const record = createInventedCanonicalSourceRecord(canonical, request, metadata);
  assert.throws(() => readSourceInterpretation({ ...record, id: "tampered" }, request), /Altered/);
});

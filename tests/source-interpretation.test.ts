import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import {
  SOURCE_INTERPRETATION_VERSION,
  buildSourceInterpretationRequest,
  sourceInterpretationKey,
  validateSourceInterpretation,
  recordSourceInterpretation,
  readSourceInterpretation,
  sourceInterpretationRecordSchema,
  type SourceInterpretationContext,
} from "../src/lib/source-interpretation";
import { stableDocumentaryJson } from "../src/lib/documentary-observation";

// Invented records check the source-only contract, never model quality.
function context(): SourceInterpretationContext {
  const values = [
    [
      "s1",
      "/procurement/orderDescription/it",
      "service",
      "Fornitura di prodotti inventati; posa accessoria; trasporto escluso.",
    ],
    ["s2", "/procurement/cpvCode/code", "context", "00000000"],
    ["s3", "/procurement/cpvCode/label/it", "context", "FAMIGLIA_INVENTATA 🌳"],
    [
      "s4",
      "/terms/conditions/it",
      "context",
      "La posa è accessoria. Il trasporto è escluso.",
    ],
  ] as const;
  return {
    binding: {
      target: { kind: "project", publicationId: "invented-publication" },
      source: {
        observationId: "invented-observation",
        snapshotHash: "b".repeat(64),
      },
      fieldsHash: "a".repeat(64),
      shapeEpochToken: "invented-epoch",
      model: "invented-model",
      reasoningEffort: "high",
    },
    targetScope: "project_context",
    coverage: {
      completeProvidedSource: true,
      linkedDocumentsRead: false,
      sourceUtf16: 200,
      fields: 4,
      chunks: 1,
    },
    body: {
      target: { kind: "project", lot: null },
      classifications: [
        {
          scope: "project_context",
          appliesTo: "target",
          rawPath: "/procurement/cpvCode",
          code: { text: "00000000", sourceRefs: ["s2"] },
          labels: [
            {
              language: "it",
              text: "FAMIGLIA_INVENTATA 🌳",
              sourceRefs: ["s3"],
            },
          ],
        },
      ],
      fields: [
        { scope: "project_context", rawPath: "/terms/missing", value: null },
      ],
      passages: values.map(([id, rawPath, role, text]) => ({
        id,
        rawPath,
        role,
        text,
        scope: "project_context",
        startUtf16: 0,
        endUtf16: text.length,
        url: "https://example.invalid/source",
      })),
    },
    readings: [],
  };
}
function response() {
  return {
    status: "resolved" as const,
    summary:
      "Fornitura di prodotti inventati con posa accessoria, senza trasporto.",
    components: [
      {
        description: "Prodotti inventati",
        role: "supply" as const,
        importance: "main" as const,
        sourceRefs: ["s1", "s3"],
      },
      {
        description: "Posa",
        role: "install" as const,
        importance: "accessory" as const,
        sourceRefs: ["s4"],
      },
      {
        description: "Trasporto",
        role: "execute" as const,
        importance: "excluded" as const,
        sourceRefs: ["s4"],
      },
    ],
    issues: [],
    targetRef: "s1",
  };
}
const metadata = {
  id: "invented-source-record",
  at: "2030-01-01T12:00:00.000Z",
  model: "invented-model",
};

test("Source-only API rejects company/profile fields instead of sending or binding them", () => {
  const input = context();
  const request = buildSourceInterpretationRequest(input);
  assert.equal(request.sourceKey, sourceInterpretationKey(input.binding));
  assert.equal(request.model, input.binding.model);
  assert.equal(request.maxTokens, 8192);
  assert.equal(
    request.prompt.includes("https://example.invalid/source"),
    false,
  );
  for (const extra of [
    { ...input, companyId: "private-company" },
    { ...input, profile: { activities: "private-activities" } },
    { ...input, binding: { ...input.binding, companyId: "private-company" } },
    {
      ...input,
      body: { ...input.body, company: { activities: "private-activities" } },
    },
  ])
    assert.throws(() => buildSourceInterpretationRequest(extra));
  assert.throws(
    () =>
      validateSourceInterpretation(
        response(),
        JSON.parse(JSON.stringify(request)),
      ),
    /Unverified/,
  );
});

test("Source and input hashes have separate scopes, stable ordering, and preserve caller ownership", () => {
  const input = context();
  const request = buildSourceInterpretationRequest(input);
  const readingContext = {
    ...input,
    readings: [
      { chunkId: "chunk1", status: "complete" as const, sourceRefs: ["s4"] },
    ],
  };
  const selected = buildSourceInterpretationRequest(readingContext);
  assert.equal(selected.sourceKey, request.sourceKey);
  assert.notEqual(selected.inputHash, request.inputHash);
  assert.equal(
    sourceInterpretationKey({
      ...input.binding,
      source: {
        snapshotHash: "b".repeat(64),
        observationId: "invented-observation",
      },
    }),
    request.sourceKey,
  );
  for (const change of [
    { fieldsHash: "c".repeat(64) },
    { model: "another-model" },
    { reasoningEffort: "none" as const },
    { shapeEpochToken: "another-epoch" },
    { source: { observationId: "another-observation" } },
  ])
    assert.notEqual(
      sourceInterpretationKey({ ...input.binding, ...change }),
      request.sourceKey,
    );
  assert.equal(Object.isFrozen(input.body.passages), false);
  assert.ok(Object.isFrozen(request.body.passages[0]));
  (input.binding.source as { observationId: string }).observationId =
    "changed-after-build";
  assert.equal(
    (request.binding.source as { observationId: string }).observationId,
    "invented-observation",
  );
});

test("Source records retain exact source evidence, all component roles, stable server IDs and no company", () => {
  const request = buildSourceInterpretationRequest(context());
  const record = recordSourceInterpretation(response(), request, metadata);
  const result = readSourceInterpretation(record, request)!;
  assert.equal(result.status, "resolved");
  assert.equal(result.version, SOURCE_INTERPRETATION_VERSION);
  assert.deepEqual(
    result.components.map((item) => [item.id, item.importance]),
    [
      ["u1", "main"],
      ["u2", "accessory"],
      ["u3", "excluded"],
    ],
  );
  assert.deepEqual(
    result.evidence.find((item) => item.id === "s3"),
    request.body.passages[2],
  );
  assert.equal(result.evidence[0].url, "https://example.invalid/source");
  assert.deepEqual(result.response, response());
  assert.deepEqual(result.readings, []);
  assert.deepEqual(Object.keys(record).sort(), [
    "at",
    "hash",
    "id",
    "inputHash",
    "model",
    "readings",
    "response",
    "sourceKey",
    "version",
  ]);
  assert.ok(Object.isFrozen(result.components[0].sourceRefs));
  assert.throws(() =>
    sourceInterpretationRecordSchema.parse({
      ...record,
      companyId: "forbidden",
    }),
  );
});

test("Unknown, duplicated or out-of-target evidence cannot support a source interpretation", () => {
  const request = buildSourceInterpretationRequest(context());
  for (const changed of [
    { targetRef: "s2" },
    { targetRef: "s999" },
    { components: [{ ...response().components[0], sourceRefs: ["s999"] }] },
    { components: [{ ...response().components[0], sourceRefs: ["s1", "s1"] }] },
    { components: [{ ...response().components[0], id: "u9" }] },
  ])
    assert.throws(() =>
      validateSourceInterpretation({ ...response(), ...changed }, request),
    );
  const input = context();
  assert.throws(
    () =>
      buildSourceInterpretationRequest({
        ...input,
        body: {
          ...input.body,
          passages: [...input.body.passages, input.body.passages[0]],
        },
      }),
    /Repeated/,
  );
  assert.throws(
    () =>
      buildSourceInterpretationRequest({
        ...input,
        body: {
          ...input.body,
          classifications: [
            {
              ...input.body.classifications[0],
              code: { text: "invented substitute", sourceRefs: ["s2"] },
            },
          ],
        },
      }),
    /exact source/,
  );
});

test("A selected lot keeps shared classification contextual and requires its own target evidence", () => {
  const input = context();
  const lot: SourceInterpretationContext = {
    ...input,
    binding: {
      ...input.binding,
      target: {
        kind: "lot",
        publicationId: "invented-publication",
        sourceProjectId: "invented-project",
        lotId: "invented-lot",
      },
    },
    targetScope: "selected_lot",
    body: {
      ...input.body,
      target: {
        kind: "lot",
        lot: { id: "invented-lot", path: "/lots/0", headerPath: null },
      },
      classifications: input.body.classifications.map((item) => ({
        ...item,
        appliesTo: "shared_project_context",
      })),
      passages: [
        ...input.body.passages,
        {
          ...input.body.passages[0],
          id: "s5",
          scope: "selected_lot",
          rawPath: "/lots/0/title/it",
        },
      ],
    },
  };
  const request = buildSourceInterpretationRequest(lot);
  assert.throws(
    () => validateSourceInterpretation(response(), request),
    /selected-target/,
  );
  assert.equal(
    validateSourceInterpretation({ ...response(), targetRef: "s5" }, request)
      .targetRef,
    "s5",
  );
  assert.throws(
    () =>
      buildSourceInterpretationRequest({
        ...lot,
        body: { ...lot.body, classifications: input.body.classifications },
      }),
    /scope mismatch/,
  );
  assert.throws(
    () =>
      buildSourceInterpretationRequest({
        ...lot,
        body: {
          ...lot.body,
          passages: lot.body.passages.map((item) =>
            item.id === "s5" ? { ...item, rawPath: "/lots/1/title/it" } : item,
          ),
        },
      }),
    /outside selected lot/,
  );
});

test("Resolved, uncertain and conflicting states enforce evidence contracts without claiming semantic entailment", () => {
  const request = buildSourceInterpretationRequest(context());
  const issue = {
    explanation: "Dubbio inventato per verificare il contratto.",
    sourceRefs: ["s1"],
  };
  assert.throws(
    () =>
      validateSourceInterpretation({ ...response(), components: [] }, request),
    /main component/,
  );
  assert.throws(
    () =>
      validateSourceInterpretation({ ...response(), issues: [issue] }, request),
    /no issues/,
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        { ...response(), status: "uncertain" },
        request,
      ),
    /requires an evidenced/,
  );
  assert.equal(
    validateSourceInterpretation(
      { ...response(), status: "uncertain", issues: [issue] },
      request,
    ).status,
    "uncertain",
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        { ...response(), status: "conflicting", issues: [issue] },
        request,
      ),
    /two distinct/,
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        {
          ...response(),
          status: "conflicting",
          issues: [{ ...issue, sourceRefs: ["s1", "s1"] }],
        },
        request,
      ),
    /Repeated/,
  );
  assert.equal(
    validateSourceInterpretation(
      {
        ...response(),
        status: "conflicting",
        issues: [{ ...issue, sourceRefs: ["s1", "s4"] }],
      },
      request,
    ).status,
    "conflicting",
  );
});

test("Readings remain bound and incomplete or unreadable coverage cannot silently become resolved", () => {
  const input = context();
  assert.throws(
    () =>
      buildSourceInterpretationRequest({
        ...input,
        coverage: { ...input.coverage, chunks: 2 },
      }),
    /Incomplete/,
  );
  assert.throws(
    () =>
      buildSourceInterpretationRequest({
        ...input,
        readings: [
          { chunkId: "chunk1", status: "complete", sourceRefs: ["s999"] },
        ],
      }),
    /absent/,
  );
  const request = buildSourceInterpretationRequest({
    ...input,
    readings: [{ chunkId: "chunk1", status: "unreadable", sourceRefs: [] }],
  });
  assert.throws(
    () => recordSourceInterpretation(response(), request, metadata),
    /Unreadable/,
  );
  const uncertain = {
    ...response(),
    status: "uncertain",
    issues: [{ explanation: "Una parte non è leggibile.", sourceRefs: ["s1"] }],
  };
  const record = recordSourceInterpretation(uncertain, request, metadata);
  assert.deepEqual(
    readSourceInterpretation(record, request)!.readings,
    request.readings,
  );
});

test("Historic versions, changed source or model are stale and current-record tampering is rejected", () => {
  const input = context();
  const request = buildSourceInterpretationRequest(input);
  const record = recordSourceInterpretation(response(), request, metadata);
  assert.equal(
    readSourceInterpretation(
      { ...record, version: "older-source-version" },
      request,
    ),
    null,
  );
  const changed = buildSourceInterpretationRequest({
    ...input,
    binding: { ...input.binding, fieldsHash: "c".repeat(64) },
  });
  assert.equal(readSourceInterpretation(record, changed), null);
  assert.equal(
    readSourceInterpretation({ ...record, model: "another-model" }, request),
    null,
  );
  assert.throws(
    () =>
      recordSourceInterpretation(response(), request, {
        ...metadata,
        model: "another-model",
      }),
    /model changed/,
  );
  assert.throws(
    () => readSourceInterpretation({ ...record, id: "tampered" }, request),
    /Altered/,
  );
  const { hash: _hash, ...unsigned } = record;
  const altered = {
    ...unsigned,
    readings: [{ chunkId: "chunk1", status: "complete", sourceRefs: ["s1"] }],
  };
  const hash = createHash("sha256")
    .update(stableDocumentaryJson(altered))
    .digest("hex");
  assert.throws(
    () => readSourceInterpretation({ ...altered, hash }, request),
    /readings mismatch/,
  );
  assert.equal(record.response.summary, response().summary);
});

test("Provider context is bounded with schema bytes included, never silently truncated", () => {
  const input = context();
  const content = "X".repeat(155_000);
  assert.throws(
    () =>
      buildSourceInterpretationRequest({
        ...input,
        body: {
          ...input.body,
          fields: [
            { scope: "project_context", rawPath: "/invented", value: content },
          ],
        },
      }),
    /source_interpretation_prompt_capacity/,
  );
  const request = buildSourceInterpretationRequest(input);
  assert.ok(
    Buffer.byteLength(
      request.system + request.prompt + JSON.stringify(request.responseFormat),
    ) <= 160_000,
  );
});

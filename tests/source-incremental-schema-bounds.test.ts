import { test } from "vitest";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import {
  buildSourceInterpretationRequest,
  recordSourceInterpretation,
  componentEvidenceGroups,
  type SourceInterpretationContext,
} from "../src/lib/source-interpretation";
import { buildSourceLiteralCatalogue } from "../src/lib/source-literal-catalogue";
import {
  buildSourceMapSelectionSchema,
  normalizeSourceMapSelection,
} from "../src/lib/source-evidence-reading";
const p = (
  id: string,
  text: string,
  rawPath: string,
  role: "service" | "context" = "context",
  scope: "project_context" | "selected_lot" = "project_context",
) => ({
  id,
  text,
  rawPath,
  role,
  scope,
  startUtf16: 0,
  endUtf16: text.length,
  url: "https://example.invalid/source",
});
function fixture(count = 19): SourceInterpretationContext {
  const passages = [
    p(
      "s1",
      "Fornitura di beni inventati.",
      "/procurement/orderDescription/it",
      "service",
    ),
    ...Array.from({ length: count - 1 }, (_, i) =>
      p(
        `s${i + 2}`,
        `Condizione originale ${i + 1}.`,
        `/criteria/qualificationCriteria/${i}/description/it`,
      ),
    ),
    ...Array.from({ length: 32 }, (_, i) =>
      p(`s${i + 100}`, `Meta originale ${i + 1}.`, `/metadata/test/${i}/it`),
    ),
  ];
  return {
    binding: {
      target: { kind: "project", publicationId: "invented-schema-bounds" },
      source: { original: "invented" },
      fieldsHash: "a".repeat(64),
      shapeEpochToken: "invented",
      model: "invented",
      reasoningEffort: "medium",
      maxTokens: 8192,
    },
    targetScope: "project_context",
    coverage: {
      completeProvidedSource: true,
      linkedDocumentsRead: false,
      sourceUtf16: passages.reduce((a, p) => a + p.text.length, 0),
      fields: passages.length,
      chunks: 1,
    },
    readings: [],
    body: {
      target: { kind: "project", lot: null },
      fields: [],
      classifications: [],
      passages,
    },
  };
}
function wire(input: SourceInterpretationContext) {
  const request = buildSourceInterpretationRequest(input),
    cat = buildSourceLiteralCatalogue(
      input.body.passages,
      componentEvidenceGroups(input.body.passages),
    ),
    target = input.body.passages.find(
      (p) => p.scope === input.targetScope && p.role === "service",
    )!,
    id = cat.literals.find((f) => f.sourceRef === target.id)!.parts[0][0];
  return {
    request,
    value: {
      evidenceFormat: "source_selections_v19",
      status: "resolved",
      targetRef: target.id,
      summary: "Fornitura di beni inventati.",
      summaryAdditionalSourceRefs: [],
      components: [
        {
          description: "Fornitura di beni inventati.",
          importance: "not_stated",
          role: "supply",
          evidence: [{ sourceRef: target.id }],
          roleEvidence: {
            state: "identified",
            scope: target.scope,
            actionSelection: { literalSelectionId: id },
          },
          meaning: {
            state: "identified",
            statement: "Beni inventati richiesti.",
            objectSelection: { literalSelectionId: id },
            basis: "explicit_text",
          },
        },
      ],
      classificationReadingsById: {},
      details: [] as any[],
      contractClauseDetails: Object.fromEntries(
        request.contractDetailFamilies.map((f) => [
          f.id,
          { originalFamily: true, kind: "execution_condition" },
        ]),
      ) as any,
      issues: [],
    },
  };
}
const meta = {
  id: "invented-incremental",
  at: "2030-01-01T12:00:00Z",
  model: "invented",
};
const accepts = (request: any, value: any) =>
  new Ajv2020({ strict: false, validateFormats: false }).compile(
    request.responseFormat.json_schema.schema,
  )(value);
const extras = (input: SourceInterpretationContext, n: number) =>
  input.body.passages
    .filter((p) => p.rawPath.startsWith("/metadata/"))
    .slice(0, n)
    .map((p) => ({
      kind: "technical_specification",
      scope: "project_context",
      quoteSelection: { sourceRef: p.id, exactText: p.text },
    }));
test("Compact originalFamily forbids shared-project kind for a project without lots before inference", () => {
  const { request, value } = wire(fixture());
  assert.equal(request.contractDetailFamilies.length, 19);
  assert(accepts(request, value));
  assert.doesNotThrow(() => recordSourceInterpretation(value, request, meta));
  value.contractClauseDetails[request.contractDetailFamilies[1].id].kind =
    "shared_project_context";
  assert.equal(accepts(request, value), false);
  assert.throws(() => recordSourceInterpretation(value, request, meta));
});
test("A lot retains the shared-project originalFamily kind only for its original project field", () => {
  const base = fixture();
  const input: SourceInterpretationContext = {
    ...base,
    binding: {
      ...base.binding,
      target: {
        kind: "lot",
        publicationId: "invented-schema-bounds",
        sourceProjectId: "invented-project",
        lotId: "invented-lot",
      },
    },
    targetScope: "selected_lot",
    body: {
      ...base.body,
      target: {
        kind: "lot",
        lot: { id: "invented-lot", path: "/lots/0", headerPath: null },
      },
      passages: [
        ...base.body.passages,
        p(
          "s1000",
          "Fornitura di beni inventati.",
          "/lots/0/orderDescription/it",
          "service",
          "selected_lot",
        ),
      ],
    },
  };
  const { request, value } = wire(input);
  value.contractClauseDetails.s1.kind = "shared_project_context";
  assert(accepts(request, value));
  assert.doesNotThrow(() => recordSourceInterpretation(value, request, meta));
  value.contractClauseDetails.s1000.kind = "shared_project_context";
  assert.equal(accepts(request, value), false);
});
for (const [families, allowed] of [
  [19, 13],
  [31, 1],
])
  test(`${families} fixed family rows permit ${allowed} optional rows, never ${allowed + 1}`, () => {
    const input = fixture(families),
      { request, value } = wire(input);
    value.details = extras(input, allowed);
    assert(accepts(request, value));
    assert.equal(
      recordSourceInterpretation(value, request, meta).response.details.length,
      32,
    );
    value.details = extras(input, allowed + 1);
    assert.equal(accepts(request, value), false);
    assert.throws(() => recordSourceInterpretation(value, request, meta));
  });
test("Variable fallback arrays retain the prudent aggregate decoder guard instead of a false schema approval", () => {
  const base = fixture(1);
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      fields: [
        {
          scope: "project_context",
          rawPath: "/terms/securityDeposits",
          value: { currency: "CHF", amount: 2 },
        },
      ],
    },
  };
  const { request, value } = wire(input);
  assert.equal(request.contractDetailFamilies.length, 2);
  const literal = request.contractDetailFamilies.find((f) => f.id === "s1")!,
    unknown = request.contractDetailFamilies.find((f) => f.id === "f0")!;
  assert(
    !unknown.originalTextParts &&
      !unknown.originalScalarExplanation &&
      !unknown.originalMultilingualExplanation,
  );
  value.contractClauseDetails = {
    s1: [
      {
        kind: "execution_condition",
        scope: literal.scope,
        sourceRefs: literal.sourceRefs,
        originalText: true,
      },
    ],
    f0: [
      {
        kind: "execution_condition",
        scope: unknown.scope,
        sourceRefs: unknown.sourceRefs,
        explanation: "Valuta CHF.",
      },
      {
        kind: "execution_condition",
        scope: unknown.scope,
        sourceRefs: unknown.sourceRefs,
        explanation: "Deposito 2.",
      },
    ],
  };
  value.details = extras(input, 29);
  assert(accepts(request, value));
  assert.equal(
    recordSourceInterpretation(value, request, meta).response.details.length,
    32,
  );
  value.details = extras(input, 30);
  assert(
    accepts(request, value),
    "JSON Schema validates per-property limits, not sums of multiple variable arrays",
  );
  assert.throws(
    () => recordSourceInterpretation(value, request, meta),
    /aggregate limit/,
  );
});
test("Keyed optional map with64 originals is accepted and65 is rejected in construction", () => {
  const chunk = {
    id: "chunk1",
    passageIds: Array.from({ length: 64 }, (_, i) => `s${i + 1}`),
  };
  const value = {
    chunkId: "chunk1",
    status: "complete",
    referenceFormat: "explicit_optional_selection_v2",
    selections: Object.fromEntries(chunk.passageIds.map((id) => [id, true])),
  };
  assert(buildSourceMapSelectionSchema(chunk).safeParse(value).success);
  assert.equal(normalizeSourceMapSelection(value, chunk).sourceRefs.length, 64);
  const larger = { ...chunk, passageIds: [...chunk.passageIds, "s65"] };
  assert.throws(() => buildSourceMapSelectionSchema(larger), /ownership/);
  assert.throws(
    () =>
      normalizeSourceMapSelection(
        { ...value, selections: { ...value.selections, s65: true } },
        larger,
      ),
    /ownership/,
  );
});

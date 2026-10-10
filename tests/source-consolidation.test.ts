import { test } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import { stableDocumentaryJson } from "../src/lib/documentary-observation";
import { contractualRoleDescription } from "../src/lib/contractual-role";
import {
  materializeSourceInterpretationPassages,
  buildSourceInterpretationRequest,
  sourceClauseLiteralFamilies,
  sourceInterpretationKey,
  SOURCE_INTERPRETATION_VERSION,
  type SourceInterpretationContext,
} from "../src/lib/source-interpretation";
import {
  isContractScopeField,
  sourceScopedCriterionContext,
} from "../src/lib/source-contract-clauses";
import {
  buildSourceMapSelectionSchema,
  normalizeSourceMapSelection,
  requiredSourceMapPassageIds,
} from "../src/lib/source-evidence-reading";
import { projectOriginalClauseDetailEvidence } from "../src/lib/source-clause-provenance";
import { originalClauseTextParts } from "../src/lib/source-clause-literals";
import {
  bindCoverageWitnesses,
  coverageSelectionSchema,
  projectCoverageSelection,
  validateCoverageProof,
} from "../src/lib/source-coverage-proof";
import {
  sourceReviewQuotePreservesOriginalValue,
  materializeSourceReviewDraft,
} from "../src/lib/source-semantic-review";
const passage = (
  id: string,
  text: string,
  rawPath: string,
  scope: "project_context" | "selected_lot" = "project_context",
) => ({
  id,
  text,
  rawPath,
  scope,
  role: "service" as const,
  startUtf16: 0,
  endUtf16: text.length,
  url: "https://example.invalid/source",
});
function context(): SourceInterpretationContext {
  return {
    binding: {
      target: { kind: "project", publicationId: "invented-consolidation" },
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
      sourceUtf16: 100,
      fields: 4,
      chunks: 1,
    },
    readings: [],
    body: {
      target: { kind: "project", lot: null },
      classifications: [],
      fields: [
        {
          scope: "project_context",
          rawPath: "/terms/subContractorAllowed",
          value: false,
        },
        {
          scope: "project_context",
          rawPath: "/terms/subContractorNote/it",
          value: null,
        },
        {
          scope: "project_context",
          rawPath: "/procurement/contractDays",
          value: 60,
        },
      ],
      passages: [
        passage(
          "s1",
          "Fornitura e assistenza richieste.",
          "/procurement/orderDescription/it",
        ),
        passage("s2", "2030-02-01", "/procurement/contractPeriod/dateRange/0"),
        passage("s3", "2031-02-01", "/procurement/contractPeriod/dateRange/1"),
        passage(
          "s4",
          "Forni e assistenza: prestazioni inventate.",
          "/base/title/it",
        ),
      ],
    },
  };
}
test("Consolidated source identity binds the shared taxonomy and refuses the historical version-only key", () => {
  const input = context(),
    digest = (v: unknown) =>
      createHash("sha256").update(stableDocumentaryJson(v)).digest("hex");
  assert.equal(
    sourceInterpretationKey(input.binding),
    digest({
      version: SOURCE_INTERPRETATION_VERSION,
      roleTaxonomyHash: digest(contractualRoleDescription),
      binding: input.binding,
    }),
  );
  assert.notEqual(
    sourceInterpretationKey(input.binding),
    digest({ version: SOURCE_INTERPRETATION_VERSION, binding: input.binding }),
  );
});
test("Full-source literal families retain descriptions, titles, exact date endpoints and false; null remains unchanged", () => {
  const input = context(),
    before = JSON.stringify(input),
    families = sourceClauseLiteralFamilies(input);
  for (const id of ["s1", "s2", "s3", "s4", "f0", "f2"])
    assert(families.requiredContractClauses.some((c) => c.id === id));
  assert(!families.requiredContractClauses.some((c) => c.id === "f1"));
  assert.equal(input.body.fields[1].value, null);
  assert.equal(input.body.fields[0].value, false);
  assert.equal(JSON.stringify(input), before);
  assert(
    buildSourceInterpretationRequest(input).providerFormat ===
      "source_selections_v21_owned",
  );
});
test("Scope filtering retains the foreign context but does not impose its timing or work as this target conditions", () => {
  assert.equal(
    isContractScopeField(
      "/lots/1/contractPeriod/dateRange/0",
      "selected_lot",
      "project_context",
    ),
    false,
  );
  assert.equal(
    isContractScopeField(
      "/lots/1/contractPeriod/dateRange/0",
      "selected_lot",
      "selected_lot",
    ),
    true,
  );
  assert.equal(
    isContractScopeField(
      "/procurement/contractPeriod/dateRange/0",
      "project_context",
      "selected_lot",
    ),
    true,
  );
});
test("Required source-map wire explicitly selects every original once; no metadata-only or canonical live bypass", () => {
  const chunk = {
    id: "chunk1",
    passageIds: ["s1", "s2", "s3"],
    requiredPassageIds: ["s1", "s2"],
  };
  const good = {
    chunkId: "chunk1",
    status: "complete",
    referenceFormat: "explicit_required_originals_v2",
    requiredSourceRefs: { s1: "s1", s2: "s2" },
    sourceRefs: ["s3"],
  };
  assert.deepEqual(normalizeSourceMapSelection(good, chunk).sourceRefs, [
    "s1",
    "s2",
    "s3",
  ]);
  for (const bad of [
    { ...good, requiredSourceRefs: { s1: "s1" } },
    { ...good, requiredSourceRefs: { s1: "s2", s2: "s2" } },
    { ...good, sourceRefs: ["s3", "s3"] },
    { chunkId: "chunk1", status: "complete", sourceRefs: ["s1", "s2"] },
  ])
    assert.throws(() => normalizeSourceMapSelection(bad, chunk));
  assert.deepEqual(
    normalizeSourceMapSelection(
      { chunkId: "chunk1", status: "complete", sourceRefs: ["s1", "s2"] },
      chunk,
      { canonicalStoredRecordForRegression: true },
    ).sourceRefs,
    ["s1", "s2"],
  );
});
test("Optional source-map keyed booleans cannot duplicate or import refs and keep the 64-reference cap", () => {
  const chunk = { id: "chunk1", passageIds: ["s1", "s2"] };
  assert.deepEqual(
    normalizeSourceMapSelection(
      {
        chunkId: "chunk1",
        status: "complete",
        referenceFormat: "explicit_optional_selection_v2",
        selections: { s1: true, s2: false },
      },
      chunk,
    ).sourceRefs,
    ["s1"],
  );
  assert.throws(() =>
    normalizeSourceMapSelection(
      {
        chunkId: "chunk1",
        status: "complete",
        referenceFormat: "explicit_optional_selection_v2",
        selections: { s1: true, s2: false, s3: true },
      },
      chunk,
    ),
  );
  assert.throws(() =>
    buildSourceMapSelectionSchema({
      id: "chunk1",
      passageIds: Array.from({ length: 65 }, (_, i) => `s${i}`),
      requiredPassageIds: Array.from({ length: 65 }, (_, i) => `s${i}`),
    }),
  );
  assert.deepEqual(
    requiredSourceMapPassageIds(context().body.passages, "project_context"),
    ["s1", "s2", "s3", "s4"],
  );
});
test("Language-separated literal projection binds only overlapping fragments and requires the entire witness set", () => {
  const de = "Nicht zulässig: " + "originale inventato. ".repeat(55);
  const it = "Vietato: " + "nota italiana inventata. ".repeat(55);
  const originals = [
    passage("s1", de, "/terms/otherRequirements/de"),
    passage("s2", it, "/terms/otherRequirements/it"),
  ];
  const parts = originalClauseTextParts(originals)!;
  const projected = projectOriginalClauseDetailEvidence(
    [
      {
        kind: "execution_condition",
        scope: "project_context",
        sourceRefs: ["s1", "s2"],
        explanation: parts[0],
        originalTextContinuation: parts.slice(1),
      },
    ],
    originals,
  );
  assert.equal(projected.map((p) => p.explanation).join(""), parts.join(""));
  assert(projected.every((p) => p.sourceRefs.length === 1));
  const draft = {
    summary: "",
    summarySourceRefs: [],
    components: [],
    details: projected,
  };
  const binding = bindCoverageWitnesses(
    {
      claimId: "q1",
      kind: "contract_clause_coverage",
      sourceRefs: ["s1", "s2"],
    },
    draft,
  );
  const validate = new Ajv2020({ strict: false }).compile(
    coverageSelectionSchema(binding, true).toJSONSchema(),
  );
  const selection = Object.fromEntries(
    ["s1", "s2"].map((ref) => [
      ref,
      {
        disposition: "represented",
        draftPaths: binding.requiredWitnessPaths![ref],
      },
    ]),
  );
  assert(validate(selection));
  const proof = projectCoverageSelection(selection, binding);
  validateCoverageProof({
    proof,
    ownedSourceRefs: ["s1", "s2"],
    kind: "contract_clause_coverage",
    verdict: "supported",
    draft,
    requiredWitnessPaths: binding.requiredWitnessPaths,
  });
  const truncated = structuredClone(selection);
  truncated.s1.draftPaths = truncated.s1.draftPaths.slice(0, 1);
  assert.equal(validate(truncated), false);
  assert.throws(() =>
    validateCoverageProof({
      proof: projectCoverageSelection(truncated, binding),
      ownedSourceRefs: ["s1", "s2"],
      kind: "contract_clause_coverage",
      verdict: "supported",
      draft,
      requiredWitnessPaths: binding.requiredWitnessPaths,
    }),
  );
});
test("Negative quotes retain the declared value instead of converting a field label into a positive claim", () => {
  assert.equal(
    sourceReviewQuotePreservesOriginalValue(
      "Consorzio ammesso, valore originale: no",
      "Consorzio ammesso",
    ),
    false,
  );
  assert.equal(
    sourceReviewQuotePreservesOriginalValue(
      "Consorzio ammesso, valore originale: no",
      "valore originale: no",
    ),
    true,
  );
});

test("Literal prompt dictionary reconstructs every original UTF16 span and rejects altered bounds", () => {
  const input = context(),
    request = buildSourceInterpretationRequest(input),
    body = JSON.parse(request.prompt);
  assert.deepEqual(
    materializeSourceInterpretationPassages(request.prompt),
    input.body.passages.map(({ url: _url, ...p }) => p),
  );
  body.passages[0].literal[2]--;
  assert.throws(
    () => materializeSourceInterpretationPassages(JSON.stringify(body)),
    /bounds/,
  );
});
test("Review original detail indices are explicit and cannot be silently reordered", () => {
  const body = {
    originalTextPieces: ["non ammesso"],
    draft: {
      details: [{ index: 0, k: 0, b: "de1", lf: true, literalPiece: 0 }],
      detailKinds: ["execution_condition"],
      detailEvidenceBindings: [
        { id: "de1", scope: "project_context", sourceRefs: ["s1"] },
      ],
    },
  };
  assert.equal(
    materializeSourceReviewDraft(JSON.stringify(body)).details[0].explanation,
    "non ammesso",
  );
  body.draft.details[0].index = 1;
  assert.throws(
    () => materializeSourceReviewDraft(JSON.stringify(body)),
    /index changed/,
  );
});

test("Official documentary context does not combine reference facts and years from separate criteria", () => {
  const originals = [
    passage(
      "s1",
      "Referenze richieste.",
      "/criteria/qualificationCriteria/0/description/it",
    ),
    passage(
      "s2",
      "Documenti allegato B.1.",
      "/criteria/qualificationCriteria/0/verification/it",
    ),
    passage(
      "s3",
      "Anno 2020.",
      "/criteria/qualificationCriteria/1/description/it",
    ),
    passage(
      "s4",
      "Fa fede la documentazione DE nei suoi limiti.",
      "/project-info/documentsLanguagesNote/it",
    ),
  ];
  const c = sourceScopedCriterionContext(originals, ["s1"]);
  assert.deepEqual(
    c.criteria.map((g) => g.originalRefs),
    [["s1", "s2"]],
  );
  assert.deepEqual(c.authorityOriginalRefs, ["s4"]);
  assert(!c.criteria[0].originalRefs.includes("s3"));
});

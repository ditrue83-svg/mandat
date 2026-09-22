import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import { test } from "vitest";
import { stableDocumentaryJson } from "../src/lib/documentary-observation";
import {
  buildSourceInterpretationRequest,
  recordSourceInterpretation,
  type SourceInterpretationContext,
} from "../src/lib/source-interpretation";
import {
  SOURCE_SEMANTIC_REVIEW_VERSION,
  buildSourceSemanticReviewRequest,
  recordSourceSemanticReview as productionRecordSourceSemanticReview,
  readSourceSemanticReview,
  sourceSemanticReviewRecordSchema,
  type SourceSemanticReviewPlan,
} from "../src/lib/source-semantic-review";

import {
  inventedSourceEvidence,
  inventedGroundedReviewRequests,
  inventedReadingRefs,
} from "./helpers/source-evidence-fixture";
import { recordSourceEvidenceReading } from "../src/lib/source-evidence-reading";
function recordSourceSemanticReview(
  responses: unknown[],
  plan: SourceSemanticReviewPlan,
  metadata: { id: string; at: string; model: string },
) {
  return productionRecordSourceSemanticReview(responses, plan, {
    ...metadata,
    sourceEvidence: inventedSourceEvidence(plan),
  });
}

const config = {
  model: "invented-review-model",
  reasoningEffort: "high" as const,
};
const metadata = {
  id: "invented-review-id",
  at: "2030-01-01T12:00:00.000Z",
  model: config.model,
};
const digest = (value: unknown) =>
  createHash("sha256").update(stableDocumentaryJson(value)).digest("hex");
function context(): SourceInterpretationContext {
  const values = [
    [
      "s1",
      "/procurement/orderDescription/it",
      "service",
      "Fornitura di articoli inventati; trasporto escluso.",
    ],
    ["s2", "/procurement/cpvCode/code", "context", "00000000"],
    [
      "s3",
      "/procurement/cpvCode/label/it",
      "context",
      "Categoria inventata 🌳",
    ],
    [
      "s4",
      "/terms/it",
      "context",
      "La quantità sarà definita, la fornitura resta identificata.",
    ],
  ] as const;
  return {
    binding: {
      target: { kind: "project", publicationId: "invented-publication" },
      source: { hash: "invented-observation" },
      fieldsHash: "a".repeat(64),
      shapeEpochToken: "invented-epoch",
      model: "invented-draft-model",
      reasoningEffort: "none",
      maxTokens: 8192,
    },
    targetScope: "project_context",
    coverage: {
      completeProvidedSource: true,
      linkedDocumentsRead: false,
      sourceUtf16: 200,
      fields: 6,
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
              text: "Categoria inventata 🌳",
              sourceRefs: ["s3"],
              language: "it",
            },
          ],
        },
      ],
      fields: [
        { scope: "project_context", rawPath: "/terms/quantity", value: 0 },
        { scope: "project_context", rawPath: "/terms/optional", value: false },
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
function draft(input = context()) {
  const request = buildSourceInterpretationRequest(input);
  const quote = input.body.passages.find((item) => item.id === "s1")!;
  return recordSourceInterpretation(
    {
      status: "resolved",
      summary: "Fornitura di articoli inventati.",
      targetRef: "s1",
      classificationReadings: [
        {
          classificationId: "c1",
          use: "broad_context",
          explanation: "Categoria coerente, senza inventare sottotipi.",
          sourceRefs: ["s2", "s3"],
        },
      ],
      components: [
        {
          description: "Fornitura di articoli inventati.",
          importance: "main",
          sourceRefs: ["s1", "s3"],
          role: "supply",
          roleEvidence: {
            state: "identified",
            actionText: quote.text,
            sourceRefs: ["s1"],
            scope: "project_context",
          },
          meaning: {
            state: "identified",
            statement: "Articoli inventati.",
            objectRefs: ["s1"],
            classificationContextIds: ["c1"],
            basis: "explicit_text",
          },
        },
      ],
      details: [
        {
          kind: "missing_specification",
          explanation: "Quantità non precisata.",
          sourceRefs: ["s4"],
          scope: "project_context",
        },
      ],
      issues: [],
    },
    request,
    { ...metadata, id: "invented-draft", model: input.binding.model },
  );
}
function answers(plan: SourceSemanticReviewPlan) {
  return inventedGroundedReviewRequests(plan).map((request) => {
    const body = JSON.parse(request.prompt);
    return {
      chunkId: request.id,
      sourceEvidenceHash: body.sourceEvidenceHash,
      coverage: "complete" as const,
      checks: request.assignedClaimIds.map((id) => {
        const claim = plan.claims.find((c) => c.id === id)!;
        return {
          claimId: id,
          verdict: "supported" as const,
          reason: "Supporto inventato per verificare soltanto il contratto.",
          sourceRefs: claim.sourceRefs,
          readingRefs: inventedReadingRefs(body, claim),
        };
      }),
      findings: [] as {
        kind: "omitted_scope" | "contradiction" | "unverifiable";
        reason: string;
        sourceRefs: string[];
      }[],
    };
  });
}

test("Independent review is source-only and binds every server claim without changing the draft", () => {
  const input = context(),
    original = draft(input),
    before = JSON.stringify(original);
  const plan = buildSourceSemanticReviewRequest(input, original, config);
  assert.equal(plan.version, SOURCE_SEMANTIC_REVIEW_VERSION);
  assert.equal(plan.sourceKey, original.sourceKey);
  assert.equal(plan.draftHash, original.hash);
  assert.equal(plan.maxTokens, 8192);
  assert.equal(plan.claims.length, 7); // summary + four dimensions + detail + classification
  const prompt = JSON.parse(plan.requests[0].prompt);
  assert.deepEqual(prompt.draft.details, original.response.details);
  assert.deepEqual(
    prompt.classificationContext,
    original.classificationContext,
  );
  assert.equal(
    prompt.passages.find((item: { id: string }) => item.id === "s3").text,
    "Categoria inventata 🌳",
  );
  assert.equal("company" in prompt, false);
  assert.equal("profile" in prompt, false);
  assert.throws(() =>
    buildSourceSemanticReviewRequest(
      { ...input, companyId: "private-company" } as SourceInterpretationContext,
      original,
      config,
    ),
  );
  assert.throws(() =>
    buildSourceSemanticReviewRequest(
      input,
      { ...original, companyId: "private-company" } as typeof original,
      config,
    ),
  );
  assert.equal(Object.isFrozen(plan.context.body.passages), true);
  assert.equal(Object.isFrozen(input.body.passages), false);
  const response = answers(plan);
  for (const [index, request] of plan.requests.entries()) {
    const validate = new Ajv2020({ strict: false }).compile(
      JSON.parse(JSON.stringify(request.responseFormat.json_schema.schema)),
    );
    assert.equal(validate(response[index]), true);
    assert.equal(validate({ accepted: true }), false);
    assert.equal(validate({ ...response[index], checks: [] }), false);
    assert.equal(validate({ ...response[index], chunkId: "review999" }), false);
  }
  const record = recordSourceSemanticReview(response, plan, metadata);
  const result = readSourceSemanticReview(record, plan)!;
  assert.equal(result.accepted, true);
  assert.equal(result.hash, record.hash);
  assert.equal(
    result.evidence.find((item) => item.id === "s1")!.url,
    input.body.passages[0].url,
  );
  assert.equal(JSON.stringify(original), before);
  assert.throws(() =>
    sourceSemanticReviewRecordSchema.parse({
      ...record,
      companyId: "private-company",
    }),
  );
  assert.throws(
    () => recordSourceSemanticReview(response, { ...plan }, metadata),
    /Unverified/,
  );
});

test("Missing repeated foreign and ungrounded checks cannot approve a source", () => {
  const plan = buildSourceSemanticReviewRequest(context(), draft(), config);
  const response = answers(plan);
  assert.throws(
    () => recordSourceSemanticReview([], plan, metadata),
    /Incomplete/,
  );
  const changed = (checks: unknown[]) => [{ ...response[0], checks }];
  for (const checks of [
    response[0].checks.slice(1),
    response[0].checks.map((item, index) =>
      index === 1 ? response[0].checks[0] : item,
    ),
    response[0].checks.map((item, index) =>
      index === 0 ? { ...item, claimId: "q999" } : item,
    ),
  ])
    assert.throws(
      () => recordSourceSemanticReview(changed(checks), plan, metadata),
      /exactly one/,
    );
  assert.throws(
    () =>
      recordSourceSemanticReview(
        changed(
          response[0].checks.map((item, index) =>
            index === 0 ? { ...item, sourceRefs: ["s999"] } : item,
          ),
        ),
        plan,
        metadata,
      ),
    /outside/,
  );
  assert.throws(
    () =>
      recordSourceSemanticReview(
        changed(
          response[0].checks.map((item, index) =>
            index === 0 ? { ...item, sourceRefs: ["s4"] } : item,
          ),
        ),
        plan,
        metadata,
      ),
    /own source/,
  );
  assert.throws(
    () =>
      recordSourceSemanticReview(
        [
          {
            ...response[0],
            findings: [
              {
                kind: "omitted_scope",
                reason: "Fonte ignota",
                sourceRefs: ["s999"],
              },
            ],
          },
        ],
        plan,
        metadata,
      ),
    /outside/,
  );
});

test("Negative inconclusive and unreadable reviews persist without repairing or promoting the draft", () => {
  const original = draft(),
    before = JSON.stringify(original);
  const plan = buildSourceSemanticReviewRequest(context(), original, config);
  for (const verdict of ["contradicted", "not_verifiable"] as const) {
    const response = answers(plan);
    const changed = response.map((item) => ({
      ...item,
      checks: item.checks.map((check, index) =>
        index === 0 ? { ...check, verdict } : check,
      ),
    }));
    const read = readSourceSemanticReview(
      recordSourceSemanticReview(changed, plan, metadata),
      plan,
    )!;
    assert.equal(read.accepted, false);
    assert.equal(read.findings[0].kind, verdict);
  }
  const response = answers(plan);
  response[0].findings.push({
    kind: "omitted_scope",
    reason: "Prestazione inventata non rappresentata.",
    sourceRefs: ["s4"],
  });
  const omitted = readSourceSemanticReview(
    recordSourceSemanticReview(response, plan, metadata),
    plan,
  )!;
  assert.equal(omitted.accepted, false);
  assert.equal(
    omitted.evidence.find((item) => item.id === "s4")!.text,
    context().body.passages[3].text,
  );
  const incomplete = answers(plan).map((item) => ({
    ...item,
    coverage: "unreadable",
  }));
  assert.equal(
    readSourceSemanticReview(
      recordSourceSemanticReview(incomplete, plan, metadata),
      plan,
    )!.accepted,
    false,
  );
  assert.equal(JSON.stringify(original), before);
});

test("Review records become stale for source draft configuration or version and reject tampering", () => {
  const input = context(),
    original = draft(input),
    plan = buildSourceSemanticReviewRequest(input, original, config);
  const record = recordSourceSemanticReview(answers(plan), plan, metadata);
  assert.equal(
    readSourceSemanticReview(
      {
        version: "historical-review",
        sourceKey: plan.sourceKey,
        oldShape: true,
      },
      plan,
    ),
    null,
  );
  for (const change of [
    { version: "historical-review" },
    { sourceKey: "b".repeat(64) },
    { draftHash: "c".repeat(64) },
    { inputHash: "d".repeat(64) },
    { model: "another-model" },
    { reasoningEffort: "none" },
  ])
    assert.equal(
      readSourceSemanticReview({ ...record, ...change }, plan),
      null,
    );
  const anotherPlan = buildSourceSemanticReviewRequest(input, original, {
    ...config,
    reasoningEffort: "none",
  });
  assert.equal(readSourceSemanticReview(record, anotherPlan), null);
  const { hash: _hash, ...unsigned } = original;
  const changedDraft = { ...unsigned, id: "different-draft" };
  const otherPlan = buildSourceSemanticReviewRequest(
    input,
    { ...changedDraft, hash: digest(changedDraft) },
    config,
  );
  assert.equal(readSourceSemanticReview(record, otherPlan), null);
  assert.throws(
    () => readSourceSemanticReview({ ...record, id: "changed" }, plan),
    /Altered/,
  );
  const changed = {
    ...record,
    responses: [{ ...record.responses[0], checks: [] }],
  };
  const { hash: _old, ...body } = changed;
  assert.throws(
    () => readSourceSemanticReview({ ...body, hash: digest(body) }, plan),
    /exactly one/,
  );
  assert.throws(
    () =>
      buildSourceSemanticReviewRequest(
        input,
        { ...original, hash: "0".repeat(64) },
        config,
      ),
    /Altered/,
  );
});

test("Long review covers every original passage and scalar including the unselected tail with one owner per claim", () => {
  const base = context();
  const passages = [
    ...base.body.passages,
    ...Array.from({ length: 120 }, (_, index) => {
      const text =
        index === 119
          ? "ULTIMA CLAUSOLA: una prestazione inventata è esplicitamente esclusa 🌳."
          : `Clausola inventata ${index}: `.padEnd(1500, "x");
      return {
        ...base.body.passages[3],
        id: `s${index + 5}`,
        rawPath: `/terms/${index}/it`,
        text,
        endUtf16: text.length,
      };
    }),
  ];
  const coverage = {
    ...base.coverage,
    sourceUtf16: passages.reduce((sum, item) => sum + item.text.length, 0),
    fields: passages.length + base.body.fields.length,
    chunks: 2,
  };
  const readings = [
    { chunkId: "chunk1", status: "complete" as const, sourceRefs: ["s1"] },
    { chunkId: "chunk2", status: "complete" as const, sourceRefs: [] },
  ];
  // Extraction was allowed to select relevant passages. Review must still see
  // the entire original source and cannot inherit that selection's omissions.
  const reduced = { ...base, coverage, readings };
  const full = { ...reduced, body: { ...base.body, passages } };
  const original = draft(reduced);
  const plan = buildSourceSemanticReviewRequest(full, original, config);
  assert.ok(plan.requests.length > 1 && plan.requests.length <= 32);
  const decoded = plan.requests.map((request) => JSON.parse(request.prompt));
  assert.deepEqual(
    decoded.flatMap((chunk) => chunk.coverage.passageIds),
    passages.map((item) => item.id),
  );
  assert.deepEqual(
    decoded.flatMap((chunk) => chunk.coverage.fieldIndexes),
    [0, 1],
  );
  assert.deepEqual(
    decoded.flatMap((chunk) =>
      chunk.fields.map((field: { value: unknown }) => field.value),
    ),
    [0, false],
  );
  const ids = decoded.flatMap((chunk) =>
    chunk.assignedClaims.map((claim: { id: string }) => claim.id),
  );
  assert.deepEqual(
    [...ids].sort(),
    plan.claims.map((claim) => claim.id).sort(),
  );
  assert.equal(new Set(ids).size, ids.length);
  for (const [index, request] of plan.requests.entries()) {
    assert.ok(
      Buffer.byteLength(
        request.system +
          request.prompt +
          JSON.stringify(request.responseFormat),
      ) <= 160000,
    );
    const chunk = decoded[index];
    for (const claim of chunk.assignedClaims)
      for (const id of claim.sourceRefs)
        assert.ok(
          chunk.passages.some((item: { id: string }) => item.id === id),
        );
    assert.deepEqual(
      chunk.classificationContext,
      original.classificationContext,
    );
  }
  const tail = passages.at(-1)!;
  const tailIndex = decoded.findIndex((chunk) =>
    chunk.coverage.passageIds.includes(tail.id),
  );
  assert.equal(
    decoded[tailIndex].passages.find(
      (item: { id: string }) => item.id === tail.id,
    ).text,
    tail.text,
  );
  const response = answers(plan);
  response[tailIndex].findings.push({
    kind: "contradiction",
    reason: "La coda della fonte richiede verifica.",
    sourceRefs: [tail.id],
  });
  assert.equal(
    readSourceSemanticReview(
      recordSourceSemanticReview(response, plan, metadata),
      plan,
    )!.accepted,
    false,
  );
  const foreign = answers(plan);
  foreign[0].findings.push({
    kind: "contradiction",
    reason: "Cita una coda non visibile in questo gruppo.",
    sourceRefs: [tail.id],
  });
  assert.throws(
    () => recordSourceSemanticReview(foreign, plan, metadata),
    /outside/,
  );
  assert.deepEqual(
    plan.requests,
    buildSourceSemanticReviewRequest(full, original, config).requests,
  );
});

test("Review capacity fails explicitly without truncating an indivisible original field", () => {
  const input = context(),
    original = draft(input);
  const oversized = {
    ...input,
    body: {
      ...input.body,
      fields: [
        ...input.body.fields,
        {
          scope: "project_context" as const,
          rawPath: "/terms/huge",
          value: "x".repeat(160000),
        },
      ],
    },
  };
  const before = JSON.stringify(oversized);
  assert.throws(
    () => buildSourceSemanticReviewRequest(oversized, original, config),
    /source_(semantic_review|evidence)_prompt_capacity/,
  );
  assert.equal(JSON.stringify(oversized), before);
});

test("Changing the proposed draft never changes the independent source request", () => {
  const input = context(),
    first = draft(input);
  const request = buildSourceInterpretationRequest(input);
  const changed = recordSourceInterpretation(
    {
      ...first.response,
      summary:
        "UNA LETTURA DIFFERENTE CHE NON DEVE ENTRARE NEL PRIMO PASSAGGIO.",
    },
    request,
    { ...metadata, id: "other-draft", model: request.model },
  );
  const a = buildSourceSemanticReviewRequest(input, first, config),
    b = buildSourceSemanticReviewRequest(input, changed, config);
  assert.deepEqual(a.evidencePlan.requests, b.evidencePlan.requests);
  assert.equal(a.evidencePlan.inputHash, b.evidencePlan.inputHash);
  assert.notEqual(a.inputHash, b.inputHash);
  assert(!JSON.stringify(a.evidencePlan.requests).includes(first.hash));
  assert(
    !JSON.stringify(b.evidencePlan.requests).includes(changed.response.summary),
  );
});

test("A v1 approval without independent evidence is obsolete and cannot be promoted", () => {
  const plan = buildSourceSemanticReviewRequest(context(), draft(), config);
  const old = {
    version: "documentary-source-semantic-review-v1",
    sourceKey: plan.sourceKey,
    responses: [
      {
        coverage: "complete",
        checks: [{ claimId: "q1", verdict: "supported" }],
        findings: [],
      },
    ],
  };
  assert.equal(readSourceSemanticReview(old, plan), null);
  assert.throws(() =>
    productionRecordSourceSemanticReview(answers(plan), plan, {
      ...metadata,
      sourceEvidence: undefined as never,
    }),
  );
  const responses = answers(plan);
  responses[0].sourceEvidenceHash = "f".repeat(64);
  assert.throws(
    () => recordSourceSemanticReview(responses, plan, metadata),
    /independent evidence mismatch/,
  );
});

test("An independent classification conflict blocks even unanimous draft approval and persists its cause", () => {
  const plan = buildSourceSemanticReviewRequest(context(), draft(), config);
  const oldEvidence = inventedSourceEvidence(plan),
    responses = structuredClone(oldEvidence.responses);
  responses[0].classifications[0].relationship = "conflicting";
  responses[0].classifications[0].explanation =
    "Contraddizione inventata fra due affermazioni originali.";
  responses[0].classifications[0].evidence.push({
    sourceRef: "s1",
    text: context().body.passages[0].text,
  });
  const evidence = recordSourceEvidenceReading(responses, plan.evidencePlan, {
    ...metadata,
    id: "invented-conflict",
  });
  assert.throws(
    () =>
      productionRecordSourceSemanticReview(answers(plan), plan, {
        ...metadata,
        sourceEvidence: evidence,
      }),
    /blocked independent reading/,
  );
  const saved = productionRecordSourceSemanticReview([], plan, {
    ...metadata,
    sourceEvidence: evidence,
  });
  const resolved = readSourceSemanticReview(saved, plan)!;
  assert.equal(resolved.accepted, false);
  assert(resolved.findings.some((f) => f.kind === "classification_conflict"));
  assert.equal(saved.responses.length, 0);
  assert.deepEqual(saved.sourceEvidence, evidence);
});

test("Classification references alone cannot approve the component's contractual role", () => {
  const plan = buildSourceSemanticReviewRequest(context(), draft(), config),
    response = answers(plan);
  const role = plan.claims.find((c) => c.kind === "component_role")!;
  for (const part of response) {
    const check = part.checks.find((c) => c.claimId === role.id);
    if (check) check.readingRefs = ["c1"];
  }
  assert.throws(
    () => recordSourceSemanticReview(response, plan, metadata),
    /independent performance/,
  );
});

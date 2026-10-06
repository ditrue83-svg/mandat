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
  buildGroundedSourceReviewRequests,
  buildSourceSemanticReviewRequest,
  recordSourceSemanticReview as productionRecordSourceSemanticReview,
  readSourceSemanticReview,
  sourceSemanticReviewRecordSchema,
  type SourceSemanticReviewPlan,
} from "../src/lib/source-semantic-review";

import {
  inventedSourceEvidence,
  inventedSourceEvidenceAnswer,
  inventedGroundedReviewRequests,
  inventedReadingRefs,
} from "./helpers/source-evidence-fixture";
import {
  recordSourceEvidenceReading,
  readSourceEvidenceReading,
} from "../src/lib/source-evidence-reading";
import { openaiJsonSchema } from "../src/lib/openai-responses";
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

test("A bilingual meaning statement stays with all owned component evidence while its literal object keeps its narrow proof", () => {
  const base = context();
  const french = "Fourniture de tenues professionnelles inventées.";
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        {
          ...base.body.passages[0],
          id: "s5",
          rawPath: "/procurement/orderDescription/fr",
          text: french,
          endUtf16: french.length,
        },
      ],
    },
  };
  const baseline = draft(input);
  const original = recordSourceInterpretation(
    {
      ...baseline.response,
      components: [
        {
          ...baseline.response.components[0],
          sourceRefs: ["s1", "s5"],
          meaning: {
            ...baseline.response.components[0].meaning,
            objectText: "articoli inventati",
            objectRefs: ["s1"],
            classificationContextIds: [],
            statement:
              "Articoli inventati; la descrizione francese indica tenute professionali inventate.",
          },
        },
      ],
    },
    buildSourceInterpretationRequest(input),
    { ...metadata, model: input.binding.model },
  );
  const before = JSON.stringify(original);
  const plan = buildSourceSemanticReviewRequest(input, original, config);
  const object = plan.claims.find((c) => c.kind === "component_domain")!;
  const statement = plan.claims.find((c) => c.kind === "component_scope")!;
  assert.equal(object.text, "articoli inventati");
  assert.deepEqual(object.sourceRefs, ["s1"]);
  assert(statement.text.includes("descrizione francese"));
  assert(
    statement.sourceRefs.includes("s1") && statement.sourceRefs.includes("s5"),
  );
  assert.equal(JSON.stringify(original), before);
});

test.each([
  ["/procurement/orderAddress/cantonId", "TI", "Ticino"],
  ["/procurement/orderAddress/countryId", "CH", "Svizzera"],
  ["/procurement/orderAddress/cantonId", "ZZ", null],
  ["/procurement/orderAddress/countryId", "TI", null],
  ["/customer/orderAddress/cantonId", "TI", null],
  ["/procurement/orderAddress/city/it", "TI", null],
])(
  "Geographic code vocabulary preserves exact own path and scope without geocoding %s = %s",
  (rawPath, code, name) => {
    const base = context();
    const input: SourceInterpretationContext = {
      ...base,
      body: {
        ...base.body,
        passages: [
          ...base.body.passages,
          {
            ...base.body.passages[3],
            id: "s5",
            rawPath: rawPath!,
            text: code!,
            endUtf16: code!.length,
          },
        ],
      },
    };
    const baseline = draft();
    const original = recordSourceInterpretation(
      {
        ...baseline.response,
        details: [
          ...baseline.response.details,
          {
            kind: "execution_condition",
            explanation: `Valore originale: ${code}.`,
            scope: "project_context",
            sourceRefs: ["s5"],
          },
        ],
      },
      buildSourceInterpretationRequest(input),
      { ...metadata, model: input.binding.model },
    );
    const before = JSON.stringify(input);
    const plan = buildSourceSemanticReviewRequest(input, original, config);
    for (const request of plan.requests) {
      const means = JSON.parse(request.prompt).geographyCodeMeanings ?? [];
      assert.deepEqual(
        means,
        name
          ? [
              {
                sourceRef: "s5",
                rawPath,
                scope: "project_context",
                originalCode: code,
                name,
              },
            ]
          : [],
      );
    }
    assert.equal(JSON.stringify(input), before);
  },
);

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
      summarySourceRefs: ["s1"],
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
            objectText: quote.text,
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
        ...input.body.passages
          .filter((p) => p.rawPath === "/procurement/options/it")
          .map((p) => ({
            kind: "execution_condition" as const,
            explanation: p.text,
            sourceRefs: [p.id],
            scope: p.scope,
          })),
      ],
      issues: [],
    },
    request,
    { ...metadata, id: "invented-draft", model: input.binding.model },
  );
}

test("Summary dates absent from the independent work selection keep their own original proof and still require independent work evidence", () => {
  const base = context();
  const date = "2030-01-01";
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        {
          ...base.body.passages[3],
          id: "s5",
          rawPath: "/procurement/contractPeriod/dateRange/0",
          text: date,
          endUtf16: date.length,
        },
      ],
    },
  };
  const source = recordSourceInterpretation(
    {
      ...draft(input).response,
      summary: "Fornitura di articoli inventati dal 1 gennaio 2030.",
      summarySourceRefs: ["s1", "s5"],
      details: [],
    },
    buildSourceInterpretationRequest(input),
    { ...metadata, model: input.binding.model },
  );
  const plan = buildSourceSemanticReviewRequest(input, source, config);
  const evidence = recordSourceEvidenceReading(
    plan.evidencePlan.requests.map((r) => {
      const value = inventedSourceEvidenceAnswer(JSON.parse(r.prompt));
      value.observations = value.observations.filter(
        (o) => !o.evidence.some((q) => q.sourceRef === "s5"),
      );
      return value;
    }),
    plan.evidencePlan,
    metadata,
  );
  const requests = buildGroundedSourceReviewRequests(plan, evidence);
  const summary = plan.claims.find((c) => c.kind === "summary")!;
  assert.deepEqual(summary.sourceRefs, ["s1", "s5"]);
  const request = requests.find((r) =>
    r.assignedClaimIds.includes(summary.id),
  )!;
  const body = JSON.parse(request.prompt);
  assert(body.originalFacts.some((f: any) => f.id === "o-s5"));
  assert(!JSON.stringify(body.independentReading).includes('"s5"'));
  assert.equal(body.passages.find((p: any) => p.id === "s5").text, date);
  const responses = requests.map((r) => {
    const body = JSON.parse(r.prompt);
    return {
      chunkId: r.id,
      sourceEvidenceHash: evidence.hash,
      coverage: "complete",
      checks: r.assignedClaimIds.map((id) => {
        const claim = plan.claims.find((c) => c.id === id)!;
        return {
          claimId: id,
          verdict: "supported",
          draftQuote: null as string | null,
          reason: "Risposta inventata per verificare il contratto delle prove.",
          sourceRefs: claim.sourceRefs,
          readingRefs: [
            ...inventedReadingRefs(body, claim),
            ...(claim.kind === "summary" ? ["o-s5"] : []),
          ],
        };
      }),
      findings: [],
    };
  });
  const store = (value: unknown[]) =>
    productionRecordSourceSemanticReview(value, plan, {
      ...metadata,
      sourceEvidence: evidence,
    });
  assert.equal(
    readSourceSemanticReview(store(responses), plan)?.accepted,
    true,
  );
  const altered = (
    mutate: (check: (typeof responses)[number]["checks"][number]) => void,
  ) => {
    const value = structuredClone(responses);
    mutate(
      value.flatMap((r) => r.checks).find((c) => c.claimId === summary.id)!,
    );
    return value;
  };
  assert.throws(
    () =>
      store(
        altered((c) => {
          c.readingRefs = ["o-s1", "o-s5"];
        }),
      ),
    /independent performance/,
  );
  assert.throws(
    () =>
      store(
        altered((c) => {
          c.sourceRefs = ["s1"];
        }),
      ),
    /own summary or detail/,
  );
  const unrelated = structuredClone(responses);
  const component = plan.claims.find((c) => c.kind === "component_domain")!;
  unrelated
    .flatMap((r) => r.checks)
    .find((c) => c.claimId === component.id)!
    .readingRefs.push("o-s5");
  assert.throws(() => store(unrelated), /own summary or detail/);
  const negative = altered((c) => {
    c.verdict = "not_verifiable";
    c.draftQuote = "dal 1 gennaio 2030";
  });
  assert.equal(
    readSourceSemanticReview(store(negative), plan)?.accepted,
    false,
  );
});
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
          draftQuote: claim.text.slice(0, 1200),
          verdict: "supported" as const,
          reason: "Supporto inventato per verificare soltanto il contratto.",
          sourceRefs: claim.sourceRefs,
          readingRefs: inventedReadingRefs(body, claim),
        };
      }),
      findings: [] as {
        kind:
          | "omitted_scope"
          | "omitted_contract_condition"
          | "contradiction"
          | "unverifiable";
        reason: string;
        sourceRefs: string[];
      }[],
    };
  });
}

// Encode invented stored fixtures for the distinct provider contract. Never
// hide duplicate IDs while converting: malformed stored lists remain invalid.
function wireResponse({ checks, ...header }: any, request?: any) {
  assert.equal(new Set(checks.map((c: any) => c.claimId)).size, checks.length);
  if (request?.claimReadingGroups) {
    return {
      ...header,
      checksFormat: "claim_keyed_refs_v3",
      checksByClaim: Object.fromEntries(
        checks.map(({ claimId, readingRefs, ...check }: any) => {
          assert.equal(new Set(readingRefs).size, readingRefs.length);
          const group = request.claimReadingGroups.find((g: any) =>
            g.claimIds.includes(claimId),
          );
          const ids =
            check.verdict === "supported" && group?.supportedReadingIds
              ? group.supportedReadingIds
              : (group?.readingIds ?? request.readingIds);
          return [
            claimId,
            {
              ...check,
              readingRefsById: Object.fromEntries([
                ...ids.map((id: string) => [id, readingRefs.includes(id)]),
                // Invalid fixtures stay invalid; do not hide unknown IDs.
                ...readingRefs
                  .filter((id: string) => !ids.includes(id))
                  .map((id: string) => [id, true]),
              ]),
            },
          ];
        }),
      ),
    };
  }
  return {
    ...header,
    checksFormat: "claim_keyed_v1",
    checksByClaim: Object.fromEntries(
      checks.map(({ claimId, ...check }: any) => [claimId, check]),
    ),
  };
}

test("Every provider claim remains required when a large review is split into small groups", () => {
  const input = context(),
    baseline = draft(input);
  const original = recordSourceInterpretation(
    {
      ...baseline.response,
      components: Array.from({ length: 8 }, (_, index) => ({
        ...baseline.response.components[0],
        description:
          index === 7
            ? "Fornitura di articoli inventati; trasporto escluso."
            : baseline.response.components[0].description,
      })),
    },
    buildSourceInterpretationRequest(input),
    { ...metadata, model: input.binding.model },
  );
  const plan = buildSourceSemanticReviewRequest(input, original, config);
  const requests = inventedGroundedReviewRequests(plan);
  assert(requests.some((r) => r.assignedClaimIds.length === 8));
  assert(requests.every((r) => r.assignedClaimIds.length <= 8));
  const lastComponent = original.response.components[7];
  assert(
    requests.some(
      (request) =>
        !request.assignedClaimIds.some((id) =>
          plan.claims
            .find((claim) => claim.id === id)!
            .subject.startsWith("/components/7/"),
        ),
    ),
  );
  for (const request of requests) {
    const body = JSON.parse(request.prompt);
    assert.deepEqual(
      body.draftComponentsForCompleteness,
      original.response.components.map((component, index) => ({
        index,
        description: component.description,
        importance: component.importance,
        sourceRefs: component.sourceRefs,
      })),
    );
    assert(
      body.rules.some((rule: string) =>
        rule.includes("rappresentazione COMPLETA"),
      ),
    );
    assert.equal(
      body.draftComponentsForCompleteness[7].description,
      lastComponent.description,
    );
  }
  const stored = answers(plan),
    wire = stored.map((part, index) => wireResponse(part, requests[index]));
  const validators = requests.map((r) =>
    new Ajv2020({ strict: false }).compile(
      openaiJsonSchema(r.responseFormat.json_schema.schema),
    ),
  );
  wire.forEach((part, i) => assert(validators[i](part)));
  const before = JSON.stringify(wire);
  const record = recordSourceSemanticReview(wire, plan, metadata);
  assert.deepEqual(record.responses, stored);
  assert.equal(readSourceSemanticReview(record, plan)?.accepted, true);
  assert.equal(JSON.stringify(wire), before);
  const firstId = requests[0].assignedClaimIds[0];
  const badValues = [
    (() => {
      const v = structuredClone(wire[0]);
      delete v.checksByClaim[firstId];
      return v;
    })(),
    {
      ...wire[0],
      checksByClaim: {
        ...wire[0].checksByClaim,
        q999: wire[0].checksByClaim[firstId],
      },
    },
    { ...wire[0], checks: stored[0].checks },
    { ...wire[0], checksFormat: "unknown" },
    stored[0],
  ];
  for (const bad of badValues) assert(!validators[0](bad));
  // The stored representation is accepted only through its own strict path.
  for (const bad of badValues.slice(0, -1)) {
    assert.throws(() =>
      recordSourceSemanticReview([bad, ...wire.slice(1)], plan, metadata),
    );
  }
  const repeated = structuredClone(stored);
  repeated[0].checks[1] = repeated[0].checks[0];
  assert.throws(
    () => recordSourceSemanticReview(repeated, plan, metadata),
    /exactly one/,
  );
});

test("Keyed checks retain negative judgments and unreadability without repairing the draft", () => {
  const plan = buildSourceSemanticReviewRequest(context(), draft(), config);
  for (const mode of [
    "contradicted",
    "not_verifiable",
    "unreadable",
  ] as const) {
    const value = answers(plan).map(wireResponse);
    const firstId = plan.requests[0].assignedClaimIds[0];
    if (mode === "unreadable") value[0].coverage = "unreadable";
    else {
      value[0].checksByClaim[firstId].verdict = mode;
      value[0].checksByClaim[firstId].draftQuote = plan.claims
        .find((c) => c.id === firstId)!
        .text.slice(0, 30);
    }
    const result = readSourceSemanticReview(
      recordSourceSemanticReview(value, plan, metadata),
      plan,
    )!;
    assert.equal(result.accepted, false);
    assert.equal(
      result.responses[0].coverage,
      mode === "unreadable" ? "unreadable" : "complete",
    );
    if (mode !== "unreadable")
      assert.equal(result.responses[0].checks[0].verdict, mode);
  }
});

test("A domain review must use its object references, not adjacent action-only evidence", () => {
  const base = context();
  const first = base.body.passages[0];
  const text = "Gli articoli consistono in pannelli informativi.";
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        {
          ...first,
          id: "s5",
          text,
          startUtf16: first.endUtf16,
          endUtf16: first.endUtf16 + text.length,
        },
      ],
    },
  };
  const baseline = draft(input);
  const component = baseline.response.components[0];
  const original = recordSourceInterpretation(
    {
      ...baseline.response,
      components: [
        {
          ...component,
          sourceRefs: ["s1", "s5"],
          meaning: {
            ...component.meaning,
            objectText: "pannelli informativi",
            objectRefs: ["s5"],
          },
        },
      ],
    },
    buildSourceInterpretationRequest(input),
    { ...metadata, model: input.binding.model },
  );
  const plan = buildSourceSemanticReviewRequest(input, original, config);
  const domain = plan.claims.find((c) => c.kind === "component_domain")!;
  const role = plan.claims.find((c) => c.kind === "component_role")!;
  assert.deepEqual(domain.sourceRefs, ["s5", "s2", "s3"]);
  assert.deepEqual(role.sourceRefs, ["s1"]);
  assert(domain.text.includes("pannelli informativi"));
  const responses = answers(plan);
  assert.equal(
    readSourceSemanticReview(
      recordSourceSemanticReview(responses, plan, metadata),
      plan,
    )?.accepted,
    true,
  );
  const wrongSource = structuredClone(responses);
  wrongSource
    .flatMap((r) => r.checks)
    .find((c) => c.claimId === domain.id)!.sourceRefs = ["s1"];
  assert.throws(
    () => recordSourceSemanticReview(wrongSource, plan, metadata),
    /own source evidence/,
  );
  const wrongReading = structuredClone(responses);
  const reading = readSourceEvidenceReading(
    inventedSourceEvidence(plan),
    plan.evidencePlan,
  )!.observations.find((o) => o.evidence.some((q) => q.sourceRef === "s1"))!;
  wrongReading
    .flatMap((r) => r.checks)
    .find((c) => c.claimId === domain.id)!.readingRefs = [reading.id];
  assert.throws(
    () => recordSourceSemanticReview(wrongReading, plan, metadata),
    /own independent evidence/,
  );
});

function languageVariantReview(
  rawPath = "/procurement/orderDescription/de",
  separateCoverage = false,
) {
  const base = context();
  const text = "Lieferung erfundener Artikel; Transport ausgeschlossen.";
  let input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        {
          ...base.body.passages[0],
          id: "s5",
          rawPath,
          text,
          endUtf16: text.length,
        },
      ],
    },
  };
  if (separateCoverage) {
    const translation = input.body.passages.at(-1)!;
    const filler = Array.from({ length: 100 }, (_, index) => {
      const text = `Clausola amministrativa inventata ${index}. `.padEnd(
        1500,
        "x",
      );
      return {
        ...base.body.passages[3],
        id: `s${index + 6}`,
        rawPath: `/terms/unrelated/${index}/it`,
        text,
        endUtf16: text.length,
      };
    });
    const passages = [translation, ...filler, ...base.body.passages];
    input = {
      ...input,
      body: { ...input.body, passages },
      coverage: {
        ...base.coverage,
        sourceUtf16: passages.reduce((n, p) => n + p.text.length, 0),
        fields: passages.length + input.body.fields.length,
        chunks: 2,
      },
      readings: [
        { chunkId: "chunk1", status: "complete", sourceRefs: ["s1"] },
        { chunkId: "chunk2", status: "complete", sourceRefs: [] },
      ],
    };
  }
  const extractionInput = separateCoverage
    ? { ...input, body: base.body }
    : input;
  const plan = buildSourceSemanticReviewRequest(
    input,
    draft(extractionInput),
    config,
  );
  const values = plan.evidencePlan.requests.map((r) =>
    inventedSourceEvidenceAnswer(JSON.parse(r.prompt)),
  );
  for (const value of values) value.observations = [];
  values[0].observations = [
    { kind: "performance", serviceRef: "s5", evidence: [{ sourceRef: "s5" }] },
  ];
  const sourceEvidence = recordSourceEvidenceReading(
    values,
    plan.evidencePlan,
    metadata,
  );
  const requests = buildGroundedSourceReviewRequests(plan, sourceEvidence);
  const responses = requests.map((request) => ({
    chunkId: request.id,
    sourceEvidenceHash: sourceEvidence.hash,
    coverage: "complete",
    checks: request.assignedClaimIds.map((id) => {
      const claim = plan.claims.find((c) => c.id === id)!;
      const classification = claim.kind === "classification_reading",
        detail = claim.kind === "detail" || claim.kind === "scope_coverage";
      return {
        claimId: id,
        draftQuote: claim.text,
        verdict: "supported",
        reason:
          "Giudizio inventato per verificare il collegamento delle citazioni, non una valutazione AI.",
        sourceRefs: [
          ...new Set([
            ...claim.sourceRefs,
            ...(!classification && !detail && request.sourceIds.includes("s5")
              ? ["s5"]
              : []),
          ]),
        ],
        readingRefs: classification
          ? ["c1"]
          : detail
            ? claim.sourceRefs.map((ref) => `o-${ref}`)
            : ["e1-1"],
      };
    }),
    findings: [],
  }));
  return { plan, sourceEvidence, responses, requests };
}

test("A later claim keeps its independent performance from another language and coverage chunk", () => {
  const { plan, sourceEvidence, responses, requests } = languageVariantReview(
    "/procurement/orderDescription/de",
    true,
  );
  assert.ok(plan.requests.length > 1);
  const claim = plan.claims.find((c) => c.kind === "component_importance")!;
  const index = requests.findIndex((r) =>
    r.assignedClaimIds.includes(claim.id),
  );
  assert.ok(index > 0);
  const request = requests[index];
  assert.ok(!request.sourceIds.includes("s5"));
  const body = JSON.parse(request.prompt);
  const performance = body.independentReading.observations.find(
    (o: { id: string }) => o.id === "e1-1",
  );
  assert.equal(performance.kind, "performance");
  assert.deepEqual(performance.evidence, [
    {
      sourceRef: "s5",
      text: "Lieferung erfundener Artikel; Transport ausgeschlossen.",
    },
  ]);
  assert.ok(request.readingIds.includes("e1-1"));
  assert.deepEqual(
    requests.flatMap((r) => r.coverage.passageIds),
    plan.context.body.passages.map((p) => p.id),
  );
  const record = productionRecordSourceSemanticReview(responses, plan, {
    ...metadata,
    sourceEvidence,
  });
  assert.equal(readSourceSemanticReview(record, plan)!.accepted, true);
  const missing = structuredClone(responses);
  missing[index].checks.find((c) => c.claimId === claim.id)!.readingRefs = [
    "c1",
  ];
  assert.throws(
    () =>
      productionRecordSourceSemanticReview(missing, plan, {
        ...metadata,
        sourceEvidence,
      }),
    /independent evidence|relevant independent/,
  );
  const foreign = languageVariantReview("/lots/0/orderDescription/de", true);
  const foreignRequest = foreign.requests.find((r) =>
    r.assignedClaimIds.includes(claim.id),
  )!;
  assert.ok(!foreignRequest.readingIds.includes("e1-1"));
  assert.throws(
    () =>
      productionRecordSourceSemanticReview(foreign.responses, foreign.plan, {
        ...metadata,
        sourceEvidence: foreign.sourceEvidence,
      }),
    /unknown independent reading/,
  );
});

test("A language variant needs the draft citation and an explicit independent reading, without duplicating its source pointer", () => {
  const { plan, sourceEvidence, responses } = languageVariantReview();
  const read = (values: unknown[]) =>
    readSourceSemanticReview(
      productionRecordSourceSemanticReview(values, plan, {
        ...metadata,
        sourceEvidence,
      }),
      plan,
    )!;
  assert.equal(read(responses).accepted, true);
  const claimId = plan.claims.find((c) => c.kind === "component_role")!.id;
  const withoutDuplicate = structuredClone(responses);
  for (const check of withoutDuplicate.flatMap((r) => r.checks)) {
    // Original-fact completeness must keep its own pointer. This regression
    // concerns translation-backed fidelity, which can use the other variant.
    if (
      plan.claims.find((c) => c.id === check.claimId)!.kind !== "scope_coverage"
    )
      check.sourceRefs = check.sourceRefs.filter((ref) => ref !== "s5");
  }
  const unchanged = JSON.stringify(withoutDuplicate);
  assert.equal(read(withoutDuplicate).accepted, true);
  assert.equal(JSON.stringify(withoutDuplicate), unchanged);
  for (const missing of ["draft_source", "independent_reading"]) {
    const changed = structuredClone(responses);
    const check = changed
      .flatMap((r) => r.checks)
      .find((c) => c.claimId === claimId)!;
    if (missing === "draft_source")
      check.sourceRefs = check.sourceRefs.filter((ref) => ref !== "s1");
    else check.readingRefs = ["c1"];
    assert.throws(
      () => read(changed),
      /independent evidence|relevant independent/,
    );
  }
  const negative = structuredClone(withoutDuplicate);
  const check = negative
    .flatMap((r) => r.checks)
    .find((c) => c.claimId === claimId)!;
  check.verdict = "contradicted";
  check.reason =
    "La versione linguistica originale contesta l'azione: controprova inventata.";
  assert.equal(read(negative).accepted, false);
  assert.equal(sourceEvidence.responses[0].observations[0].serviceRef, "s5");
});

test("A language suffix cannot bridge different fields, lots or unnamed text variants", () => {
  for (const rawPath of [
    "/base/title/de",
    "/lots/0/orderDescription/de",
    "/procurement/otherDescription/de",
    "/procurement/orderDescription/extra",
    "/procurement/orderDescription/it",
  ]) {
    const { plan, sourceEvidence, responses } = languageVariantReview(rawPath);
    assert.throws(
      () =>
        productionRecordSourceSemanticReview(responses, plan, {
          ...metadata,
          sourceEvidence,
        }),
      /independent evidence|relevant independent/,
    );
  }
});

test("Metadata warnings survive review without becoming evidence or overriding a negative claim", () => {
  const original = draft(),
    before = JSON.stringify(original);
  const plan = buildSourceSemanticReviewRequest(context(), original, config);
  const inputs = plan.evidencePlan.requests.map((r) =>
    inventedSourceEvidenceAnswer(JSON.parse(r.prompt)),
  );
  inputs[0].classifications[0].relationship = "metadata_discrepancy";
  inputs[0].classifications[0].explanation =
    "Avviso inventato sulla categoria, non prova del significato.";
  inputs[0].classifications[0].evidence.push({ sourceRef: "s1" });
  const sourceEvidence = recordSourceEvidenceReading(
    inputs,
    plan.evidencePlan,
    metadata,
  );
  const grounded = buildGroundedSourceReviewRequests(plan, sourceEvidence);
  for (const request of grounded) {
    const reading = JSON.parse(request.prompt).independentReading;
    assert(
      !JSON.stringify(reading).includes(
        inputs[0].classifications[0].explanation,
      ),
    );
    assert(
      reading.classifications.every(
        (c: any) => !Object.hasOwn(c, "relationship"),
      ),
    );
  }
  const responses = answers(plan).map((r) => ({
    ...r,
    sourceEvidenceHash: sourceEvidence.hash,
  }));
  const reviewed = readSourceSemanticReview(
    productionRecordSourceSemanticReview(responses, plan, {
      ...metadata,
      sourceEvidence,
    }),
    plan,
  )!;
  assert.equal(reviewed.accepted, true);
  assert.equal(
    reviewed.warnings[0].reason,
    inputs[0].classifications[0].explanation,
  );
  assert.match(reviewed.reason, /avviso/);
  assert(
    reviewed.evidence.some(
      (p) => p.id === "s3" && p.text === context().body.passages[2].text,
    ),
  );
  const negative = responses.map((r) => ({
    ...r,
    checks: r.checks.map((c, i) =>
      i === 0 ? { ...c, verdict: "contradicted" } : c,
    ),
  }));
  const blocked = readSourceSemanticReview(
    productionRecordSourceSemanticReview(negative, plan, {
      ...metadata,
      sourceEvidence,
    }),
    plan,
  )!;
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.warnings.length, 1);
  assert.equal(blocked.findings[0].kind, "contradicted");
  assert.equal(JSON.stringify(original), before);
});

test("Territorial review keeps common work and local partition separate without overriding missing proof or negative checks", () => {
  const base = context();
  const local =
    "Regione Est: ripartizione territoriale della fornitura comune.";
  const input: SourceInterpretationContext = {
    ...base,
    binding: {
      ...base.binding,
      target: {
        kind: "lot",
        publicationId: "invented-publication",
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
      classifications: base.body.classifications.map((c) => ({
        ...c,
        appliesTo: "shared_project_context",
      })),
      passages: [
        ...base.body.passages,
        {
          id: "s5",
          rawPath: "/lots/0/title/it",
          role: "service",
          text: local,
          scope: "selected_lot",
          startUtf16: 0,
          endUtf16: local.length,
          url: "https://example.invalid/source",
        },
      ],
    },
  };
  const value = structuredClone(draft().response);
  value.targetRef = "s5";
  value.summarySourceRefs = ["s1", "s5"];
  value.summary = "Fornitura di articoli inventati per la Regione Est.";
  value.components[0].sourceRefs.push("s5");
  value.components[0].meaning.classificationContextIds = [];
  value.classificationReadings[0].use = "shared_project_only";
  const original = recordSourceInterpretation(
    value,
    buildSourceInterpretationRequest(input),
    {
      ...metadata,
      model: input.binding.model,
    },
  );
  const plan = buildSourceSemanticReviewRequest(input, original, config);
  const responses = plan.evidencePlan.requests.map((request) => {
    const answer = inventedSourceEvidenceAnswer(JSON.parse(request.prompt));
    answer.observations = [
      {
        kind: "performance",
        serviceRef: "s1",
        evidence: [{ sourceRef: "s1" }],
      },
      {
        kind: "target_partition",
        serviceRef: "s5",
        evidence: [{ sourceRef: "s5" }],
      },
      {
        kind: "condition",
        serviceRef: "s1",
        evidence: [{ sourceRef: "s4" }],
      },
    ];
    return answer;
  });
  const sourceEvidence = recordSourceEvidenceReading(
    responses,
    plan.evidencePlan,
    metadata,
  );
  const requests = buildGroundedSourceReviewRequests(plan, sourceEvidence);
  const body = JSON.parse(requests[0].prompt);
  assert.deepEqual(
    body.independentReading.observations.map((o: any) => [o.kind, o.scope]),
    [
      ["performance", "project_context"],
      ["target_partition", "selected_lot"],
      ["condition", "project_context"],
    ],
  );
  for (const id of ["s1", "s5"])
    assert.deepEqual(
      body.passages.find((p: any) => p.id === id),
      (({ url: _url, ...passage }) => passage)(
        input.body.passages.find((p) => p.id === id)!,
      ),
    );
  for (const observation of body.independentReading.observations) {
    assert.equal("statement" in observation, false);
    for (const quote of observation.evidence) {
      const originalPassage = input.body.passages.find(
        (p) => p.id === quote.sourceRef,
      )!;
      const text =
        quote.text ??
        body.passages.find((p: any) => p.id === quote.sourceRef).text;
      assert.equal(text, originalPassage.text);
    }
  }
  const rejected = requests.map((request) => {
    const data = JSON.parse(request.prompt);
    return {
      chunkId: request.id,
      sourceEvidenceHash: sourceEvidence.hash,
      coverage: "complete",
      checks: request.assignedClaimIds.map((id) => {
        const claim = plan.claims.find((c) => c.id === id)!;
        return {
          claimId: id,
          draftQuote: claim.text.slice(0, 1200),
          verdict:
            claim.kind === "component_scope" ? "not_verifiable" : "supported",
          reason:
            "Esito inventato per verificare il blocco, non la qualità semantica.",
          sourceRefs: claim.sourceRefs,
          readingRefs: inventedReadingRefs(data, claim),
        };
      }),
      findings: [],
    };
  });
  const record = productionRecordSourceSemanticReview(rejected, plan, {
    ...metadata,
    sourceEvidence,
  });
  assert.equal(readSourceSemanticReview(record, plan)?.accepted, false);
  const incomplete = structuredClone(responses);
  incomplete[0].observations = incomplete[0].observations.filter(
    (o) => o.kind === "target_partition",
  );
  const regionOnly = recordSourceEvidenceReading(
    incomplete,
    plan.evidencePlan,
    metadata,
  );
  assert.throws(
    () => buildGroundedSourceReviewRequests(plan, regionOnly),
    /accepted/,
  );
});

test("Review output allowance is independent from source reading and explicit limits remain bound", () => {
  const input = context();
  const original = draft(input);
  const standard = buildSourceSemanticReviewRequest(input, original, config);
  const explicitSmaller = buildSourceSemanticReviewRequest(input, original, {
    ...config,
    maxTokens: 8192,
  });
  const expanded = buildSourceSemanticReviewRequest(input, original, {
    ...config,
    maxTokens: 16_384,
  });
  assert.equal(standard.maxTokens, 16_384);
  assert(standard.requests.every((request) => request.maxTokens === 16_384));
  assert.equal(standard.evidencePlan.maxTokens, 8192);
  assert.equal(explicitSmaller.maxTokens, 8192);
  assert(
    explicitSmaller.requests.every((request) => request.maxTokens === 8192),
  );
  assert.notEqual(explicitSmaller.inputHash, standard.inputHash);
  assert.equal(
    explicitSmaller.evidencePlan.inputHash,
    standard.evidencePlan.inputHash,
  );
  assert.equal(expanded.maxTokens, 16_384);
  assert.equal(expanded.evidencePlan.maxTokens, 16_384);
  assert(expanded.requests.every((request) => request.maxTokens === 16_384));
  assert(
    expanded.evidencePlan.requests.every(
      (request) => request.maxTokens === 16_384,
    ),
  );
  assert.notEqual(expanded.inputHash, standard.inputHash);
  assert.notEqual(
    expanded.evidencePlan.inputHash,
    standard.evidencePlan.inputHash,
  );
  const standardRecord = recordSourceSemanticReview(
    answers(standard),
    standard,
    metadata,
  );
  const expandedRecord = recordSourceSemanticReview(
    answers(expanded),
    expanded,
    metadata,
  );
  assert.equal("maxTokens" in standardRecord, false);
  assert.equal("maxTokens" in expandedRecord, false);
  const smallerRecord = recordSourceSemanticReview(
    answers(explicitSmaller),
    explicitSmaller,
    metadata,
  );
  assert.equal(smallerRecord.maxTokens, 8192);
  assert.equal(readSourceSemanticReview(smallerRecord, standard), null);
  assert.equal(readSourceSemanticReview(standardRecord, explicitSmaller), null);
  assert.equal(
    readSourceSemanticReview(expandedRecord, expanded)?.accepted,
    true,
  );
  assert.equal(readSourceSemanticReview(standardRecord, expanded), null);
  assert.equal(readSourceSemanticReview(expandedRecord, standard), null);
  for (const maxTokens of [0, 16_385, NaN])
    assert.throws(() =>
      buildSourceSemanticReviewRequest(input, original, {
        ...config,
        maxTokens,
      }),
    );
});

test("A large review uses bounded groups while an explicit output limit changes only the review", () => {
  const input = context();
  input.body.passages[0].text =
    "Fornitura di articoli inventati A, B, C e D; trasporto escluso.";
  input.body.passages[0].endUtf16 = input.body.passages[0].text.length;
  const original = draft(input);
  const complex = recordSourceInterpretation(
    {
      ...original.response,
      components: ["A", "B", "C", "D"].map((group) => ({
        ...original.response.components[0],
        description: `Fornitura di articoli inventati ${group}.`,
        meaning: {
          ...original.response.components[0].meaning,
          statement: `Articoli inventati ${group}.`,
        },
      })),
    },
    buildSourceInterpretationRequest(input),
    { ...metadata, model: input.binding.model },
  );
  const automatic = buildSourceSemanticReviewRequest(input, complex, config);
  const expanded = buildSourceSemanticReviewRequest(input, complex, {
    ...config,
    maxTokens: 16_384,
  });
  assert.equal(
    automatic.claims.filter((c) => c.kind !== "scope_coverage").length,
    19,
  );
  assert.equal(automatic.maxTokens, 16_384);
  assert.equal(expanded.maxTokens, 16_384);
  assert(
    automatic.requests.every((request) => request.assignedClaimIds.length <= 8),
  );
  assert.notEqual(
    automatic.evidencePlan.inputHash,
    expanded.evidencePlan.inputHash,
  );
  assert.deepEqual(automatic.claims, expanded.claims);
  assert.deepEqual(
    automatic.requests.map(({ maxTokens: _, ...request }) => request),
    expanded.requests.map(({ maxTokens: _, ...request }) => request),
  );
  assert.notEqual(automatic.inputHash, expanded.inputHash);
  const record = recordSourceSemanticReview(
    answers(automatic),
    automatic,
    metadata,
  );
  assert.equal(record.maxTokens, undefined);
  assert.equal(readSourceSemanticReview(record, automatic)?.accepted, true);
  assert.equal(readSourceSemanticReview(record, expanded), null);
});

test("Independent review is source-only and binds every server claim without changing the draft", () => {
  const input = context(),
    original = draft(input),
    before = JSON.stringify(original);
  const plan = buildSourceSemanticReviewRequest(input, original, config);
  assert.equal(plan.version, SOURCE_SEMANTIC_REVIEW_VERSION);
  assert.equal(plan.sourceKey, original.sourceKey);
  assert.equal(plan.draftHash, original.hash);
  assert.equal(plan.maxTokens, 16_384);
  assert.equal(plan.claims.length, 8); // fidelity checks plus mandatory source completeness
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
    assert.equal(validate(wireResponse(response[index], request)), true);
    assert.equal(validate({ accepted: true }), false);
    assert.equal(
      validate({
        ...wireResponse(response[index], request),
        checksByClaim: {},
      }),
      false,
    );
    assert.equal(
      validate({
        ...wireResponse(response[index], request),
        chunkId: "review999",
      }),
      false,
    );
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

test("A keyed review blocks omitted work even when every stated claim is supported", () => {
  const base = context();
  const sourceText =
    "Fornitura di articoli inventati, installazione e rimozione finale.";
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: base.body.passages.map((passage, index) =>
        index === 0
          ? { ...passage, text: sourceText, endUtf16: sourceText.length }
          : passage,
      ),
    },
  };
  const original = draft(input);
  const before = JSON.stringify(original);
  const plan = buildSourceSemanticReviewRequest(input, original, config);
  const responses = answers(plan);
  responses[0].findings.push({
    kind: "omitted_scope",
    reason:
      "La fornitura è attestata, ma installazione e rimozione finale non sono rappresentate come lavori acquistati.",
    sourceRefs: ["s1"],
  });
  const stored = recordSourceSemanticReview(
    responses.map(wireResponse),
    plan,
    metadata,
  );
  assert(
    stored.responses
      .flatMap((r) => r.checks)
      .every((c) => c.verdict === "supported"),
  );
  const reviewed = readSourceSemanticReview(stored, plan)!;
  assert.equal(reviewed.accepted, false);
  assert.equal(reviewed.findings.length, 1);
  assert.equal(reviewed.findings[0].kind, "omitted_scope");
  assert.equal(reviewed.evidence.find((p) => p.id === "s1")!.text, sourceText);
  assert.equal(JSON.stringify(original), before);
});

test("Mandatory work completeness uses every component even when the summary uses a collective name", () => {
  const base = context();
  const purchased =
    "Fornitura di pannelli, porte e apparecchi di climatizzazione; realizzazione e rimozione di segnaletica.";
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: base.body.passages.map((p) =>
        p.id === "s1"
          ? { ...p, text: purchased, endUtf16: purchased.length }
          : p,
      ),
    },
  };
  const seed = draft(input).response;
  const component = seed.components[0];
  const descriptions = [
    "Fornitura di pannelli.",
    "Fornitura di porte.",
    "Fornitura di apparecchi di climatizzazione.",
    "Realizzazione e rimozione di segnaletica.",
  ];
  const make = (complete: boolean) =>
    recordSourceInterpretation(
      {
        ...seed,
        summary: "Fornitura di attrezzature e realizzazione di segnaletica.",
        components: descriptions
          .slice(0, complete ? 4 : 3)
          .map((description) => ({
            ...component,
            description,
            meaning: { ...component.meaning, statement: description },
          })),
      },
      buildSourceInterpretationRequest(input),
      { ...metadata, model: input.binding.model },
    );
  const original = make(true),
    before = JSON.stringify(original);
  const plan = buildSourceSemanticReviewRequest(input, original, config);
  const requests = inventedGroundedReviewRequests(plan);
  const coverageClaims = plan.claims.filter((c) => c.kind === "scope_coverage");
  assert.deepEqual(
    coverageClaims.flatMap((c) => c.sourceRefs).sort(),
    [
      ...input.body.passages.map((p) => p.id),
      ...input.body.fields.map((_f, i) => `f${i}`),
    ].sort(),
  );
  assert.equal(new Set(coverageClaims.flatMap((c) => c.sourceRefs)).size, 6);
  for (const claim of coverageClaims) {
    const owner = requests.filter((r) => r.assignedClaimIds.includes(claim.id));
    assert.equal(owner.length, 1);
    const representation = JSON.parse(owner[0].prompt).draft;
    assert.deepEqual(
      representation.components.map((c: any) => c.description),
      descriptions,
    );
    assert.equal(representation.summary, original.response.summary);
    assert.deepEqual(owner[0].ownedScopeCoverageIds, claim.sourceRefs);
    assert(owner[0].assignedClaimIds.length <= 8);
  }
  const valid = answers(plan);
  assert.equal(
    readSourceSemanticReview(
      recordSourceSemanticReview(valid.map(wireResponse), plan, metadata),
      plan,
    )?.accepted,
    true,
  );
  const ownerIndex = requests.findIndex((r) =>
    r.ownedScopeCoverageIds.includes("s1"),
  );
  const nonOwner = requests.findIndex(
    (r) =>
      !r.ownedScopeCoverageIds.includes("s1") && r.sourceIds.includes("s1"),
  );
  assert(nonOwner >= 0);
  const invalid = structuredClone(valid);
  invalid[nonOwner].findings.push({
    kind: "omitted_scope",
    reason:
      "La sintesi breve viene erroneamente scambiata per tutte le componenti.",
    sourceRefs: ["s1"],
  });
  assert.throws(() =>
    recordSourceSemanticReview(invalid.map(wireResponse), plan, metadata),
  );
  assert.throws(
    () => recordSourceSemanticReview(invalid, plan, metadata),
    /mandatory source coverage owner/,
  );
  const missingCheck = structuredClone(valid);
  missingCheck[ownerIndex].checks = missingCheck[ownerIndex].checks.filter(
    (c) => c.claimId !== requests[ownerIndex].scopeCoverageClaim!.id,
  );
  assert.throws(() =>
    recordSourceSemanticReview(missingCheck.map(wireResponse), plan, metadata),
  );
  assert.throws(
    () => recordSourceSemanticReview(missingCheck, plan, metadata),
    /exactly one check/,
  );

  const incomplete = make(false),
    incompleteBefore = JSON.stringify(incomplete);
  const missingPlan = buildSourceSemanticReviewRequest(
    input,
    incomplete,
    config,
  );
  const missingCoverage = missingPlan.claims.find(
    (c) => c.kind === "scope_coverage" && c.sourceRefs.includes("s1"),
  )!;
  const negative = answers(missingPlan);
  Object.assign(
    negative
      .flatMap((r) => r.checks)
      .find((c) => c.claimId === missingCoverage.id)!,
    {
      verdict: "not_verifiable",
      draftQuote: "Tutte le prestazioni acquistate, accessorie o escluse",
      reason:
        "La fonte acquista anche realizzazione e rimozione di segnaletica; la rappresentazione completa non contiene questa componente.",
    },
  );
  assert.equal(
    readSourceSemanticReview(
      recordSourceSemanticReview(
        negative.map(wireResponse),
        missingPlan,
        metadata,
      ),
      missingPlan,
    )?.accepted,
    false,
  );
  assert.equal(JSON.stringify(original), before);
  assert.equal(JSON.stringify(incomplete), incompleteBefore);
});

test("A cited compound contract note can still omit a separate bidding permission", () => {
  const base = context();
  const note =
    "Subappalto ammesso fino al 70%. Le candidature multiple in più offerte sono possibili.";
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        {
          ...base.body.passages[0],
          id: "s5",
          role: "context",
          rawPath: "/terms/subContractorNote/it",
          text: note,
          startUtf16: 0,
          endUtf16: note.length,
        },
      ],
    },
  };
  const request = buildSourceInterpretationRequest(input);
  const original = recordSourceInterpretation(
    {
      ...draft().response,
      details: [
        {
          kind: "execution_condition",
          scope: "project_context",
          sourceRefs: ["s5"],
          explanation: "Subappalto ammesso fino al 70%.",
        },
      ],
    },
    request,
    { ...metadata, model: input.binding.model },
  );
  const plan = buildSourceSemanticReviewRequest(input, original, config);
  const grounded = inventedGroundedReviewRequests(plan);
  const binding = grounded
    .flatMap((part) => JSON.parse(part.prompt).contractClauseDraftBindings)
    .find((item: { sourceRef: string }) => item.sourceRef === "s5");
  assert.deepEqual(binding.candidateDetails, [
    { index: 0, explanation: "Subappalto ammesso fino al 70%." },
  ]);
  assert(
    grounded.some((part) =>
      JSON.parse(part.prompt).requiredContractClauses.some(
        (clause: { id: string; text: string }) =>
          clause.id === "s5" && clause.text === note,
      ),
    ),
  );
  const responses = answers(plan);
  const index = grounded.findIndex((part) =>
    part.ownedContractClauseIds.includes("s5"),
  );
  responses[index].findings.push({
    kind: "omitted_contract_condition",
    reason: "Il draft omette il permesso di comparire in più offerte.",
    sourceRefs: ["s5"],
  });
  const stored = recordSourceSemanticReview(
    responses.map(wireResponse),
    plan,
    metadata,
  );
  const reviewed = readSourceSemanticReview(stored, plan)!;
  assert.equal(reviewed.accepted, false);
  assert.equal(reviewed.findings[0].kind, "omitted_contract_condition");
});

test("Contract completeness locates a detail even when its claim belongs to another review group", () => {
  const base = context();
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        {
          ...base.body.passages[3],
          id: "s5",
          rawPath: "/terms/subContractorAllowed",
          text: "yes",
          endUtf16: 3,
        },
      ],
    },
  };
  const response = draft().response;
  const explanation = "Il ricorso a subappaltatori è consentito.";
  const original = recordSourceInterpretation(
    {
      ...response,
      summary:
        "Fornitura di articoli inventati; ricorso a subappaltatori consentito.",
      summarySourceRefs: ["s1", "s5"],
      components: Array.from({ length: 3 }, () => response.components[0]),
      details: [
        ...response.details,
        {
          kind: "execution_condition",
          scope: "project_context",
          sourceRefs: ["s5"],
          explanation,
        },
      ],
    },
    buildSourceInterpretationRequest(input),
    { ...metadata, model: input.binding.model },
  );
  const before = JSON.stringify(original);
  const plan = buildSourceSemanticReviewRequest(input, original, config);
  const detailClaim = plan.claims.find((c) => c.subject === "/details/1")!;
  const elsewhere = inventedGroundedReviewRequests(plan).filter((part) => {
    const body = JSON.parse(part.prompt);
    return (
      !part.assignedClaimIds.includes(detailClaim.id) &&
      body.requiredContractClauses.some((c: { id: string }) => c.id === "s5")
    );
  });
  assert(elsewhere.length > 0);
  for (const part of elsewhere) {
    const body = JSON.parse(part.prompt);
    assert.deepEqual(body.contractClauseDraftBindings, [
      {
        sourceRef: "s5",
        scope: "project_context",
        candidateDetails: [{ index: 1, explanation }],
      },
    ]);
    assert.deepEqual(body.draft.details, original.response.details);
  }
  assert.equal(JSON.stringify(original), before);
});

test("A cited submission clause with its envelope label omitted has a mandatory independent completeness judgment", () => {
  const base = context();
  const note =
    "Offerta completa, in busta chiusa con dicitura CONCORSO INVENTATO.";
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        {
          ...base.body.passages[3],
          id: "s5",
          rawPath: "/dates/specificDeadlinesAndFormalRequirements/it",
          text: note,
          endUtf16: note.length,
        },
      ],
    },
  };
  const candidate = recordSourceInterpretation(
    {
      ...draft().response,
      details: [
        ...draft().response.details,
        {
          kind: "execution_condition",
          scope: "project_context",
          sourceRefs: ["s5"],
          explanation: "Offerta completa in busta chiusa.",
        },
      ],
    },
    buildSourceInterpretationRequest(input),
    { ...metadata, model: input.binding.model },
  );
  const before = JSON.stringify(candidate);
  const plan = buildSourceSemanticReviewRequest(input, candidate, config);
  const claim = plan.claims.find(
    (c) => c.kind === "contract_clause_coverage" && c.sourceRefs.includes("s5"),
  )!;
  assert(claim);
  const requests = inventedGroundedReviewRequests(plan);
  const owner = requests.findIndex((r) =>
    r.ownedContractClauseIds.includes("s5"),
  );
  assert(owner >= 0);
  assert.equal(
    requests.filter((r) => r.ownedContractClauseIds.includes("s5")).length,
    1,
  );
  const body = JSON.parse(requests[owner].prompt);
  assert.equal(
    body.requiredContractClauses.find((c: any) => c.id === "s5").text,
    note,
  );
  assert.deepEqual(
    body.contractClauseDraftBindings.find((c: any) => c.sourceRef === "s5")
      .candidateDetails,
    [{ index: 1, explanation: "Offerta completa in busta chiusa." }],
  );
  const negative = answers(plan);
  const check = negative[owner].checks.find((c) => c.claimId === claim.id)!;
  Object.assign(check, {
    verdict: "not_verifiable",
    draftQuote: "Tutte le proposizioni della clausola s5 sono rappresentate",
    reason:
      "La dicitura obbligatoria CONCORSO INVENTATO è assente; citare la nota non conserva tale obbligo.",
  });
  assert.equal(
    readSourceSemanticReview(
      recordSourceSemanticReview(negative.map(wireResponse), plan, metadata),
      plan,
    )?.accepted,
    false,
  );
  const missingCheck = structuredClone(negative);
  missingCheck[owner].checks = missingCheck[owner].checks.filter(
    (c) => c.claimId !== claim.id,
  );
  assert.throws(
    () => recordSourceSemanticReview(missingCheck, plan, metadata),
    /exactly one check/,
  );
  assert.equal(JSON.stringify(candidate), before);
});

test("Each original compound clause has one mandatory completeness owner; unrelated groups cannot report its omission", () => {
  const base = context();
  const note =
    "Subappalto ammesso fino al 70%. Le candidature multiple in più offerte sono possibili.";
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        {
          ...base.body.passages[3],
          id: "s5",
          rawPath: "/terms/subContractorNote/it",
          text: note,
          endUtf16: note.length,
        },
      ],
    },
  };
  const response = draft().response;
  const make = (complete: boolean) =>
    recordSourceInterpretation(
      {
        ...response,
        summary: "Fornitura di articoli inventati; subappalto ammesso.",
        summarySourceRefs: ["s1", "s5"],
        components: Array.from({ length: 3 }, () => response.components[0]),
        details: [
          ...response.details,
          {
            kind: "execution_condition",
            scope: "project_context",
            sourceRefs: ["s5"],
            explanation: "Subappalto ammesso fino al 70%.",
          },
          ...(complete
            ? [
                {
                  kind: "execution_condition",
                  scope: "project_context",
                  sourceRefs: ["s5"],
                  explanation:
                    "Sono possibili candidature multiple in più offerte.",
                },
              ]
            : []),
        ],
      },
      buildSourceInterpretationRequest(input),
      { ...metadata, model: input.binding.model },
    );
  const original = make(true),
    before = JSON.stringify(original);
  const plan = buildSourceSemanticReviewRequest(input, original, config);
  const requests = inventedGroundedReviewRequests(plan);
  const coverage = plan.claims.filter(
    (c) => c.kind === "contract_clause_coverage",
  );
  assert.equal(coverage.length, 1);
  assert.deepEqual(coverage[0].sourceRefs, ["s5"]);
  assert(
    coverage[0].text.includes(
      "Sono possibili candidature multiple in più offerte.",
    ),
  );
  const owners = requests.filter((r) =>
    r.ownedContractClauseIds.includes("s5"),
  );
  assert.equal(owners.length, 1);
  assert(owners[0].assignedClaimIds.includes(coverage[0].id));
  assert.equal(
    JSON.parse(owners[0].prompt).passages.find((p: any) => p.id === "s5").text,
    note,
  );
  const nonOwner = requests.findIndex(
    (r) => !r.ownedContractClauseIds.includes("s5"),
  );
  assert(nonOwner >= 0);
  const valid = answers(plan);
  assert.equal(
    readSourceSemanticReview(
      recordSourceSemanticReview(valid.map(wireResponse), plan, metadata),
      plan,
    )?.accepted,
    true,
  );
  const falseFinding = structuredClone(valid);
  falseFinding[nonOwner].findings.push({
    kind: "omitted_contract_condition",
    reason: "Il permesso presente viene erroneamente dichiarato assente.",
    sourceRefs: ["s5"],
  });
  // Both the native strict wire and legacy ordered representation enforce
  // responsibility. Neither silently filters or rescales an invalid finding.
  assert.throws(() =>
    recordSourceSemanticReview(falseFinding.map(wireResponse), plan, metadata),
  );
  assert.throws(
    () => recordSourceSemanticReview(falseFinding, plan, metadata),
    /mandatory clause coverage owner/,
  );
  const omittedCheck = structuredClone(valid);
  const ownerIndex = requests.indexOf(owners[0]);
  omittedCheck[ownerIndex].checks = omittedCheck[ownerIndex].checks.filter(
    (c) => c.claimId !== coverage[0].id,
  );
  assert.throws(
    () => recordSourceSemanticReview(omittedCheck, plan, metadata),
    /exactly one check/,
  );

  const incomplete = make(false);
  const missingPlan = buildSourceSemanticReviewRequest(
    input,
    incomplete,
    config,
  );
  const missingCoverage = missingPlan.claims.find(
    (c) => c.kind === "contract_clause_coverage",
  )!;
  assert(
    !missingCoverage.text.includes(
      "Sono possibili candidature multiple in più offerte.",
    ),
  );
  const negative = answers(missingPlan);
  const missingCheck = negative
    .flatMap((r) => r.checks)
    .find((c) => c.claimId === missingCoverage.id)!;
  Object.assign(missingCheck, {
    verdict: "not_verifiable",
    draftQuote: "Tutte le proposizioni della clausola s5 sono rappresentate",
    reason:
      "Il dettaglio conserva il 70% ma omette il permesso originale di candidature multiple in più offerte.",
  });
  const rejected = readSourceSemanticReview(
    recordSourceSemanticReview(
      negative.map(wireResponse),
      missingPlan,
      metadata,
    ),
    missingPlan,
  )!;
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.findings[0].kind, "not_verifiable");
  assert.equal(JSON.stringify(original), before);
});

for (const flag of ["no", "yes", false] as const) {
  test(`Summary proof remains visible beside null notes in every review group (${String(flag)})`, () => {
    const base = context();
    const ref = typeof flag === "string" ? "s5" : "f2";
    const input: SourceInterpretationContext = {
      ...base,
      body: {
        ...base.body,
        passages:
          typeof flag === "string"
            ? [
                ...base.body.passages,
                {
                  ...base.body.passages[3],
                  id: ref,
                  rawPath: "/terms/subContractorAllowed",
                  text: flag,
                  endUtf16: flag.length,
                },
              ]
            : base.body.passages,
        fields: [
          ...base.body.fields,
          ...(typeof flag === "boolean"
            ? [
                {
                  scope: "project_context" as const,
                  rawPath: "/terms/subContractorAllowed",
                  value: flag,
                },
              ]
            : []),
          ...["de", "en", "fr", "it"].map((language) => ({
            scope: "project_context" as const,
            rawPath: `/terms/subContractorNote/${language}`,
            value: null,
          })),
        ],
      },
    };
    const permitted = flag === "yes";
    const explanation = permitted
      ? "Il ricorso a subappaltatori è consentito."
      : "Il ricorso a subappaltatori non è consentito.";
    const response = draft().response;
    const original = recordSourceInterpretation(
      {
        ...response,
        summary: `Fornitura di articoli inventati. ${explanation}`,
        summarySourceRefs: ["s1", ref],
        components: Array.from({ length: 3 }, () => response.components[0]),
        details: [
          ...response.details,
          {
            kind: "execution_condition",
            scope: "project_context",
            sourceRefs: [ref],
            explanation,
          },
        ],
      },
      buildSourceInterpretationRequest(input),
      { ...metadata, model: input.binding.model },
    );
    const before = JSON.stringify({ input, original });
    const plan = buildSourceSemanticReviewRequest(input, original, config);
    const summary = plan.claims.find((claim) => claim.kind === "summary")!;
    const evidence = recordSourceEvidenceReading(
      plan.evidencePlan.requests.map((part) => {
        const body = JSON.parse(part.prompt);
        const answer = inventedSourceEvidenceAnswer(body);
        // This fixture also reads the explicit false scalar. The usual
        // passage-only helper cannot stand in for a required JSON field.
        for (const field of body.requiredClauseFields) {
          answer.observations.push({
            kind: "condition",
            serviceRef: "s1",
            evidence: [{ sourceRef: field.sourceRef }],
          });
        }
        return answer;
      }),
      plan.evidencePlan,
      metadata,
    );
    const requests = buildGroundedSourceReviewRequests(plan, evidence);
    assert(requests.length > 1);
    assert(
      requests.some((part) => {
        const body = JSON.parse(part.prompt);
        return (
          !part.assignedClaimIds.includes(summary.id) &&
          body.fields.some(
            (field: { rawPath: string; value: unknown }) =>
              field.rawPath.startsWith("/terms/subContractorNote/") &&
              field.value === null,
          )
        );
      }),
    );
    for (const part of requests) {
      const body = JSON.parse(part.prompt);
      assert(part.sourceIds.includes(ref));
      if (typeof flag === "string") {
        const proof = body.passages.find(
          (item: { id: string }) => item.id === ref,
        );
        assert.equal(proof.text, flag);
        assert.equal(proof.rawPath, "/terms/subContractorAllowed");
      } else {
        const proof = body.fields.find(
          (item: { id: string }) => item.id === ref,
        );
        assert.equal(proof.value, false);
        assert.equal(proof.rawPath, "/terms/subContractorAllowed");
      }
      assert.deepEqual(body.draft, JSON.parse(plan.requests[0].prompt).draft);
      assert(
        Buffer.byteLength(
          part.system + part.prompt + JSON.stringify(part.responseFormat),
        ) <= 160000,
      );
    }
    assert.deepEqual(
      requests.flatMap((part) => part.coverage.passageIds),
      input.body.passages.map((item) => item.id),
    );
    assert.deepEqual(
      requests.flatMap((part) => part.coverage.fieldIndexes),
      input.body.fields.map((_item, index) => index),
    );
    assert.equal(
      requests.filter((part) => part.assignedClaimIds.includes(summary.id))
        .length,
      1,
    );
    assert.equal(JSON.stringify({ input, original }), before);
  });
}

test("Shared summary context does not approve a claim that contradicts an explicit permission", () => {
  const base = context();
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        {
          ...base.body.passages[3],
          id: "s5",
          rawPath: "/terms/subContractorAllowed",
          text: "yes",
          endUtf16: 3,
        },
      ],
    },
  };
  const original = recordSourceInterpretation(
    {
      ...draft().response,
      summary: "Fornitura di articoli inventati; subappaltatori vietati.",
      summarySourceRefs: ["s1", "s5"],
      details: [
        {
          kind: "execution_condition",
          scope: "project_context",
          sourceRefs: ["s5"],
          explanation: "Il ricorso a subappaltatori è consentito.",
        },
      ],
    },
    buildSourceInterpretationRequest(input),
    { ...metadata, model: input.binding.model },
  );
  const before = JSON.stringify(original);
  const plan = buildSourceSemanticReviewRequest(input, original, config);
  const claim = plan.claims.find((item) => item.kind === "summary")!;
  const responses = answers(plan).map(wireResponse);
  const owner = responses.find((part) => part.checksByClaim[claim.id])!;
  owner.checksByClaim[claim.id] = {
    verdict: "contradicted",
    draftQuote: "subappaltatori vietati",
    reason: "Il campo originale indica yes: il divieto dichiarato è falso.",
    sourceRefs: ["s5"],
    readingRefs: ["o-s5"],
  };
  const stored = recordSourceSemanticReview(responses, plan, metadata);
  assert.equal(readSourceSemanticReview(stored, plan)!.accepted, false);
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
    { version: "documentary-source-semantic-review-v20" },
    { version: "documentary-source-semantic-review-v22" },
    { version: "documentary-source-semantic-review-v40" },
    { version: "documentary-source-semantic-review-v49" },
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

test.each([null, { dateRange: ["2030-02-01", "2031-02-01"] }])(
  "Duration claims retain their own original fields, separately from extension notes (%j)",
  (period) => {
    const base = context();
    const flag = {
      ...base.body.passages[3],
      id: "s5",
      rawPath: "/procurement/canContractBeExtended",
      text: "no",
      endUtf16: 2,
    };
    const fields: SourceInterpretationContext["body"]["fields"] = [
      {
        scope: "project_context",
        rawPath: "/procurement/contractDays",
        value: null,
      },
      {
        scope: "project_context",
        rawPath: "/procurement/contractPeriod",
        value: period,
      },
      {
        scope: "project_context",
        rawPath: "/procurement/canContractBeExtendedNote/it",
        value: null,
      },
      {
        scope: "project_context",
        rawPath: "/dates/offerValidityDeadlineDays",
        value: 180,
      },
      {
        scope: "selected_lot",
        rawPath: "/procurement/contractPeriod",
        value: { dateRange: ["2040-01-01", "2041-01-01"] },
      },
      {
        scope: "project_context",
        rawPath: "/lots/9/procurement/contractDays",
        value: 365,
      },
      {
        scope: "project_context",
        rawPath: "/procurement/executionDays",
        value: 90,
      },
    ];
    const input: SourceInterpretationContext = {
      ...base,
      body: { ...base.body, passages: [...base.body.passages, flag], fields },
    };
    const before = JSON.stringify(input);
    const original = recordSourceInterpretation(
      {
        ...draft(base).response,
        details: [
          {
            kind: "execution_condition",
            scope: "project_context",
            sourceRefs: ["s5"],
            explanation:
              "Il contratto non è prorogabile; la durata non è indicata.",
          },
          {
            kind: "execution_condition",
            scope: "project_context",
            sourceRefs: ["f3"],
            explanation: "L'offerta ha validità di 180 giorni.",
          },
        ],
      },
      buildSourceInterpretationRequest(input),
      { ...metadata, model: input.binding.model },
    );
    const originalBefore = JSON.stringify(original);
    const plan = buildSourceSemanticReviewRequest(input, original, config);
    const claim = plan.claims.find((c) => c.kind === "detail")!;
    const requests = inventedGroundedReviewRequests(plan);
    const part = requests.find((r) => r.assignedClaimIds.includes(claim.id))!;
    const body = JSON.parse(part.prompt);
    const binding = body.originalFactBindings.find(
      (b: any) => b.claimId === claim.id,
    );
    assert.deepEqual(binding.declaredSourceRefs, ["s5"]);
    assert.deepEqual(binding.relatedNoteContextRefs, ["f2"]);
    assert.deepEqual(binding.relatedContractDurationContextRefs, ["f0", "f1"]);
    const allowed = body.detailEvidenceBindings.find(
      (b: any) => b.claimId === claim.id,
    ).readingIds;
    for (const index of [0, 1, 2]) {
      assert.deepEqual(
        body.fields.find((f: any) => f.id === `f${index}`),
        { id: `f${index}`, index, ...fields[index] },
      );
      assert(allowed.includes(`o-f${index}`));
    }
    for (const index of [3, 4, 5, 6]) assert(!allowed.includes(`o-f${index}`));
    assert.deepEqual(
      requests.flatMap((r) => r.coverage.fieldIndexes),
      fields.map((_, i) => i),
    );
    assert.equal(JSON.stringify(input), before);
    assert.equal(JSON.stringify(original), originalBefore);
    // Supplied context must not turn a negative model judgment into approval.
    const responses = answers(plan);
    const check = responses
      .flatMap((r) => r.checks)
      .find((c) => c.claimId === claim.id)! as {
      verdict: "supported" | "contradicted" | "not_verifiable";
      sourceRefs: string[];
      readingRefs: string[];
    };
    check.verdict = period === null ? "not_verifiable" : "contradicted";
    check.sourceRefs = ["s5", "f1"];
    check.readingRefs = ["o-s5", "o-f1"];
    assert.equal(
      readSourceSemanticReview(
        recordSourceSemanticReview(responses, plan, metadata),
        plan,
      )?.accepted,
      false,
    );
  },
);

test("A value and its nullable Note remain separate original proofs across coverage groups and scopes", () => {
  const base = context();
  const flag = {
    ...base.body.passages[3],
    id: "s5",
    rawPath: "/terms/optional",
    text: "no",
    endUtf16: 2,
  };
  const tail = Array.from({ length: 80 }, (_, i) => {
    const text = `Contesto inventato ${i}: ${"x".repeat(1400)}`;
    return {
      ...flag,
      id: `s${i + 6}`,
      rawPath: `/unrelated/${i}`,
      text,
      endUtf16: text.length,
    };
  });
  const fields: SourceInterpretationContext["body"]["fields"] = [
    {
      scope: "project_context",
      rawPath: "/terms/optionalNote/it",
      value: null,
    },
    {
      scope: "project_context",
      rawPath: "/terms/optionalNote/de",
      value: null,
    },
    { scope: "selected_lot", rawPath: "/terms/optionalNote/it", value: false },
    {
      scope: "project_context",
      rawPath: "/terms/optionalOtherNote/it",
      value: null,
    },
  ];
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [...base.body.passages, flag, ...tail],
      fields,
    },
  };
  const before = JSON.stringify(input);
  const original = recordSourceInterpretation(
    {
      ...draft(base).response,
      details: [
        {
          kind: "execution_condition",
          scope: "project_context",
          sourceRefs: ["s5"],
          explanation:
            "L'opzione non è ammessa; la nota esplicativa non è indicata.",
        },
      ],
    },
    buildSourceInterpretationRequest(input),
    { ...metadata, model: input.binding.model },
  );
  const draftBefore = JSON.stringify(original);
  const plan = buildSourceSemanticReviewRequest(input, original, config);
  const requests = inventedGroundedReviewRequests(plan);
  const claim = plan.claims.find((c) => c.kind === "detail")!;
  const part = requests.find((r) => r.assignedClaimIds.includes(claim.id))!;
  const body = JSON.parse(part.prompt);
  assert(requests.length > 1);
  assert(!part.coverage.fieldIndexes.includes(0));
  assert.deepEqual(claim.sourceRefs, ["s5"]);
  assert.deepEqual(
    body.originalFactBindings.find((b: any) => b.claimId === claim.id),
    {
      claimId: claim.id,
      declaredSourceRefs: ["s5"],
      relatedNoteContextRefs: ["f1", "f0"],
    },
  );
  for (const index of [0, 1]) {
    const field = body.fields.find((f: any) => f.id === `f${index}`);
    assert.deepEqual(field, { id: `f${index}`, index, ...fields[index] });
    assert(
      body.detailEvidenceBindings
        .find((b: any) => b.claimId === claim.id)
        .readingIds.includes(`o-f${index}`),
    );
  }
  assert(
    !body.detailEvidenceBindings
      .find((b: any) => b.claimId === claim.id)
      .readingIds.some((id: string) => id === "o-f2" || id === "o-f3"),
  );
  assert.deepEqual(
    requests.flatMap((r) => r.coverage.fieldIndexes),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    requests.flatMap((r) => r.coverage.passageIds),
    input.body.passages.map((p) => p.id),
  );
  const responses = answers(plan);
  const check = responses
    .flatMap((r) => r.checks)
    .find((c) => c.claimId === claim.id)!;
  check.sourceRefs = ["s5", "f0", "f1"];
  check.readingRefs = ["o-s5", "o-f0", "o-f1"];
  assert(
    readSourceSemanticReview(
      recordSourceSemanticReview(responses, plan, metadata),
      plan,
    )?.accepted,
  );
  // Structural context never overrides a negative judgment or supplies proof
  // from another scope or merely similarly named field.
  const negative = structuredClone(responses);
  negative
    .flatMap((r) => r.checks)
    .find((c) => c.claimId === claim.id)!.verdict = "contradicted" as any;
  assert.equal(
    readSourceSemanticReview(
      recordSourceSemanticReview(negative, plan, metadata),
      plan,
    )?.accepted,
    false,
  );
  for (const other of ["f2", "f3"]) {
    const wrong = structuredClone(responses);
    const c = wrong
      .flatMap((r) => r.checks)
      .find((c) => c.claimId === claim.id)!;
    c.sourceRefs = [other];
    c.readingRefs = [`o-${other}`];
    assert.throws(() => recordSourceSemanticReview(wrong, plan, metadata));
  }
  assert.equal(JSON.stringify(input), before);
  assert.equal(JSON.stringify(original), draftBefore);
});

test.each([
  ["subContractor", "Allowed"],
  ["subContractor", "MultiApplicationAllowed"],
  ["consortium", "Allowed"],
  ["consortium", "MultiApplicationAllowed"],
])(
  "The simap %s%s field carries its actual organizational Note without borrowing another scope or path",
  (family, flagName) => {
    const base = context();
    const flag = {
      ...base.body.passages[3],
      id: "s5",
      rawPath: `/terms/${family}${flagName}`,
      text: "no",
      endUtf16: 2,
    };
    const fields: SourceInterpretationContext["body"]["fields"] = [
      {
        scope: "project_context",
        rawPath: `/terms/${family}Note/de`,
        value: null,
      },
      {
        scope: "project_context",
        rawPath: `/terms/${family}Note/it`,
        value: null,
      },
      {
        scope: "selected_lot",
        rawPath: `/terms/${family}Note/it`,
        value: null,
      },
      {
        scope: "project_context",
        rawPath: `/lots/9/terms/${family}Note/it`,
        value: null,
      },
      {
        scope: "project_context",
        rawPath: `/terms/${family}OtherNote/it`,
        value: null,
      },
    ];
    const input: SourceInterpretationContext = {
      ...base,
      body: { ...base.body, passages: [...base.body.passages, flag], fields },
    };
    const before = JSON.stringify(input);
    const original = recordSourceInterpretation(
      {
        ...draft(base).response,
        details: [
          {
            kind: "execution_condition",
            scope: "project_context",
            sourceRefs: ["s5"],
            explanation: "Il valore è no; la nota non è indicata.",
          },
        ],
      },
      buildSourceInterpretationRequest(input),
      { ...metadata, model: input.binding.model },
    );
    const draftBefore = JSON.stringify(original);
    const plan = buildSourceSemanticReviewRequest(input, original, config);
    const claim = plan.claims.find((c) => c.kind === "detail")!;
    const request = inventedGroundedReviewRequests(plan).find((r) =>
      r.assignedClaimIds.includes(claim.id),
    )!;
    const body = JSON.parse(request.prompt);
    assert.deepEqual(
      body.originalFactBindings.find((b: any) => b.claimId === claim.id),
      {
        claimId: claim.id,
        declaredSourceRefs: ["s5"],
        relatedNoteContextRefs: ["f0", "f1"],
      },
    );
    assert.deepEqual(claim.sourceRefs, ["s5"]);
    const allowed = body.detailEvidenceBindings.find(
      (b: any) => b.claimId === claim.id,
    ).readingIds;
    for (const index of [0, 1]) {
      assert(allowed.includes(`o-f${index}`));
      assert.deepEqual(
        body.fields.find((f: any) => f.id === `f${index}`),
        { id: `f${index}`, index, ...fields[index] },
      );
    }
    assert(
      !allowed.some((id: string) => ["o-f2", "o-f3", "o-f4"].includes(id)),
    );
    assert.deepEqual(
      plan.requests.flatMap((r) => r.coverage.fieldIndexes),
      [0, 1, 2, 3, 4],
    );
    const responses = answers(plan);
    const check = responses
      .flatMap((r) => r.checks)
      .find((c) => c.claimId === claim.id)!;
    check.sourceRefs = ["s5", "f0", "f1"];
    check.readingRefs = ["o-s5", "o-f0", "o-f1"];
    assert(
      readSourceSemanticReview(
        recordSourceSemanticReview(responses, plan, metadata),
        plan,
      )?.accepted,
    );
    const negative = structuredClone(responses);
    negative
      .flatMap((r) => r.checks)
      .find((c) => c.claimId === claim.id)!.verdict = "not_verifiable" as any;
    assert.equal(
      readSourceSemanticReview(
        recordSourceSemanticReview(negative, plan, metadata),
        plan,
      )?.accepted,
      false,
    );
    assert.equal(JSON.stringify(input), before);
    assert.equal(JSON.stringify(original), draftBefore);
  },
);

test.each(["subContractor", "consortium"])(
  "The simap %sNote carries both original flags as separate context",
  (family) => {
    const base = context();
    const note = {
      ...base.body.passages[3],
      id: "s5",
      rawPath: `/terms/${family}Note/it`,
      text: "Condizione organizzativa inventata.",
      endUtf16: 33,
    };
    note.endUtf16 = note.text.length;
    const allowed = {
      ...note,
      id: "s6",
      rawPath: `/terms/${family}Allowed`,
      text: "yes",
      endUtf16: 3,
    };
    const multiple = {
      ...note,
      id: "s7",
      rawPath: `/terms/${family}MultiApplicationAllowed`,
      text: "no",
      endUtf16: 2,
    };
    const unrelated = {
      ...allowed,
      id: "s8",
      rawPath: `/terms/${family}OtherAllowed`,
    };
    const foreign = {
      ...allowed,
      id: "s9",
      rawPath: `/lots/9/terms/${family}Allowed`,
    };
    const input = {
      ...base,
      body: {
        ...base.body,
        passages: [
          ...base.body.passages,
          note,
          allowed,
          multiple,
          unrelated,
          foreign,
        ],
      },
    };
    const before = JSON.stringify(input);
    const original = recordSourceInterpretation(
      {
        ...draft(base).response,
        details: [note, allowed, multiple, unrelated, foreign].map((p) => ({
          kind: "execution_condition" as const,
          scope: "project_context" as const,
          sourceRefs: [p.id],
          explanation: p.text,
        })),
      },
      buildSourceInterpretationRequest(input),
      { ...metadata, model: input.binding.model },
    );
    const plan = buildSourceSemanticReviewRequest(input, original, config);
    const claim = plan.claims.find((c) => c.kind === "detail")!;
    const request = inventedGroundedReviewRequests(plan).find((r) =>
      r.assignedClaimIds.includes(claim.id),
    )!;
    const body = JSON.parse(request.prompt);
    assert.deepEqual(
      body.originalFactBindings.find((b: any) => b.claimId === claim.id),
      {
        claimId: claim.id,
        declaredSourceRefs: ["s5"],
        relatedNoteContextRefs: ["s6", "s7"],
      },
    );
    assert.deepEqual(claim.sourceRefs, ["s5"]);
    const own = body.detailEvidenceBindings.find(
      (b: any) => b.claimId === claim.id,
    ).readingIds;
    assert(own.includes("o-s6") && own.includes("o-s7"));
    assert(!own.includes("o-s8") && !own.includes("o-s9"));
    assert.equal(JSON.stringify(input), before);
  },
);

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
          [...chunk.passages, ...chunk.fields].some(
            (item: { id: string }) => item.id === id,
          ),
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

test("A rich draft with many small original facts still fits grounded review without losing work or scalar coverage", () => {
  const base = context();
  const labels = Array.from({ length: 12 }, (_, i) => ({
    ...base.body.passages[2],
    id: `s${i + 5}`,
    rawPath: `/invented/classifications/${i}/label/it`,
    text: `Famiglia inventata ${i}. `.padEnd(100, "x"),
    endUtf16: 100,
  }));
  const classifications = [
    ...base.body.classifications,
    ...labels.map((p, i) => ({
      ...base.body.classifications[0],
      rawPath: `/invented/classifications/${i}`,
      code: null,
      labels: [{ text: p.text, sourceRefs: [p.id], language: "it" }],
    })),
  ];
  const passages = [
    ...base.body.passages,
    ...labels,
    ...Array.from({ length: 180 }, (_, i) => {
      const text = `Condizione inventata ${i}. `.padEnd(300, "x");
      return {
        ...base.body.passages[3],
        id: `s${i + 17}`,
        rawPath: `/conditions/${i}/it`,
        text,
        endUtf16: text.length,
      };
    }),
  ];
  const fields = [
    ...base.body.fields,
    ...Array.from({ length: 300 }, (_, i) => ({
      scope: "project_context" as const,
      rawPath: `/metadata/${i}`,
      value: `Valore originale inventato ${i}. `.padEnd(220, "x"),
    })),
  ];
  const reduced = {
    ...base,
    body: {
      ...base.body,
      passages: [...base.body.passages, ...labels],
      classifications,
    },
    coverage: {
      ...base.coverage,
      sourceUtf16: passages.reduce((n, p) => n + p.text.length, 0),
      fields: passages.length + fields.length,
      chunks: 2,
    },
    readings: [
      { chunkId: "chunk1", status: "complete" as const, sourceRefs: ["s1"] },
      { chunkId: "chunk2", status: "complete" as const, sourceRefs: [] },
    ],
  };
  const seed = draft(base).response;
  const original = recordSourceInterpretation(
    {
      ...seed,
      classificationReadings: classifications.map((c, i) => ({
        classificationId: `c${i + 1}`,
        use: "broad_context" as const,
        explanation: "Famiglia inventata di contesto, senza nuove prestazioni.",
        sourceRefs: c.labels[0].sourceRefs,
      })),
      components: Array.from({ length: 3 }, (_, i) => ({
        ...seed.components[0],
        description: `Prestazione inventata ${i}. `.padEnd(590, "x"),
      })),
      details: Array.from({ length: 29 }, (_, i) => ({
        ...seed.details[0],
        explanation: `Dettaglio inventato ${i}. `.padEnd(590, "x"),
      })),
    },
    buildSourceInterpretationRequest(reduced),
    { ...metadata, model: reduced.binding.model },
  );
  const full = { ...reduced, body: { ...reduced.body, passages, fields } },
    before = JSON.stringify(full),
    draftBefore = JSON.stringify(original);
  const plan = buildSourceSemanticReviewRequest(full, original, config);
  const requests = inventedGroundedReviewRequests(plan);
  assert(requests.length > 1 && requests.length <= 32);
  assert.deepEqual(
    requests.flatMap((r) => r.coverage.passageIds),
    passages.map((p) => p.id),
  );
  assert.deepEqual(
    requests.flatMap((r) => r.coverage.fieldIndexes),
    fields.map((_f, i) => i),
  );
  for (const request of requests) {
    assert(
      Buffer.byteLength(
        request.system +
          request.prompt +
          JSON.stringify(request.responseFormat),
      ) <= 160000,
    );
    assert(request.assignedClaimIds.length <= 8);
    const body = JSON.parse(request.prompt);
    assert.deepEqual(
      body.draft.components.map((c: any) => c.description),
      original.response.components.map((c) => c.description),
    );
    assert.deepEqual(body.draft.details, original.response.details);
    for (const ref of request.ownedScopeCoverageIds)
      assert(body.originalFacts.some((f: any) => f.sourceRef === ref));
  }
  const responses = answers(plan),
    lastRef = `f${fields.length - 1}`;
  const index = requests.findIndex((r) =>
    r.ownedScopeCoverageIds.includes(lastRef),
  );
  const claim = requests[index].scopeCoverageClaim!;
  Object.assign(
    responses[index].checks.find((c) => c.claimId === claim.id)!,
    {
      verdict: "not_verifiable",
      draftQuote: "Tutte le prestazioni acquistate",
      reason:
        "Giudizio negativo inventato sulla completezza: la verifica resta obbligatoria anche nell'ultimo gruppo.",
    },
  );
  assert.equal(
    readSourceSemanticReview(
      recordSourceSemanticReview(responses.map(wireResponse), plan, metadata),
      plan,
    )?.accepted,
    false,
  );
  assert.equal(JSON.stringify(full), before);
  assert.equal(JSON.stringify(original), draftBefore);
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

test("Grounded review preserves original passages while avoiding repeated materialized quotation text", () => {
  const input = context();
  const plan = buildSourceSemanticReviewRequest(input, draft(input), config);
  const evidence = inventedSourceEvidence(plan);
  const before = JSON.stringify(evidence);
  const requests = inventedGroundedReviewRequests(plan);
  for (const request of requests) {
    const body = JSON.parse(request.prompt);
    assert.equal(body.sourceEvidenceHash, evidence.hash);
    const passages = new Map(body.passages.map((p: any) => [p.id, p.text]));
    for (const reading of [
      ...body.independentReading.observations,
      ...body.independentReading.classifications,
    ]) {
      for (const quote of reading.evidence) {
        const original = input.body.passages.find(
          (p) => p.id === quote.sourceRef,
        )!;
        if (passages.has(quote.sourceRef)) {
          assert.equal(passages.get(quote.sourceRef), original.text);
          assert.equal("text" in quote, false);
        } else assert.equal(quote.text, original.text);
      }
    }
    assert(
      Buffer.byteLength(
        request.system +
          request.prompt +
          JSON.stringify(request.responseFormat),
      ) <= 160_000,
    );
  }
  assert.equal(JSON.stringify(evidence), before);
});

test("A detail absent from the work selection uses its exact original fact without bypassing independent work evidence", () => {
  const input = context();
  const date = input.body.passages[3];
  date.text = "Durata dal 1 gennaio al 31 dicembre 2030.";
  date.endUtf16 = date.text.length;
  const original = recordSourceInterpretation(
    {
      ...draft(input).response,
      details: [
        {
          kind: "execution_condition",
          explanation: date.text,
          sourceRefs: ["s4"],
          scope: "project_context",
        },
      ],
    },
    buildSourceInterpretationRequest(input),
    { ...metadata, model: input.binding.model },
  );
  const plan = buildSourceSemanticReviewRequest(input, original, config);
  const selections = plan.evidencePlan.requests.map((r) => {
    const answer = inventedSourceEvidenceAnswer(JSON.parse(r.prompt));
    answer.observations = answer.observations.filter(
      (o) => !o.evidence.some((q) => q.sourceRef === "s4"),
    );
    return answer;
  });
  const evidence = recordSourceEvidenceReading(
    selections,
    plan.evidencePlan,
    metadata,
  );
  const request = buildGroundedSourceReviewRequests(plan, evidence)[0];
  const body = JSON.parse(request.prompt);
  assert.deepEqual(
    body.originalFacts.filter((f: any) => ["s1", "s4"].includes(f.sourceRef)),
    [
      {
        id: "o-s1",
        sourceRef: "s1",
        scope: "project_context",
        rawPath: input.body.passages[0].rawPath,
      },
      {
        id: "o-s4",
        sourceRef: "s4",
        scope: "project_context",
        rawPath: date.rawPath,
      },
    ],
  );
  assert.equal(body.passages.find((p: any) => p.id === "s4").text, date.text);
  assert(
    request.ownedScopeCoverageIds.every((ref) =>
      body.originalFacts.some((f: any) => f.sourceRef === ref),
    ),
  );
  assert(!JSON.stringify(body.independentReading).includes('"s4"'));
  const response = {
    chunkId: request.id,
    sourceEvidenceHash: evidence.hash,
    coverage: "complete",
    checks: request.assignedClaimIds.map((id) => {
      const claim = plan.claims.find((c) => c.id === id)!;
      return {
        claimId: id,
        draftQuote: claim.text.slice(0, 1200),
        verdict: "supported",
        reason: "Risposta inventata per il contratto.",
        sourceRefs: claim.sourceRefs,
        readingRefs:
          claim.kind === "detail" ? ["o-s4"] : inventedReadingRefs(body, claim),
      };
    }),
    findings: [],
  };
  const wire = new Ajv2020({ strict: false }).compile(
    request.responseFormat.json_schema.schema,
  );
  const openaiWire = new Ajv2020({ strict: false }).compile(
    openaiJsonSchema(request.responseFormat.json_schema.schema),
  );
  assert(wire(wireResponse(response, request)));
  assert(openaiWire(wireResponse(response, request)));
  const store = (answer: typeof response) =>
    productionRecordSourceSemanticReview([answer], plan, {
      ...metadata,
      sourceEvidence: evidence,
    });
  assert.equal(readSourceSemanticReview(store(response), plan)?.accepted, true);
  for (const kind of [
    "summary",
    "component_domain",
    "classification_reading",
  ]) {
    const changed = structuredClone(response);
    const claim = plan.claims.find((c) => c.kind === kind)!;
    const extraPointer = structuredClone(response);
    extraPointer.checks
      .find((c) => c.claimId === claim.id)!
      .readingRefs.push("o-s4");
    assert(
      !wire(wireResponse(extraPointer, request)),
      `${kind} cannot add a detail-only pointer`,
    );
    assert(!openaiWire(wireResponse(extraPointer, request)));
    assert.throws(() => store(extraPointer), /own summary or detail claim/);
    changed.checks.find((c) => c.claimId === claim.id)!.readingRefs = ["o-s4"];
    assert(
      !wire(wireResponse(changed, request)),
      `${kind} cannot substitute a detail-only pointer`,
    );
    assert(!openaiWire(wireResponse(changed, request)));
    assert.throws(() => store(changed), /own summary or detail claim/);
  }
  const detail = plan.claims.find((c) => c.kind === "detail")!;
  const wrongOriginal = structuredClone(response);
  wrongOriginal.checks.find((c) => c.claimId === detail.id)!.sourceRefs = [
    "s1",
  ];
  assert.throws(() => store(wrongOriginal), /own summary or detail claim/);
  const wrongSelection = structuredClone(response);
  wrongSelection.checks.find((c) => c.claimId === detail.id)!.readingRefs = [
    "e1-1",
  ];
  assert(!wire(wireResponse(wrongSelection, request)));
  assert(!openaiWire(wireResponse(wrongSelection, request)));
  assert.throws(() => store(wrongSelection), /own independent evidence/);
  assert.deepEqual(
    body.detailEvidenceBindings.find((b: any) => b.claimId === detail.id),
    { claimId: detail.id, readingIds: ["o-s4"] },
  );
  const mixedEvidence = structuredClone(response);
  mixedEvidence.checks
    .find((c) => c.claimId === detail.id)!
    .readingRefs.push("e1-1");
  assert(!wire(wireResponse(mixedEvidence, request)));
  assert(!openaiWire(wireResponse(mixedEvidence, request)));
  assert.throws(() => store(mixedEvidence), /unrelated independent evidence/);
  // A negative verdict may use other independent observations to explain
  // why the detail is false or unverified; it must still quote that detail.
  for (const verdict of ["contradicted", "not_verifiable"] as const) {
    const negative = structuredClone(wrongSelection);
    negative.checks.find((c) => c.claimId === detail.id)!.verdict = verdict;
    assert(wire(wireResponse(negative, request)));
    assert(openaiWire(wireResponse(negative, request)));
    assert.equal(
      readSourceSemanticReview(store(negative), plan)?.accepted,
      false,
    );
  }
  const unknown = structuredClone(response);
  unknown.checks.find((c) => c.claimId === detail.id)!.readingRefs = ["o-s999"];
  assert(!wire(wireResponse(unknown, request)));
  assert.throws(() => store(unknown), /unknown independent reading/);
  const omitted = structuredClone(response);
  omitted.checks.find((c) => c.claimId === detail.id)!.readingRefs = [];
  assert(wire(wireResponse(omitted, request)));
  assert.throws(() => store(wireResponse(omitted, request)));
  assert.throws(() => store(omitted));
});

test("A structured condition owns a review claim and retains false without becoming a text passage", () => {
  const base = context();
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      fields: [
        {
          scope: "project_context",
          rawPath: "/terms/subContractorAllowed",
          value: false,
        },
      ],
    },
  };
  const original = recordSourceInterpretation(
    {
      ...draft(base).response,
      details: [
        {
          kind: "execution_condition",
          scope: "project_context",
          sourceRefs: ["f0"],
          explanation: "Il subappalto non è consentito.",
        },
      ],
    },
    buildSourceInterpretationRequest(input),
    { ...metadata, model: input.binding.model },
  );
  const plan = buildSourceSemanticReviewRequest(input, original, config);
  const selections = plan.evidencePlan.requests.map((r) => {
    const body = JSON.parse(r.prompt);
    const answer = inventedSourceEvidenceAnswer(body);
    answer.observations.push({
      kind: "condition",
      serviceRef: "s1",
      evidence: [{ sourceRef: "s1" }, { sourceRef: "f0" }],
    });
    return answer;
  });
  const evidence = recordSourceEvidenceReading(
    selections,
    plan.evidencePlan,
    metadata,
  );
  const requests = buildGroundedSourceReviewRequests(plan, evidence);
  const claim = plan.claims.find((c) => c.kind === "detail")!;
  assert.deepEqual(claim.sourceRefs, ["f0"]);
  assert.equal(
    requests.flatMap((r) => r.assignedClaimIds).filter((id) => id === claim.id)
      .length,
    1,
  );
  const request = requests.find((r) => r.assignedClaimIds.includes(claim.id))!;
  const body = JSON.parse(request.prompt);
  assert.equal(body.fields.find((f: any) => f.id === "f0").value, false);
  assert(!body.passages.some((p: any) => p.id === "f0"));
  assert(
    body.originalFacts.some(
      (f: any) =>
        f.id === "o-f0" && f.rawPath === "/terms/subContractorAllowed",
    ),
  );
  const responses = requests.map((r) => {
    const b = JSON.parse(r.prompt);
    return {
      chunkId: r.id,
      sourceEvidenceHash: evidence.hash,
      coverage: "complete",
      findings: [],
      checks: r.assignedClaimIds.map((id) => {
        const c = plan.claims.find((x) => x.id === id)!;
        return {
          claimId: id,
          verdict: "supported",
          draftQuote: null,
          reason: "Risposta inventata per verificare il contratto.",
          sourceRefs: c.sourceRefs,
          readingRefs:
            c.kind === "detail" ? ["o-f0"] : inventedReadingRefs(b, c),
        };
      }),
    };
  });
  for (const [i, r] of requests.entries())
    assert(
      new Ajv2020({ strict: false }).compile(
        r.responseFormat.json_schema.schema,
      )(wireResponse(responses[i], r)),
    );
  const record = productionRecordSourceSemanticReview(responses, plan, {
    ...metadata,
    sourceEvidence: evidence,
  });
  assert(readSourceSemanticReview(record, plan)?.accepted);
  const wrong = structuredClone(responses);
  const summary = plan.claims.find((c) => c.kind === "summary")!;
  wrong
    .flatMap((r) => r.checks)
    .find((c) => c.claimId === summary.id)!.readingRefs = ["o-f0"];
  assert.throws(
    () =>
      productionRecordSourceSemanticReview(wrong, plan, {
        ...metadata,
        sourceEvidence: evidence,
      }),
    /own summary or detail claim/,
  );
});

test("The generated review schema keeps each original fact with its own detail", () => {
  const base = context();
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        {
          ...base.body.passages[3],
          id: "s5",
          rawPath: "/other-condition/it",
          text: "Consegna presso il magazzino inventato.",
          endUtf16: "Consegna presso il magazzino inventato.".length,
        },
      ],
    },
  };
  const original = recordSourceInterpretation(
    {
      ...draft(input).response,
      details: ["s4", "s5"].map((id) => ({
        kind: "execution_condition",
        explanation: input.body.passages.find((p) => p.id === id)!.text,
        sourceRefs: [id],
        scope: "project_context",
      })),
    },
    buildSourceInterpretationRequest(input),
    { ...metadata, model: input.binding.model },
  );
  const plan = buildSourceSemanticReviewRequest(input, original, config);
  const evidence = inventedSourceEvidence(plan);
  const request = buildGroundedSourceReviewRequests(plan, evidence)[0];
  const body = JSON.parse(request.prompt);
  const response = {
    chunkId: request.id,
    sourceEvidenceHash: evidence.hash,
    coverage: "complete",
    checks: request.assignedClaimIds.map((id) => {
      const claim = plan.claims.find((c) => c.id === id)!;
      return {
        claimId: id,
        draftQuote: null,
        verdict: "supported",
        reason: "Controllo inventato della proprietà dei riferimenti.",
        sourceRefs: claim.sourceRefs,
        readingRefs:
          claim.kind === "detail"
            ? claim.sourceRefs.map((ref) => `o-${ref}`)
            : inventedReadingRefs(body, claim),
      };
    }),
    findings: [],
  };
  const wire = new Ajv2020({ strict: false }).compile(
    openaiJsonSchema(request.responseFormat.json_schema.schema),
  );
  assert(wire(wireResponse(response, request)));
  const claim = plan.claims.find(
    (c) => c.kind === "detail" && c.sourceRefs.includes("s4"),
  )!;
  response.checks.find((c) => c.claimId === claim.id)!.readingRefs.push("o-s5");
  assert(!wire(wireResponse(response, request)));
  assert.throws(
    () =>
      productionRecordSourceSemanticReview(
        [response, ...answers(plan).slice(1)],
        plan,
        {
          ...metadata,
          sourceEvidence: evidence,
        },
      ),
    /own summary or detail claim/,
  );
});

test.each(["accessory", "excluded"] as const)(
  "A %s component may cite a relevant original condition but cannot promote it to main work",
  (importance) => {
    const originalContext = context();
    const text =
      importance === "accessory"
        ? "È acquistabile a richiesta il montaggio opzionale."
        : "Il montaggio è escluso dal contratto.";
    const input = {
      ...originalContext,
      body: {
        ...originalContext.body,
        passages: [
          ...originalContext.body.passages,
          {
            ...originalContext.body.passages[3],
            id: "s5",
            rawPath: "/procurement/options/it",
            text,
            endUtf16: text.length,
          },
        ],
      },
    };
    const base = draft(input);
    const extra = {
      description: text,
      importance,
      sourceRefs: ["s5"],
      role: "execute",
      roleEvidence: {
        state: "identified",
        actionText: text,
        sourceRefs: ["s5"],
        scope: "project_context",
      },
      meaning: {
        state: "identified",
        statement: text,
        objectText: text,
        objectRefs: ["s5"],
        classificationContextIds: [],
        basis: "explicit_text",
      },
    };
    const make = (importance: "main" | "accessory" | "excluded") => {
      const source = recordSourceInterpretation(
        {
          ...base.response,
          components: [...base.response.components, { ...extra, importance }],
        },
        buildSourceInterpretationRequest(input),
        { ...metadata, model: input.binding.model },
      );
      const plan = buildSourceSemanticReviewRequest(input, source, config);
      const evidence = inventedSourceEvidence(plan);
      const responses = answers(plan);
      return { plan, evidence, responses };
    };
    const valid = make(importance);
    const record = productionRecordSourceSemanticReview(
      valid.responses,
      valid.plan,
      {
        ...metadata,
        sourceEvidence: valid.evidence,
      },
    );
    assert.equal(readSourceSemanticReview(record, valid.plan)?.accepted, true);
    const promoted = make("main");
    assert.throws(
      () =>
        productionRecordSourceSemanticReview(
          promoted.responses,
          promoted.plan,
          {
            ...metadata,
            sourceEvidence: promoted.evidence,
          },
        ),
      /independent performance/,
    );
    const unrelated = structuredClone(valid.responses);
    const componentClaim = valid.plan.claims.find(
      (c) => c.kind === "component_scope" && c.subject === "/components/1",
    )!;
    unrelated
      .find((part) =>
        part.checks.some((check) => check.claimId === componentClaim.id),
      )!
      .checks.find((c) => c.claimId === componentClaim.id)!.readingRefs = [
      "c1",
    ];
    assert.throws(
      () =>
        productionRecordSourceSemanticReview(unrelated, valid.plan, {
          ...metadata,
          sourceEvidence: valid.evidence,
        }),
      /own independent evidence/,
    );
  },
);

test("Review preserves original classification evidence without inheriting a prior model's opinion", () => {
  const input = context();
  const original = draft(input);
  const plan = buildSourceSemanticReviewRequest(input, original, config);
  for (const relationship of [
    "consistent",
    "broad_context",
    "not_decisive",
  ] as const) {
    const responses = plan.evidencePlan.requests.map((part) =>
      inventedSourceEvidenceAnswer(JSON.parse(part.prompt)),
    );
    const opinion = "IPOTESI AI INVENTATA: ignorare la famiglia originale.";
    responses[0].classifications[0].relationship = relationship;
    responses[0].classifications[0].explanation = opinion;
    const evidence = recordSourceEvidenceReading(responses, plan.evidencePlan, {
      ...metadata,
      id: `invented-${relationship}`,
    });
    const before = JSON.stringify(evidence);
    for (const request of buildGroundedSourceReviewRequests(plan, evidence)) {
      const body = JSON.parse(request.prompt);
      assert.equal(body.sourceEvidenceHash, evidence.hash);
      assert.deepEqual(
        body.classificationContext,
        original.classificationContext,
      );
      assert(!request.prompt.includes(opinion));
      for (const item of body.independentReading.classifications) {
        assert.equal("relationship" in item, false);
        assert.equal("explanation" in item, false);
        assert.equal(item.id, item.classificationId);
        assert(request.readingIds.includes(item.id));
        assert.equal(item.label.text, "Categoria inventata 🌳");
        assert(
          item.evidence.some(
            (quote: { sourceRef: string }) => quote.sourceRef === "s2",
          ),
        );
        assert(
          item.evidence.some(
            (quote: { sourceRef: string }) => quote.sourceRef === "s3",
          ),
        );
      }
    }
    // Keep the original response and its hash available for diagnostics.
    assert.equal(JSON.stringify(evidence), before);
    assert.equal(evidence.responses[0].classifications[0].explanation, opinion);
  }
});

test("Approvals using earlier independent evidence contracts cannot be promoted", () => {
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
  assert.equal(
    readSourceSemanticReview(
      { ...old, version: "documentary-source-semantic-review-v2" },
      plan,
    ),
    null,
  );
  assert.equal(
    readSourceSemanticReview(
      { ...old, version: "documentary-source-semantic-review-v4" },
      plan,
    ),
    null,
  );
  const prior = recordSourceSemanticReview(answers(plan), plan, metadata);
  const { hash: _hash, ...priorUnsigned } = {
    ...prior,
    version: "documentary-source-semantic-review-v6",
  };
  assert.equal(
    readSourceSemanticReview(
      { ...priorUnsigned, hash: digest(priorUnsigned) },
      plan,
    ),
    null,
  );
  assert.equal(
    readSourceSemanticReview(
      { ...prior, version: "documentary-source-semantic-review-v10" },
      plan,
    ),
    null,
  );
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
  const responses = plan.evidencePlan.requests.map((part) =>
    inventedSourceEvidenceAnswer(JSON.parse(part.prompt)),
  );
  responses[0].classifications[0].relationship = "conflicting";
  responses[0].classifications[0].explanation =
    "Contraddizione inventata fra due affermazioni originali.";
  responses[0].classifications[0].evidence.push({
    sourceRef: "s1",
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
    /own independent evidence/,
  );
});

test("Grounded review keeps numeric evidence and missing details without letting a detail prove a performance", () => {
  const input = context(),
    plan = buildSourceSemanticReviewRequest(input, draft(input), config);
  const wire: any[] = plan.evidencePlan.requests.map((r) =>
    inventedSourceEvidenceAnswer(JSON.parse(r.prompt)),
  );
  wire[0].observations.push({
    kind: "condition",
    serviceRef: "s1",
    evidence: [{ sourceRef: "f0" }],
  });
  wire[0].missingDetails.push({
    description: "Marca non precisata.",
    serviceRef: "s1",
    evidence: [{ sourceRef: "s1" }],
  });
  const sourceEvidence = recordSourceEvidenceReading(wire, plan.evidencePlan, {
    ...metadata,
    model: plan.model,
  });
  const requests = buildGroundedSourceReviewRequests(plan, sourceEvidence);
  const body = JSON.parse(requests[0].prompt);
  assert.equal(body.fields.find((f: any) => f.id === "f0").value, 0);
  assert.equal(body.independentReading.missingDetails[0].id, "d1-1");
  const responses = requests.map((r) => {
    const b = JSON.parse(r.prompt);
    return {
      chunkId: r.id,
      sourceEvidenceHash: sourceEvidence.hash,
      coverage: "complete",
      checks: r.assignedClaimIds.map((id) => {
        const claim = plan.claims.find((c) => c.id === id)!;
        return {
          claimId: id,
          draftQuote: claim.text.slice(0, 1200),
          verdict: "supported",
          reason: "Solo verifica del contratto.",
          sourceRefs: claim.sourceRefs,
          readingRefs: inventedReadingRefs(b, claim),
        };
      }),
      findings: [
        {
          kind: "unverifiable",
          reason: "Rilievo inventato sul valore originale.",
          sourceRefs: ["f0"],
        },
      ],
    };
  });
  assert(
    new Ajv2020({ strict: false }).compile(
      requests[0].responseFormat.json_schema.schema,
    )(wireResponse(responses[0], requests[0])),
  );
  const record = productionRecordSourceSemanticReview(responses, plan, {
    ...metadata,
    sourceEvidence,
  });
  const reviewed = readSourceSemanticReview(record, plan)!;
  assert.equal(reviewed.accepted, false);
  assert.equal(reviewed.evidence.find((p) => p.id === "f0")!.text, "0");
  assert.equal(
    reviewed.evidence.find((p) => p.id === "f0")!.rawPath,
    "/terms/quantity",
  );
  const invalid = structuredClone(responses);
  invalid[0].checks[0].readingRefs = ["d1-1"];
  assert.throws(
    () =>
      productionRecordSourceSemanticReview(invalid, plan, {
        ...metadata,
        sourceEvidence,
      }),
    /independent performance/,
  );
});

test("An AI uncertainty note cannot replace the original allocation of aggregate quantities", () => {
  const input = context();
  const original =
    "Fornitura di articoli inventati per le sedi A e B. Quantità principali: 100 pezzi.";
  const passage = input.body.passages.find((item) => item.id === "s1")!;
  passage.text = original;
  passage.endUtf16 = original.length;
  const plan = buildSourceSemanticReviewRequest(input, draft(input), config);
  const wire: any[] = plan.evidencePlan.requests.map((request) =>
    inventedSourceEvidenceAnswer(JSON.parse(request.prompt)),
  );
  const speculation = "Le quantità si riferiscono soltanto alla sede A.";
  wire[0].missingDetails.push({
    serviceRef: "s1",
    description: speculation,
    evidence: [{ sourceRef: "s1" }],
  });
  const evidence = recordSourceEvidenceReading(wire, plan.evidencePlan, {
    ...metadata,
    model: plan.model,
  });
  const before = stableDocumentaryJson(evidence);
  const requests = buildGroundedSourceReviewRequests(plan, evidence);
  const body = JSON.parse(requests[0].prompt);
  const note = body.independentReading.missingDetails.find(
    (item: any) => item.id === "d1-1",
  );

  assert.equal(note.authority, "unverified_ai_note");
  assert.equal(note.description, speculation);
  assert.equal(note.evidence[0].sourceRef, "s1");
  assert.equal(
    body.passages.find((item: any) => item.id === "s1").text,
    original,
  );
  assert.equal(body.sourceEvidenceHash, evidence.hash);
  assert.equal(stableDocumentaryJson(evidence), before);
});

test("Earlier approvals cannot be reused with the bounded review-reference contract", () => {
  const plan = buildSourceSemanticReviewRequest(context(), draft(), config);
  const record = recordSourceSemanticReview(answers(plan), plan, metadata);
  for (const version of [
    "documentary-source-semantic-review-v28",
    "documentary-source-semantic-review-v29",
  ]) {
    const { hash: _hash, ...old } = { ...record, version };
    assert.equal(
      readSourceSemanticReview({ ...old, hash: digest(old) }, plan),
      null,
    );
  }
});

test("Provider reference bounds reject repetition floods without removing independent evidence", () => {
  const plan = buildSourceSemanticReviewRequest(context(), draft(), config);
  const evidence = inventedSourceEvidence(plan);
  const request = buildGroundedSourceReviewRequests(plan, evidence)[0];
  const body = JSON.parse(request.prompt);
  const response = answers(plan)[0];
  const validate = new Ajv2020({ strict: false }).compile(
    openaiJsonSchema(request.responseFormat.json_schema.schema),
  );
  const claim = plan.claims.find((c) => c.kind === "classification_reading")!;
  const check = response.checks.find((c) => c.claimId === claim.id)!;
  const independentIds = [
    ...body.independentReading.observations,
    ...body.independentReading.classifications,
    ...body.independentReading.missingDetails,
  ].map((item: { id: string }) => item.id);
  check.readingRefs = independentIds;
  check.sourceRefs = request.sourceIds;
  assert(
    validate(wireResponse(response, request)),
    JSON.stringify(validate.errors),
  );
  assert.equal(new Set(independentIds).size, independentIds.length);
  check.readingRefs = Array.from({ length: 1024 }, () => independentIds[0]);
  assert.throws(() => wireResponse(response, request));
  check.readingRefs = [independentIds[0], independentIds[0]];
  assert.throws(
    () => recordSourceSemanticReview([response], plan, metadata),
    /unknown independent reading/,
  );
  assert(
    body.rules.some((rule: string) => rule.includes("ciascuno una sola volta")),
  );
});

test("Keyed reading selections preserve evidence and reject malformed or empty selections", () => {
  const plan = buildSourceSemanticReviewRequest(context(), draft(), config);
  const evidence = inventedSourceEvidence(plan);
  const requests = buildGroundedSourceReviewRequests(plan, evidence);
  const stored = answers(plan);
  const wire = stored.map((response, index) =>
    wireResponse(response, requests[index]),
  );
  const validators = requests.map((request) =>
    new Ajv2020({ strict: false }).compile(
      openaiJsonSchema(request.responseFormat.json_schema.schema),
    ),
  );
  wire.forEach((response, index) =>
    assert(
      validators[index](response),
      JSON.stringify(validators[index].errors),
    ),
  );
  const before = JSON.stringify(wire);
  const record = productionRecordSourceSemanticReview(wire, plan, {
    ...metadata,
    sourceEvidence: evidence,
  });
  assert.deepEqual(record.responses, stored);
  assert(readSourceSemanticReview(record, plan)?.accepted);
  assert.equal(JSON.stringify(wire), before);
  assert.equal(wire[0].checksFormat, "claim_keyed_refs_v3");
  const claimId = requests[0].assignedClaimIds[0];
  const selected = wire[0].checksByClaim[claimId].readingRefsById;
  assert(Object.values(selected).some((value) => value === true));
  for (const mutate of [
    (check: any) => {
      check.readingRefsById["o-s999"] = true;
    },
    (check: any) => {
      delete check.readingRefsById[Object.keys(selected)[0]];
    },
    (check: any) => {
      check.readingRefsById[Object.keys(selected)[0]] = "true";
    },
    (check: any) => {
      check.readingRefs = ["e1-1", "e1-1"];
    },
  ]) {
    const changed = structuredClone(wire);
    mutate(changed[0].checksByClaim[claimId]);
    assert(!validators[0](changed[0]));
    assert.throws(() =>
      productionRecordSourceSemanticReview(changed, plan, {
        ...metadata,
        sourceEvidence: evidence,
      }),
    );
  }
  const empty = structuredClone(wire);
  for (const id of Object.keys(selected))
    empty[0].checksByClaim[claimId].readingRefsById[id] = false;
  // The semantic validator still requires an actual citation; flags alone
  // never grant approval or fabricate support for an empty selection.
  assert.throws(() =>
    productionRecordSourceSemanticReview(empty, plan, {
      ...metadata,
      sourceEvidence: evidence,
    }),
  );
  // Older wire lists are validated, never repaired into a keyed selection.
  const legacy = stored.map((response) => wireResponse(response));
  const originalRef = legacy[0].checksByClaim[claimId].readingRefs[0];
  legacy[0].checksByClaim[claimId].readingRefs = [originalRef, originalRef];
  const legacyBefore = JSON.stringify(legacy);
  assert.throws(() =>
    productionRecordSourceSemanticReview(legacy, plan, {
      ...metadata,
      sourceEvidence: evidence,
    }),
  );
  assert.equal(JSON.stringify(legacy), legacyBefore);
});

test("V3 projects only explicitly selected own original facts; legacy omissions remain invalid", () => {
  const base = context();
  const flag = {
    ...base.body.passages[3],
    id: "s5",
    rawPath: "/terms/optional",
    text: "no",
    endUtf16: 2,
  };
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [...base.body.passages, flag],
      fields: [
        {
          scope: "project_context",
          rawPath: "/terms/optionalNote/it",
          value: null,
        },
        {
          scope: "project_context",
          rawPath: "/terms/optionalNote/de",
          value: null,
        },
        {
          scope: "selected_lot",
          rawPath: "/terms/optionalNote/it",
          value: false,
        },
        {
          scope: "project_context",
          rawPath: "/terms/otherNote/it",
          value: null,
        },
      ],
    },
  };
  const original = recordSourceInterpretation(
    {
      ...draft(base).response,
      details: [
        {
          kind: "execution_condition",
          scope: "project_context",
          sourceRefs: ["s5"],
          explanation:
            "L'opzione non è ammessa; la nota italiana non è indicata.",
        },
      ],
    },
    buildSourceInterpretationRequest(input),
    { ...metadata, model: input.binding.model },
  );
  const plan = buildSourceSemanticReviewRequest(input, original, config);
  const evidence = inventedSourceEvidence(plan);
  const requests = buildGroundedSourceReviewRequests(plan, evidence);
  const claim = plan.claims.find((c) => c.kind === "detail")!;
  const partIndex = requests.findIndex((r) =>
    r.assignedClaimIds.includes(claim.id),
  );
  const wire = answers(plan).map((response, index) =>
    wireResponse(response, requests[index]),
  );
  const check = wire[partIndex].checksByClaim[claim.id];
  check.sourceRefs = [];
  for (const id of Object.keys(check.readingRefsById))
    check.readingRefsById[id] = ["o-s5", "o-f0"].includes(id);
  const before = JSON.stringify({ input, original, evidence, wire });
  const store = (responses: unknown[]) =>
    productionRecordSourceSemanticReview(responses, plan, {
      ...metadata,
      sourceEvidence: evidence,
    });
  const record = store(wire);
  const normalized = record.responses[partIndex].checks.find(
    (c) => c.claimId === claim.id,
  )!;
  assert.deepEqual([...normalized.sourceRefs].sort(), ["f0", "s5"]);
  assert.deepEqual([...normalized.readingRefs].sort(), ["o-f0", "o-s5"]);
  assert.equal(normalized.verdict, "supported");
  assert(readSourceSemanticReview(record, plan)?.accepted);
  assert.equal(JSON.stringify({ input, original, evidence, wire }), before);
  assert(!normalized.sourceRefs.includes("f1"));
  assert(!normalized.sourceRefs.includes("f2"));
  const validators = requests.map((request) =>
    new Ajv2020({ strict: false }).compile(
      openaiJsonSchema(request.responseFormat.json_schema.schema),
    ),
  );
  wire.forEach((response, index) => assert(validators[index](response)));
  // V2 still demands the duplicate pointer; do not reparse a closed V2
  // response as V3, or add the missing pointer to its canonical record.
  const legacy = structuredClone(wire);
  for (const response of legacy) response.checksFormat = "claim_keyed_refs_v2";
  legacy[partIndex].checksByClaim[claim.id].sourceRefs = ["s5"];
  assert.throws(() => store(legacy), /own summary or detail claim/);
  const missingStored = structuredClone(record.responses);
  missingStored[partIndex].checks.find(
    (c) => c.claimId === claim.id,
  )!.sourceRefs = ["s5"];
  assert.throws(() => store(missingStored), /own summary or detail claim/);
  const negative = structuredClone(wire);
  negative[partIndex].checksByClaim[claim.id].verdict = "not_verifiable";
  const readingGroup = requests[partIndex].claimReadingGroups.find((group) =>
    group.claimIds.includes(claim.id),
  )!;
  for (const id of readingGroup.readingIds)
    negative[partIndex].checksByClaim[claim.id].readingRefsById[id] ??= false;
  assert.equal(
    readSourceSemanticReview(store(negative), plan)?.accepted,
    false,
  );
  for (const invalidId of ["o-f2", "o-f3", "o-f999"]) {
    const foreign = structuredClone(wire);
    foreign[partIndex].checksByClaim[claim.id].readingRefsById[invalidId] =
      true;
    assert(!validators[partIndex](foreign[partIndex]));
    assert.throws(() => store(foreign));
  }
  const duplicate = structuredClone(wire);
  duplicate[partIndex].checksByClaim[claim.id].sourceRefs = ["s5", "s5"];
  assert.throws(() => store(duplicate), /repeats source evidence/);
  const empty = structuredClone(wire);
  for (const id of Object.keys(
    empty[partIndex].checksByClaim[claim.id].readingRefsById,
  ))
    empty[partIndex].checksByClaim[claim.id].readingRefsById[id] = false;
  assert.throws(() => store(empty));
});

test("V3 fact projection does not replace an independent performance or the assigned criticism quote", () => {
  const plan = buildSourceSemanticReviewRequest(context(), draft(), config);
  const evidence = inventedSourceEvidence(plan);
  const requests = buildGroundedSourceReviewRequests(plan, evidence);
  const wire = answers(plan).map((response, index) =>
    wireResponse(response, requests[index]),
  );
  const summary = plan.claims.find((c) => c.kind === "summary")!;
  const index = requests.findIndex((r) =>
    r.assignedClaimIds.includes(summary.id),
  );
  const check = wire[index].checksByClaim[summary.id];
  check.sourceRefs = [];
  for (const id of Object.keys(check.readingRefsById))
    check.readingRefsById[id] = id === "o-s1";
  const store = (responses: unknown[]) =>
    productionRecordSourceSemanticReview(responses, plan, {
      ...metadata,
      sourceEvidence: evidence,
    });
  assert.throws(() => store(wire), /independent performance/);
  check.verdict = "contradicted";
  check.draftQuote = "Un'affermazione estranea al summary.";
  assert.throws(
    () => store(wire),
    /criticism must quote its own assigned claim/,
  );
});

test("Review criticisms quote their assigned text without confusing summary and detail", () => {
  const input = context();
  const exactCondition =
    "I beni vengono preparati in laboratorio e consegnati a domicilio.";
  const widenedSummary = "Tutto il servizio si svolge in laboratorio.";
  const passage = input.body.passages[0];
  const original = {
    ...input,
    body: {
      ...input.body,
      passages: input.body.passages.map((p) =>
        p.id === passage.id
          ? { ...p, text: exactCondition, endUtf16: exactCondition.length }
          : p,
      ),
    },
  };
  const extraction = buildSourceInterpretationRequest(original);
  const value = draft(original).response;
  const record = recordSourceInterpretation(
    {
      ...value,
      summary: widenedSummary,
      details: [
        {
          kind: "execution_condition",
          explanation: exactCondition,
          scope: "project_context",
          sourceRefs: [passage.id],
        },
      ],
    },
    extraction,
    { ...metadata, model: original.binding.model },
  );
  const plan = buildSourceSemanticReviewRequest(original, record, config);
  const summary = plan.claims.find((c) => c.kind === "summary")!,
    detail = plan.claims.find((c) => c.kind === "detail")!;
  assert.equal(summary.text, widenedSummary);
  assert.equal(detail.text, exactCondition);
  assert(Object.isFrozen(summary) && Object.isFrozen(detail));
  const response = answers(plan);
  const setCheck = (
    id: string,
    quote: string | null,
    verdict: "supported" | "not_verifiable",
  ) =>
    response.map((r) => ({
      ...r,
      checks: r.checks.map((c) =>
        c.claimId === id ? { ...c, draftQuote: quote, verdict } : c,
      ),
    }));
  assert.throws(
    () =>
      recordSourceSemanticReview(
        setCheck(detail.id, widenedSummary, "not_verifiable"),
        plan,
        metadata,
      ),
    /quote its own assigned claim/,
  );
  assert.throws(
    () =>
      recordSourceSemanticReview(
        setCheck(detail.id, null, "not_verifiable"),
        plan,
        metadata,
      ),
    /quote its own assigned claim/,
  );
  assert.throws(
    () =>
      recordSourceSemanticReview(
        setCheck(summary.id, exactCondition, "not_verifiable"),
        plan,
        metadata,
      ),
    /quote its own assigned claim/,
  );
  assert.throws(
    () =>
      recordSourceSemanticReview(
        setCheck(summary.id, "parole inventate", "supported"),
        plan,
        metadata,
      ),
    /quote its own assigned claim/,
  );
  const negative = recordSourceSemanticReview(
    setCheck(summary.id, widenedSummary, "not_verifiable"),
    plan,
    metadata,
  );
  const resolved = readSourceSemanticReview(negative, plan)!;
  assert.equal(resolved.accepted, false);
  assert.equal(
    negative.responses
      .flatMap((r) => r.checks)
      .find((c) => c.claimId === detail.id)!.verdict,
    "supported",
  );
  assert.equal(record.response.details[0].explanation, exactCondition);
  assert.equal(record.response.summary, widenedSummary);
  assert.equal(
    readSourceSemanticReview(
      recordSourceSemanticReview(
        setCheck(detail.id, null, "supported"),
        plan,
        metadata,
      ),
      plan,
    )?.accepted,
    true,
  );
});

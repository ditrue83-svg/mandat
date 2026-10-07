import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import { test } from "vitest";
import {
  buildSourceEvidenceReadingRequest,
  recordSourceEvidenceReading,
  readSourceEvidenceReading,
} from "../src/lib/source-evidence-reading";
import {
  buildSourceInterpretationRequest,
  recordSourceInterpretation,
  type SourceInterpretationContext,
} from "../src/lib/source-interpretation";
import {
  buildSourceSemanticReviewRequest as buildCurrentSourceSemanticReviewRequest,
  buildGroundedSourceReviewRequests,
} from "../src/lib/source-semantic-review";
const buildSourceSemanticReviewRequest = (
  ...args: Parameters<typeof buildCurrentSourceSemanticReviewRequest>
) =>
  buildCurrentSourceSemanticReviewRequest(args[0], args[1], {
    ...args[2],
    legacyProviderFormatForRegression: true,
  });

import {
  inventedSourceEvidenceAnswer,
  inventedClauseSelections,
} from "./helpers/source-evidence-fixture";
import { stableDocumentaryJson } from "../src/lib/documentary-observation";
import { openaiJsonSchema } from "../src/lib/openai-responses";

const config = {
  model: "invented-independent-model",
  reasoningEffort: "high" as const,
};
const metadata = {
  id: "invented-evidence",
  at: "2030-01-01T12:00:00.000Z",
  model: config.model,
};
test("Classification alternatives retain distinct first keys in the provider wire schema", () => {
  const plan = buildSourceEvidenceReadingRequest(context(), config);
  const original = plan.requests[0].responseFormat.json_schema.schema;
  const wire = openaiJsonSchema(original);
  const dereference = (value: any): any => {
    if (!value.$ref) return value;
    return dereference(
      value.$ref
        .slice(2)
        .split("/")
        .reduce((v: any, k: string) => v[k], wire),
    );
  };
  let checked = 0;
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (value.anyOf) {
      const branches = value.anyOf.map(dereference);
      if (branches.every((b: any) => b.properties?.classificationId)) {
        assert.deepEqual(
          branches.map((b: any) => Object.keys(b.properties)[0]),
          ["explanation", "relationship"],
        );
        checked++;
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(wire);
  assert(checked > 0);
  const accepts = new Ajv2020({ strict: false }).compile(wire);
  const input = responses(plan)[0];
  const wrap = (answer: unknown) =>
    "result" in (wire.properties as object) ? { result: answer } : answer;
  assert(accepts(wrap(input)), JSON.stringify(accepts.errors));
  input.classifications[0].explanation =
    "Una prestazione inventata senza prova propria.";
  assert.equal(accepts(wrap(input)), false);
});
test("Compatible classification relations cannot introduce uncited narrative claims", () => {
  const original = context();
  const originalBytes = JSON.stringify(original);
  const plan = buildSourceEvidenceReadingRequest(original, config);
  const accepts = new Ajv2020({ strict: false }).compile(
    plan.requests[0].responseFormat.json_schema.schema,
  );
  for (const relationship of [
    "consistent",
    "broad_context",
    "not_decisive",
  ] as const) {
    const input = responses(plan);
    input[0].classifications[0].relationship = relationship;
    input[0].classifications[0].evidence = [{ sourceRef: "s1" }];
    assert(accepts(input[0]), JSON.stringify(accepts.errors));
    const record = recordSourceEvidenceReading(input, plan, metadata);
    const classification = record.responses[0].classifications[0];
    assert.equal(classification.relationship, relationship);
    assert(!classification.explanation.includes("Alfa"));
    assert.deepEqual(
      classification.evidence.map((q) => q.sourceRef),
      ["s1", "s2", "s3"],
    );
    const unsupported = structuredClone(input);
    unsupported[0].classifications[0].explanation =
      "Sono richiesti fornitura, posa e collaudo in una sede diversa.";
    const before = JSON.stringify(unsupported);
    assert.equal(accepts(unsupported[0]), false);
    assert.throws(
      () => recordSourceEvidenceReading(unsupported, plan, metadata),
      /Classification explanation does not match/,
    );
    assert.equal(JSON.stringify(unsupported), before);
    const tampered = structuredClone(record);
    tampered.responses[0].classifications[0].explanation =
      "Ulteriore prestazione non citata.";
    const { hash: _hash, ...unsigned } = tampered;
    tampered.hash = createHash("sha256")
      .update(stableDocumentaryJson(unsigned))
      .digest("hex");
    assert.throws(
      () => readSourceEvidenceReading(tampered, plan),
      /Classification relation label was modified/,
    );
  }
  assert.equal(JSON.stringify(original), originalBytes);
});
test("Classification discrepancies and conflicts retain their concrete reasons", () => {
  const plan = buildSourceEvidenceReadingRequest(context(), config);
  const accepts = new Ajv2020({ strict: false }).compile(
    plan.requests[0].responseFormat.json_schema.schema,
  );
  for (const relationship of ["metadata_discrepancy", "conflicting"] as const) {
    const input = responses(plan);
    input[0].classifications[0].relationship = relationship;
    input[0].classifications[0].evidence = [{ sourceRef: "s1" }];
    assert.equal(accepts(input[0]), false);
    assert.throws(
      () => recordSourceEvidenceReading(input, plan, metadata),
      /Classification explanation does not match/,
    );
    const reason =
      "Differenza inventata tra il prodotto Alfa e la famiglia alimentare indicata.";
    input[0].classifications[0].explanation = reason;
    assert(accepts(input[0]), JSON.stringify(accepts.errors));
    const record = recordSourceEvidenceReading(input, plan, metadata);
    const result = readSourceEvidenceReading(record, plan)!;
    assert.equal(record.responses[0].classifications[0].explanation, reason);
    assert.equal(
      relationship === "conflicting"
        ? result.findings.length
        : result.warnings.length,
      1,
    );
    if (relationship === "conflicting") assert.equal(result.accepted, false);
  }
});
test("Known form obligations cannot be covered only by unknown product specifications", () => {
  const base = contractContext();
  const note =
    "Scaricare il formulario, compilare ogni parte e consegnare tutte le pagine. Specifiche degli articoli nel capitolato.";
  const input = {
    ...base,
    body: {
      ...base.body,
      passages: base.body.passages.map((p) =>
        p.id === "s5"
          ? {
              ...p,
              rawPath: "/project-info/documentsSourceNote/it",
              text: note,
              endUtf16: note.length,
            }
          : p,
      ),
    },
  };
  const before = JSON.stringify(input);
  const plan = buildSourceEvidenceReadingRequest(input, config);
  const complete: any[] = responses(plan);
  const index = plan.requests.findIndex((part) =>
    part.requiredClauseIds.includes("s5"),
  );
  complete[index].missingDetails.push({
    serviceRef: "s1",
    missingAspects: ["technical_specifications"],
    evidence: [{ sourceRef: "s5" }],
  });
  const onlyUnknown = structuredClone(complete);
  onlyUnknown[index].requiredClauseSelections.s5 = [
    {
      collection: "missingDetails",
      index: complete[index].missingDetails.length - 1,
    },
  ];
  assert.throws(
    () => recordSourceEvidenceReading(onlyUnknown, plan, metadata),
    /as an unknown specification/,
  );
  const accepts = new Ajv2020({ strict: false }).compile(
    plan.requests[index].responseFormat.json_schema.schema,
  );
  assert.equal(accepts(onlyUnknown[index]), false);
  assert(accepts(complete[index]), JSON.stringify(accepts.errors));
  const record = recordSourceEvidenceReading(complete, plan, metadata);
  assert(readSourceEvidenceReading(record, plan)?.accepted);
  assert.equal(
    record.responses[index].missingDetails
      .at(-1)
      ?.evidence.find((q) => q.sourceRef === "s5")?.text,
    note,
  );
  assert.equal(JSON.stringify(input), before);
});
function context(): SourceInterpretationContext {
  const passages = [
    {
      id: "s1",
      rawPath: "/title/it",
      role: "service" as const,
      text: "Fornitura del prodotto Alfa inventato.",
    },
    {
      id: "s2",
      rawPath: "/cpv/code",
      role: "context" as const,
      text: "00000000",
    },
    {
      id: "s3",
      rawPath: "/cpv/label/it",
      role: "context" as const,
      text: "Famiglia alimentare inventata",
    },
    {
      id: "s4",
      rawPath: "/terms/it",
      role: "context" as const,
      text: "Nessun sottotipo precisato; quantità da definire.",
    },
  ].map((p) => ({
    ...p,
    scope: "project_context" as const,
    startUtf16: 0,
    endUtf16: p.text.length,
    url: "https://example.invalid/public-source",
  }));
  return {
    binding: {
      target: { kind: "project", publicationId: "invented-publication" },
      source: { hash: "invented-source" },
      fieldsHash: "a".repeat(64),
      shapeEpochToken: "invented-shape",
      model: "invented-original-model",
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
      passages,
      fields: [
        { scope: "project_context", rawPath: "/quantity", value: 0 },
        { scope: "project_context", rawPath: "/optional", value: false },
      ],
      classifications: [
        {
          scope: "project_context",
          appliesTo: "target",
          rawPath: "/cpv",
          code: { text: "00000000", sourceRefs: ["s2"] },
          labels: [
            {
              text: "Famiglia alimentare inventata",
              sourceRefs: ["s3"],
              language: "it",
            },
          ],
        },
      ],
    },
    readings: [],
  };
}
const responses = (
  plan: ReturnType<typeof buildSourceEvidenceReadingRequest>,
) =>
  plan.requests.map((r) => inventedSourceEvidenceAnswer(JSON.parse(r.prompt)));

function contractContext(): SourceInterpretationContext {
  const base = context();
  const notes = [
    [
      "/terms/subContractorNote/it",
      "Subappalto ammesso fino al 45%; la posa principale resta all'offerente.",
    ],
    [
      "/terms/subContractorNote/de",
      "Unteraufträge bis 45%; die Hauptmontage bleibt beim Anbieter.",
    ],
    ["/procurement/optionsNote/it", "La seconda sede è opzionale."],
    [
      "/procurement/executionNote/it",
      "La posa avviene mantenendo in servizio la prima sede.",
    ],
  ];
  return {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        ...notes.map(([rawPath, text], i) => ({
          ...base.body.passages[0],
          id: `s${i + 5}`,
          role: "context" as const,
          rawPath,
          text,
          endUtf16: text.length,
        })),
      ],
    },
  };
}

test("Independent reading cannot skip submission obligations, validity, document dates or collection address", () => {
  const base = context();
  const originals = [
    [
      "s5",
      "/dates/specificDeadlinesAndFormalRequirements/it",
      "Busta chiusa con dicitura CONCORSO INVENTATO.",
    ],
    [
      "s6",
      "/dates/offerValidityNotes/it",
      "Sei mesi vincolanti; prolungamento da concordare.",
    ],
    ["s7", "/dates/documentsAvailable/start", "2030-01-02"],
    ["s8", "/project-info/documentsSourceAddress/street", "Via inventata 1"],
  ];
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        ...originals.map(([id, rawPath, text]) => ({
          ...base.body.passages[0],
          id,
          rawPath,
          text,
          role: "context" as const,
          endUtf16: text.length,
        })),
      ],
      fields: [
        ...base.body.fields,
        {
          scope: "project_context",
          rawPath: "/dates/offerValidityDeadlineDays",
          value: 180,
        },
        {
          scope: "project_context",
          rawPath: "/dates/offerValidityDeadlineDate",
          value: null,
        },
      ],
    },
  };
  const before = JSON.stringify(input);
  const plan = buildSourceEvidenceReadingRequest(input, config);
  assert.deepEqual(
    plan.requests.flatMap((r) => r.requiredClauseIds),
    ["s5", "s6", "s7", "s8", "f2"],
  );
  const complete = responses(plan);
  assert(
    readSourceEvidenceReading(
      recordSourceEvidenceReading(complete, plan, metadata),
      plan,
    )?.accepted,
  );
  for (const ref of ["s5", "s6", "s7", "s8", "f2"]) {
    const missing = structuredClone(complete);
    for (const answer of missing)
      answer.observations = answer.observations.filter(
        (o: any) => !o.evidence.some((e: any) => e.sourceRef === ref),
      );
    assert.throws(
      () => recordSourceEvidenceReading(missing, plan, metadata),
      /contractual clause evidence coverage/,
    );
  }
  assert.equal(JSON.stringify(input), before);
});

test("Complete independent wire requires every original selection, and indexes cannot replace own evidence", () => {
  const base = context();
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        {
          ...base.body.passages[0],
          id: "s5",
          rawPath: "/dates/offerValidityDeadlineType",
          role: "context",
          text: "days_after",
          endUtf16: 10,
        },
      ],
      fields: [
        ...base.body.fields,
        {
          scope: "project_context",
          rawPath: "/dates/offerValidityDeadlineDays",
          value: 180,
        },
      ],
    },
  };
  const plan = buildSourceEvidenceReadingRequest(input, config);
  const complete: any = responses(plan);
  const accepts = new Ajv2020({ strict: false }).compile<any>(
    plan.requests[0].responseFormat.json_schema.schema,
  );
  assert(accepts(complete[0]));
  const before = JSON.stringify(complete);
  for (const id of ["s5", "f2"]) {
    const missing = structuredClone(complete);
    delete missing[0].requiredClauseSelections[id];
    assert(!accepts(missing[0]));
    assert.throws(
      () => recordSourceEvidenceReading(missing, plan, metadata),
      /clause selections/,
    );
    const empty = structuredClone(complete);
    empty[0].requiredClauseSelections[id] = [];
    assert(!accepts(empty[0]));
    assert.throws(
      () => recordSourceEvidenceReading(empty, plan, metadata),
      /clause evidence coverage/,
    );
  }
  const borrowed = structuredClone(complete);
  borrowed[0].requiredClauseSelections.s5 = [
    {
      collection: "observations",
      index: borrowed[0].observations.findIndex(
        (o: any) => o.kind === "performance",
      ),
    },
  ];
  assert.throws(
    () => recordSourceEvidenceReading(borrowed, plan, metadata),
    /own original/,
  );
  const absentRow = structuredClone(complete);
  absentRow[0].requiredClauseSelections.s5 = [
    { collection: "observations", index: 31 },
  ];
  assert.throws(
    () => recordSourceEvidenceReading(absentRow, plan, metadata),
    /own original/,
  );
  const duplicated = structuredClone(complete);
  duplicated[0].requiredClauseSelections.s5.push({
    ...duplicated[0].requiredClauseSelections.s5[0],
  });
  assert.throws(
    () => recordSourceEvidenceReading(duplicated, plan, metadata),
    /Repeated.*selection/,
  );
  const unreadable = structuredClone(complete);
  unreadable[0].coverage = "unreadable";
  unreadable[0].requiredClauseSelections.s5 = [];
  assert(accepts(unreadable[0]));
  assert.equal(
    readSourceEvidenceReading(
      recordSourceEvidenceReading(unreadable, plan, metadata),
      plan,
    )?.accepted,
    false,
  );
  assert.equal(JSON.stringify(complete), before);
});

test("A complete reading must preserve every original work clause, including language variants", () => {
  const plan = buildSourceEvidenceReadingRequest(contractContext(), config);
  const answer = responses(plan);
  const body = JSON.parse(plan.requests[0].prompt);
  assert.deepEqual(plan.requests[0].requiredClauseIds, [
    "s5",
    "s6",
    "s7",
    "s8",
  ]);
  assert.deepEqual(
    body.requiredClausePassages.map((p: any) => p.sourceRef),
    ["s5", "s6", "s7", "s8"],
  );
  assert(
    readSourceEvidenceReading(
      recordSourceEvidenceReading(answer, plan, metadata),
      plan,
    )?.accepted,
  );
  for (const ref of plan.requests[0].requiredClauseIds) {
    const missing = structuredClone(answer);
    missing[0].observations = missing[0].observations.filter(
      (o: any) => !o.evidence.some((q: any) => q.sourceRef === ref),
    );
    assert.throws(
      () => recordSourceEvidenceReading(missing, plan, metadata),
      /contractual clause evidence coverage/,
    );
  }
  const classificationOnly = structuredClone(answer);
  classificationOnly[0].observations =
    classificationOnly[0].observations.filter(
      (o: any) => !o.evidence.some((q: any) => q.sourceRef === "s5"),
    );
  classificationOnly[0].classifications[0].evidence.push({ sourceRef: "s5" });
  assert.throws(
    () => recordSourceEvidenceReading(classificationOnly, plan, metadata),
    /contractual clause evidence coverage/,
  );
});

test.each([
  [
    "canContractBeExtendedNote",
    "Una proroga è possibile prima del termine indicato.",
  ],
  ["optionsNote", "La seconda sede è opzionale."],
  ["executionNote", "La posa inizia dopo l'autorizzazione del committente."],
])(
  "Flat lot %s conditions cannot disappear from source generation or independent reading",
  (field, text) => {
    const base = lotContext("Fornitura di prodotti Alfa inventati.");
    const input: SourceInterpretationContext = {
      ...base,
      body: {
        ...base.body,
        passages: [
          ...base.body.passages,
          {
            ...base.body.passages.find((p) => p.id === "s5")!,
            id: "s901",
            role: "context",
            rawPath: `/lots/0/${field}/it`,
            text,
            endUtf16: text.length,
          },
        ],
      },
    };
    const sourceRequest = buildSourceInterpretationRequest(input);
    assert(sourceRequest.requiredContractClauseIds.includes("s901"));
    const plan = buildSourceEvidenceReadingRequest(input, config);
    assert(
      plan.requests.some((part) => part.requiredClauseIds.includes("s901")),
    );
    const complete = responses(plan);
    assert(
      readSourceEvidenceReading(
        recordSourceEvidenceReading(complete, plan, metadata),
        plan,
      )?.accepted,
    );
    const missing = structuredClone(complete);
    for (const part of missing)
      part.observations = part.observations.filter(
        (observation) =>
          !observation.evidence.some((e) => e.sourceRef === "s901"),
      );
    assert.throws(
      () => recordSourceEvidenceReading(missing, plan, metadata),
      /contractual clause evidence coverage/,
    );
  },
);

test("A flat lot extension deadline reaches semantic review even when a cited draft detail omits it", () => {
  const base = lotContext("Fornitura di prodotti Alfa inventati.");
  const note =
    "Il committente può chiedere nuovi prezzi prima della scadenza indicata. È ammessa una sola proroga di due anni.";
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        {
          ...base.body.passages.find((p) => p.id === "s5")!,
          id: "s901",
          role: "context",
          rawPath: "/lots/0/canContractBeExtendedNote/it",
          text: note,
          endUtf16: note.length,
        },
      ],
    },
  };
  const request = buildSourceInterpretationRequest(input);
  const answer = {
    status: "resolved",
    summary: "Fornitura di prodotti Alfa inventati.",
    summarySourceRefs: ["s5"],
    targetRef: "s5",
    details: [
      {
        kind: "execution_condition",
        scope: "selected_lot",
        sourceRefs: ["s901"],
        explanation: "È ammessa una sola proroga di due anni.",
      },
    ],
    classificationReadings: [
      {
        classificationId: "c1",
        use: "shared_project_only",
        sourceRefs: ["s2", "s3"],
        explanation:
          "Categoria condivisa del progetto, senza prestazione aggiuntiva.",
      },
    ],
    components: [
      {
        description: "Fornitura di prodotti Alfa inventati.",
        importance: "not_stated",
        role: "supply",
        sourceRefs: ["s5"],
        roleEvidence: {
          state: "identified",
          actionText: "Fornitura",
          sourceRefs: ["s5"],
          scope: "selected_lot",
        },
        meaning: {
          state: "identified",
          statement: "Prodotti Alfa inventati.",
          objectText: "prodotti Alfa inventati",
          objectRefs: ["s5"],
          classificationContextIds: [],
          basis: "explicit_text",
        },
      },
    ],
    issues: [],
  };
  const before = JSON.stringify(answer);
  assert.throws(
    () =>
      recordSourceInterpretation({ ...answer, details: [] }, request, {
        ...metadata,
        model: input.binding.model,
      }),
    /Incomplete.*contract clauses/,
  );
  // A reference alone cannot prove semantic completeness. Keep the entire
  // original note beside the partial candidate for the separate review.
  const source = recordSourceInterpretation(answer, request, {
    ...metadata,
    model: input.binding.model,
  });
  const plan = buildSourceSemanticReviewRequest(input, source, config);
  const reading = recordSourceEvidenceReading(
    responses(plan.evidencePlan),
    plan.evidencePlan,
    metadata,
  );
  const parts = buildGroundedSourceReviewRequests(plan, reading);
  const bodies = parts.map((part) => JSON.parse(part.prompt));
  assert(
    bodies.some((body) =>
      body.requiredContractClauses.some(
        (clause: { id: string; text: string }) =>
          clause.id === "s901" && clause.text === note,
      ),
    ),
  );
  const binding = bodies
    .flatMap((body) => body.contractClauseDraftBindings)
    .find((item: { sourceRef: string }) => item.sourceRef === "s901");
  assert.deepEqual(binding.candidateDetails, [
    { index: 0, explanation: "È ammessa una sola proroga di due anni." },
  ]);
  assert.equal(JSON.stringify(answer), before);
});

for (const scope of ["project_context", "selected_lot"] as const) {
  for (const value of ["no", "yes", false, true] as const) {
    test(`Subcontracting ${String(value)} in ${scope} cannot disappear from a complete reading`, () => {
      const base = scope === "selected_lot" ? lotContext() : context();
      const rawPath = `${scope === "selected_lot" ? "/lots/0" : ""}/terms/subContractorAllowed`;
      const anchor = base.body.passages.find(
        (p) => p.scope === scope && p.role === "service",
      )!;
      const isText = typeof value === "string";
      const ref = isText ? "s901" : `f${base.body.fields.length}`;
      const input = {
        ...base,
        body: {
          ...base.body,
          passages: isText
            ? [
                ...base.body.passages,
                {
                  ...anchor,
                  id: ref,
                  rawPath,
                  role: "context" as const,
                  text: value,
                  startUtf16: 0,
                  endUtf16: value.length,
                },
              ]
            : base.body.passages,
          fields: isText
            ? base.body.fields
            : [...base.body.fields, { scope, rawPath, value }],
        },
      };
      const plan = buildSourceEvidenceReadingRequest(input, config);
      const index = plan.requests.findIndex((r) =>
        r.requiredClauseIds.includes(ref),
      );
      assert(index >= 0);
      const answers: any[] = responses(plan);
      answers[index].observations = answers[index].observations.filter(
        (o: any) => !o.evidence.some((q: any) => q.sourceRef === ref),
      );
      assert.throws(
        () => recordSourceEvidenceReading(answers, plan, metadata),
        /contractual clause evidence coverage/,
      );
      answers[index].observations.push({
        kind: "condition",
        serviceRef: anchor.id,
        evidence: [{ sourceRef: ref }],
      });
      answers[index].requiredClauseSelections = inventedClauseSelections(
        plan.requests[index].requiredClauseIds,
        answers[index],
      );
      const record = recordSourceEvidenceReading(answers, plan, metadata);
      assert(readSourceEvidenceReading(record, plan)?.accepted);
      const condition = record.responses[index].observations.find((o) =>
        o.evidence.some((q) => q.sourceRef === ref),
      )!;
      assert.equal(condition.scope, scope);
      assert.equal(
        condition.evidence.find((q) => q.sourceRef === ref)?.text,
        String(value),
      );
    });
  }
}

test("An unspecified subcontracting permission is not converted into a prohibition", () => {
  const base = context();
  const plan = buildSourceEvidenceReadingRequest(
    {
      ...base,
      body: {
        ...base.body,
        fields: [
          ...base.body.fields,
          {
            scope: "project_context",
            rawPath: "/terms/subContractorAllowed",
            value: null,
          },
        ],
      },
    },
    config,
  );
  assert.equal(plan.requests.flatMap((r) => r.requiredClauseIds).length, 0);
  assert(
    readSourceEvidenceReading(
      recordSourceEvidenceReading(responses(plan), plan, metadata),
      plan,
    )?.accepted,
  );
});

test("Unreadable work clauses stay blocked and missing-detail quotations cannot move between scopes", () => {
  const plan = buildSourceEvidenceReadingRequest(contractContext(), config);
  const answer = responses(plan);
  answer[0].observations = answer[0].observations.filter(
    (o: any) => !o.evidence.some((q: any) => q.sourceRef === "s5"),
  );
  answer[0].coverage = "unreadable";
  answer[0].requiredClauseSelections = inventedClauseSelections(
    plan.requests[0].requiredClauseIds,
    answer[0],
  );
  const result = readSourceEvidenceReading(
    recordSourceEvidenceReading(answer, plan, metadata),
    plan,
  )!;
  assert.equal(result.accepted, false);
  assert(result.findings.some((f) => f.kind === "unreadable_source"));

  const base = lotContext();
  const note = contractContext().body.passages[4];
  const mixed = buildSourceEvidenceReadingRequest(
    {
      ...base,
      body: {
        ...base.body,
        passages: [...base.body.passages, { ...note, id: "s6" }],
      },
    },
    config,
  );
  const moved: any[] = responses(mixed);
  moved[0].observations = moved[0].observations.filter(
    (o: any) => !o.evidence.some((q: any) => q.sourceRef === "s6"),
  );
  moved[0].missingDetails = [
    {
      serviceRef: "s5",
      missingAspects: ["technical_specifications"],
      evidence: [{ sourceRef: "s6" }],
    },
  ];
  moved[0].observations.push({
    serviceRef: "s5",
    kind: "condition",
    evidence: [{ sourceRef: "s6" }],
  });
  moved[0].requiredClauseSelections = inventedClauseSelections(
    mixed.requests[0].requiredClauseIds,
    moved[0],
  );
  assert.throws(
    () => recordSourceEvidenceReading(moved, mixed, metadata),
    /scope mismatch/,
  );
});

test("A clause near the end of a long lot source retains a same-scope descriptive anchor", () => {
  const base = lotContext();
  const notes = Array.from({ length: 120 }, (_, i) => {
    const text = `Contesto inventato ${i} `.padEnd(1500, "x");
    return {
      ...base.body.passages[0],
      id: `s${i + 6}`,
      role: "context" as const,
      rawPath: `/context/${i}`,
      text,
      endUtf16: text.length,
    };
  });
  const note = { ...contractContext().body.passages[4], id: "s126" };
  const plan = buildSourceEvidenceReadingRequest(
    {
      ...base,
      body: { ...base.body, passages: [...base.body.passages, ...notes, note] },
    },
    config,
  );
  assert(plan.requests.length > 1);
  const owner = plan.requests.find((r) =>
    r.requiredClauseIds.includes(note.id),
  )!;
  const body = JSON.parse(owner.prompt);
  assert(
    body.passages.some(
      (p: any) =>
        p.id === "s1" && p.scope === "project_context" && p.role === "service",
    ),
  );
  assert(
    body.passages.some((p: any) => p.id === "s5" && p.scope === "selected_lot"),
  );
  assert.equal(
    plan.requests
      .flatMap((r) => r.requiredClauseIds)
      .filter((id) => id === note.id).length,
    1,
  );
  assert.deepEqual(
    plan.requests.flatMap((r) => r.coverage.passageIds),
    [...base.body.passages, ...notes, note].map((p) => p.id),
  );
});

test("A structured project permission in a later lot chunk keeps the project anchor and scope", () => {
  const base = lotContext();
  const notes = Array.from({ length: 120 }, (_, i) => {
    const text = `Contesto inventato ${i} `.padEnd(1500, "x");
    return {
      ...base.body.passages[0],
      id: `s${i + 6}`,
      role: "context" as const,
      rawPath: `/context/${i}`,
      text,
      endUtf16: text.length,
    };
  });
  const ref = `f${base.body.fields.length}`;
  const plan = buildSourceEvidenceReadingRequest(
    {
      ...base,
      body: {
        ...base.body,
        passages: [...base.body.passages, ...notes],
        fields: [
          ...base.body.fields,
          {
            scope: "project_context",
            rawPath: "/terms/subContractorAllowed",
            value: false,
          },
        ],
      },
    },
    config,
  );
  const index = plan.requests.findIndex((r) =>
    r.requiredClauseIds.includes(ref),
  );
  assert(index > 0);
  const body = JSON.parse(plan.requests[index].prompt);
  assert(
    body.passages.some(
      (p: any) => p.id === "s1" && p.scope === "project_context",
    ),
  );
  assert.deepEqual(body.requiredClauseFields, [
    {
      sourceRef: ref,
      scope: "project_context",
      rawPath: "/terms/subContractorAllowed",
    },
  ]);
  const answers: any[] = responses(plan);
  answers[index].observations = answers[index].observations.slice(0, 31);
  answers[index].observations.push({
    kind: "condition",
    serviceRef: "s5",
    evidence: [{ sourceRef: ref }],
  });
  assert.throws(
    () => recordSourceEvidenceReading(answers, plan, metadata),
    /scope mismatch/,
  );
});

test("Independent readings from before contractual-clause coverage cannot be reused", () => {
  const plan = buildSourceEvidenceReadingRequest(context(), config);
  const record = recordSourceEvidenceReading(responses(plan), plan, metadata);
  assert.equal(
    readSourceEvidenceReading(
      { ...record, version: "source-evidence-reading-v13" },
      plan,
    ),
    null,
  );
});

test("An explicit output limit binds requests, plan, record and hash without changing the default", () => {
  const input = context();
  const standard = buildSourceEvidenceReadingRequest(input, config);
  const explicitDefault = buildSourceEvidenceReadingRequest(input, {
    ...config,
    maxTokens: 8192,
  });
  const expanded = buildSourceEvidenceReadingRequest(input, {
    ...config,
    maxTokens: 16_384,
  });
  assert.equal(standard.maxTokens, 8192);
  assert(standard.requests.every((request) => request.maxTokens === 8192));
  assert.equal(explicitDefault.inputHash, standard.inputHash);
  assert.deepEqual(explicitDefault.requests, standard.requests);
  assert.equal(expanded.maxTokens, 16_384);
  assert(expanded.requests.every((request) => request.maxTokens === 16_384));
  assert.notEqual(expanded.inputHash, standard.inputHash);
  const standardRecord = recordSourceEvidenceReading(
    responses(standard),
    standard,
    metadata,
  );
  const expandedRecord = recordSourceEvidenceReading(
    responses(expanded),
    expanded,
    metadata,
  );
  assert.equal("maxTokens" in standardRecord, false);
  assert.equal(expandedRecord.maxTokens, 16_384);
  assert.equal(
    readSourceEvidenceReading(expandedRecord, expanded)?.accepted,
    true,
  );
  assert.equal(readSourceEvidenceReading(standardRecord, expanded), null);
  assert.equal(readSourceEvidenceReading(expandedRecord, standard), null);
  for (const maxTokens of [0, 16_385, NaN])
    assert.throws(() =>
      buildSourceEvidenceReadingRequest(input, { ...config, maxTokens }),
    );
});

test("A project cannot be described as a selected lot partition in the provider schema", () => {
  const plan = buildSourceEvidenceReadingRequest(context(), config);
  const answers = responses(plan);
  const validate = new Ajv2020({ strict: false }).compile(
    plan.requests[0].responseFormat.json_schema.schema,
  );
  assert(validate(answers[0]));
  answers[0].observations[0].kind = "target_partition";
  assert(!validate(answers[0]));
});

test("Independent reading contains original source only and preserves label evidence in its strict schema", () => {
  const input = context(),
    plan = buildSourceEvidenceReadingRequest(input, config),
    answers = responses(plan);
  const data = JSON.parse(plan.requests[0].prompt);
  for (const forbidden of [
    "draft",
    "summary",
    "assignedClaims",
    "company",
    "profile",
    "readings",
  ])
    assert.equal(forbidden in data, false);
  assert.deepEqual(
    data.coverage.passageIds,
    input.body.passages.map((p) => p.id),
  );
  assert.deepEqual(
    data.fields.map((f: any) => f.value),
    [0, false],
  );
  assert(
    new Ajv2020({ strict: false }).compile(
      plan.requests[0].responseFormat.json_schema.schema,
    )(answers[0]),
  );
  const result = readSourceEvidenceReading(
    recordSourceEvidenceReading(answers, plan, metadata),
    plan,
  )!;
  assert(result.accepted);
  assert.equal(
    result.responses[0].classifications[0].label!.text,
    "Famiglia alimentare inventata",
  );
  assert.throws(() =>
    buildSourceEvidenceReadingRequest(
      { ...input, draft: "UNTRUSTED DRAFT" } as SourceInterpretationContext,
      config,
    ),
  );
  assert.throws(() =>
    buildSourceEvidenceReadingRequest(input, {
      ...config,
      company: "PRIVATE",
    } as typeof config),
  );
});

test("Missing classifications, invented labels and non-contiguous quotes cannot produce an independent record", () => {
  const plan = buildSourceEvidenceReadingRequest(context(), config);
  for (const mutate of [
    (a: any) => {
      a.classifications = [];
    },
    (a: any) => {
      a.classifications.push(a.classifications[0]);
    },
    (a: any) => {
      a.classifications[0].label = null;
    },
    (a: any) => {
      a.classifications[0].label = { text: "Famiglia tecnica inventata" };
    },
    (a: any) => {
      a.classifications[0].label = { text: "Famiglia" };
    },
    (a: any) => {
      a.observations[0].evidence[0].text = "Fornitura Alfa";
    },
    (a: any) => {
      a.observations[0].evidence[0].sourceRef = "s999";
    },
    (a: any) => {
      a.observations[0].scope = "selected_lot";
    },
    (a: any) => {
      a.observations[0].serviceRef = "s3";
      a.observations[0].evidence = [{ sourceRef: "s3" }];
    },
  ]) {
    const a = responses(plan);
    mutate(a[0]);
    assert.throws(() => recordSourceEvidenceReading(a, plan, metadata));
  }
});

test("Independent classification conflicts, uncertainty and incomplete readings remain blocking", () => {
  const plan = buildSourceEvidenceReadingRequest(context(), config);
  const quote = { sourceRef: "s1" };
  for (const mutate of [
    (a: any) => {
      a.classifications[0].relationship = "conflicting";
      a.classifications[0].explanation =
        "Differenza inventata fra la categoria e il prodotto Alfa della fonte.";
      a.classifications[0].evidence.push(quote);
    },
    (a: any) => {
      a.issues.push({
        kind: "object_uncertain",
        reason: "Incertezza inventata",
        evidence: [quote],
      });
    },
    (a: any) => {
      a.coverage = "unreadable";
    },
    (a: any) => {
      a.observations = [];
    },
  ]) {
    const a = responses(plan);
    mutate(a[0]);
    const result = readSourceEvidenceReading(
      recordSourceEvidenceReading(a, plan, metadata),
      plan,
    )!;
    assert.equal(result.accepted, false);
  }
  const insufficient = responses(plan);
  insufficient[0].classifications[0].relationship = "conflicting";
  insufficient[0].classifications[0].explanation =
    "Differenza inventata fra la categoria e il prodotto Alfa della fonte.";
  assert.throws(
    () => recordSourceEvidenceReading(insufficient, plan, metadata),
    /non-classification evidence/,
  );
});

test("An extension conflict blocks approval while retaining both original assertions", () => {
  const base = context();
  const notes = [
    ["/procurement/canContractBeExtended", "no"],
    ["/procurement/executionNote/it", "La fornitura è rinnovabile di un anno."],
  ];
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        ...notes.map(([rawPath, text], i) => ({
          ...base.body.passages[3],
          id: `s${i + 5}`,
          rawPath,
          text,
          endUtf16: text.length,
        })),
      ],
    },
  };
  const plan = buildSourceEvidenceReadingRequest(input, config);
  const required = plan.requests.flatMap((r) =>
    JSON.parse(r.prompt).requiredClausePassages.map(
      (p: { sourceRef: string }) => p.sourceRef,
    ),
  );
  assert.deepEqual(required, ["s5", "s6"]);
  const answers = responses(plan).map((answer, index) =>
    index === 0
      ? {
          ...answer,
          issues: [
            {
              kind: "source_conflict" as const,
              reason:
                "Il campo esclude la proroga, la nota prevede rinnovo dello stesso contratto; nessuna precedenza.",
              evidence: [{ sourceRef: "s5" }, { sourceRef: "s6" }],
            },
          ],
        }
      : answer,
  );
  const record = recordSourceEvidenceReading(answers, plan, metadata);
  const result = readSourceEvidenceReading(record, plan)!;
  assert.equal(result.accepted, false);
  assert.equal(result.findings[0].kind, "source_conflict");
  assert.deepEqual(result.findings[0].sourceRefs, ["s5", "s6"]);
  assert.equal(
    result.responses[0].issues[0].evidence.find((p) => p.sourceRef === "s5")!
      .text,
    "no",
  );
  assert.equal(
    readSourceEvidenceReading(
      { ...record, version: "source-evidence-reading-v14" },
      plan,
    ),
    null,
  );
});

test("A metadata advisory preserves original evidence and cannot clear material findings", () => {
  const plan = buildSourceEvidenceReadingRequest(context(), config);
  const input = responses(plan);
  input[0].classifications[0].relationship = "metadata_discrepancy";
  input[0].classifications[0].explanation =
    "Etichetta da controllare; prestazione esplicita conservata.";
  input[0].classifications[0].evidence.push({ sourceRef: "s1" });
  const value = recordSourceEvidenceReading(input, plan, metadata);
  const result = readSourceEvidenceReading(value, plan)!;
  assert.equal(result.accepted, true);
  assert.equal(result.findings.length, 0);
  assert.equal(result.warnings[0].kind, "classification_metadata_discrepancy");
  assert.deepEqual(
    new Set(result.warnings[0].sourceRefs),
    new Set(["s1", "s2", "s3"]),
  );
  assert.equal(
    result.responses[0].classifications[0].label!.text,
    context().body.classifications[0].labels[0].text,
  );
  for (const mutate of [
    (a: any) => {
      a.coverage = "unreadable";
    },
    (a: any) => {
      a.issues.push({
        kind: "source_conflict",
        reason: "Due clausole opposte inventate.",
        evidence: [{ sourceRef: "s1" }, { sourceRef: "s4" }],
      });
    },
    (a: any) => {
      a.issues.push({
        kind: "object_uncertain",
        reason: "Oggetto non determinabile.",
        evidence: [{ sourceRef: "s1" }],
      });
    },
  ]) {
    const changed = structuredClone(input);
    mutate(changed[0]);
    const blocked = readSourceEvidenceReading(
      recordSourceEvidenceReading(changed, plan, metadata),
      plan,
    )!;
    assert.equal(blocked.accepted, false);
    assert.equal(blocked.warnings.length, 1);
    assert(blocked.findings.length > 0);
  }
  assert.equal(
    readSourceEvidenceReading(
      { ...value, version: "source-evidence-reading-v11" },
      plan,
    ),
    null,
  );
});

test("Metadata advisories require a selected original performance, not a code or administrative detail", () => {
  const plan = buildSourceEvidenceReadingRequest(context(), config);
  for (const refs of [["s2", "s3"], ["s4"]]) {
    const input = responses(plan);
    input[0].classifications[0].relationship = "metadata_discrepancy";
    input[0].classifications[0].explanation =
      "Differenza inventata fra la categoria e il prodotto Alfa della fonte.";
    input[0].classifications[0].evidence = refs.map((sourceRef) => ({
      sourceRef,
    }));
    assert.throws(
      () => recordSourceEvidenceReading(input, plan, metadata),
      /original performance in the same scope/,
    );
  }
  const input = responses(plan);
  input[0].classifications[0].relationship = "metadata_discrepancy";
  input[0].classifications[0].explanation =
    "Differenza inventata fra la categoria e il prodotto Alfa della fonte.";
  input[0].classifications[0].evidence.push({ sourceRef: "s1" });
  input[0].observations[0].kind = "condition";
  assert.throws(
    () => recordSourceEvidenceReading(input, plan, metadata),
    /original performance in the same scope/,
  );
});

test("A metadata advisory can cite an owned service passage without changing the performance anchor", () => {
  const base = context();
  const french = "Fourniture du produit Alfa inventé.";
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        {
          ...base.body.passages[0],
          id: "s5",
          rawPath: "/description/fr",
          text: french,
          endUtf16: french.length,
        },
      ],
    },
  };
  const plan = buildSourceEvidenceReadingRequest(input, config);
  const answers = responses(plan);
  answers[0].observations = [
    {
      kind: "performance",
      serviceRef: "s1",
      evidence: [{ sourceRef: "s5" }],
    },
  ];
  answers[0].classifications[0].relationship = "metadata_discrepancy";
  answers[0].classifications[0].explanation =
    "Differenza inventata fra la categoria e il prodotto Alfa della fonte.";
  answers[0].classifications[0].evidence = [{ sourceRef: "s5" }];
  const before = structuredClone({ input, answers });
  const result = readSourceEvidenceReading(
    recordSourceEvidenceReading(answers, plan, metadata),
    plan,
  )!;
  assert.equal(result.accepted, true);
  assert.equal(result.findings.length, 0);
  assert.equal(result.warnings[0].kind, "classification_metadata_discrepancy");
  assert.equal(result.responses[0].observations[0].serviceRef, "s1");
  assert.deepEqual(
    result.responses[0].observations[0].evidence.map((e) => e.sourceRef),
    ["s1", "s5"],
  );
  assert.equal(
    result.responses[0].classifications[0].evidence.find(
      (e) => e.sourceRef === "s5",
    )!.text,
    french,
  );
  assert.deepEqual({ input, answers }, before);
});

test("Attached metadata proof must be an owned service passage in the classification scope", () => {
  const base = context();
  const planWith = (scope: "project_context" | "selected_lot") =>
    buildSourceEvidenceReadingRequest(
      scope === "selected_lot"
        ? lotContext()
        : {
            ...base,
            body: {
              ...base.body,
              passages: [
                ...base.body.passages,
                {
                  ...base.body.passages[0],
                  id: "s5",
                  rawPath: "/description/fr",
                  scope,
                },
              ],
            },
          },
      config,
    );
  for (const scenario of ["unowned", "context", "condition", "other_scope"]) {
    const plan = planWith(
      scenario === "other_scope" ? "selected_lot" : "project_context",
    );
    const answers = responses(plan);
    const proof = scenario === "context" ? "s4" : "s5";
    answers[0].observations = [
      {
        kind: scenario === "condition" ? "condition" : "performance",
        serviceRef: scenario === "other_scope" ? "s5" : "s1",
        evidence: scenario === "unowned" ? [] : [{ sourceRef: proof }],
      },
    ];
    answers[0].classifications[0].relationship = "metadata_discrepancy";
    answers[0].classifications[0].explanation =
      "Differenza inventata fra la categoria e il prodotto Alfa della fonte.";
    answers[0].classifications[0].evidence = [{ sourceRef: proof }];
    const before = structuredClone(answers);
    assert.throws(
      () => recordSourceEvidenceReading(answers, plan, metadata),
      /original performance in the same scope/,
      scenario,
    );
    assert.deepEqual(answers, before);
  }
});

test("Long original readings cover the entire tail and never use extraction-selected passages", () => {
  const base = context();
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        ...Array.from({ length: 120 }, (_, i) => {
          const text =
            i === 119
              ? "CODA INVENTATA: un acquisto aggiuntivo è escluso."
              : `Prestazione inventata ${i} `.padEnd(1500, "x");
          return {
            ...base.body.passages[0],
            id: `s${i + 5}`,
            rawPath: `/description/${i}`,
            text,
            endUtf16: text.length,
          };
        }),
      ],
    },
  };
  const plan = buildSourceEvidenceReadingRequest(input, config);
  assert(plan.requests.length > 1);
  assert.deepEqual(
    plan.requests.flatMap((r) => r.coverage.passageIds),
    input.body.passages.map((p) => p.id),
  );
  assert.deepEqual(
    plan.requests.flatMap((r) => r.coverage.fieldIndexes),
    [0, 1],
  );
  assert.equal(
    plan.requests
      .flatMap((r) => r.classificationIds)
      .filter((id) => id === "c1").length,
    1,
  );
  assert(plan.requests.some((r) => r.prompt.includes("CODA INVENTATA")));
  for (const r of plan.requests)
    assert(
      Buffer.byteLength(
        r.system + r.prompt + JSON.stringify(r.responseFormat),
      ) <= 160000,
    );
  assert.throws(
    () => recordSourceEvidenceReading(responses(plan).slice(1), plan, metadata),
    /Incomplete/,
  );
});

test("Independent evidence is bound to source and configuration and rejects tampering", () => {
  const input = context(),
    plan = buildSourceEvidenceReadingRequest(input, config),
    record = recordSourceEvidenceReading(responses(plan), plan, metadata);
  assert.throws(
    () => readSourceEvidenceReading({ ...record, id: "altered" }, plan),
    /Altered/,
  );
  const changed = buildSourceEvidenceReadingRequest(input, {
    ...config,
    reasoningEffort: "none",
  });
  assert.equal(readSourceEvidenceReading(record, changed), null);
  input.body.passages[0].text += " RETTIFICA";
  input.body.passages[0].endUtf16 = input.body.passages[0].text.length;
  assert.equal(
    readSourceEvidenceReading(
      record,
      buildSourceEvidenceReadingRequest(input, config),
    ),
    null,
  );
});

test("Reference selections preserve complete HTML and Unicode without accepting model-written quotations", () => {
  const input = context();
  const original = `<p>Fornitura Alfa 🧹. ${"Il contesto originale resta integro. ".repeat(30)}La seconda frase non può essere eliminata.</p>`;
  input.body.passages[0].text = original;
  input.body.passages[0].endUtf16 = original.length;
  const plan = buildSourceEvidenceReadingRequest(input, config);
  const selections = responses(plan);
  const before = JSON.stringify(selections);
  const record = recordSourceEvidenceReading(selections, plan, metadata);
  assert.equal(record.responses[0].observations[0].evidence[0].text, original);
  assert.equal(JSON.stringify(selections), before);
  assert.equal(readSourceEvidenceReading(record, plan)?.accepted, true);
  const wire = new Ajv2020({ strict: false }).compile(
    plan.requests[0].responseFormat.json_schema.schema,
  );
  for (const suppliedText of [original, "<p>Fornitura Alfa 🧹.</p>"]) {
    const invalid = responses(plan);
    Object.assign(invalid[0].observations[0].evidence[0], {
      text: suppliedText,
    });
    assert.equal(wire(invalid[0]), false);
    assert.throws(() => recordSourceEvidenceReading(invalid, plan, metadata));
  }
  const duplicate = responses(plan);
  duplicate[0].observations[0].evidence.push({ sourceRef: "s1" });
  assert.throws(
    () => recordSourceEvidenceReading(duplicate, plan, metadata),
    /Repeated/,
  );
});

test("Stored evidence cannot replace the original passage with a reconstructed or shortened quote, even with a new hash", () => {
  const input = context();
  const original =
    "<p>Fornitura Alfa. Anche la seconda frase appartiene alla fonte.</p>";
  input.body.passages[0].text = original;
  input.body.passages[0].endUtf16 = original.length;
  const plan = buildSourceEvidenceReadingRequest(input, config);
  const record = recordSourceEvidenceReading(responses(plan), plan, metadata);
  for (const replacement of ["<p>Fornitura Alfa.</p>", "Fornitura Alfa."]) {
    const changed = structuredClone(record);
    changed.responses[0].observations[0].evidence[0].text = replacement;
    const { hash: _hash, ...unsigned } = changed;
    changed.hash = createHash("sha256")
      .update(stableDocumentaryJson(unsigned))
      .digest("hex");
    assert.throws(
      () => readSourceEvidenceReading(changed, plan),
      /exact original quotation/,
    );
  }
  for (const version of [
    "source-evidence-reading-v1",
    "source-evidence-reading-v9",
    "source-evidence-reading-v10",
    "source-evidence-reading-v20",
    "source-evidence-reading-v21",
  ])
    assert.equal(readSourceEvidenceReading({ ...record, version }, plan), null);
});

test("Evidence observations preserve original contractual parties and reject an additional model paraphrase", () => {
  const input = context();
  const original =
    "<p>Le mandant pourra demander au prestataire un service complémentaire facultatif.</p>";
  input.body.passages[3].text = original;
  input.body.passages[3].endUtf16 = original.length;
  const plan = buildSourceEvidenceReadingRequest(input, config);
  const answer = responses(plan);
  answer[0].observations = [
    { kind: "performance", serviceRef: "s1", evidence: [] },
    {
      kind: "condition",
      serviceRef: "s1",
      evidence: [{ sourceRef: "s4" }],
    },
  ];
  const wire = new Ajv2020({ strict: false }).compile(
    plan.requests[0].responseFormat.json_schema.schema,
  );
  assert.equal(wire(answer[0]), true);
  const record = recordSourceEvidenceReading(answer, plan, metadata);
  const condition = record.responses[0].observations[1];
  assert.equal("statement" in condition, false);
  assert.equal(condition.scope, "project_context");
  assert.deepEqual(condition.evidence, [
    { sourceRef: "s1", text: input.body.passages[0].text },
    { sourceRef: "s4", text: original },
  ]);
  const incorrect = "Il prestatore può chiedere al committente il servizio.";
  const supplied = structuredClone(answer);
  Object.assign(supplied[0].observations[1], { statement: incorrect });
  assert.equal(wire(supplied[0]), false);
  assert.throws(() => recordSourceEvidenceReading(supplied, plan, metadata));
  const changed = structuredClone(record);
  Object.assign(changed.responses[0].observations[1], { statement: incorrect });
  const { hash: _hash, ...unsigned } = changed;
  changed.hash = createHash("sha256")
    .update(stableDocumentaryJson(unsigned))
    .digest("hex");
  assert.throws(() => readSourceEvidenceReading(changed, plan));
});

test("Fragmented classification labels are copied completely from their ordered original references", () => {
  const input = context();
  const label =
    "Famiglia alimentare " + "contesto ".repeat(80) + "e prodotti secchi";
  const first = input.body.passages[2];
  first.text = label.slice(0, 600);
  first.endUtf16 = first.text.length;
  const expanded = {
    ...input,
    body: {
      ...input.body,
      passages: [
        ...input.body.passages,
        {
          ...first,
          id: "s5",
          text: label.slice(600),
          startUtf16: 600,
          endUtf16: label.length,
        },
      ],
      classifications: [
        {
          ...input.body.classifications[0],
          labels: [{ language: "it", text: label, sourceRefs: ["s3", "s5"] }],
        },
      ],
    },
  };
  const plan = buildSourceEvidenceReadingRequest(expanded, config);
  const record = recordSourceEvidenceReading(responses(plan), plan, metadata);
  assert.deepEqual(record.responses[0].classifications[0].label, {
    text: label,
    sourceRefs: ["s3", "s5"],
  });
  assert.equal(readSourceEvidenceReading(record, plan)?.accepted, true);
  for (const sourceRefs of [["s3"], ["s5", "s3"], ["s1"]]) {
    const invalid = structuredClone(record);
    invalid.responses[0].classifications[0].label!.sourceRefs = sourceRefs;
    const { hash: _hash, ...unsigned } = invalid;
    invalid.hash = createHash("sha256")
      .update(stableDocumentaryJson(unsigned))
      .digest("hex");
    assert.throws(
      () => readSourceEvidenceReading(invalid, plan),
      /complete original label/,
    );
  }
});

test("The wire schema limits citations to existing text and scalar field references", () => {
  const plan = buildSourceEvidenceReadingRequest(context(), config);
  const validate = new Ajv2020({ strict: false }).compile(
    plan.requests[0].responseFormat.json_schema.schema,
  );
  for (const sourceRef of ["s999", "f999"]) {
    const invalid = responses(plan);
    invalid[0].observations[0].evidence = [{ sourceRef }];
    assert.equal(validate(invalid[0]), false);
    assert.throws(
      () => recordSourceEvidenceReading(invalid, plan, metadata),
      /outside its request/,
    );
  }
  const valid = responses(plan);
  valid[0].observations.push({
    kind: "condition",
    serviceRef: "s1",
    evidence: [{ sourceRef: "f0" }, { sourceRef: "f1" }],
  });
  assert.equal(validate(valid[0]), true);
  const record = recordSourceEvidenceReading(valid, plan, metadata);
  assert.deepEqual(record.responses[0].observations.at(-1)!.evidence.slice(1), [
    { sourceRef: "f0", text: "0" },
    { sourceRef: "f1", text: "false" },
  ]);
  const changed = structuredClone(record);
  changed.responses[0].observations.at(-1)!.evidence[1].text = "null";
  const { hash: _hash, ...unsigned } = changed;
  changed.hash = createHash("sha256")
    .update(stableDocumentaryJson(unsigned))
    .digest("hex");
  assert.throws(
    () => readSourceEvidenceReading(changed, plan),
    /exact original quotation/,
  );
});

test("Classifications retain all original languages without delegating label assembly", () => {
  const input = context();
  const translated = "Invented food family";
  const multilingual = {
    ...input,
    body: {
      ...input.body,
      passages: [
        ...input.body.passages,
        {
          ...input.body.passages[2],
          id: "s5",
          rawPath: "/cpv/label/en",
          text: translated,
          endUtf16: translated.length,
        },
      ],
      classifications: [
        {
          ...input.body.classifications[0],
          labels: [
            ...input.body.classifications[0].labels,
            { language: "en", text: translated, sourceRefs: ["s5"] },
          ],
        },
      ],
    },
  };
  const plan = buildSourceEvidenceReadingRequest(multilingual, config);
  const answers = responses(plan);
  answers[0].classifications[0].evidence = [{ sourceRef: "s1" }];
  const record = recordSourceEvidenceReading(answers, plan, metadata);
  assert.equal("label" in answers[0].classifications[0], false);
  assert.deepEqual(
    record.responses[0].classifications[0].evidence.map((q) => q.sourceRef),
    ["s1", "s2", "s3", "s5"],
  );
  assert.deepEqual(record.responses[0].classifications[0].label, {
    text: input.body.classifications[0].labels[0].text,
    sourceRefs: ["s3"],
  });
  const invalid: any = responses(plan);
  invalid[0].classifications[0].label = { sourceRefs: ["s3", "s5"] };
  assert.equal(
    new Ajv2020({ strict: false }).compile(
      plan.requests[0].responseFormat.json_schema.schema,
    )(invalid[0]),
    false,
  );
  assert.throws(() => recordSourceEvidenceReading(invalid, plan, metadata));
});

test("Missing specifications remain visible without clearing material uncertainty or conflicts", () => {
  const plan = buildSourceEvidenceReadingRequest(context(), config);
  const answers: any[] = responses(plan);
  answers[0].missingDetails.push({
    missingAspects: ["subtype"],
    serviceRef: "s1",
    evidence: [{ sourceRef: "s4" }],
  });
  const result = readSourceEvidenceReading(
    recordSourceEvidenceReading(answers, plan, metadata),
    plan,
  )!;
  assert.equal(result.accepted, true);
  assert.equal(result.missingDetails[0].id, "d1-1");
  assert.equal(
    result.missingDetails[0].evidence.find((q) => q.sourceRef === "s4")!.text,
    context().body.passages[3].text,
  );
  answers[0].issues.push({
    kind: "source_conflict",
    reason: "Due clausole sostanziali incompatibili.",
    evidence: [{ sourceRef: "s1" }, { sourceRef: "s4" }],
  });
  assert.equal(
    readSourceEvidenceReading(
      recordSourceEvidenceReading(answers, plan, metadata),
      plan,
    )!.accepted,
    false,
  );
});

test("Missing details select absent aspects without inventing known objects or places", () => {
  const plan = buildSourceEvidenceReadingRequest(context(), config);
  const answers: any[] = responses(plan);
  answers[0].missingDetails.push({
    serviceRef: "s1",
    evidence: [{ sourceRef: "s4" }],
    missingAspects: ["quantities", "technical_specifications"],
  });
  const validate = new Ajv2020({ strict: false }).compile(
    plan.requests[0].responseFormat.json_schema.schema,
  );
  assert(validate(answers[0]));
  const before = JSON.stringify(answers);
  const record = recordSourceEvidenceReading(answers, plan, metadata);
  assert.equal(
    record.responses[0].missingDetails[0].description,
    "Non precisati nel materiale fornito: quantità; specifiche tecniche di dettaglio.",
  );
  assert.deepEqual(
    record.responses[0].missingDetails[0].evidence.map((q) => q.sourceRef),
    ["s1", "s4"],
  );
  assert.equal(JSON.stringify(answers), before);
  const inventedObject = structuredClone(answers);
  inventedObject[0].missingDetails[0].description =
    "Quantità delle condotte a Lugano non precisate.";
  assert.equal(validate(inventedObject[0]), false);
  assert.throws(() =>
    recordSourceEvidenceReading(inventedObject, plan, metadata),
  );
  for (const aspects of [
    [],
    ["unknown_object"],
    ["quantities", "quantities"],
  ]) {
    const bad = structuredClone(answers);
    bad[0].missingDetails[0].missingAspects = aspects;
    assert.throws(() => recordSourceEvidenceReading(bad, plan, metadata));
  }
});

test("Contract metadata alone cannot be promoted to a performance and earlier evidence stays stale", () => {
  const plan = buildSourceEvidenceReadingRequest(context(), config),
    answers = responses(plan);
  answers[0].observations[0].serviceRef = "s2";
  answers[0].observations[0].evidence = [{ sourceRef: "f0" }];
  assert.throws(
    () => recordSourceEvidenceReading(answers, plan, metadata),
    /original service description/,
  );
  const record = recordSourceEvidenceReading(responses(plan), plan, metadata);
  assert.equal(
    readSourceEvidenceReading(
      { ...record, version: "source-evidence-reading-v6" },
      plan,
    ),
    null,
  );
});

test("The provider schema requires descriptive evidence for performances and missing details", () => {
  const plan = buildSourceEvidenceReadingRequest(context(), config);
  const answers: any[] = responses(plan);
  const validate = new Ajv2020({ strict: false }).compile(
    plan.requests[0].responseFormat.json_schema.schema,
  );
  answers[0].observations[0].serviceRef = "s2";
  answers[0].observations[0].evidence = [{ sourceRef: "f0" }];
  assert.equal(validate(answers[0]), false);
  answers[0].observations[0].serviceRef = "s1";
  assert.equal(validate(answers[0]), true);
  answers[0].missingDetails.push({
    missingAspects: ["technical_specifications"],
    serviceRef: "s4",
    evidence: [{ sourceRef: "s4" }],
  });
  assert.equal(validate(answers[0]), false);
  assert.throws(
    () => recordSourceEvidenceReading(answers, plan, metadata),
    /descriptive anchor requires/,
  );
  answers[0].missingDetails[0].serviceRef = "s1";
  assert.equal(validate(answers[0]), true);
  assert.equal(
    readSourceEvidenceReading(
      recordSourceEvidenceReading(answers, plan, metadata),
      plan,
    )!.accepted,
    true,
  );
});

function lotContext(
  localText = "Il lotto 1 applica la fornitura descritta nel progetto alla regione Nord.",
) {
  const original = context();
  const input: SourceInterpretationContext = {
    ...original,
    binding: {
      ...original.binding,
      target: {
        kind: "lot",
        publicationId: "invented-publication",
        sourceProjectId: "invented-project",
        lotId: "invented-lot",
      },
    },
    targetScope: "selected_lot",
    body: {
      ...original.body,
      classifications: original.body.classifications.map((c) => ({
        ...c,
        appliesTo: "shared_project_context" as const,
      })),
      target: {
        kind: "lot",
        lot: { id: "invented-lot", path: "/lots/0", headerPath: null },
      },
      passages: [
        ...original.body.passages,
        {
          ...original.body.passages[0],
          id: "s5",
          scope: "selected_lot",
          rawPath: "/lots/0/orderDescription/it",
          text: localText,
          endUtf16: localText.length,
        },
      ],
    },
  };
  return input;
}

test("Lot facts and shared facts remain separate in the provider schema and stored reading", () => {
  const plan = buildSourceEvidenceReadingRequest(lotContext(), config);
  const valid: any[] = responses(plan);
  valid[0].observations[0].serviceRef = "s5";
  valid[0].observations[0].evidence = [{ sourceRef: "s5" }];
  valid[0].missingDetails.push({
    missingAspects: ["referenced_documents"],
    serviceRef: "s5",
    evidence: [{ sourceRef: "s5" }],
  });
  const validate = new Ajv2020({ strict: false }).compile(
    plan.requests[0].responseFormat.json_schema.schema,
  );
  assert.equal(validate(valid[0]), true);
  assert(valid[0].observations.some((o: any) => o.serviceRef === "s1"));
  assert.equal(
    readSourceEvidenceReading(
      recordSourceEvidenceReading(valid, plan, metadata),
      plan,
    )!.accepted,
    true,
  );
  const unanchored = structuredClone(valid);
  unanchored[0].observations[0].evidence = [{ sourceRef: "s1" }];
  assert.equal(validate(unanchored[0]), true); // Cross-field scope is checked locally.
  assert.throws(
    () => recordSourceEvidenceReading(unanchored, plan, metadata),
    /scope mismatch/,
  );
  const mislabelled = structuredClone(valid);
  mislabelled[0].observations[0].serviceRef = "s1";
  assert.equal(validate(mislabelled[0]), true);
  assert.throws(
    () => recordSourceEvidenceReading(mislabelled, plan, metadata),
    /scope mismatch/,
  );
  const mixed = structuredClone(valid);
  mixed[0].observations[0].evidence.push({ sourceRef: "s1" });
  assert.equal(validate(mixed[0]), true);
  assert.throws(
    () => recordSourceEvidenceReading(mixed, plan, metadata),
    /scope mismatch/,
  );
  const mixedDetail = structuredClone(valid);
  mixedDetail[0].missingDetails[0].evidence.push({ sourceRef: "f0" });
  assert.equal(validate(mixedDetail[0]), true);
  assert.throws(
    () => recordSourceEvidenceReading(mixedDetail, plan, metadata),
    /scope mismatch/,
  );
});

test("A territorial partition identifies the lot only with a separately grounded common performance", () => {
  const plan = buildSourceEvidenceReadingRequest(
    lotContext("Regione Nord"),
    config,
  );
  const answers: any[] = responses(plan);
  const local = answers[0].observations.find((o: any) => o.serviceRef === "s5");
  local.kind = "target_partition";
  const validate = new Ajv2020({ strict: false }).compile(
    plan.requests[0].responseFormat.json_schema.schema,
  );
  assert.equal(validate(answers[0]), true);
  const result = readSourceEvidenceReading(
    recordSourceEvidenceReading(answers, plan, metadata),
    plan,
  )!;
  assert.equal(result.identified, true);
  assert.equal(result.accepted, true);
  assert(
    !result.observations.some(
      (o) => o.kind === "performance" && o.scope === "selected_lot",
    ),
  );
  const noWork = structuredClone(answers);
  noWork[0].observations = noWork[0].observations.filter(
    (o: any) => o.kind !== "performance",
  );
  assert.equal(
    readSourceEvidenceReading(
      recordSourceEvidenceReading(noWork, plan, metadata),
      plan,
    )!.identified,
    false,
  );
  const noPartition = structuredClone(answers);
  noPartition[0].observations.find(
    (o: any) => o.kind === "target_partition",
  ).kind = "condition";
  assert.equal(
    readSourceEvidenceReading(
      recordSourceEvidenceReading(noPartition, plan, metadata),
      plan,
    )!.identified,
    false,
  );
  const uncertain = structuredClone(answers);
  uncertain[0].issues.push({
    kind: "target_uncertain",
    reason: "L'applicabilità al lotto non è stabilita.",
    evidence: [{ sourceRef: "s5" }],
  });
  assert.equal(
    readSourceEvidenceReading(
      recordSourceEvidenceReading(uncertain, plan, metadata),
      plan,
    )!.accepted,
    false,
  );
  const wrongScope = structuredClone(answers);
  const project = wrongScope[0].observations.find(
    (o: any) => o.kind === "performance",
  );
  project.kind = "target_partition";
  assert.equal(validate(wrongScope[0]), true);
  assert.throws(
    () => recordSourceEvidenceReading(wrongScope, plan, metadata),
    /partition must belong/,
  );
});

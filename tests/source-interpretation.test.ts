import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import {
  SOURCE_INTERPRETATION_VERSION,
  SOURCE_INTERPRETATION_MAX_TOKENS,
  sourceInterpretationTokenLimit,
  buildSourceInterpretationRequest,
  sourceInterpretationKey,
  validateSourceInterpretation,
  recordSourceInterpretation,
  readSourceInterpretation,
  sourceInterpretationRecordSchema,
  type SourceInterpretationContext,
} from "../src/lib/source-interpretation";
import { stableDocumentaryJson } from "../src/lib/documentary-observation";
import { openaiResponseBody } from "../src/lib/openai-responses";

test("Submission, validity and document collection remain mandatory with their own values and complete scoped address", () => {
  const base = context();
  const originals = [
    [
      "s5",
      "/dates/offerValidityNotes/it",
      "Offerta vincolante per sei mesi; eventuale prolungamento da concordare.",
    ],
    [
      "s6",
      "/dates/specificDeadlinesAndFormalRequirements/it",
      "Offerta completa e tempestiva, in busta chiusa con dicitura CONCORSO INVENTATO.",
    ],
    ["s7", "/dates/documentsAvailable/start", "2030-01-02"],
    ["s8", "/dates/documentsAvailable/end", "2030-01-31"],
    ["s9", "/project-info/documentsSourceAddress/name", "Ufficio inventato"],
    ["s10", "/project-info/documentsSourceAddress/street", "Via inventata 1"],
    ["s11", "/project-info/documentsSourceAddress/city", "Comune inventato"],
    ["s12", "/project-info/documentsSourceAddress/countryId", "CH"],
    ["s13", "/project-info/offerAddress/street", "Recapito offerte distinto"],
    [
      "s14",
      "/project-info/offerSpecificNote/it",
      "Inviare due esemplari firmati.",
    ],
  ] as const;
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
        {
          scope: "project_context",
          rawPath: "/project-info/documentsSourceAddress/postalCode",
          value: 9999,
        },
      ],
    },
  };
  const before = JSON.stringify(input);
  const request = buildSourceInterpretationRequest(input);
  assert.deepEqual(request.requiredContractClauseIds, [
    "s5",
    "s6",
    "s7",
    "s8",
    "s9",
    "s10",
    "s11",
    "s12",
    "s14",
    "f0",
    "f2",
  ]);
  assert(!request.citableFieldIds.includes("f1"));
  const addressRefs = ["s9", "s10", "s11", "s12", "f2"];
  const supplied = {
    ...response(input),
    details: [
      ...originals
        .filter(([id]) => !addressRefs.includes(id) && id !== "s13")
        .map(([id, , text]) => ({
          kind: "execution_condition" as const,
          scope: "project_context" as const,
          sourceRefs: [id],
          explanation: text,
        })),
      {
        kind: "execution_condition",
        scope: "project_context",
        sourceRefs: ["f0"],
        explanation: "Il campo numerico dichiara 180 giorni di validità.",
      },
      {
        kind: "execution_condition",
        scope: "project_context",
        sourceRefs: addressRefs,
        explanation:
          "Documenti presso Ufficio inventato, Via inventata 1, 9999 Comune inventato, CH.",
      },
    ],
  };
  const wire: any = wireResponse(supplied, request);
  const accepts = new Ajv2020({ strict: false }).compile<any>(
    request.responseFormat.json_schema.schema,
  );
  assert(accepts(wire));
  const stored = recordSourceInterpretation(wire, request, metadata);
  assert.equal(stored.response.details.length, 7);
  assert.deepEqual(
    stored.response.details.find((d) => d.sourceRefs.includes("s9"))
      ?.sourceRefs,
    addressRefs,
  );
  for (const id of request.requiredContractClauseIds) {
    const missing = structuredClone(wire);
    delete missing.contractClauseDetailIndexes[id];
    assert(!accepts(missing));
    assert.throws(
      () => recordSourceInterpretation(missing, request, metadata),
      /Incomplete|Invalid/,
    );
  }
  for (const ref of ["s13", "s5"]) {
    const unrelated = structuredClone(wire);
    unrelated.details[
      unrelated.contractClauseDetailIndexes.s9[0]
    ].sourceRefs.push(ref);
    assert(!accepts(unrelated));
    assert.throws(
      () => recordSourceInterpretation(unrelated, request, metadata),
      /own scoped source/,
    );
  }
  const withoutOwnValue = structuredClone(wire);
  withoutOwnValue.details[
    withoutOwnValue.contractClauseDetailIndexes.f0[0]
  ].sourceRefs = ["s5"];
  assert.throws(
    () => recordSourceInterpretation(withoutOwnValue, request, metadata),
    /own scoped source/,
  );
  assert.equal(JSON.stringify(input), before);
});

test("Provider contract rejects grouping independent validity values, flags and formal fields while accepting same-field translations", () => {
  const base = context();
  const originalClauses = [
    ["s5", "/dates/offerValidityDeadlineType", "days_after"],
    ["s6", "/dates/offerValidityNotes/it", "Offerte vincolanti per sei mesi."],
    ["s7", "/procurement/options", "no"],
    ["s8", "/procurement/variants", "no"],
    [
      "s9",
      "/dates/specificDeadlinesAndFormalRequirements/it",
      "Busta chiusa, dicitura CONCORSO INVENTATO.",
    ],
    [
      "s10",
      "/dates/specificDeadlinesAndFormalRequirements/fr",
      "Enveloppe fermée, mention CONCORSO INVENTATO.",
    ],
    ["s11", "/project-info/offerSpecificNote/it", "Due copie firmate."],
  ] as const;
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      fields: [
        {
          scope: "project_context",
          rawPath: "/dates/offerValidityDeadlineDays",
          value: 180,
        },
      ],
      passages: [
        ...base.body.passages,
        ...originalClauses.map(([id, rawPath, text]) => ({
          ...base.body.passages[0],
          id,
          rawPath,
          text,
          endUtf16: text.length,
          role: "context" as const,
        })),
      ],
    },
  };
  const before = JSON.stringify(input);
  const request = buildSourceInterpretationRequest(input);
  const wire = wireResponse(
    {
      ...response(input),
      details: [
        ...originalClauses
          .filter(([id]) => id !== "s10")
          .map(([id, , text]) => ({
            kind: "execution_condition" as const,
            scope: "project_context" as const,
            explanation: text,
            sourceRefs: id === "s9" ? ["s9", "s10"] : [id],
          })),
        {
          kind: "execution_condition",
          scope: "project_context",
          explanation: "Valore originale: 180 giorni.",
          sourceRefs: ["f0"],
        },
      ],
    },
    request,
  );
  const accepts = new Ajv2020({ strict: false }).compile(
    request.responseFormat.json_schema.schema,
  );
  assert(accepts(wire));
  recordSourceInterpretation(wire, request, metadata);
  for (const [own, foreign] of [
    ["s5", "f0"],
    ["s5", "s6"],
    ["s7", "s8"],
    ["s9", "s11"],
  ]) {
    const mixed: any = structuredClone(wire);
    mixed.details[mixed.contractClauseDetailIndexes[own][0]].sourceRefs.push(
      foreign,
    );
    assert(!accepts(mixed));
    assert.throws(
      () => recordSourceInterpretation(mixed, request, metadata),
      /own scoped source/,
    );
  }
  assert.deepEqual(
    JSON.parse(request.prompt).contractDetailFamilies.find(
      (family: any) =>
        family.rawPath === "/dates/specificDeadlinesAndFormalRequirements",
    ).sourceRefs,
    ["s9", "s10"],
  );
  assert.equal(JSON.stringify(input), before);
});

test("A singleton contract field cannot request duplicate references and byte-identical mapped details are stored once", () => {
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
          role: "context",
          rawPath: "/procurement/options",
          text: "no",
          endUtf16: 2,
        },
      ],
    },
  };
  const request = buildSourceInterpretationRequest(input);
  const value = {
    ...response(input),
    details: [
      {
        kind: "execution_condition",
        explanation: "Non sono previste opzioni.",
        sourceRefs: ["s5"],
        scope: "project_context",
      },
    ],
  };
  const wire = wireResponse(value, request);
  const accepts = new Ajv2020({ strict: false }).compile(
    request.responseFormat.json_schema.schema,
  );
  const duplicatedRefs = structuredClone(wire);
  duplicatedRefs.details[
    duplicatedRefs.contractClauseDetailIndexes.s5[0]
  ].sourceRefs = ["s5", "s5"];
  assert.throws(
    () => recordSourceInterpretation(duplicatedRefs, request, metadata),
    /Repeated/,
  );
  wire.details.push(
    structuredClone(wire.details[wire.contractClauseDetailIndexes.s5[0]]),
  );
  const before = JSON.stringify(wire);
  const recorded = recordSourceInterpretation(wire, request, metadata);
  assert.equal(recorded.response.details.length, 1);
  assert.deepEqual(recorded.response.details[0].sourceRefs, ["s5"]);
  assert.equal(JSON.stringify(wire), before);
  // Different wording is not merged or judged equivalent automatically.
  const different = structuredClone(wire);
  different.details[0].explanation = "Il campo originale options contiene no.";
  assert.equal(
    recordSourceInterpretation(different, request, metadata).response.details
      .length,
    2,
  );
});

test("A flat provider clause map cannot expand the unchanged 32-detail bound or borrow an indexed row", () => {
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
          role: "context",
          rawPath: "/procurement/options",
          text: "no",
          endUtf16: 2,
        },
      ],
    },
  };
  const request = buildSourceInterpretationRequest(input);
  const wire: any = wireResponse(
    {
      ...response(input),
      details: [
        {
          kind: "execution_condition",
          scope: "project_context",
          sourceRefs: ["s5"],
          explanation: "Nessuna opzione.",
        },
      ],
    },
    request,
  );
  const accepts = new Ajv2020({ strict: false }).compile<any>(
    request.responseFormat.json_schema.schema,
  );
  assert(accepts(wire));
  assert.deepEqual(wire.contractClauseDetailIndexes, { s5: [0] });
  const before = JSON.stringify(wire);
  for (const indexes of [[31], [0, 0]]) {
    const invalid = structuredClone(wire);
    invalid.contractClauseDetailIndexes.s5 = indexes;
    assert.throws(
      () => recordSourceInterpretation(invalid, request, metadata),
      /index|own scoped source/,
    );
  }
  const outOfBounds = structuredClone(wire);
  outOfBounds.contractClauseDetailIndexes.s5 = [32];
  assert(!accepts(outOfBounds));
  const overflow = structuredClone(wire);
  overflow.details = Array.from({ length: 33 }, (_, i) => ({
    ...wire.details[0],
    explanation: `Condizione inventata ${i}.`,
  }));
  assert(!accepts(overflow));
  assert.throws(() => recordSourceInterpretation(overflow, request, metadata));
  const historical = {
    ...structuredClone(wire),
    evidenceFormat: "component_quotations_v5",
  };
  assert(!accepts(historical));
  assert.throws(() =>
    recordSourceInterpretation(historical, request, metadata),
  );
  assert.equal(JSON.stringify(wire), before);
});

test("Present options, organisational limits, territory and document access cannot disappear behind null notes", () => {
  const base = context();
  const originals = [
    ["s5", "/procurement/options", "no"],
    ["s6", "/terms/consortiumAllowed", "yes"],
    [
      "s7",
      "/terms/consortiumNote/it",
      "Al massimo tre membri; ciascuno partecipa a un solo consorzio. Responsabilità solidale e illimitata.",
    ],
    ["s8", "/terms/subContractorMultiApplicationAllowed", "no"],
    ["s9", "/procurement/orderAddress/city/it", "Comune inventato"],
    [
      "s10",
      "/project-info/documentsSourceNote/it",
      "Richiedere la documentazione via email all'ufficio del committente.",
    ],
    [
      "s11",
      "/terms/walkThroughNotes/it",
      "Visita facoltativa su appuntamento.",
    ],
  ] as const;
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      fields: [
        {
          scope: "project_context",
          rawPath: "/procurement/optionsNote/it",
          value: null,
        },
        {
          scope: "project_context",
          rawPath: "/terms/consortiumMultiApplicationAllowed",
          value: false,
        },
        {
          scope: "project_context",
          rawPath: "/procurement/variants",
          value: false,
        },
      ],
      passages: [
        ...base.body.passages,
        ...originals.map(([id, rawPath, text]) => ({
          id,
          rawPath,
          text,
          scope: "project_context" as const,
          role: "context" as const,
          startUtf16: 0,
          endUtf16: text.length,
          url: "https://example.invalid/source",
        })),
      ],
    },
  };
  const before = JSON.stringify(input);
  const request = buildSourceInterpretationRequest(input);
  assert.deepEqual(request.requiredContractClauseIds, [
    ...originals.map(([id]) => id),
    "f1",
    "f2",
  ]);
  assert.equal(request.citableFieldIds.includes("f0"), false);
  const supplied = {
    ...response(input),
    details: [
      ...originals.map(([id, , text]) => ({
        kind: "execution_condition" as const,
        explanation: text,
        sourceRefs: [id],
        scope: "project_context" as const,
      })),
      {
        kind: "execution_condition" as const,
        explanation: "Partecipazione a più consorzi non consentita.",
        sourceRefs: ["f1"],
        scope: "project_context" as const,
      },
      {
        kind: "execution_condition" as const,
        explanation: "Varianti non consentite.",
        sourceRefs: ["f2"],
        scope: "project_context" as const,
      },
    ],
  };
  const wire = wireResponse(supplied, request);
  const record = recordSourceInterpretation(wire, request, metadata);
  assert.equal(record.response.details.length, 9);
  for (const id of request.requiredContractClauseIds) {
    const missing = structuredClone(wire);
    delete missing.contractClauseDetailIndexes[id];
    assert.throws(
      () => recordSourceInterpretation(missing, request, metadata),
      /Incomplete|Required|Invalid/,
    );
  }
  const wrongScope = structuredClone(wire);
  wrongScope.details[wrongScope.contractClauseDetailIndexes.s5[0]].scope =
    "selected_lot";
  assert.throws(
    () => recordSourceInterpretation(wrongScope, request, metadata),
    /scope|Invalid/,
  );
  assert.equal(JSON.stringify(input), before);
  // Coverage is mechanical; it does not decide the meaning of the supplied
  // explanations, create extra purchased services or qualify a company.
  assert.equal(record.response.components.length, supplied.components.length);
});

test("A shared translated note keeps every own reference and is stored once without merging flags or scopes", () => {
  const base = context();
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        ...[
          ["s5", "/terms/consortiumNote/it", "Al massimo tre membri."],
          ["s6", "/terms/consortiumNote/fr", "Au maximum trois membres."],
          ["s7", "/terms/consortiumAllowed", "yes"],
        ].map(([id, rawPath, text]) => ({
          id,
          rawPath,
          text,
          role: "context" as const,
          scope: "project_context" as const,
          startUtf16: 0,
          endUtf16: text.length,
          url: "https://example.invalid/source",
        })),
      ],
    },
  };
  const original = JSON.stringify(input);
  const request = buildSourceInterpretationRequest(input);
  const value = {
    ...response(input),
    details: [
      {
        kind: "execution_condition",
        explanation: "Le due note limitano il consorzio a tre membri.",
        sourceRefs: ["s5", "s6"],
        scope: "project_context",
      },
      {
        kind: "execution_condition",
        explanation: "I consorzi sono ammessi.",
        sourceRefs: ["s7"],
        scope: "project_context",
      },
    ],
  };
  const wire = wireResponse(value, request);
  const before = JSON.stringify(wire);
  const record = recordSourceInterpretation(wire, request, metadata);
  assert.deepEqual(record.response.details, value.details);
  assert.deepEqual(record.response.details[0].sourceRefs, ["s5", "s6"]);
  assert.equal(JSON.stringify(wire), before);
  assert.equal(JSON.stringify(input), original);
  const ajv = new Ajv2020({ strict: false }).compile(
    request.responseFormat.json_schema.schema,
  );
  assert(ajv(wire));
  for (const edit of [
    (v: any) => {
      v.details[v.contractClauseDetailIndexes.s5[0]].sourceRefs = ["s6"];
    },
    (v: any) => {
      v.details[v.contractClauseDetailIndexes.s5[0]].sourceRefs.push("s7");
    },
    (v: any) => {
      v.details[v.contractClauseDetailIndexes.s5[0]].sourceRefs.push("s1");
    },
    (v: any) => {
      v.details[v.contractClauseDetailIndexes.s5[0]].scope = "selected_lot";
    },
  ]) {
    const invalid = structuredClone(wire);
    edit(invalid);
    assert.throws(
      () => recordSourceInterpretation(invalid, request, metadata),
      /Contract clause|scope|Invalid/,
    );
  }
});

test("A project-only provider contract cannot invent a selected-lot role scope", () => {
  const input = context();
  const request = buildSourceInterpretationRequest(input);
  const wire: any = wireResponse(response(input), request);
  const validate = new Ajv2020({ strict: false }).compile<any>(
    request.responseFormat.json_schema.schema,
  );
  assert(validate(wire));
  const invalid = structuredClone(wire);
  invalid.components[0].roleEvidence.scope = "selected_lot";
  assert.equal(validate(invalid), false);
  assert.throws(
    () => recordSourceInterpretation(invalid, request, metadata),
    /Role action|scope/,
  );
  assert.equal(wire.components[0].roleEvidence.scope, "project_context");
});

test("Source identity focus preserves original titles, descriptions and split spans without resolving differences", () => {
  const base = context();
  const additions = [
    {
      id: "s5",
      rawPath: "/base/title/de",
      role: "service",
      text: "Fiktive Lieferung 2028–2030 🌳",
    },
    {
      id: "s6",
      rawPath: "/base/title/fr",
      role: "service",
      text: "Livraison inventée 2028–2029",
    },
    {
      id: "s7",
      rawPath: "/project-info/title/it",
      role: "service",
      text: "Fornitura inventata 2028–2030",
    },
    {
      id: "s8",
      rawPath: "/procurement/orderDescription/fr",
      role: "service",
      text: "Livraison inventée pour ",
    },
    {
      id: "s9",
      rawPath: "/procurement/orderDescription/fr",
      role: "service",
      text: "le site A.",
    },
    {
      id: "s10",
      rawPath: "/metadata/title/it",
      role: "context",
      text: "Metadato non descrittivo",
    },
    {
      id: "s11",
      rawPath: "/terms/remediesNotice/it",
      role: "context",
      text: "Informazione procedurale",
    },
  ] as const;
  const input = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        ...additions.map((p) => ({
          ...p,
          scope: "project_context" as const,
          startUtf16: p.id === "s9" ? additions[3].text.length : 0,
          endUtf16:
            (p.id === "s9" ? additions[3].text.length : 0) + p.text.length,
          url: "https://example.invalid/source",
        })),
      ],
    },
  };
  const before = JSON.stringify(input);
  const request = buildSourceInterpretationRequest(input);
  const prompt = JSON.parse(request.prompt);
  const originals = ["s1", "s5", "s6", "s7", "s8", "s9"];
  assert.deepEqual(prompt.sourceIdentityAssertions, originals);
  assert.deepEqual(
    prompt.passages,
    input.body.passages.map(({ url: _url, ...p }) => p),
  );
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(request.body, input.body);
  assert.deepEqual(request.binding, input.binding);
  // This verifies original context transmission, not a model verdict or
  // an automatic inference that a translated title is inconsistent.
  assert.equal("detectedConflict" in prompt, false);
  assert.equal("preferredLanguage" in prompt, false);
});

test("Source identity focus is absent without original service titles or descriptions", () => {
  const base = context();
  const input = {
    ...base,
    body: {
      ...base.body,
      passages: base.body.passages.map((p, i) =>
        i === 0 ? { ...p, rawPath: "/terms/serviceNote/it" } : p,
      ),
    },
  };
  const request = buildSourceInterpretationRequest(input);
  const prompt = JSON.parse(request.prompt);
  assert.equal("sourceIdentityAssertions" in prompt, false);
  assert.deepEqual(
    prompt.passages,
    input.body.passages.map(({ url: _url, ...p }) => p),
  );
  assert.equal(request.version, SOURCE_INTERPRETATION_VERSION);
});

test("Component evidence keeps its explicitly selected territory and period without inheriting summary references", () => {
  const base = context();
  const additions = [
    {
      id: "s5",
      rawPath: "/procurement/orderAddressDescription/it",
      text: "Comprensorio inventato di Valle A",
    },
    {
      id: "s6",
      rawPath: "/procurement/contractPeriod/dateRange/0",
      text: "2030-01-01",
    },
  ];
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        ...additions.map((p) => ({
          ...p,
          scope: "project_context" as const,
          role: "context" as const,
          startUtf16: 0,
          endUtf16: p.text.length,
          url: "https://example.invalid/source",
        })),
      ],
    },
  };
  const before = JSON.stringify(input);
  const request = buildSourceInterpretationRequest(input);
  const answer = response(input);
  answer.details = [
    {
      kind: "execution_condition",
      explanation: additions[0].text,
      sourceRefs: ["s5"],
      scope: "project_context",
    },
  ] as any;
  const result = validateSourceInterpretation(
    {
      ...answer,
      summary:
        "Fornitura inventata a Valle A dal 2030, posa accessoria e trasporto escluso.",
      summarySourceRefs: ["s1", "s4", "s5", "s6"],
      components: [
        {
          ...answer.components[0],
          description: "Fornitura inventata a Valle A dal 2030",
          sourceRefs: ["s1", "s3", "s5", "s6"],
        },
        ...answer.components.slice(1),
      ],
    },
    request,
  );
  assert.deepEqual(result.components[0].sourceRefs, ["s1", "s3", "s5", "s6"]);
  assert(
    result.components
      .slice(1)
      .every(
        (c) => !c.sourceRefs.includes("s5") && !c.sourceRefs.includes("s6"),
      ),
  );
  assert.deepEqual(result.summarySourceRefs, ["s1", "s4", "s5", "s6"]);
  assert.equal(JSON.stringify(input), before);
  // Relational transmission is tested here. These assertions do not certify
  // semantic support; the independent original-evidence review must do that.
});

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
      maxTokens: SOURCE_INTERPRETATION_MAX_TOKENS,
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
function meaning(
  statement: string,
  objectRefs: string[],
  input: SourceInterpretationContext = context(),
) {
  return {
    state: "identified" as const,
    statement,
    objectText: [
      ...(input.body.passages.find((p) => p.id === objectRefs[0])?.text ??
        statement),
    ]
      .slice(0, 100)
      .join(""),
    basis: "explicit_text" as const,
    objectRefs,
    classificationContextIds: [] as string[],
  };
}
function roleEvidence(input: SourceInterpretationContext, id: string) {
  const passage = input.body.passages.find((item) => item.id === id)!;
  return {
    state: "identified" as const,
    actionText: [...passage.text].slice(0, 100).join(""),
    sourceRefs: [id],
    scope: passage.scope,
  };
}
function issueFields(
  kind:
    | "object_identity"
    | "role_identity"
    | "target_scope"
    | "source_conflict"
    | "unreadable_source"
    | "representation_incomplete",
  componentIndexes: number[] = [],
) {
  return { kind, scope: "project_context" as const, componentIndexes };
}
function response(input = context()) {
  return {
    status: "resolved" as const,
    summary:
      "Fornitura di prodotti inventati con posa accessoria, senza trasporto.",
    summarySourceRefs: [
      input.body.passages.find(
        (p) => p.scope === input.targetScope && p.role === "service",
      )!.id,
      "s4",
    ],
    details: [],
    classificationReadings: input.body.classifications.map((item, index) => ({
      classificationId: `c${index + 1}`,
      use:
        item.appliesTo === "target"
          ? ("broad_context" as const)
          : ("shared_project_only" as const),
      explanation:
        "Contesto classificatorio distinto dalla prestazione concreta.",
      sourceRefs: [
        ...(item.code?.sourceRefs ?? []),
        ...item.labels.flatMap((label) => label.sourceRefs),
      ],
    })),
    components: [
      {
        description: "Prodotti inventati",
        role: "supply" as const,
        roleEvidence: roleEvidence(input, "s1"),
        importance: "main" as const,
        sourceRefs: ["s1", "s3"],
        meaning: meaning(
          "Prodotti inventati esplicitamente descritti",
          ["s1"],
          input,
        ),
      },
      {
        description: "Posa",
        role: "install" as const,
        roleEvidence: roleEvidence(input, "s4"),
        importance: "accessory" as const,
        sourceRefs: ["s4"],
        meaning: meaning("Posa accessoria", ["s4"], input),
      },
      {
        description: "Trasporto",
        role: "execute" as const,
        roleEvidence: roleEvidence(input, "s4"),
        importance: "excluded" as const,
        sourceRefs: ["s4"],
        meaning: meaning("Trasporto escluso", ["s4"], input),
      },
    ],
    issues: [],
    targetRef: "s1",
  };
}

test("A summary keeps its own date evidence and rejects missing, foreign or classification-only citations", () => {
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
  const request = buildSourceInterpretationRequest(input);
  const answer = {
    ...response(input),
    summary: "Fornitura di prodotti inventati dal 1 gennaio 2030.",
    summarySourceRefs: ["s1", "s5"],
  };
  const value = validateSourceInterpretation(answer, request);
  assert.deepEqual(value.summarySourceRefs, ["s1", "s5"]);
  assert.equal(value.evidence.find((p) => p.id === "s5")!.text, date);
  assert(value.components.every((c) => !c.sourceRefs.includes("s5")));
  const { summarySourceRefs: _refs, ...missing } = answer;
  assert.throws(() => validateSourceInterpretation(missing, request));
  for (const refs of [[], ["s3"], ["s4"], ["s1", "s999"], ["s1", "f0"]])
    assert.throws(() =>
      validateSourceInterpretation(
        { ...answer, summarySourceRefs: refs },
        request,
      ),
    );
});

test("An explicit purchase with unstated hierarchy remains resolved without inventing a main or accessory role", () => {
  const request = buildSourceInterpretationRequest(context());
  const answer = response();
  const result = validateSourceInterpretation(
    {
      ...answer,
      components: [{ ...answer.components[0], importance: "not_stated" }],
    },
    request,
  );
  assert.equal(result.status, "resolved");
  assert.equal(result.components[0].importance, "not_stated");
  assert.deepEqual(result.issues, []);
  for (const importance of ["accessory", "excluded"])
    assert.throws(() =>
      validateSourceInterpretation(
        { ...answer, components: [{ ...answer.components[0], importance }] },
        request,
      ),
    );
});

test("A renewal note cannot hide the opposing original extension flag", () => {
  const base = context();
  const notes = [
    ["/procurement/executionNote/it", "Il contratto è rinnovabile di un anno."],
    ["/procurement/canContractBeExtended", "no"],
  ];
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        ...notes.map(([rawPath, text], index) => ({
          ...base.body.passages[3],
          id: `s${index + 5}`,
          rawPath,
          text,
          endUtf16: text.length,
        })),
      ],
    },
  };
  const request = buildSourceInterpretationRequest(input);
  assert.deepEqual(request.requiredContractClauseIds, ["s5", "s6"]);
  const incomplete = {
    ...response(input),
    details: [
      {
        kind: "execution_condition",
        scope: "project_context",
        explanation: "Il contratto è rinnovabile di un anno.",
        sourceRefs: ["s5"],
      },
    ],
  };
  assert.throws(
    () => validateSourceInterpretation(incomplete, request),
    /Incomplete.*contract clauses/,
  );
  const conflict = validateSourceInterpretation(
    {
      ...incomplete,
      status: "conflicting",
      issues: [
        {
          ...issueFields("source_conflict"),
          explanation:
            "La nota prevede rinnovo, il campo originale lo esclude; nessuna precedenza indicata.",
          sourceRefs: ["s5", "s6"],
        },
      ],
    },
    request,
  );
  assert.equal(conflict.status, "conflicting");
  assert.deepEqual(conflict.issues[0].sourceRefs, ["s5", "s6"]);
  assert.equal(conflict.evidence.find((p) => p.id === "s6")!.text, "no");
});

test.each([false, true, null])(
  "Extension value %s is kept beside its note without treating null as prohibition",
  (value) => {
    const base = context();
    const input: SourceInterpretationContext = {
      ...base,
      body: {
        ...base.body,
        fields: [
          {
            scope: "project_context",
            rawPath: "/procurement/canContractBeExtended",
            value,
          },
        ],
        passages: [
          ...base.body.passages,
          {
            ...base.body.passages[3],
            id: "s5",
            rawPath: "/procurement/canContractBeExtendedNote/it",
            text: "Condizioni della proroga da verificare nel dossier.",
            endUtf16: "Condizioni della proroga da verificare nel dossier."
              .length,
          },
        ],
      },
    };
    const request = buildSourceInterpretationRequest(input);
    assert.deepEqual(
      request.requiredContractClauseIds,
      value === null ? ["s5"] : ["s5", "f0"],
    );
    const prompt = JSON.parse(request.prompt);
    assert.equal(prompt.fields[0].value, value);
    assert.equal(prompt.fields[0].id, value === null ? undefined : "f0");
    const noteOnly = {
      ...response(input),
      details: [
        {
          kind: "missing_specification",
          scope: "project_context",
          explanation: "Condizioni della proroga nel dossier non fornito.",
          sourceRefs: ["s5"],
        },
      ],
    };
    if (value === null)
      assert.equal(
        validateSourceInterpretation(noteOnly, request).status,
        "resolved",
      );
    else
      assert.throws(
        () => validateSourceInterpretation(noteOnly, request),
        /Incomplete.*contract clauses/,
      );
  },
);

test("A resolved draft cannot omit a structured subcontracting prohibition", () => {
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
          role: "context",
          rawPath: "/terms/subContractorAllowed",
          text: "no",
          startUtf16: 0,
          endUtf16: 2,
        },
      ],
    },
  };
  const request = buildSourceInterpretationRequest(input);
  assert.deepEqual(request.requiredContractClauseIds, ["s5"]);
  assert.throws(
    () => validateSourceInterpretation(response(input), request),
    /Incomplete.*contract clauses/,
  );
  const complete = {
    ...response(input),
    details: [
      {
        kind: "execution_condition",
        scope: "project_context",
        sourceRefs: ["s5"],
        explanation: "Il subappalto non è consentito.",
      },
    ],
  };
  assert.equal(
    validateSourceInterpretation(complete, request).details.length,
    1,
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        {
          ...complete,
          details: [
            {
              ...complete.details[0],
              scope: "selected_lot",
            },
          ],
        },
        request,
      ),
    /Detail scope/,
  );
  // A clause cited only as component evidence does not document its condition.
  const incidental = response(input);
  incidental.components[0].sourceRefs.push("s5");
  assert.throws(
    () => validateSourceInterpretation(incidental, request),
    /Incomplete.*contract clauses/,
  );
});

test("Known technical details retain evidence, scope and bounded explanations", () => {
  const input = context();
  const request = buildSourceInterpretationRequest(input);
  const draft = {
    ...response(input),
    details: [
      {
        kind: "technical_specification",
        explanation: "I prodotti indicati sono oggetto della fornitura.",
        sourceRefs: ["s1"],
        scope: "project_context",
      },
    ],
  };
  assert.equal(
    validateSourceInterpretation(draft, request).details[0].kind,
    "technical_specification",
  );
  for (const invalid of [
    { ...draft.details[0], sourceRefs: ["s999"] },
    { ...draft.details[0], scope: "selected_lot" },
    { ...draft.details[0], explanation: "x".repeat(601) },
  ]) {
    assert.throws(() =>
      validateSourceInterpretation({ ...draft, details: [invalid] }, request),
    );
  }
  assert.deepEqual(request.body.passages, input.body.passages);
});

test("Standalone extension and delegation flags must be explained in details", () => {
  const base = context();
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        ...[
          ["s5", "/procurement/canContractBeExtended"],
          ["s6", "/terms/subContractorAllowed"],
        ].map(([id, rawPath]) => ({
          ...base.body.passages[0],
          id,
          rawPath,
          role: "context" as const,
          text: "yes",
          startUtf16: 0,
          endUtf16: 3,
        })),
      ],
    },
  };
  const request = buildSourceInterpretationRequest(input);
  const prompt = JSON.parse(request.prompt);
  assert.deepEqual(prompt.requiredContractClauseIds, ["s5", "s6"]);
  assert.match(prompt.rules.join(" "), /canContractBeExtended yes\/true/);
  assert.match(prompt.rules.join(" "), /senza inventare durata/);
  assert.equal(prompt.requiredContractClauses[0].text, "yes");
  const omitted = response(input);
  omitted.summarySourceRefs.push("s5", "s6");
  assert.throws(
    () => validateSourceInterpretation(omitted, request),
    /Incomplete.*contract clauses/,
  );
  const complete = {
    ...omitted,
    details: [
      {
        kind: "execution_condition",
        scope: "project_context",
        sourceRefs: ["s5"],
        explanation: "La proroga del contratto è consentita.",
      },
      {
        kind: "execution_condition",
        scope: "project_context",
        sourceRefs: ["s6"],
        explanation: "Il subappalto è consentito.",
      },
    ],
  };
  assert.equal(
    validateSourceInterpretation(complete, request).status,
    "resolved",
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        { ...complete, details: complete.details.slice(1) },
        request,
      ),
    /Incomplete.*contract clauses/,
  );
});

test.each([false, true, 0, null])(
  "Structured contract value %s keeps its exact JSON identity",
  (value) => {
    const base = context();
    const input: SourceInterpretationContext = {
      ...base,
      body: {
        ...base.body,
        fields: [
          {
            scope: "project_context",
            rawPath: "/terms/subContractorAllowed",
            value,
          },
        ],
      },
    };
    const request = buildSourceInterpretationRequest(input);
    const prompt = JSON.parse(request.prompt);
    assert.equal(prompt.fields[0].value, value);
    assert.equal(prompt.fields[0].id, value === null ? undefined : "f0");
    assert.deepEqual(request.citableFieldIds, value === null ? [] : ["f0"]);
    assert.deepEqual(
      request.requiredContractClauseIds,
      value === null ? [] : ["f0"],
    );
    if (value === null) {
      assert.equal(
        validateSourceInterpretation(response(input), request).status,
        "resolved",
      );
      return;
    }
    assert.equal(prompt.requiredContractClauses[0].value, value);
    assert.throws(
      () => validateSourceInterpretation(response(input), request),
      /Incomplete.*contract clauses/,
    );
    const complete = {
      ...response(input),
      details: [
        {
          kind: value === 0 ? "missing_specification" : "execution_condition",
          scope: "project_context",
          sourceRefs: ["f0"],
          explanation:
            value === false
              ? "Il subappalto non è consentito."
              : value === true
                ? "Il subappalto è consentito."
                : "Valore originale 0: significato non precisato, da verificare.",
        },
      ],
    };
    assert(
      new Ajv2020({ strict: false }).compile(
        request.responseFormat.json_schema.schema,
      )(wireResponse(complete, request)),
    );
    const recorded = recordSourceInterpretation(
      wireResponse(complete, request),
      request,
      {
        id: "invented-contract-field",
        at: "2030-01-01T12:00:00.000Z",
        model: input.binding.model,
      },
    );
    const resolved = readSourceInterpretation(recorded, request)!;
    assert.equal(
      resolved.evidence.find((p) => p.id === "f0")?.text,
      JSON.stringify(value),
    );
    assert.throws(() =>
      validateSourceInterpretation(
        {
          ...complete,
          details: [
            {
              ...complete.details[0],
              sourceRefs: ["f999"],
            },
          ],
        },
        request,
      ),
    );
    const fabricatedComponent = structuredClone(complete);
    fabricatedComponent.components[0].sourceRefs = ["f0"];
    assert.throws(() =>
      validateSourceInterpretation(fabricatedComponent, request),
    );
  },
);

test("A text citation cannot gain an unrelated null field with the same numeric suffix", () => {
  const base = context();
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      fields: Array.from({ length: 6 }, (_, index) => ({
        scope: "project_context" as const,
        rawPath:
          index === 0
            ? "/procurement/quantity"
            : `/project-info/address/${index}`,
        value: index === 0 ? 0 : null,
      })),
      passages: [
        ...base.body.passages,
        {
          ...base.body.passages[0],
          id: "s5",
          role: "context",
          rawPath: "/terms/subContractorAllowed",
          text: "no",
          startUtf16: 0,
          endUtf16: 2,
        },
      ],
    },
  };
  const request = buildSourceInterpretationRequest(input);
  const prompt = JSON.parse(request.prompt);
  assert.deepEqual(request.citableFieldIds, ["f0"]);
  assert.equal(prompt.fields[0].id, "f0");
  assert.equal(prompt.fields[0].value, 0);
  assert.equal(prompt.fields[5].value, null);
  assert.equal("id" in prompt.fields[5], false);
  const valid = {
    ...response(input),
    details: [
      {
        kind: "execution_condition",
        scope: "project_context",
        sourceRefs: ["s5"],
        explanation: "Il subappalto è vietato.",
      },
    ],
  };
  const validateWire = new Ajv2020({ strict: false }).compile(
    request.responseFormat.json_schema.schema,
  );
  assert(validateWire(wireResponse(valid, request)));
  const invalid = {
    ...valid,
    details: [{ ...valid.details[0], sourceRefs: ["s5", "f5"] }],
  };
  const before = JSON.stringify(invalid);
  assert(!validateWire(wireResponse(invalid, request)));
  assert.throws(
    () =>
      recordSourceInterpretation(
        wireResponse(invalid, request),
        request,
        metadata,
      ),
    /own scoped source/,
  );
  assert.equal(JSON.stringify(invalid), before);
  assert.equal(
    readSourceInterpretation(
      recordSourceInterpretation(
        wireResponse(valid, request),
        request,
        metadata,
      ),
      request,
    )?.status,
    "resolved",
  );
});

test("Contract note languages all remain required, unrelated fields do not", () => {
  const base = context();
  const clauses = [
    ["/terms/subContractorNote/it", "Subappalto con limite del 30%."],
    ["/terms/subContractorNote/de", "Untervergabe maximal 30%."],
    ["/procurement/optionsNote/it", "Opzione: manutenzione annuale."],
    ["/procurement/executionNote/it", "Esecuzione durante la chiusura."],
    ["/metadata/subContractorAllowed", "no"],
  ];
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        ...clauses.map(([rawPath, text], index) => ({
          ...base.body.passages[0],
          id: `s${index + 5}`,
          role: "context" as const,
          rawPath,
          text,
          startUtf16: 0,
          endUtf16: text.length,
        })),
      ],
    },
  };
  const request = buildSourceInterpretationRequest(input);
  assert.deepEqual(request.requiredContractClauseIds, ["s5", "s6", "s7", "s8"]);
  const complete = {
    ...response(input),
    details: clauses.slice(0, 4).map(([, text], index) => ({
      kind: "execution_condition",
      scope: "project_context",
      sourceRefs: [`s${index + 5}`],
      explanation: text,
    })),
  };
  assert.equal(
    validateSourceInterpretation(complete, request).status,
    "resolved",
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        { ...complete, details: complete.details.slice(0, 3) },
        request,
      ),
    /Incomplete.*contract clauses/,
  );
});

test("A compound subcontracting note is presented as multiple required facts", () => {
  const base = context();
  const note =
    "Subappalto ammesso fino al 70%. I subappaltatori vanno elencati. Le candidature multiple in più offerte sono possibili.";
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
  const prompt = JSON.parse(request.prompt);
  assert.equal(prompt.requiredContractClauses[0].text, note);
  assert.match(
    prompt.rules.join(" "),
    /ogni proposizione autonoma.*candidature multiple in più offerte/,
  );
});

test.each(["\n", "\r\n"])(
  "Independent contract sections survive length fragments and %j boundaries",
  (newline) => {
    const base = context();
    const texts = [
      `Edificio B 🏠${newline}I lavori nell'edificio B sono in opzione.`,
      `Lavoro a turni:${newline}L'installazione è generalmente eseguita in due turni.`,
      `Clima:${newline}Le misure si applicano quando la temperatura supera la soglia indicata.`,
    ];
    const note = texts.join(newline + " \t" + newline);
    // Deliberately split inside the second section: a source chunk boundary
    // must not detach its heading or invent a separate contractual subject.
    const cut = note.indexOf("generalmente") + 4;
    const input: SourceInterpretationContext = {
      ...base,
      body: {
        ...base.body,
        passages: [
          ...base.body.passages,
          ...[note.slice(0, cut), note.slice(cut)].map((text, index) => ({
            ...base.body.passages[0],
            id: `s${index + 5}`,
            role: "context" as const,
            rawPath: "/procurement/executionNote/it",
            text,
            startUtf16: index === 0 ? 0 : cut,
            endUtf16: index === 0 ? cut : note.length,
          })),
        ],
      },
    };
    const request = buildSourceInterpretationRequest(input);
    const prompt = JSON.parse(request.prompt);
    assert.deepEqual(
      prompt.contractClauseBlocks.map((b: any) => b.text),
      texts,
    );
    assert.deepEqual(
      prompt.contractClauseBlocks.map((b: any) => b.sourceRefs),
      [["s5"], ["s5", "s6"], ["s6"]],
    );
    for (const block of prompt.contractClauseBlocks) {
      assert.equal(note.slice(block.startUtf16, block.endUtf16), block.text);
      assert.equal(block.scope, "project_context");
      assert.equal(block.rawPath, "/procurement/executionNote/it");
    }
    assert.equal(
      prompt.requiredContractClauses.map((p: any) => p.text).join(""),
      note,
    );
    assert.match(
      prompt.rules.join(" "),
      /non ereditare ambiti dal blocco precedente/,
    );
    assert.match(prompt.rules.join(" "), /condizione generale resta generale/);
    assert.match(
      prompt.rules.join(" "),
      /separa condizioni autonome nei details/,
    );
    assert.equal(request.version, SOURCE_INTERPRETATION_VERSION);
    const oldKey = createHash("sha256")
      .update(
        stableDocumentaryJson({
          version: "documentary-source-interpretation-v21",
          binding: input.binding,
        }),
      )
      .digest("hex");
    assert.notEqual(request.sourceKey, oldKey);
    assert.deepEqual(
      input.body.passages.slice(-2).map((p) => p.text),
      [note.slice(0, cut), note.slice(cut)],
    );
  },
);
// Test fixtures keep the stored contract; encode their citations explicitly
// when exercising the distinct provider JSON Schema.
function wireResponse(
  value: any,
  request?: ReturnType<typeof buildSourceInterpretationRequest>,
) {
  const required = request?.requiredContractClauseIds ?? [];
  const clauseIndexes = Object.fromEntries(
    required.map((id) => [
      id,
      value.details.flatMap((detail: any, index: number) =>
        detail.sourceRefs.includes(id) ? [index] : [],
      ),
    ]),
  );
  return {
    ...value,
    evidenceFormat: "component_quotations_v6",
    ...(value.status === "resolved" && required.length
      ? {
          contractClauseDetailIndexes: clauseIndexes,
        }
      : {}),
    components: value.components.map(
      ({ sourceRefs, roleEvidence, meaning, ...component }: any) => {
        const { sourceRefs: _roleRefs, ...role } = roleEvidence ?? {};
        const { objectRefs: _objectRefs, ...object } = meaning ?? {};
        return {
          ...component,
          evidence: sourceRefs.map((sourceRef: string) => ({
            sourceRef,
          })),
          roleEvidence: roleEvidence ? role : undefined,
          meaning: meaning ? object : undefined,
        };
      },
    ),
  };
}

test("Partial offers, language authority and purchase reservations require separate original evidence", () => {
  const base = context();
  const conditions = [
    [
      "s5",
      "/procurement/partialOffersNote/it",
      "Solo interi lotti, nessuna frazione del lotto.",
    ],
    [
      "s6",
      "/project-info/documentsLanguagesNote/fr",
      "La version française fait foi en cas de divergences.",
    ],
    [
      "s7",
      "/terms/otherRequirements/fr",
      "Les crédits annuels sont réservés. Les prestations peuvent être destinées à d'autres services fédéraux et les options commandées en tout, en partie ou pas du tout.",
    ],
  ];
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      fields: [
        {
          scope: "project_context",
          rawPath: "/procurement/partialOffers",
          value: true,
        },
      ],
      passages: [
        ...base.body.passages,
        ...conditions.map(([id, rawPath, text]) => ({
          ...base.body.passages[0],
          id,
          rawPath,
          text,
          role: "context" as const,
          endUtf16: text.length,
        })),
      ],
    },
  };
  const before = JSON.stringify(input);
  const request = buildSourceInterpretationRequest(input);
  assert.deepEqual(request.requiredContractClauseIds, ["s5", "s6", "s7", "f0"]);
  const value = {
    ...response(input),
    details: [
      {
        kind: "execution_condition",
        scope: "project_context",
        sourceRefs: ["s5"],
        explanation: "Sono ammesse offerte per interi lotti, non per frazioni.",
      },
      {
        kind: "execution_condition",
        scope: "project_context",
        sourceRefs: ["s6"],
        explanation: "In caso di divergenze fa fede la versione francese.",
      },
      {
        kind: "execution_condition",
        scope: "project_context",
        sourceRefs: ["s7"],
        explanation:
          "Sono riservati i crediti annuali; le prestazioni possono servire altri servizi federali e le opzioni possono essere ordinate interamente, parzialmente o per nulla.",
      },
      {
        kind: "execution_condition",
        scope: "project_context",
        sourceRefs: ["f0"],
        explanation:
          "Il valore positivo resta distinto dal limite descritto nella nota.",
      },
    ],
  };
  const wire = wireResponse(value, request);
  const record = recordSourceInterpretation(wire, request, metadata);
  assert.deepEqual(record.response.details, value.details);
  for (const id of ["s5", "s6", "s7", "f0"]) {
    const missing = structuredClone(wire);
    delete missing.contractClauseDetailIndexes[id];
    assert.throws(() => recordSourceInterpretation(missing, request, metadata));
  }
  assert.equal(JSON.stringify(input), before);
});

test("Resolved wire requires every contractual clause separately with its own scoped original ID", () => {
  const base = context();
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      fields: [
        {
          scope: "project_context",
          rawPath: "/procurement/canContractBeExtended",
          value: false,
        },
      ],
      passages: [
        ...base.body.passages,
        ...[
          ["s5", "/terms/subContractorAllowed", "yes"],
          [
            "s6",
            "/terms/subContractorNote/it",
            "Subappalto massimo 70%, da elencare nell’offerta.",
          ],
        ].map(([id, rawPath, text]) => ({
          ...base.body.passages[0],
          id,
          rawPath,
          text,
          role: "context" as const,
          endUtf16: text.length,
        })),
      ],
    },
  };
  const request = buildSourceInterpretationRequest(input);
  assert.deepEqual(request.requiredContractClauseIds, ["s5", "s6", "f0"]);
  const value = {
    ...response(input),
    details: [
      {
        kind: "execution_condition",
        explanation: "Il ricorso a subappaltatori è consentito.",
        scope: "project_context",
        sourceRefs: ["s5"],
      },
      {
        kind: "execution_condition",
        explanation: "Subappalto massimo 70%, con elenco nell’offerta.",
        scope: "project_context",
        sourceRefs: ["s6"],
      },
      {
        kind: "execution_condition",
        explanation: "La proroga del contratto è vietata.",
        scope: "project_context",
        sourceRefs: ["f0"],
      },
    ],
  };
  const wire = wireResponse(value, request);
  const originalWire = JSON.stringify(wire);
  const accepts = new Ajv2020({ strict: false }).compile(
    request.responseFormat.json_schema.schema,
  );
  assert.equal(accepts(wire), true);
  const record = recordSourceInterpretation(wire, request, metadata);
  assert.deepEqual(record.response.details, value.details);
  assert.equal("contractClauseDetailIndexes" in record.response, false);
  assert.equal(
    readSourceInterpretation(record, request)!.evidence.find(
      (p) => p.id === "f0",
    )!.text,
    "false",
  );
  assert.equal(JSON.stringify(wire), originalWire);
  for (const [index, mutate] of [
    (v: any) => {
      delete v.contractClauseDetailIndexes.s5;
      v.details = value.details;
    },
    (v: any) => {
      v.contractClauseDetailIndexes.s5 = [];
    },
    (v: any) => {
      v.details[v.contractClauseDetailIndexes.s5[0]].sourceRefs = ["s6"];
    },
    (v: any) => {
      v.details[v.contractClauseDetailIndexes.s5[0]].scope = "selected_lot";
    },
    (v: any) => {
      v.contractClauseDetailIndexes.s999 = v.contractClauseDetailIndexes.s5;
    },
  ].entries()) {
    const changed = structuredClone(wire);
    mutate(changed);
    const before = JSON.stringify(changed);
    // Cross-row own evidence is checked locally; missing keys, empty selections and wrong scopes also fail the wire schema.
    assert.equal(accepts(changed), index === 2);
    assert.throws(() => recordSourceInterpretation(changed, request, metadata));
    assert.equal(JSON.stringify(changed), before);
  }
  // The provider map cannot exceed the unchanged aggregate stored limit.
  const overflow = structuredClone(wire);
  overflow.details = Array.from({ length: 30 }, (_, index) => ({
    kind: "technical_specification",
    explanation: `Specifica inventata ${index} per il test del limite.`,
    scope: "project_context",
    sourceRefs: ["s1"],
  }));
  assert.throws(() => recordSourceInterpretation(overflow, request, metadata));
});
const metadata = {
  id: "invented-source-record",
  at: "2030-01-01T12:00:00.000Z",
  model: "invented-model",
};

test("Stored meaning cannot borrow adjacent evidence; new wire quotations locate their own cited span", () => {
  const base = context();
  const first = "Fornitura e posa di pannelli informativi e porte temporanee. ";
  const second = "Riscaldamento e deumidificazione dei locali.";
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        { ...base.body.passages[0], text: first, endUtf16: first.length },
        ...base.body.passages.slice(1),
        {
          ...base.body.passages[0],
          id: "s5",
          text: second,
          startUtf16: first.length,
          endUtf16: first.length + second.length,
        },
      ],
    },
  };
  const request = buildSourceInterpretationRequest(input);
  const value = response(input);
  value.components = [
    {
      ...value.components[0],
      sourceRefs: ["s1", "s5"],
      meaning: {
        ...value.components[0].meaning,
        objectText: "pannelli informativi",
        objectRefs: ["s5"],
      },
    },
  ];
  const wire = wireResponse(value);
  const before = JSON.stringify(wire);
  const accepts = new Ajv2020({ strict: false }).compile(
    request.responseFormat.json_schema.schema,
  );
  assert.equal(accepts(wire), true); // The server checks the actual cited text.
  assert.throws(
    () => recordSourceInterpretation(value, request, metadata),
    /Meaning object must be an exact quotation/,
  );
  assert.deepEqual(
    recordSourceInterpretation(wire, request, metadata).response.components[0]
      .meaning.objectRefs,
    ["s1"],
  );
  const outsideSelection = structuredClone(wire);
  outsideSelection.components[0].evidence = [{ sourceRef: "s5" }];
  outsideSelection.components[0].roleEvidence.actionText = "Riscaldamento";
  assert.throws(
    () => recordSourceInterpretation(outsideSelection, request, metadata),
    /Meaning object must be an exact quotation/,
  );
  const legacyWire = {
    ...wire,
    evidenceFormat: "component_evidence_v2",
    components: wire.components.map((component: any) => ({
      ...component,
      evidence: [
        { sourceRef: "s1", use: "role" },
        { sourceRef: "s5", use: "meaning" },
      ],
    })),
  };
  assert(!accepts(legacyWire));
  assert.throws(() =>
    recordSourceInterpretation(legacyWire, request, metadata),
  );
  assert.equal(JSON.stringify(wire), before);
});

test("Object quotations are required and cannot be translated or paraphrased", () => {
  const request = buildSourceInterpretationRequest(context());
  const wire = wireResponse(response());
  const missing = structuredClone(wire);
  delete missing.components[0].meaning.objectText;
  const accepts = new Ajv2020({ strict: false }).compile(
    request.responseFormat.json_schema.schema,
  );
  assert(!accepts(missing));
  assert.throws(() => recordSourceInterpretation(missing, request, metadata));
  const oldFormat = { ...wire, evidenceFormat: "component_evidence_v1" };
  assert(!accepts(oldFormat));
  assert.throws(() => recordSourceInterpretation(oldFormat, request, metadata));
  for (const objectText of [
    "Invented products",
    "Apparecchiature inventate",
    "FAMIGLIA_INVENTATA 🌳",
  ]) {
    const changed = structuredClone(wire);
    changed.components[0].meaning.objectText = objectText;
    assert.throws(
      () => recordSourceInterpretation(changed, request, metadata),
      /Meaning object must be an exact quotation/,
    );
  }
});

test("Object quotations retain contracted articles or omit them without grammatical rewriting", () => {
  const base = context();
  const original =
    "Fornitura del materiale inventato, posa accessoria; trasporto escluso.";
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: base.body.passages.map((passage, index) =>
        index === 0
          ? { ...passage, text: original, endUtf16: original.length }
          : passage,
      ),
    },
  };
  const request = buildSourceInterpretationRequest(input);
  const wire = wireResponse(response(input));
  wire.components[0].roleEvidence.actionText = "Fornitura";
  for (const objectText of ["del materiale inventato", "materiale inventato"]) {
    const value = structuredClone(wire);
    value.components[0].meaning.objectText = objectText;
    const before = JSON.stringify(value);
    const record = recordSourceInterpretation(value, request, metadata);
    assert.equal(record.response.components[0].meaning.objectText, objectText);
    assert.equal(JSON.stringify(value), before);
  }
  const changed = structuredClone(wire);
  changed.components[0].meaning.objectText = "il materiale inventato";
  const before = JSON.stringify(changed);
  assert.throws(
    () => recordSourceInterpretation(changed, request, metadata),
    /Meaning object must be an exact quotation/,
  );
  assert.equal(JSON.stringify(changed), before);
});

test("Provider quotations preserve original initials instead of adapting them to a description", () => {
  const base = context();
  const original =
    "Fornitura di Quadri di distribuzione inventati; posa accessoria; trasporto escluso.";
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: base.body.passages.map((passage, index) =>
        index === 0
          ? { ...passage, text: original, endUtf16: original.length }
          : passage,
      ),
    },
  };
  const request = buildSourceInterpretationRequest(input);
  const wire = wireResponse(response(input));
  wire.components[0].roleEvidence.actionText = "Fornitura";
  wire.components[0].meaning.objectText = "Quadri di distribuzione inventati";
  const before = JSON.stringify(wire);
  const record = recordSourceInterpretation(wire, request, metadata);
  assert.equal(
    readSourceInterpretation(record, request)!.components[0].meaning.objectText,
    "Quadri di distribuzione inventati",
  );
  for (const field of ["object", "action"] as const) {
    const changed = structuredClone(wire);
    if (field === "object")
      changed.components[0].meaning.objectText =
        "quadri di distribuzione inventati";
    else changed.components[0].roleEvidence.actionText = "fornitura";
    const negativeBefore = JSON.stringify(changed);
    assert.throws(
      () => recordSourceInterpretation(changed, request, metadata),
      /must be an exact quotation/,
    );
    assert.equal(JSON.stringify(changed), negativeBefore);
  }
  assert.equal(JSON.stringify(wire), before);
});

test("Provider evidence records a supporting title once and derives all existing reference lists", () => {
  const base = context();
  const title = "Fornitura di prodotti inventati";
  const input: SourceInterpretationContext = {
    ...base,
    body: {
      ...base.body,
      passages: [
        ...base.body.passages,
        {
          ...base.body.passages[0],
          id: "s5",
          rawPath: "/base/title/it",
          role: "context",
          text: title,
          endUtf16: title.length,
        },
      ],
    },
  };
  const request = buildSourceInterpretationRequest(input);
  const wire = wireResponse(response(input));
  wire.components[0].evidence.push({ sourceRef: "s5" });
  wire.components[0].meaning.objectText = title;
  const before = JSON.stringify(wire);
  const accepts = new Ajv2020({ strict: false }).compile(
    request.responseFormat.json_schema.schema,
  );
  assert(accepts(wire));
  const record = recordSourceInterpretation(wire, request, metadata);
  const read = readSourceInterpretation(record, request)!;
  assert.deepEqual(read.components[0].sourceRefs, ["s1", "s3", "s5"]);
  assert.deepEqual(read.components[0].meaning.objectRefs, ["s1", "s5"]);
  assert.deepEqual(read.components[0].roleEvidence.sourceRefs, ["s1"]);
  assert.equal(read.evidence.find((item) => item.id === "s5")!.text, title);
  assert.equal(JSON.stringify(wire), before);
  assert.equal("evidenceFormat" in record.response, false);
  // The stored contract is still strict. It never repairs an old malformed
  // response by silently adding a missing parent reference.
  const malformed = structuredClone(record.response);
  malformed.components[0].sourceRefs = ["s1", "s3"];
  assert.throws(
    () => recordSourceInterpretation(malformed, request, metadata),
    /within the component/,
  );
  const { hash: _hash, ...unsigned } = record;
  const changed = { ...unsigned, response: malformed };
  const tampered = {
    ...changed,
    hash: createHash("sha256")
      .update(stableDocumentaryJson(changed))
      .digest("hex"),
  };
  assert.throws(
    () => readSourceInterpretation(tampered, request),
    /within the component/,
  );
});

test("Selected evidence must contain both quotations without adding missing references", () => {
  const request = buildSourceInterpretationRequest(context());
  const base = wireResponse(response());
  const first = base.components[0];
  const changes = [
    { evidence: [{ sourceRef: "s3" }] },
    { evidence: [{ sourceRef: "s999" }] },
    { evidence: [{ sourceRef: "s1", use: "role_and_meaning" }] },
    {
      roleEvidence: {
        ...first.roleEvidence,
        actionText: "Traduzione non presente",
      },
    },
    { roleEvidence: { ...first.roleEvidence, scope: "selected_lot" } },
    { evidence: [...first.evidence, first.evidence[0]] },
  ];
  for (const change of changes) {
    const value = { ...base, components: [{ ...first, ...change }] };
    const before = JSON.stringify(value);
    assert.throws(() => recordSourceInterpretation(value, request, metadata));
    assert.equal(JSON.stringify(value), before);
  }
});

function splitServiceContext() {
  const base = context();
  const original =
    "La fornitura, l’installazione e la manutenzione riguardano apparecchiature per il raffrescamento, il riscaldamento e la deumidificazione dei locali.";
  const cut = original.indexOf("riscaldamento") + 4;
  const first = base.body.passages[0];
  return {
    ...base,
    body: {
      ...base.body,
      passages: [
        { ...first, text: original.slice(0, cut), endUtf16: cut },
        {
          ...first,
          id: "s5",
          text: original.slice(cut),
          startUtf16: cut,
          endUtf16: original.length,
        },
        ...base.body.passages.slice(1),
      ],
    },
  };
}

test("An explicit contiguous evidence group grounds an action in the first fragment and an object crossing the split", () => {
  const input = splitServiceContext();
  const before = JSON.stringify(input);
  const request = buildSourceInterpretationRequest(input);
  const group = JSON.parse(request.prompt).componentEvidenceGroups[0];
  assert.deepEqual(group, {
    id: "g1",
    scope: "project_context",
    rawPath: "/procurement/orderDescription/it",
    sourceRefs: ["s1", "s5"],
  });
  const wire = wireResponse(response(input));
  wire.components[0].evidence = [{ sourceRef: group.id }];
  wire.components[0].roleEvidence.actionText =
    "fornitura, l’installazione e la manutenzione";
  wire.components[0].meaning.objectText =
    "apparecchiature per il raffrescamento, il riscaldamento e la deumidificazione dei locali";
  const wireBefore = JSON.stringify(wire);
  const accepts = new Ajv2020({ strict: false }).compile(
    request.responseFormat.json_schema.schema,
  );
  assert.equal(accepts(wire), true);
  const record = recordSourceInterpretation(wire, request, metadata);
  const component = readSourceInterpretation(record, request)!.components[0];
  assert.deepEqual(component.sourceRefs, ["s1", "s5"]);
  assert.deepEqual(component.roleEvidence.sourceRefs, ["s1"]);
  assert.deepEqual(component.meaning.objectRefs, ["s1", "s5"]);
  assert.equal(JSON.stringify(wire), wireBefore);
  assert.equal(JSON.stringify(input), before);
  for (const evidence of [
    [{ sourceRef: "s5" }],
    [{ sourceRef: "g999" }],
    [{ sourceRef: "g1" }, { sourceRef: "s1" }],
  ]) {
    const changed = structuredClone(wire);
    changed.components[0].evidence = evidence;
    assert.throws(() => recordSourceInterpretation(changed, request, metadata));
  }
  for (const actionText of [
    "fornitura, installazione e manutenzione",
    "Fornitura, l’installazione e la manutenzione",
    "azioni inventate",
  ]) {
    const changed = structuredClone(wire);
    changed.components[0].roleEvidence.actionText = actionText;
    assert.throws(
      () => recordSourceInterpretation(changed, request, metadata),
      /exact quotation/,
    );
  }
});

test.each(["gap", "field", "scope", "url", "role"] as const)(
  "Component evidence groups never bridge different %s",
  (boundary) => {
    const base = splitServiceContext();
    const changes = {
      gap: {
        startUtf16: base.body.passages[1].startUtf16 + 1,
        endUtf16: base.body.passages[1].endUtf16 + 1,
      },
      field: { rawPath: "/other/field/it" },
      scope: { scope: "selected_lot" as const },
      url: { url: "https://example.invalid/another-source" },
      role: { role: "context" as const },
    };
    const input = {
      ...base,
      body: {
        ...base.body,
        passages: base.body.passages.map((p) =>
          p.id === "s5" ? { ...p, ...changes[boundary] } : p,
        ),
      },
    };
    // The selected-lot boundary also violates the original project context
    // guard; no invented group can make that context valid.
    if (boundary === "scope") {
      assert.throws(() => buildSourceInterpretationRequest(input));
      return;
    }
    const request = buildSourceInterpretationRequest(input);
    assert.equal(JSON.parse(request.prompt).componentEvidenceGroups, undefined);
    const wire = wireResponse(response(input));
    wire.components[0].evidence = [{ sourceRef: "g1" }];
    const accepts = new Ajv2020({ strict: false }).compile(
      request.responseFormat.json_schema.schema,
    );
    assert(!accepts(wire));
    assert.throws(() => recordSourceInterpretation(wire, request, metadata));
  },
);

test("Provider schema requires the wire version, bounded IDs and a single unambiguous evidence format", () => {
  const request = buildSourceInterpretationRequest(context());
  const accepts = new Ajv2020({ strict: false }).compile(
    request.responseFormat.json_schema.schema,
  );
  const wire = wireResponse(response());
  assert.equal(accepts(response()), false);
  const { evidenceFormat: _format, ...unversioned } = wire;
  for (const value of [
    unversioned,
    { ...wire, evidenceFormat: "unknown" },
    { ...wire, components: [{ ...wire.components[0], sourceRefs: ["s1"] }] },
    {
      ...wire,
      components: [
        {
          ...wire.components[0],
          evidence: [{ sourceRef: "s999" }],
        },
      ],
    },
    {
      ...wire,
      components: [
        {
          ...wire.components[0],
          meaning: { ...wire.components[0].meaning, objectRefs: ["s1"] },
        },
      ],
    },
  ]) {
    assert.equal(accepts(value), false);
    assert.throws(() => recordSourceInterpretation(value, request, metadata));
  }
});

test("OpenAI can encode the full source interpretation union without dropping local validation", () => {
  const input = context();
  const request = buildSourceInterpretationRequest(input);
  const before = structuredClone(request.responseFormat);
  const body = openaiResponseBody(
    "gpt-6-luna",
    request.system,
    request.prompt,
    8192,
    request.responseFormat,
    "high",
  );
  const accepts = new Ajv2020({ strict: false }).compile(
    body.text!.format.schema,
  );
  // The provider rejected nested $defs paths despite valid JSON Schema.
  // Exercise the real generation schema, not only a simplified root union.
  const wireSchema = body.text!.format.schema;
  const references = JSON.stringify(wireSchema).matchAll(/"\$ref":"([^"]+)"/g);
  let referenceCount = 0;
  for (const [, ref] of references) {
    assert.match(ref, /^#\/\$defs\/[^/]+$/);
    assert(Object.hasOwn(wireSchema.$defs as object, ref.slice(8)));
    referenceCount++;
  }
  assert(referenceCount > 10);
  const checkReferenceSiblings = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if ("$ref" in value) assert.deepEqual(Object.keys(value), ["$ref"]);
    Object.values(value).forEach(checkReferenceSiblings);
  };
  checkReferenceSiblings(wireSchema);
  assert(accepts({ result: wireResponse(response(input)) }));
  const missingRole = structuredClone(response(input)) as Record<string, any>;
  delete missingRole.components[0].roleEvidence;
  assert.equal(accepts({ result: wireResponse(missingRole) }), false);
  const badQuote = structuredClone(response(input));
  badQuote.components[0].roleEvidence.actionText =
    "Invented quote with valid JSON shape";
  assert(accepts({ result: wireResponse(badQuote) }));
  assert.throws(() => validateSourceInterpretation(badQuote, request));
  assert.deepEqual(request.responseFormat, before);
});

test("An untyped issue cannot make a fully identified source uncertain", () => {
  const request = buildSourceInterpretationRequest(context());
  const value = {
    ...response(),
    status: "uncertain",
    issues: [
      {
        explanation:
          "Nessuna incertezza materiale: mancano solo misure esatte.",
        sourceRefs: ["s1"],
      },
    ],
  };
  // No lexical detector: an issue needs an explicit, grounded blocking kind.
  assert.throws(() => validateSourceInterpretation(value, request));
});

test("Known object and action retain missing specifications as details without creating components", () => {
  const input = context();
  const clause =
    "La quantità sarà precisata: il documento non indica il numero di pezzi.";
  const request = buildSourceInterpretationRequest({
    ...input,
    body: {
      ...input.body,
      passages: [
        ...input.body.passages,
        {
          ...input.body.passages[3],
          id: "s5",
          rawPath: "/terms/quantity/it",
          text: clause,
          endUtf16: clause.length,
        },
      ],
    },
  });
  const detail = {
    kind: "missing_specification",
    explanation: "Numero di pezzi non precisato.",
    sourceRefs: ["s5"],
    scope: "project_context",
  };
  const value = { ...response(), details: [detail] };
  const provider = new Ajv2020({ strict: false }).compile(
    request.responseFormat.json_schema.schema,
  );
  assert.equal(provider(wireResponse(value)), true);
  const record = recordSourceInterpretation(value, request, metadata);
  const read = readSourceInterpretation(record, request)!;
  assert.equal(read.status, "resolved");
  assert.deepEqual(read.details, [detail]);
  assert.equal(read.components.length, 3);
  assert.equal(read.evidence.find((item) => item.id === "s5")!.text, clause);
  const unsupported = {
    ...value,
    status: "uncertain",
    issues: [
      {
        ...issueFields("object_identity", [0]),
        explanation: "Manca il numero di pezzi.",
        sourceRefs: ["s1", "s5"],
      },
    ],
  };
  assert.throws(
    () => validateSourceInterpretation(unsupported, request),
    /ambiguous component/,
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        { ...value, details: [{ ...detail, scope: "selected_lot" }] },
        request,
      ),
    /Detail scope/,
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        { ...value, details: [{ ...detail, sourceRefs: ["s999"] }] },
        request,
      ),
    /Unknown or empty/,
  );
  const untypedBlockingDetail = {
    ...value,
    status: "uncertain",
    issues: [{ ...detail, componentIndexes: [] }],
  };
  assert.equal(provider(wireResponse(untypedBlockingDetail)), false);
  assert.throws(() =>
    validateSourceInterpretation(untypedBlockingDetail, request),
  );
  const tampered = structuredClone(record);
  tampered.response.details[0].explanation =
    "Quantità inventata dopo registrazione.";
  assert.throws(() => readSourceInterpretation(tampered, request), /Altered/);
});

test("Role identity requires a quoted action or an explicitly unresolved role with its own issue", () => {
  const request = buildSourceInterpretationRequest(context());
  const base = response();
  const component = base.components[0];
  const unresolved = {
    ...base,
    status: "uncertain",
    components: [
      {
        ...component,
        role: null,
        roleEvidence: { ...component.roleEvidence, state: "unresolved" },
      },
    ],
    issues: [
      {
        ...issueFields("role_identity", [0]),
        explanation:
          "Il testo non consente di attribuire un'azione contrattuale precisa.",
        sourceRefs: ["s1"],
      },
    ],
  };
  const provider = new Ajv2020({ strict: false }).compile(
    request.responseFormat.json_schema.schema,
  );
  assert.equal(provider(wireResponse(unresolved)), true);
  const before = JSON.stringify(unresolved);
  const read = readSourceInterpretation(
    recordSourceInterpretation(unresolved, request, metadata),
    request,
  )!;
  assert.equal(read.status, "uncertain");
  assert.equal(read.components[0].role, null);
  assert.equal(JSON.stringify(unresolved), before);
  for (const value of [
    { ...unresolved, status: "resolved", issues: [] },
    { ...base, components: [{ ...component, role: null }] },
    {
      ...unresolved,
      components: [{ ...unresolved.components[0], role: "maintain" }],
    },
  ]) {
    assert.equal(provider(wireResponse(value)), false);
    assert.throws(() => validateSourceInterpretation(value, request));
  }
  assert.throws(
    () =>
      validateSourceInterpretation(
        { ...unresolved, components: [component] },
        request,
      ),
    /unresolved role/,
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        {
          ...unresolved,
          issues: [{ ...unresolved.issues[0], componentIndexes: [1] }],
        },
        request,
      ),
    /unknown component/,
  );
  for (const role of [
    {
      ...component.roleEvidence,
      actionText: "Una parafrasi non presente nella fonte.",
    },
    {
      ...component.roleEvidence,
      sourceRefs: ["s3"],
      actionText: "FAMIGLIA_INVENTATA 🌳",
    },
    {
      ...component.roleEvidence,
      sourceRefs: ["s4"],
      actionText: "La posa è accessoria.",
    },
    { ...component.roleEvidence, scope: "selected_lot" },
  ])
    assert.throws(
      () =>
        validateSourceInterpretation(
          { ...base, components: [{ ...component, roleEvidence: role }] },
          request,
        ),
      /Role/,
    );
});

test.each([
  [
    "Gestione continuativa ",
    "del deposito 🌳.",
    "Gestione continuativa del deposito 🌳.",
  ],
  [
    "<p>Gestione continuativa </p>",
    "<p>del deposito 🌳.</p>",
    "Gestione continuativa del deposito 🌳.",
  ],
])(
  "Role quotations preserve contiguous fragments without bridging gaps or fields: %s",
  (first, second, quotation) => {
    const input = context();
    const request = buildSourceInterpretationRequest({
      ...input,
      body: {
        ...input.body,
        passages: [
          ...input.body.passages.filter((item) => item.id !== "s1"),
          { ...input.body.passages[0], text: first, endUtf16: first.length },
          {
            ...input.body.passages[0],
            id: "s5",
            text: second,
            startUtf16: first.length,
            endUtf16: first.length + second.length,
          },
        ],
      },
    });
    const value = {
      ...response(),
      components: [
        {
          ...response().components[0],
          sourceRefs: ["s1", "s5"],
          role: "operate",
          roleEvidence: {
            state: "identified",
            actionText: quotation,
            sourceRefs: ["s5", "s1"],
            scope: "project_context",
          },
          meaning: {
            ...response().components[0].meaning,
            objectText: quotation,
            objectRefs: ["s5", "s1"],
          },
        },
      ],
    };
    assert.equal(
      validateSourceInterpretation(value, request).status,
      "resolved",
    );
    for (const change of [
      {
        startUtf16: first.length + 1,
        endUtf16: first.length + second.length + 1,
      },
      { rawPath: "/other/field/it" },
    ]) {
      const changed = buildSourceInterpretationRequest({
        ...input,
        body: {
          ...request.body,
          passages: request.body.passages.map((item) =>
            item.id === "s5" ? { ...item, ...change } : item,
          ),
        },
      });
      assert.throws(
        () => validateSourceInterpretation(value, changed),
        /exact quotation/,
      );
    }
  },
);

test("Unreadability and incomplete representation retain distinct evidenced blocking reasons", () => {
  const request = buildSourceInterpretationRequest(context());
  const value = {
    ...response(),
    status: "uncertain",
    issues: [
      {
        ...issueFields("representation_incomplete"),
        explanation:
          "Una prestazione nella clausola non è rappresentata compiutamente.",
        sourceRefs: ["s4"],
      },
    ],
  };
  // This records an admission requiring review, not proof that something is
  // actually missing. Textual entailment is not asserted by a mocked response.
  assert.equal(
    validateSourceInterpretation(value, request).status,
    "uncertain",
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        { ...value, issues: [{ ...value.issues[0], sourceRefs: ["s3"] }] },
        request,
      ),
    /non-classification/,
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        {
          ...value,
          issues: [{ ...value.issues[0], kind: "unreadable_source" }],
        },
        request,
      ),
    /unreadable source reading/,
  );
  assert.throws(
    () =>
      validateSourceInterpretation({ ...value, status: "resolved" }, request),
    /no issues/,
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        { ...value, issues: [{ ...value.issues[0], scope: "selected_lot" }] },
        request,
      ),
    /Issue scope/,
  );
});

test("Provider JSON Schema rejects the resolved ambiguous combination already rejected locally", () => {
  const request = buildSourceInterpretationRequest(context());
  const validate = new Ajv2020({ strict: false }).compile(
    request.responseFormat.json_schema.schema,
  );
  const original = response();
  const incoherent = {
    ...original,
    components: [
      {
        ...original.components[0],
        meaning: {
          ...original.components[0].meaning,
          state: "ambiguous",
          basis: "text_with_classification_context",
        },
      },
    ],
    issues: [
      {
        ...issueFields("object_identity", [0]),
        explanation: "Ambiguità inventata, non una lettura semantica reale.",
        sourceRefs: ["s1"],
      },
    ],
  };
  assert.throws(() => validateSourceInterpretation(incoherent, request));
  assert.equal(validate(wireResponse(incoherent)), false);
});

test("Serialized provider schema and local validator agree on tagged states without coercing responses", () => {
  const request = buildSourceInterpretationRequest(context());
  // Validate what is actually sent, independently of the Zod parser/refinements.
  const schema = JSON.parse(
    JSON.stringify(request.responseFormat.json_schema.schema),
  );
  const providerAccepts = new Ajv2020({ strict: false }).compile(schema);
  const resolved = response();
  const uncertain = {
    ...resolved,
    status: "uncertain",
    components: [
      {
        ...resolved.components[0],
        meaning: {
          ...resolved.components[0].meaning,
          state: "ambiguous",
          basis: "unresolved",
        },
      },
    ],
    issues: [
      {
        ...issueFields("object_identity", [0]),
        explanation: "Oggetto non identificabile dai dati inventati.",
        sourceRefs: ["s1"],
      },
    ],
  };
  const conflicting = {
    ...uncertain,
    status: "conflicting",
    issues: [
      {
        ...issueFields("source_conflict", [0]),
        explanation: "Asserzioni inventate da sottoporre a revisione.",
        sourceRefs: ["s1", "s3"],
      },
    ],
  };
  const examples: Array<[string, unknown, boolean]> = [
    ["resolved", resolved, true],
    ["uncertain ambiguous", uncertain, true],
    ["conflicting", conflicting, true],
    ["resolved with issue", { ...resolved, issues: uncertain.issues }, false],
    [
      "resolved with ambiguous meaning",
      { ...uncertain, status: "resolved", issues: [] },
      false,
    ],
    [
      "resolved with unresolved classification",
      {
        ...resolved,
        classificationReadings: [
          { ...resolved.classificationReadings[0], use: "unresolved" },
        ],
      },
      false,
    ],
    [
      "resolved with conflicting classification",
      {
        ...resolved,
        classificationReadings: [
          { ...resolved.classificationReadings[0], use: "conflicting" },
        ],
      },
      false,
    ],
    [
      "identified with unresolved basis",
      {
        ...resolved,
        components: [
          {
            ...resolved.components[0],
            meaning: { ...resolved.components[0].meaning, basis: "unresolved" },
          },
        ],
      },
      false,
    ],
    [
      "ambiguous with explicit basis",
      {
        ...uncertain,
        components: [
          {
            ...uncertain.components[0],
            meaning: {
              ...uncertain.components[0].meaning,
              basis: "explicit_text",
            },
          },
        ],
      },
      false,
    ],
    ["uncertain without issue", { ...uncertain, issues: [] }, false],
    ["conflicting without issue", { ...conflicting, issues: [] }, false],
  ];
  for (const [name, value, wanted] of examples) {
    const before = JSON.stringify(value);
    assert.equal(providerAccepts(wireResponse(value)), wanted, name);
    if (wanted) {
      assert.deepEqual(
        validateSourceInterpretation(value, request).response,
        value,
        name,
      );
      assert.deepEqual(
        recordSourceInterpretation(wireResponse(value), request, metadata)
          .response,
        value,
        name,
      );
    } else
      assert.throws(() => validateSourceInterpretation(value, request), name);
    assert.equal(JSON.stringify(value), before, name);
  }
});

test("Cross-reference and main-component guarantees remain server checks beyond the tagged provider schema", () => {
  const request = buildSourceInterpretationRequest(context());
  const providerAccepts = new Ajv2020({ strict: false }).compile(
    request.responseFormat.json_schema.schema,
  );
  const resolved = response();
  const malformed = [
    { ...resolved, components: [resolved.components[1]] },
    {
      ...resolved,
      status: "uncertain",
      issues: [
        {
          ...issueFields("object_identity", [0]),
          explanation:
            "Identità dichiarata incerta ma componenti tutte identificate.",
          sourceRefs: ["s1"],
        },
      ],
    },
    {
      ...resolved,
      components: [
        {
          ...resolved.components[0],
          meaning: {
            ...resolved.components[0].meaning,
            objectRefs: ["s3"],
          },
        },
      ],
    },
    {
      ...resolved,
      components: [{ ...resolved.components[0], sourceRefs: ["s1", "s1"] }],
    },
    {
      ...resolved,
      status: "conflicting",
      issues: [
        {
          ...issueFields("source_conflict", [0]),
          explanation: "Una sola asserzione non prova un conflitto.",
          sourceRefs: ["s1"],
        },
      ],
    },
  ];
  for (const value of malformed) {
    assert.equal(providerAccepts(wireResponse(value)), true);
    assert.throws(() => validateSourceInterpretation(value, request));
  }
});

test("A resolved paraphrase cannot omit classification accounting and meaning grounding", () => {
  const request = buildSourceInterpretationRequest(context());
  const { classificationReadings: _readings, ...current } = response();
  const legacy = {
    ...current,
    components: current.components.map(
      ({ meaning: _meaning, ...item }) => item,
    ),
  };
  // This was a valid v3 record despite dropping the available context. This
  // checks an information-loss contract, not whether an LLM understands it.
  assert.throws(() => recordSourceInterpretation(legacy, request, metadata));
});

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
    "classificationContext",
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

test("Provider details keep original project and selected-lot references in separate scopes", () => {
  const base = context();
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
        lot: { id: "invented-lot", path: "/lots/3", headerPath: null },
      },
      fields: [
        { scope: "project_context", rawPath: "/name", value: "Progetto" },
        { scope: "selected_lot", rawPath: "/lots/3/lotNumber", value: 4 },
      ],
      classifications: base.body.classifications.map((c) => ({
        ...c,
        appliesTo: "shared_project_context",
      })),
      passages: [
        ...base.body.passages,
        {
          ...base.body.passages[0],
          id: "s5",
          scope: "selected_lot",
          rawPath: "/lots/3/description/it",
        },
      ],
    },
  };
  const before = JSON.stringify(input);
  const request = buildSourceInterpretationRequest(input);
  const value = {
    ...response(input),
    targetRef: "s5",
    details: [
      ...response(input).details,
      {
        kind: "technical_specification",
        explanation: "Dati del contesto originale del progetto inventato.",
        sourceRefs: ["s1", "f0"],
        scope: "project_context",
      },
      {
        kind: "technical_specification",
        explanation: "Dati del lotto inventato selezionato.",
        sourceRefs: ["s5", "f1"],
        scope: "selected_lot",
      },
    ],
  };
  const wire = wireResponse(value, request);
  const accepts = new Ajv2020({ strict: false }).compile(
    request.responseFormat.json_schema.schema,
  );
  assert.equal(accepts(wire), true);
  assert.doesNotThrow(() =>
    recordSourceInterpretation(wire, request, metadata),
  );
  const selectedIndex = wire.details.findIndex((d: any) =>
    d.sourceRefs.includes("f1"),
  );
  assert(selectedIndex >= 0);
  for (const changes of [
    { sourceRefs: ["s5", "s1"] },
    { sourceRefs: ["s5", "f0"] },
    { sourceRefs: ["f1"], scope: "project_context" },
    { kind: "shared_project_context" },
  ]) {
    const changed = structuredClone(wire);
    Object.assign(changed.details[selectedIndex], changes);
    const original = JSON.stringify(changed);
    assert.equal(accepts(changed), false);
    assert.throws(() => recordSourceInterpretation(changed, request, metadata));
    assert.equal(JSON.stringify(changed), original);
  }
  const projectRequest = buildSourceInterpretationRequest(base);
  const projectWire = wireResponse(response(base), projectRequest);
  const acceptsProject = new Ajv2020({ strict: false }).compile(
    projectRequest.responseFormat.json_schema.schema,
  );
  assert.equal(acceptsProject(projectWire), true);
  projectWire.details.push({
    kind: "technical_specification",
    explanation: "Un riferimento di progetto non cambia ambito.",
    sourceRefs: ["s1"],
    scope: "selected_lot",
  });
  assert.equal(acceptsProject(projectWire), false);
  assert.equal(JSON.stringify(input), before);
});

test("An opening selected-lot identifier uses its explicit number and its own field proof", () => {
  const base = context();
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
        lot: {
          id: "invented-lot",
          path: "/lots/3",
          headerPath: "/base/lots/3",
        },
      },
      fields: [
        { scope: "selected_lot", rawPath: "/lots/3/lotNumber", value: 4 },
        { scope: "selected_lot", rawPath: "/base/lots/3/lotNumber", value: 4 },
      ],
      classifications: base.body.classifications.map((c) => ({
        ...c,
        appliesTo: "shared_project_context",
      })),
      passages: [
        ...base.body.passages,
        {
          ...base.body.passages[0],
          id: "s5",
          scope: "selected_lot",
          rawPath: "/lots/3/description/it",
        },
      ],
    },
  };
  const before = JSON.stringify(input);
  const request = buildSourceInterpretationRequest(input);
  assert.deepEqual(JSON.parse(request.prompt).targetNumberEvidence, [
    { sourceRef: "f0", value: 4 },
    { sourceRef: "f1", value: 4 },
  ]);
  assert(
    JSON.parse(request.prompt).rules.some(
      (rule: string) =>
        rule.includes("summarySourceRefs") &&
        rule.includes("targetNumberEvidence: f0, f1") &&
        rule.includes("I passaggi sN non provano quel numero"),
    ),
  );
  const valid = {
    ...response(input),
    targetRef: "s5",
    summary:
      "Il lotto 4 riguarda prodotti inventati, con posa accessoria e trasporto escluso.",
    summarySourceRefs: [...response(input).summarySourceRefs, "f0"],
  };
  assert.equal(
    recordSourceInterpretation(valid, request, metadata).response.summary,
    valid.summary,
  );
  for (const number of [0, 1, 3, 5])
    assert.throws(
      () =>
        recordSourceInterpretation(
          {
            ...valid,
            summary: valid.summary.replace("lotto 4", `lotto ${number}`),
          },
          request,
          metadata,
        ),
      /lot number contradicts original metadata/,
    );
  assert.throws(
    () =>
      recordSourceInterpretation(
        { ...valid, summarySourceRefs: response(input).summarySourceRefs },
        request,
        metadata,
      ),
    /own original field evidence/,
  );
  const conflictingInput = {
    ...input,
    body: {
      ...input.body,
      fields: input.body.fields.map((f, i) => ({
        ...f,
        value: i === 1 ? 5 : f.value,
      })),
    },
  };
  assert.throws(
    () =>
      recordSourceInterpretation(
        valid,
        buildSourceInterpretationRequest(conflictingInput),
        metadata,
      ),
    /lot number contradicts original metadata/,
  );
  assert.equal(JSON.stringify(input), before);
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
  const withConditions = {
    ...lot,
    body: {
      ...lot.body,
      fields: [
        {
          scope: "project_context" as const,
          rawPath: "/terms/subContractorAllowed",
          value: true,
        },
        {
          scope: "selected_lot" as const,
          rawPath: "/lots/0/terms/subContractorAllowed",
          value: false,
        },
      ],
    },
  };
  const conditionRequest = buildSourceInterpretationRequest(withConditions);
  const conditioned = {
    ...response(lot),
    targetRef: "s5",
    details: [
      {
        kind: "execution_condition",
        scope: "project_context",
        sourceRefs: ["f0"],
        explanation:
          "Il progetto consente il subappalto nel contesto generale.",
      },
      {
        kind: "execution_condition",
        scope: "selected_lot",
        sourceRefs: ["f1"],
        explanation: "Il lotto vieta il subappalto.",
      },
    ],
  };
  assert.deepEqual(conditionRequest.requiredContractClauseIds, ["f0", "f1"]);
  assert.equal(
    validateSourceInterpretation(conditioned, conditionRequest).details.length,
    2,
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        {
          ...conditioned,
          details: conditioned.details.map((d) => ({
            ...d,
            scope: "selected_lot",
          })),
        },
        conditionRequest,
      ),
    /Detail scope/,
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        { ...conditioned, details: conditioned.details.slice(1) },
        conditionRequest,
      ),
    /Incomplete.*contract clauses/,
  );
  assert.throws(
    () => validateSourceInterpretation(response(), request),
    /selected-target/,
  );
  assert.equal(
    validateSourceInterpretation({ ...response(lot), targetRef: "s5" }, request)
      .targetRef,
    "s5",
  );
  const scopeQuestion = {
    ...response(lot),
    status: "uncertain",
    targetRef: "s5",
    issues: [
      {
        ...issueFields("target_scope", [0]),
        scope: "selected_lot",
        explanation:
          "Il progetto e il lotto non delimitano chiaramente la medesima prestazione.",
        sourceRefs: ["s1", "s5"],
      },
    ],
    details: [
      {
        kind: "shared_project_context",
        explanation: "Condizioni condivise mantenute come contesto.",
        sourceRefs: ["s4"],
        scope: "project_context",
      },
    ],
  };
  assert.equal(
    validateSourceInterpretation(scopeQuestion, request).status,
    "uncertain",
  );
  assert(
    new Ajv2020({ strict: false }).compile(
      request.responseFormat.json_schema.schema,
    )(wireResponse(scopeQuestion)),
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        {
          ...scopeQuestion,
          issues: [{ ...scopeQuestion.issues[0], sourceRefs: ["s1"] }],
        },
        request,
      ),
    /both scopes/,
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        {
          ...scopeQuestion,
          details: [
            {
              ...scopeQuestion.details[0],
              sourceRefs: ["s5"],
              scope: "selected_lot",
            },
          ],
        },
        request,
      ),
    /Shared project detail/,
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        {
          ...scopeQuestion,
          targetRef: "s1",
          summarySourceRefs: response(input).summarySourceRefs,
          classificationReadings: response(input).classificationReadings,
          details: [],
          issues: [
            {
              ...scopeQuestion.issues[0],
              scope: "project_context",
              sourceRefs: ["s1", "s4"],
            },
          ],
        },
        buildSourceInterpretationRequest(input),
      ),
    /lot and evidence/,
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
    ...issueFields("source_conflict"),
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
  assert.throws(
    () =>
      validateSourceInterpretation(
        { ...response(), status: "uncertain", issues: [issue] },
        request,
      ),
    /Source conflict/,
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
    issues: [
      {
        ...issueFields("unreadable_source"),
        explanation: "Una parte non è leggibile.",
        sourceRefs: ["s1"],
      },
    ],
  };
  const record = recordSourceInterpretation(uncertain, request, metadata);
  assert.deepEqual(
    readSourceInterpretation(record, request)!.readings,
    request.readings,
  );
});

test("Unreadability issues must cite localized unreadable readings even when another reading has no references", () => {
  const input = context();
  const complete = {
    chunkId: "chunk1",
    status: "complete" as const,
    sourceRefs: ["s1"],
  };
  const localized = {
    chunkId: "chunk2",
    status: "unreadable" as const,
    sourceRefs: ["s4"],
  };
  const unlocalized = {
    chunkId: "chunk3",
    status: "unreadable" as const,
    sourceRefs: [],
  };
  const answer = (sourceRefs: string[]) => ({
    ...response(),
    status: "uncertain",
    issues: [
      {
        ...issueFields("unreadable_source"),
        explanation: "Una parte del testo non è leggibile.",
        sourceRefs,
      },
    ],
  });
  for (const readings of [
    [complete, localized],
    [complete, localized, unlocalized],
  ]) {
    const request = buildSourceInterpretationRequest({
      ...input,
      coverage: { ...input.coverage, chunks: readings.length },
      readings,
    });
    assert.throws(
      () => validateSourceInterpretation(answer(["s1"]), request),
      /Unreadable issue must cite/,
    );
    const recorded = recordSourceInterpretation(
      answer(["s4"]),
      request,
      metadata,
    );
    const result = readSourceInterpretation(recorded, request)!;
    assert.equal(result.status, "uncertain");
    assert.deepEqual(result.issues[0].sourceRefs, ["s4"]);
  }
  // When no unreadable reading can be localized, retain the historical
  // conservative review outcome; no cited passage is declared unreadable.
  const readings = [complete, unlocalized];
  const request = buildSourceInterpretationRequest({
    ...input,
    coverage: { ...input.coverage, chunks: readings.length },
    readings,
  });
  assert.equal(
    validateSourceInterpretation(answer(["s1"]), request).status,
    "uncertain",
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

test("Compact source JSON preserves every long-source value and reference within the byte limit", () => {
  const input = context();
  const base = buildSourceInterpretationRequest(input);
  const tail = "ULTIMA CLAUSOLA: trasporto escluso, pulizia accessoria 🌳";
  const passages = [
    ...input.body.passages,
    ...Array.from({ length: 380 }, (_, index) => {
      const text =
        index === 379
          ? tail
          : `Prestazione inventata numero ${index}: `.padEnd(220, "x");
      return {
        id: `s${index + 5}`,
        scope: "project_context" as const,
        role: "context" as const,
        rawPath: `/terms/clauses/${index}/it`,
        startUtf16: 0,
        endUtf16: text.length,
        text,
        url: "https://example.invalid/source",
      };
    }),
  ];
  const large: SourceInterpretationContext = {
    ...input,
    coverage: {
      ...input.coverage,
      sourceUtf16: passages.reduce(
        (total, passage) => total + passage.text.length,
        0,
      ),
      fields: passages.length + 3,
      chunks: 19,
    },
    body: {
      ...input.body,
      passages,
      fields: [
        ...input.body.fields,
        { scope: "project_context", rawPath: "/terms/optional", value: false },
        { scope: "project_context", rawPath: "/terms/quantity", value: 0 },
      ],
    },
    readings: Array.from({ length: 19 }, (_, index) => ({
      chunkId: `chunk${index + 1}`,
      status: "complete" as const,
      sourceRefs: passages
        .slice(index * 21, (index + 1) * 21)
        .map((passage) => passage.id),
    })),
  };
  const expected = {
    ...JSON.parse(base.prompt),
    coverage: large.coverage,
    readings: large.readings,
    ...large.body,
    fields: [
      large.body.fields[0],
      { ...large.body.fields[1], id: "f1" },
      { ...large.body.fields[2], id: "f2" },
    ],
    passages: passages.map(({ url: _url, ...passage }) => passage),
  };
  delete expected.classifications;
  const before = JSON.stringify(large);
  // This exact payload exceeds the bound only with pretty-print whitespace.
  const request = buildSourceInterpretationRequest(large);
  const schemaBytes = JSON.stringify(request.responseFormat);
  assert.ok(
    Buffer.byteLength(
      request.system + JSON.stringify(expected, null, 2) + schemaBytes,
    ) > 160_000,
  );
  assert.ok(
    Buffer.byteLength(request.system + request.prompt + schemaBytes) <= 160_000,
  );
  const decoded = JSON.parse(request.prompt);
  assert.deepEqual(decoded, expected);
  assert.equal(decoded.passages.at(-1).text, tail);
  assert.deepEqual(
    decoded.readings.flatMap(
      (reading: { sourceRefs: string[] }) => reading.sourceRefs,
    ),
    passages.map((passage) => passage.id),
  );
  assert.deepEqual(
    request.selectedIds,
    passages.map((passage) => passage.id),
  );
  assert.equal(JSON.stringify(large), before);
});

test("Classification-only components reject the entire interpretation regardless of importance or duplicated classification paths", () => {
  const input = context();
  const duplicate = input.body.classifications[0];
  const request = buildSourceInterpretationRequest({
    ...input,
    body: {
      ...input.body,
      classifications: [
        ...input.body.classifications,
        {
          ...duplicate,
          rawPath: "/base/cpvCode",
          code: { text: "00000000", sourceRefs: ["s5"] },
          labels: [
            {
              language: "it",
              text: "FAMIGLIA_INVENTATA 🌳",
              sourceRefs: ["s6"],
            },
          ],
        },
      ],
      passages: [
        ...input.body.passages,
        { ...input.body.passages[1], id: "s5", rawPath: "/base/cpvCode/code" },
        {
          ...input.body.passages[2],
          id: "s6",
          rawPath: "/base/cpvCode/label/it",
        },
      ],
    },
  });
  assert.equal(
    recordSourceInterpretation(response(request), request, metadata).response
      .status,
    "resolved",
  );
  for (const importance of ["main", "accessory", "excluded"] as const)
    for (const refs of [
      ["s2"],
      ["s3"],
      ["s5"],
      ["s2", "s5"],
      ["s2", "s3", "s5", "s6"],
    ]) {
      const invalid = {
        ...response(request),
        components: [
          {
            ...response().components[0],
            description: "Oggetto acquistato",
            sourceRefs: ["s1"],
          },
          {
            description: "Classificazione CPV",
            role: "supply",
            roleEvidence: roleEvidence(request, "s1"),
            importance,
            sourceRefs: refs,
            meaning: meaning("Classificazione CPV", refs),
          },
        ],
      };
      const before = JSON.stringify(invalid);
      // Reject the record as a whole. Returning just the first component would
      // rewrite the model's interpretation and conceal the invalid second one.
      assert.throws(() =>
        recordSourceInterpretation(invalid, request, metadata),
      );
      assert.equal(JSON.stringify(invalid), before);
    }
});

test("Concrete main accessory and excluded activities may be supported entirely by clause context", () => {
  const input = context();
  const clauseText =
    "Il servizio comprende gestione del deposito, con pulizia accessoria; manutenzione dei mezzi esclusa.";
  const request = buildSourceInterpretationRequest({
    ...input,
    body: {
      ...input.body,
      passages: input.body.passages.map((passage) =>
        passage.id === "s4"
          ? { ...passage, text: clauseText, endUtf16: clauseText.length }
          : passage,
      ),
    },
  });
  assert.equal(
    request.body.passages.find((passage) => passage.id === "s4")!.role,
    "context",
  );
  const record = recordSourceInterpretation(
    {
      ...response(),
      components: [
        {
          description: "Gestione del deposito.",
          role: "operate",
          roleEvidence: roleEvidence(request, "s4"),
          importance: "main",
          sourceRefs: ["s4"],
          meaning: meaning("Gestione del deposito", ["s4"], request),
        },
        {
          description: "Pulizia del deposito.",
          role: "execute",
          roleEvidence: roleEvidence(request, "s4"),
          importance: "accessory",
          sourceRefs: ["s4"],
          meaning: meaning("Pulizia del deposito", ["s4"], request),
        },
        {
          description: "Manutenzione dei mezzi.",
          role: "maintain",
          roleEvidence: roleEvidence(request, "s4"),
          importance: "excluded",
          sourceRefs: ["s4"],
          meaning: meaning("Manutenzione dei mezzi", ["s4"], request),
        },
      ],
    },
    request,
    metadata,
  );
  const resolved = readSourceInterpretation(record, request)!;
  assert.deepEqual(
    resolved.components.map((component) => component.importance),
    ["main", "accessory", "excluded"],
  );
  assert.ok(
    resolved.components.every(
      (component) =>
        component.sourceRefs.length === 1 && component.sourceRefs[0] === "s4",
    ),
  );
  assert.equal(
    resolved.evidence.find((passage) => passage.id === "s4")!.text,
    clauseText,
  );
});

test("A real purchased classification or cataloguing service is not rejected by its vocabulary", () => {
  const input = context();
  const serviceText =
    "Servizi di classificazione CPV, catalogazione e correzione dei metadati del catalogo acquisti.";
  const request = buildSourceInterpretationRequest({
    ...input,
    body: {
      ...input.body,
      passages: input.body.passages.map((passage) =>
        passage.id === "s1"
          ? { ...passage, text: serviceText, endUtf16: serviceText.length }
          : passage,
      ),
    },
  });
  const record = recordSourceInterpretation(
    {
      ...response(),
      summary: serviceText,
      components: [
        {
          description: serviceText,
          role: "execute",
          roleEvidence: roleEvidence(request, "s1"),
          importance: "main",
          sourceRefs: ["s1"],
          meaning: meaning(serviceText, ["s1"], request),
        },
      ],
    },
    request,
    metadata,
  );
  assert.equal(
    readSourceInterpretation(record, request)!.components[0].description,
    serviceText,
  );
});

test.each([
  "documentary-source-interpretation-v5",
  "documentary-source-interpretation-v6",
  "documentary-source-interpretation-v7",
  "documentary-source-interpretation-v8",
  "documentary-source-interpretation-v9",
  "documentary-source-interpretation-v10",
  "documentary-source-interpretation-v11",
  "documentary-source-interpretation-v12",
  "documentary-source-interpretation-v13",
  "documentary-source-interpretation-v14",
  "documentary-source-interpretation-v15",
  "documentary-source-interpretation-v16",
  "documentary-source-interpretation-v17",
  "documentary-source-interpretation-v18",
  "documentary-source-interpretation-v19",
  "documentary-source-interpretation-v20",
  "documentary-source-interpretation-v30",
  "documentary-source-interpretation-v31",
  "documentary-source-interpretation-v32",
  "documentary-source-interpretation-v33",
  "documentary-source-interpretation-v34",
  "documentary-source-interpretation-v35",
  "documentary-source-interpretation-v36",
  "documentary-source-interpretation-v42",
  "documentary-source-interpretation-v44",
  "documentary-source-interpretation-v45",
])("Source %s is stale before parsing its historical schema", (version) => {
  const request = buildSourceInterpretationRequest(context());
  assert.equal(request.version, SOURCE_INTERPRETATION_VERSION);
  const current = recordSourceInterpretation(response(), request, metadata);
  const digest = (value: unknown) =>
    createHash("sha256").update(stableDocumentaryJson(value)).digest("hex");
  const { hash: _hash, ...unsigned } = current;
  const historicalBody = {
    ...unsigned,
    version,
    sourceKey: digest({
      version,
      binding: request.binding,
    }),
  };
  const historical = { ...historicalBody, hash: digest(historicalBody) };
  const before = JSON.stringify(historical);
  assert.notEqual(historical.sourceKey, current.sourceKey);
  assert.equal(readSourceInterpretation(historical, request), null);
  assert.equal(
    readSourceInterpretation(
      { ...historical, response: { oldSchema: true } },
      request,
    ),
    null,
  );
  assert.equal(
    readSourceInterpretation(
      {
        ...historical,
        sourceKey: current.sourceKey,
        inputHash: current.inputHash,
      },
      request,
    ),
    null,
  );
  assert.equal(JSON.stringify(historical), before);
  assert.equal(readSourceInterpretation(current, request)!.status, "resolved");
});

test("Source output allowance is bounded, independent from thinking and part of the cache identity", () => {
  const input = context();
  const high = buildSourceInterpretationRequest(input);
  const none = buildSourceInterpretationRequest({
    ...input,
    binding: { ...input.binding, reasoningEffort: "none" },
  });
  assert.equal(high.maxTokens, 8192);
  assert.equal(none.maxTokens, 8192);
  assert.equal(none.binding.maxTokens, none.maxTokens);
  assert.notEqual(high.sourceKey, none.sourceKey);
  assert.notEqual(high.inputHash, none.inputHash);
  assert.deepEqual(none.body, high.body);
  assert.deepEqual(none.responseFormat, high.responseFormat);
  const expanded = buildSourceInterpretationRequest({
    ...input,
    binding: { ...input.binding, maxTokens: 16_384 },
  });
  assert.equal(expanded.maxTokens, 16_384);
  assert.notEqual(expanded.sourceKey, high.sourceKey);
  assert.notEqual(expanded.inputHash, high.inputHash);
  assert.equal(expanded.prompt, high.prompt);
  assert.deepEqual(expanded.responseFormat, high.responseFormat);
  assert.equal(
    openaiResponseBody(
      "gpt-6-luna",
      expanded.system,
      expanded.prompt,
      expanded.maxTokens,
      expanded.responseFormat,
      "high",
    ).max_output_tokens,
    16_384,
  );
  const { maxTokens: _maxTokens, ...unbound } = input.binding;
  for (const binding of [
    unbound,
    ...[1600, 8193, 16_385, NaN].map((maxTokens) => ({
      ...input.binding,
      maxTokens,
    })),
  ])
    assert.throws(() =>
      buildSourceInterpretationRequest(
        JSON.parse(JSON.stringify({ ...input, binding })),
      ),
    );
  const stored = recordSourceInterpretation(response(), high, metadata);
  assert.equal(readSourceInterpretation(stored, none), null);
  assert.equal(readSourceInterpretation(stored, expanded), null);
  const expandedRecord = recordSourceInterpretation(
    response(),
    expanded,
    metadata,
  );
  assert.equal(readSourceInterpretation(expandedRecord, high), null);
  assert.equal(
    readSourceInterpretation(expandedRecord, expanded)?.status,
    "resolved",
  );
});

test("Large source output allowance has fixed limits and rejects malformed size inputs", () => {
  assert.equal(
    sourceInterpretationTokenLimit({ sourceUtf16: 8_000, classifications: 7 }),
    8192,
  );
  assert.equal(
    sourceInterpretationTokenLimit({ sourceUtf16: 8_001, classifications: 7 }),
    16_384,
  );
  assert.equal(
    sourceInterpretationTokenLimit({ sourceUtf16: 8_837, classifications: 3 }),
    16_384,
  );
  assert.equal(
    sourceInterpretationTokenLimit({ sourceUtf16: 1000, classifications: 8 }),
    16_384,
  );
  for (const value of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() =>
      sourceInterpretationTokenLimit({
        sourceUtf16: value,
        classifications: 1,
      }),
    );
    assert.throws(() =>
      sourceInterpretationTokenLimit({
        sourceUtf16: 100,
        classifications: value,
      }),
    );
  }
});

test("Server classification context retains every original label and reference independently of model citations", () => {
  const input = context();
  const request = buildSourceInterpretationRequest(input);
  const value = response();
  value.components[0].sourceRefs = ["s1"];
  value.classificationReadings[0].sourceRefs = ["s2"];
  const record = recordSourceInterpretation(value, request, metadata);
  const result = readSourceInterpretation(record, request)!;
  assert.deepEqual(record.classificationContext, [
    { id: "c1", ...input.body.classifications[0] },
  ]);
  assert.deepEqual(result.classificationContext, record.classificationContext);
  assert.equal(
    result.evidence.find((item) => item.id === "s3")!.text,
    input.body.classifications[0].labels[0].text,
  );
  assert.ok(Object.isFrozen(record.classificationContext[0].labels[0]));
  const prompt = JSON.parse(request.prompt);
  assert.deepEqual(prompt.classificationContext, record.classificationContext);
  assert.equal("classifications" in prompt, false);
  assert.equal("classificationContext" in value, false);
  assert.throws(() =>
    recordSourceInterpretation(
      { ...value, classificationContext: [] },
      request,
      metadata,
    ),
  );
});

test("Omitted duplicate invented or ungrounded classification readings reject the whole response", () => {
  const request = buildSourceInterpretationRequest(context());
  const valid = response();
  for (const classificationReadings of [
    [],
    [...valid.classificationReadings, ...valid.classificationReadings],
    [{ ...valid.classificationReadings[0], classificationId: "c99" }],
    [{ ...valid.classificationReadings[0], sourceRefs: ["s1"] }],
    [{ ...valid.classificationReadings[0], use: "shared_project_only" }],
  ]) {
    assert.throws(() =>
      recordSourceInterpretation(
        { ...valid, classificationReadings },
        request,
        metadata,
      ),
    );
  }
  for (const grounding of [
    { ...valid.components[0].meaning, objectRefs: ["s3"] },
    { ...valid.components[0].meaning, objectRefs: ["s4"] },
    { ...valid.components[0].meaning, classificationContextIds: ["c99"] },
  ])
    assert.throws(() =>
      recordSourceInterpretation(
        {
          ...valid,
          components: [{ ...valid.components[0], meaning: grounding }],
        },
        request,
        metadata,
      ),
    );
});

test("Exact classification binding rejects rehashed label scope and provenance tampering", () => {
  const request = buildSourceInterpretationRequest(context());
  const record = recordSourceInterpretation(response(), request, metadata);
  const { hash: _hash, ...unsigned } = record;
  for (const classificationContext of [
    [],
    [
      {
        ...record.classificationContext[0],
        appliesTo: "shared_project_context",
      },
    ],
    [{ ...record.classificationContext[0], rawPath: "/invented/cpvCode" }],
    [
      {
        ...record.classificationContext[0],
        labels: [
          { ...record.classificationContext[0].labels[0], text: "Substitute" },
        ],
      },
    ],
    [
      {
        ...record.classificationContext[0],
        code: { text: "00000000", sourceRefs: ["s3"] },
      },
    ],
  ]) {
    const altered = { ...unsigned, classificationContext };
    const hash = createHash("sha256")
      .update(stableDocumentaryJson(altered))
      .digest("hex");
    assert.throws(
      () => readSourceInterpretation({ ...altered, hash }, request),
      /classification context mismatch/,
    );
  }
});

test("Domain grounding requires a target label; unknown code meanings and material ambiguity cannot be resolved", () => {
  const request = buildSourceInterpretationRequest(context());
  const value = response();
  const classified = {
    ...value,
    components: [
      {
        ...value.components[0],
        meaning: {
          ...value.components[0].meaning,
          basis: "text_with_classification_context",
          classificationContextIds: ["c1"],
        },
      },
    ],
    classificationReadings: [
      {
        ...value.classificationReadings[0],
        use: "clarifies_domain",
        sourceRefs: ["s3"],
      },
    ],
  };
  assert.equal(
    validateSourceInterpretation(classified, request).status,
    "resolved",
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        {
          ...classified,
          classificationReadings: [
            { ...classified.classificationReadings[0], sourceRefs: ["s2"] },
          ],
        },
        request,
      ),
    /original label/,
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        { ...classified, components: value.components },
        request,
      ),
    /grounded component/,
  );
  const ambiguous = {
    ...value,
    components: [
      {
        ...value.components[0],
        meaning: {
          ...value.components[0].meaning,
          state: "ambiguous",
          basis: "unresolved",
        },
      },
    ],
  };
  assert.throws(
    () => validateSourceInterpretation(ambiguous, request),
    /identified meaning/,
  );
  const unresolved = {
    ...ambiguous,
    status: "uncertain",
    classificationReadings: [
      { ...value.classificationReadings[0], use: "unresolved" },
    ],
    issues: [
      {
        ...issueFields("object_identity", [0]),
        explanation: "Il testo lascia indeterminato il prodotto concreto.",
        sourceRefs: ["s1", "s3"],
      },
    ],
  };
  const uncertain = readSourceInterpretation(
    recordSourceInterpretation(unresolved, request, metadata),
    request,
  )!;
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.response.status, "uncertain");
  assert.equal(uncertain.components[0].meaning.state, "ambiguous");
  assert.throws(
    () =>
      validateSourceInterpretation(
        { ...value, classificationReadings: unresolved.classificationReadings },
        request,
      ),
    /settled classification context/,
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        { ...unresolved, status: "resolved", issues: [] },
        request,
      ),
    /identified meaning/,
  );
  const input = context();
  const codeOnly = {
    ...input,
    body: {
      ...input.body,
      classifications: [{ ...input.body.classifications[0], labels: [] }],
    },
  };
  const codeOnlyValue = response(codeOnly);
  codeOnlyValue.components[0].sourceRefs = ["s1"];
  const codeRequest = buildSourceInterpretationRequest(codeOnly);
  assert.equal(
    validateSourceInterpretation(codeOnlyValue, codeRequest).status,
    "resolved",
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        {
          ...classified,
          classificationReadings: [
            { ...classified.classificationReadings[0], sourceRefs: ["s2"] },
          ],
        },
        codeRequest,
      ),
    /original label/,
  );
});

test("Classification conflicts retain both source assertions and cannot be declared resolved", () => {
  const request = buildSourceInterpretationRequest(context());
  const value = response();
  const reading = {
    ...value.classificationReadings[0],
    use: "conflicting",
    sourceRefs: ["s1", "s3"],
  };
  const conflict = {
    ...value,
    status: "conflicting",
    classificationReadings: [reading],
    issues: [
      {
        ...issueFields("source_conflict"),
        explanation:
          "Due asserzioni inventate incompatibili sullo stesso acquisto.",
        sourceRefs: ["s1", "s3"],
      },
    ],
  };
  assert.equal(
    validateSourceInterpretation(conflict, request).status,
    "conflicting",
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        { ...conflict, status: "resolved", issues: [] },
        request,
      ),
    /settled classification context/,
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        {
          ...conflict,
          classificationReadings: [{ ...reading, sourceRefs: ["s3"] }],
        },
        request,
      ),
    /two references/,
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        {
          ...conflict,
          issues: [{ ...conflict.issues[0], sourceRefs: ["s1", "s4"] }],
        },
        request,
      ),
    /two references/,
  );
  // Structure records the asserted conflict; no test pretends these invented
  // statements establish a real semantic contradiction.
});

test("Clear prose without classifications remains usable and has no synthetic domain context", () => {
  const input = context();
  const noCpv: SourceInterpretationContext = {
    ...input,
    body: {
      ...input.body,
      classifications: [],
      passages: input.body.passages.filter(
        (item) => item.id === "s1" || item.id === "s4",
      ),
    },
  };
  const value = response(noCpv);
  value.components[0].sourceRefs = ["s1"];
  const request = buildSourceInterpretationRequest(noCpv);
  const record = recordSourceInterpretation(value, request, metadata);
  assert.deepEqual(record.classificationContext, []);
  assert.deepEqual(record.response.classificationReadings, []);
  assert.equal(readSourceInterpretation(record, request)!.status, "resolved");
});

test("Shared classification can clarify only an unclassified lot with its own object evidence", () => {
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
          rawPath: "/lots/0/description/it",
        },
      ],
    },
  };
  const request = buildSourceInterpretationRequest(lot);
  const valid = { ...response(lot), targetRef: "s5" };
  assert.equal(validateSourceInterpretation(valid, request).status, "resolved");
  const clarified = {
    ...valid,
    classificationReadings: [
      { ...valid.classificationReadings[0], use: "clarifies_domain" },
    ],
    components: [
      {
        ...valid.components[0],
        sourceRefs: ["s5", "s3"],
        roleEvidence: roleEvidence(lot, "s5"),
        meaning: {
          ...valid.components[0].meaning,
          basis: "text_with_classification_context",
          objectRefs: ["s5"],
          classificationContextIds: ["c1"],
        },
      },
    ],
  };
  assert.equal(
    validateSourceInterpretation(clarified, request).status,
    "resolved",
  );
  assert.throws(
    () =>
      validateSourceInterpretation(
        {
          ...clarified,
          components: [
            {
              ...clarified.components[0],
              sourceRefs: ["s1", "s3"],
              roleEvidence: roleEvidence(lot, "s1"),
              meaning: {
                ...clarified.components[0].meaning,
                objectRefs: ["s1"],
              },
            },
          ],
        },
        request,
      ),
    /target domain clarification/,
  );
  const ownClassification: SourceInterpretationContext = {
    ...lot,
    body: {
      ...lot.body,
      classifications: [
        ...lot.body.classifications,
        {
          ...input.body.classifications[0],
          scope: "selected_lot",
          rawPath: "/lots/0/cpvCode",
          code: { text: "00000000", sourceRefs: ["s6"] },
          labels: [
            {
              language: "it",
              text: "FAMIGLIA_INVENTATA 🌳",
              sourceRefs: ["s7"],
            },
          ],
        },
      ],
      passages: [
        ...lot.body.passages,
        {
          ...input.body.passages[1],
          id: "s6",
          scope: "selected_lot",
          rawPath: "/lots/0/cpvCode/code",
        },
        {
          ...input.body.passages[2],
          id: "s7",
          scope: "selected_lot",
          rawPath: "/lots/0/cpvCode/label/it",
        },
      ],
    },
  };
  const localRequest = buildSourceInterpretationRequest(ownClassification);
  assert.throws(
    () =>
      validateSourceInterpretation(
        {
          ...clarified,
          classificationReadings: [
            ...clarified.classificationReadings,
            response(ownClassification).classificationReadings[1],
          ],
        },
        localRequest,
      ),
    /target domain clarification/,
  );
  assert.equal(
    request.classificationContext[0].appliesTo,
    "shared_project_context",
  );
});

test("Multilingual classification labels spanning passages retain exact ordered provenance", () => {
  const input = context();
  const parts = ["Invented ", "family 🌳"];
  const split: SourceInterpretationContext = {
    ...input,
    body: {
      ...input.body,
      classifications: [
        {
          ...input.body.classifications[0],
          labels: [
            ...input.body.classifications[0].labels,
            { language: "en", text: parts.join(""), sourceRefs: ["s5", "s6"] },
          ],
        },
      ],
      passages: [
        ...input.body.passages,
        ...parts.map((text, index) => ({
          ...input.body.passages[2],
          id: `s${index + 5}`,
          rawPath: "/procurement/cpvCode/label/en",
          startUtf16: index ? parts[0].length : 0,
          endUtf16: index ? parts.join("").length : parts[0].length,
          text,
        })),
      ],
    },
  };
  const request = buildSourceInterpretationRequest(split);
  const value = response(split);
  value.classificationReadings[0].sourceRefs = ["s2"];
  const read = readSourceInterpretation(
    recordSourceInterpretation(value, request, metadata),
    request,
  )!;
  assert.deepEqual(
    read.classificationContext[0].labels,
    split.body.classifications[0].labels,
  );
  assert.deepEqual(
    ["s5", "s6"].map(
      (id) => read.evidence.find((item) => item.id === id)!.text,
    ),
    parts,
  );
});

test("Provider schema forbids shared-project details on project targets while preserving lot context and relational checks", () => {
  const project = buildSourceInterpretationRequest(context());
  const value = response();
  const shared = {
    ...value,
    details: [
      {
        kind: "shared_project_context",
        explanation: "Contesto inventato",
        sourceRefs: ["s4"],
        scope: "project_context",
      },
    ],
  };
  const validate = new Ajv2020({ strict: false }).compile(
    project.responseFormat.json_schema.schema,
  );
  assert(validate(wireResponse(value)));
  assert.equal(validate(wireResponse(shared)), false);
  assert.throws(
    () => validateSourceInterpretation(shared, project),
    /Shared project detail requires a lot/,
  );
  const orphan = {
    ...value,
    classificationReadings: value.classificationReadings.map((r) => ({
      ...r,
      use: "clarifies_domain",
    })),
  };
  assert.throws(
    () => validateSourceInterpretation(orphan, project),
    /grounded component/,
  );
  assert(
    JSON.stringify(project.responseFormat).includes(
      "meaning.classificationContextIds",
    ),
  );
  assert(
    JSON.stringify(project.responseFormat).includes(
      "shared_project_context è ammesso solo per un lotto",
    ),
  );
  const linked = {
    ...orphan,
    components: orphan.components.map((item, index) =>
      index === 0
        ? {
            ...item,
            meaning: {
              ...item.meaning,
              classificationContextIds: ["c1"],
              basis: "text_with_classification_context",
            },
          }
        : item,
    ),
  };
  assert.equal(
    validateSourceInterpretation(linked, project).status,
    "resolved",
  );
});

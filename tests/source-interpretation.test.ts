import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import {
  SOURCE_INTERPRETATION_VERSION,
  SOURCE_INTERPRETATION_MAX_TOKENS,
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
function meaning(statement: string, objectRefs: string[]) {
  return {
    state: "identified" as const,
    statement,
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
        meaning: meaning("Prodotti inventati esplicitamente descritti", ["s1"]),
      },
      {
        description: "Posa",
        role: "install" as const,
        roleEvidence: roleEvidence(input, "s4"),
        importance: "accessory" as const,
        sourceRefs: ["s4"],
        meaning: meaning("Posa accessoria", ["s4"]),
      },
      {
        description: "Trasporto",
        role: "execute" as const,
        roleEvidence: roleEvidence(input, "s4"),
        importance: "excluded" as const,
        sourceRefs: ["s4"],
        meaning: meaning("Trasporto escluso", ["s4"]),
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
  assert.equal(provider(value), true);
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
  assert.equal(provider(untypedBlockingDetail), false);
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
  assert.equal(provider(unresolved), true);
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
    assert.equal(provider(value), false);
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

test("Role action quotations preserve contiguous long-source fragments and never bridge gaps or fields", () => {
  const input = context();
  const first = "Gestione continuativa ",
    second = "del deposito 🌳.";
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
          actionText: first + second,
          sourceRefs: ["s5", "s1"],
          scope: "project_context",
        },
      },
    ],
  };
  assert.equal(validateSourceInterpretation(value, request).status, "resolved");
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
});

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
  assert.equal(validate(incoherent), false);
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
    assert.equal(providerAccepts(value), wanted, name);
    if (wanted)
      assert.deepEqual(
        validateSourceInterpretation(value, request).response,
        value,
        name,
      );
    else
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
    assert.equal(providerAccepts(value), true);
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
          : `Prestazione inventata numero ${index}: `.padEnd(230, "x");
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
          meaning: meaning("Gestione del deposito", ["s4"]),
        },
        {
          description: "Pulizia del deposito.",
          role: "execute",
          roleEvidence: roleEvidence(request, "s4"),
          importance: "accessory",
          sourceRefs: ["s4"],
          meaning: meaning("Pulizia del deposito", ["s4"]),
        },
        {
          description: "Manutenzione dei mezzi.",
          role: "maintain",
          roleEvidence: roleEvidence(request, "s4"),
          importance: "excluded",
          sourceRefs: ["s4"],
          meaning: meaning("Manutenzione dei mezzi", ["s4"]),
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
          meaning: meaning(serviceText, ["s1"]),
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

test("A source v5 record is stale under v6 before parsing its historical schema", () => {
  const request = buildSourceInterpretationRequest(context());
  assert.equal(request.version, "documentary-source-interpretation-v6");
  const current = recordSourceInterpretation(response(), request, metadata);
  const digest = (value: unknown) =>
    createHash("sha256").update(stableDocumentaryJson(value)).digest("hex");
  const { hash: _hash, ...unsigned } = current;
  const historicalBody = {
    ...unsigned,
    version: "documentary-source-interpretation-v5",
    sourceKey: digest({
      version: "documentary-source-interpretation-v5",
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

test("Source output allowance remains 8192 with or without thinking and is bound to the request", () => {
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
  const { maxTokens: _maxTokens, ...unbound } = input.binding;
  for (const binding of [unbound, { ...input.binding, maxTokens: 1600 }])
    assert.throws(() =>
      buildSourceInterpretationRequest(
        JSON.parse(JSON.stringify({ ...input, binding })),
      ),
    );
  const stored = recordSourceInterpretation(response(), high, metadata);
  assert.equal(readSourceInterpretation(stored, none), null);
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

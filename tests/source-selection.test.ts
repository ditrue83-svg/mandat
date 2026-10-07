import assert from "node:assert/strict";
import { test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import {
  resolveSourceSelection,
  resolveSourceTextSelection,
} from "../src/lib/source-selection";
import { validateCoverageProof } from "../src/lib/source-coverage-proof";
import {
  buildSourceInterpretationRequest,
  recordSourceInterpretation,
  type SourceInterpretationContext,
} from "../src/lib/source-interpretation";
import {
  buildSourceSemanticReviewRequest,
  buildGroundedSourceReviewRequests,
  recordSourceSemanticReview,
} from "../src/lib/source-semantic-review";
import {
  inventedSourceEvidence,
  inventedReadingRefs,
} from "./helpers/source-evidence-fixture";
import { openaiResponseBody } from "../src/lib/openai-responses";

// Invented minimal reproductions of the five recorded failure mechanisms.
// These are protocol regressions, not re-scoring any archived model answer.
const passage = (
  id: string,
  text: string,
  rawPath = "/procurement/orderDescription/it",
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
      target: { kind: "project", publicationId: "invented" },
      source: { original: "invented" },
      fieldsHash: "a".repeat(64),
      shapeEpochToken: "invented",
      model: "invented-model",
      reasoningEffort: "medium",
      maxTokens: 8192,
    },
    targetScope: "project_context",
    coverage: {
      completeProvidedSource: true,
      linkedDocumentsRead: false,
      sourceUtf16: 300,
      fields: 4,
      chunks: 1,
    },
    readings: [],
    body: {
      target: { kind: "project", lot: null },
      fields: [],
      classifications: [
        {
          scope: "project_context",
          appliesTo: "target",
          rawPath: "/procurement/cpvCode",
          code: null,
          labels: [
            { language: "it", text: "Progettazione", sourceRefs: ["s2"] },
          ],
        },
      ],
      passages: [
        passage("s1", "Revisione del progetto definitivo."),
        {
          ...passage("s2", "Progettazione", "/procurement/cpvCode/label/it"),
          role: "context",
        },
        {
          ...passage(
            "s3",
            "Iscrizione obbligatoria alla visita.",
            "/dates/walkThrough",
          ),
          role: "context",
        },
        {
          ...passage(
            "s4",
            "Senza visita l'offerta non sarà considerata.",
            "/terms/walkThroughNotes/it",
          ),
          role: "context",
        },
      ],
    },
  };
}
const metadata = {
  id: "invented-local-only",
  at: "2030-01-01T12:00:00Z",
  model: "invented-model",
};
const span = (sourceRef: string, startUtf16: number, endUtf16: number) => ({
  sourceRef,
  startUtf16,
  endUtf16,
});
function wire(input = context()): any {
  return {
    evidenceFormat: "source_selections_v11",
    status: "resolved",
    targetRef: "s1",
    summary: "Revisione del progetto definitivo.",
    summarySourceRefs: ["s1"],
    components: [
      {
        description: "Revisione del progetto definitivo.",
        importance: "not_stated",
        role: "design",
        evidence: [{ sourceRef: "s1" }],
        roleEvidence: {
          state: "identified",
          scope: "project_context",
          actionSelection: { sourceRef: "s1", exactText: "Revisione" },
        },
        meaning: {
          state: "identified",
          statement: "Progetto definitivo da revisionare.",
          objectSelection: {
            sourceRef: "s1",
            exactText: "del progetto definitivo",
          },
          basis: "text_with_classification_context",
        },
      },
    ],
    classificationReadingsById: {
      c1: {
        ownSourceRef: "s2",
        use: "clarifies_domain",
        sourceRefs: [],
        explanation: "Etichetta originale relativa alla progettazione.",
        componentIndexes: [0],
      },
    },
    details: [
      {
        kind: "execution_condition",
        scope: "project_context",
        quoteSelection: {
          sourceRef: "s3",
          exactText: input.body.passages[2].text,
        },
      },
    ],
    contractClauseDetails: {
      s4: [
        {
          kind: "execution_condition",
          scope: "project_context",
          explanation: input.body.passages[3].text,
          sourceRefs: ["s4"],
        },
      ],
    },
    issues: [],
  };
}

test("V11 copies the original preposition and has one classification-to-component link", () => {
  const input = context(),
    request = buildSourceInterpretationRequest(input),
    value = wire(input);
  const before = JSON.stringify({ input, value });
  const native = openaiResponseBody(
    "gpt-6-luna",
    request.system,
    request.prompt,
    request.maxTokens,
    request.responseFormat,
    "medium",
  );
  const accepts = new Ajv2020({ strict: false }).compile(
    native.text!.format.schema,
  );
  assert(accepts({ result: value }), JSON.stringify(accepts.errors));
  const record = recordSourceInterpretation(value, request, metadata);
  assert.equal(
    record.response.components[0].meaning.objectText,
    "del progetto definitivo",
  );
  assert.deepEqual(
    record.response.components[0].meaning.classificationContextIds,
    ["c1"],
  );
  assert.equal(record.response.components[0].role, "design");
  assert.deepEqual(record.response.components[0].meaning.objectRefs, ["s1"]);
  assert.equal(JSON.stringify({ input, value }), before);
  for (const mutate of [
    (v: any) => {
      v.components[0].meaning.objectText = "il progetto definitivo";
    },
    (v: any) => {
      v.classificationReadingsById.c1.componentIndexes = [];
    },
    (v: any) => {
      v.details[0].explanation = "Senza visita l'offerta non sarà considerata.";
    },
  ]) {
    const bad = structuredClone(value);
    mutate(bad);
    assert(!accepts({ result: bad }));
    assert.throws(() => recordSourceInterpretation(bad, request, metadata));
  }
  for (const indexes of [[1], [0, 0]]) {
    const bad = structuredClone(value);
    bad.classificationReadingsById.c1.componentIndexes = indexes;
    assert.throws(
      () => recordSourceInterpretation(bad, request, metadata),
      /distinct existing component/,
    );
  }
});

test("Additional details cannot append a document-source enum or a visit consequence from another field", () => {
  const input = context();
  const value = wire(input),
    request = buildSourceInterpretationRequest(input);
  const record = recordSourceInterpretation(value, request, metadata);
  assert.equal(
    record.response.details[0].explanation,
    "Iscrizione obbligatoria alla visita.",
  );
  assert.deepEqual(record.response.details[0].sourceRefs, ["s3"]);
  assert.equal(
    record.response.details[1].explanation,
    "Senza visita l'offerta non sarà considerata.",
  );
  assert.deepEqual(record.response.details[1].sourceRefs, ["s4"]);
  const bad = structuredClone(value);
  bad.details[0].quoteSelection.exactText = "Contenuto inesistente";
  assert.throws(
    () => recordSourceInterpretation(bad, request, metadata),
    /not an exact original span/,
  );
  const docs = {
    ...input,
    body: {
      ...input.body,
      passages: [
        ...input.body.passages,
        {
          ...passage(
            "s5",
            "documents_source_simap",
            "/project-info/documentsSourceType",
          ),
          role: "context" as const,
        },
      ],
    },
  };
  const requestDocs = buildSourceInterpretationRequest(docs);
  const docsWire = wire(docs);
  docsWire.contractClauseDetails.s5 = [
    {
      kind: "execution_condition",
      scope: "project_context",
      explanation: "Fonte: documents_source_simap.",
      sourceRefs: ["s5"],
    },
  ];
  docsWire.details[0].explanation = "documents_source_simap";
  assert.throws(() =>
    recordSourceInterpretation(docsWire, requestDocs, metadata),
  );
  delete docsWire.details[0].explanation;
  assert.doesNotThrow(() =>
    recordSourceInterpretation(docsWire, requestDocs, metadata),
  );
});

test("Selections retain exact contiguous spans and reject gaps, another lot and split Unicode", () => {
  const first = passage("s1", "del progetto ");
  const second = {
    ...passage("s2", "definitivo 🌳"),
    startUtf16: first.text.length,
    endUtf16: first.text.length + "definitivo 🌳".length,
  };
  const groups = [{ id: "g1", sourceRefs: ["s1", "s2"] }];
  assert.equal(
    resolveSourceSelection(span("g1", 0, 23), [first, second], groups).text,
    "del progetto definitivo",
  );
  assert.throws(
    () =>
      resolveSourceSelection(
        span("g1", 0, 23),
        [first, { ...second, scope: "selected_lot" }],
        groups,
      ),
    /scopes or gaps/,
  );
  assert.throws(
    () =>
      resolveSourceSelection(
        span("g1", 0, 23),
        [
          first,
          {
            ...second,
            startUtf16: second.startUtf16 + 1,
            endUtf16: second.endUtf16 + 1,
          },
        ],
        groups,
      ),
    /scopes or gaps/,
  );
  assert.throws(
    () => resolveSourceSelection(span("s2", 11, 12), [second]),
    /splits a character/,
  );
  const value = wire();
  value.components[0].meaning.objectSelection = {
    sourceRef: "s3",
    exactText: "Iscrizione",
  };
  assert.throws(
    () =>
      recordSourceInterpretation(
        value,
        buildSourceInterpretationRequest(context()),
        metadata,
      ),
    /own component evidence/,
  );
});

test("Literal selections locate complete actions without asking the provider to count characters", () => {
  const source = passage(
    "s1",
    "🌳 Appalto per il servizio di noleggio, lavaggio e stiratura della biancheria.",
  );
  const before = JSON.stringify(source);
  for (const exactText of [
    "noleggio",
    "lavaggio e stiratura",
    "della biancheria",
  ])
    assert.deepEqual(
      resolveSourceTextSelection({ sourceRef: "s1", exactText }, [source]),
      {
        text: exactText,
        sourceRefs: ["s1"],
        scope: "project_context",
      },
    );
  for (const exactText of [
    "noleg",
    "ggio",
    "delle biancherie",
    "Noleggio",
    " ",
  ])
    assert.throws(() =>
      resolveSourceTextSelection({ sourceRef: "s1", exactText }, [source]),
    );
  assert.equal(JSON.stringify(source), before);
});

test("Literal selectors neither normalize nor choose an arbitrary occurrence", () => {
  const source = passage(
    "s1",
    "Posa di tubi. Posa di raccordi. Caffe\u0300.\nOpere di\nposa.",
  );
  assert.throws(
    () =>
      resolveSourceTextSelection({ sourceRef: "s1", exactText: "Posa" }, [
        source,
      ]),
    /ambiguous/,
  );
  assert.equal(
    resolveSourceTextSelection(
      { sourceRef: "s1", exactText: "Posa di raccordi" },
      [source],
    ).text,
    "Posa di raccordi",
  );
  for (const exactText of ["Caffè", "Opere di posa", "Caffe"])
    assert.throws(() =>
      resolveSourceTextSelection({ sourceRef: "s1", exactText }, [source]),
    );
  assert.equal(
    resolveSourceTextSelection(
      { sourceRef: "s1", exactText: "Opere di\nposa" },
      [source],
    ).text,
    "Opere di\nposa",
  );
  assert.throws(() =>
    resolveSourceTextSelection(
      { sourceRef: "s1", exactText: "a".repeat(601) },
      [source],
    ),
  );
});

test("Literal group selections preserve field ownership and reject scope or location gaps", () => {
  const first = passage("s1", "Fornitura e ");
  const second = {
    ...passage("s2", "posa di condotte."),
    startUtf16: first.text.length,
    endUtf16: first.text.length + 17,
  };
  const groups = [{ id: "g1", sourceRefs: ["s1", "s2"] }];
  const selection = { sourceRef: "g1", exactText: "Fornitura e posa" };
  assert.deepEqual(
    resolveSourceTextSelection(selection, [first, second], groups).sourceRefs,
    ["s1", "s2"],
  );
  for (const changed of [
    { ...second, scope: "selected_lot" as const },
    { ...second, rawPath: "/another/field" },
    { ...second, url: "https://example.invalid/another" },
    {
      ...second,
      startUtf16: second.startUtf16 + 1,
      endUtf16: second.endUtf16 + 1,
    },
  ])
    assert.throws(
      () => resolveSourceTextSelection(selection, [first, changed], groups),
      /scopes or gaps/,
    );
});

test("Production V11 refuses numeric offsets and altered quotations instead of repairing them", () => {
  const input = context(),
    request = buildSourceInterpretationRequest(input);
  for (const mutate of [
    (v: any) => {
      v.components[0].roleEvidence.actionSelection = span("s1", 0, 9);
    },
    (v: any) => {
      v.components[0].meaning.objectSelection.exactText =
        "il progetto definitivo";
    },
    (v: any) => {
      v.evidenceFormat = "source_selections_v10";
    },
  ]) {
    const value = wire(input);
    mutate(value);
    const before = JSON.stringify(value);
    assert.throws(() => recordSourceInterpretation(value, request, metadata));
    assert.equal(JSON.stringify(value), before);
  }
});

const draftForProof = {
  summary: "Fornitura di cancelleria.",
  summarySourceRefs: ["s1"],
  components: [],
  details: [
    {
      explanation: "Avvio presunto dicembre 2026, durata stimata 24 mesi.",
      sourceRefs: ["s55"],
    },
  ],
};
test("A source date cannot masquerade as a date preserved in the draft; optional omission stays distinct", () => {
  const missingDate = {
    sourceRef: "s56",
    disposition: "represented" as const,
    witnesses: [{ draftPath: "/details/0/explanation", quote: "2026-12-01" }],
  };
  const args = {
    proof: [missingDate],
    ownedSourceRefs: ["s56"],
    kind: "scope_coverage" as const,
    verdict: "supported" as const,
    draft: draftForProof,
  };
  assert.throws(() => validateCoverageProof(args), /own cited draft field/);
  missingDate.witnesses[0].quote = draftForProof.details[0].explanation;
  assert.throws(() => validateCoverageProof(args), /own cited draft field/);
  const optional = [
    { sourceRef: "s56", disposition: "not_required" as const, witnesses: [] },
  ];
  assert.doesNotThrow(() =>
    validateCoverageProof({ ...args, proof: optional }),
  );
  assert.throws(
    () =>
      validateCoverageProof({
        ...args,
        proof: optional,
        kind: "contract_clause_coverage",
      }),
    /mandatory clause/,
  );
  assert.throws(
    () =>
      validateCoverageProof({
        ...args,
        proof: [{ ...optional[0], disposition: "missing" }],
      }),
    /cannot receive supported/,
  );
  assert.throws(
    () => validateCoverageProof({ ...args, proof: [] }),
    /every owned source/,
  );
  const complete = {
    ...draftForProof,
    details: [{ explanation: "Inizio: 2026-12-01.", sourceRefs: ["s56"] }],
  };
  assert.doesNotThrow(() =>
    validateCoverageProof({
      ...args,
      draft: complete,
      proof: [
        {
          ...missingDate,
          witnesses: [
            { draftPath: "/details/0/explanation", quote: "2026-12-01" },
          ],
        },
      ],
    }),
  );
});

test("Production review V5 requires explicit coverage proof and cannot emit the false positive preservation reason", () => {
  const input = context(),
    request = buildSourceInterpretationRequest(input);
  const draft = recordSourceInterpretation(wire(input), request, metadata);
  const plan = buildSourceSemanticReviewRequest(input, draft, {
    model: metadata.model,
  });
  const evidence = inventedSourceEvidence(plan);
  const requests = buildGroundedSourceReviewRequests(plan, evidence);
  const responses = requests.map((r) => {
    const body = JSON.parse(r.prompt);
    return {
      chunkId: r.id,
      sourceEvidenceHash: body.sourceEvidenceHash,
      coverage: "complete",
      findings: [],
      checksFormat: "claim_keyed_refs_v5",
      checksByClaim: Object.fromEntries(
        r.assignedClaimIds.map((id) => {
          const claim = plan.claims.find((c) => c.id === id)!;
          const readings = inventedReadingRefs(body, claim);
          const group = r.claimReadingGroups.find((g) =>
            g.claimIds.includes(id),
          )!;
          const proof = claim.kind.endsWith("coverage")
            ? claim.sourceRefs.map((sourceRef) => {
                const detail = draft.response.details.findIndex((d) =>
                  d.sourceRefs.includes(sourceRef),
                );
                return detail >= 0
                  ? {
                      sourceRef,
                      disposition: "represented",
                      witnesses: [
                        {
                          draftPath: `/details/${detail}/explanation`,
                          quote: draft.response.details[detail].explanation,
                        },
                      ],
                    }
                  : sourceRef === "s1"
                    ? {
                        sourceRef,
                        disposition: "represented",
                        witnesses: [
                          {
                            draftPath: "/summary",
                            quote: draft.response.summary,
                          },
                        ],
                      }
                    : { sourceRef, disposition: "not_required", witnesses: [] };
              })
            : [];
          return [
            id,
            {
              verdict: "supported",
              draftQuote: null,
              reason:
                "Le prove indicate sostengono il claim; coverageProof distingue fatti rappresentati e dati facoltativi.",
              sourceRefs: claim.sourceRefs,
              readingRefsById: Object.fromEntries(
                (group.supportedReadingIds ?? group.readingIds).map((ref) => [
                  ref,
                  readings.includes(ref),
                ]),
              ),
              coverageBySource: Object.fromEntries(
                proof.map((row) => [
                  row.sourceRef,
                  {
                    disposition: row.disposition,
                    draftPaths: row.witnesses.map((w) => w.draftPath),
                  },
                ]),
              ),
            },
          ];
        }),
      ),
    };
  });
  requests.forEach((r, index) => {
    const native = openaiResponseBody(
      "gpt-6-luna",
      r.system,
      r.prompt,
      r.maxTokens,
      r.responseFormat,
    );
    const accepts = new Ajv2020({ strict: false }).compile(
      native.text!.format.schema,
    );
    assert(accepts(responses[index]), JSON.stringify(accepts.errors));
    const bad = structuredClone(responses[index]);
    const check: any = Object.values(bad.checksByClaim).find(
      (c: any) => Object.keys(c.coverageBySource).length,
    );
    check.reason =
      "Le date precise sono conservate nei dettagli o nel summary.";
    assert(!accepts(bad));
    const missing = structuredClone(responses[index]);
    const mandatory = plan.claims.find(
      (c) =>
        r.assignedClaimIds.includes(c.id) &&
        c.kind === "contract_clause_coverage",
    );
    if (mandatory) {
      const claim: any = missing.checksByClaim[mandatory.id];
      const original = structuredClone(claim.coverageBySource);
      claim.coverageBySource = {};
      assert.equal(accepts(missing), false);
      claim.coverageBySource = original;
      const ref = mandatory.sourceRefs[0];
      claim.coverageBySource[ref] = { disposition: "missing", draftPaths: [] };
      assert.equal(accepts(missing), false);
      claim.coverageBySource[ref] = {
        disposition: "not_required",
        draftPaths: [],
      };
      assert.equal(accepts(missing), false);
    }
  });
  assert.doesNotThrow(() =>
    recordSourceSemanticReview(responses, plan, {
      ...metadata,
      sourceEvidence: evidence,
    }),
  );
  const bad = structuredClone(responses);
  const check: any = bad
    .flatMap((r) => Object.values(r.checksByClaim))
    .find((c: any) => Object.keys(c.coverageBySource).length);
  check.coverageBySource = {};
  assert.throws(
    () =>
      recordSourceSemanticReview(bad, plan, {
        ...metadata,
        sourceEvidence: evidence,
      }),
    /./,
  );
});

test("Classification selections bind every ID to its own label and target scope on the wire", () => {
  const input = context();
  const withCpc = {
    ...input,
    body: {
      ...input.body,
      passages: [
        ...input.body.passages,
        {
          ...passage(
            "s5",
            "CPC: altri servizi",
            "/procurement/cpcCode/label/it",
          ),
          role: "context" as const,
        },
      ],
    },
  };
  const request = buildSourceInterpretationRequest(withCpc);
  const original = wire(withCpc);
  const native = openaiResponseBody(
    "gpt-6-luna",
    request.system,
    request.prompt,
    request.maxTokens,
    request.responseFormat,
  );
  const accepts = new Ajv2020({ strict: false }).compile(
    native.text!.format.schema,
  );
  assert(accepts({ result: original }));
  for (const mutate of [
    (v: any) => {
      v.classificationReadingsById.c1.ownSourceRef = "s5";
    },
    (v: any) => {
      v.classificationReadingsById.c1.use = "shared_project_only";
    },
    (v: any) => {
      delete v.classificationReadingsById.c1;
    },
    (v: any) => {
      v.classificationReadingsById.c2 = { ...v.classificationReadingsById.c1 };
    },
    (v: any) => {
      v.evidenceFormat = "source_selections_v9";
    },
  ]) {
    const bad = structuredClone(original);
    mutate(bad);
    assert(!accepts({ result: bad }));
    assert.throws(() => recordSourceInterpretation(bad, request, metadata));
  }
  const broad = structuredClone(original);
  broad.classificationReadingsById.c1.use = "broad_context";
  broad.classificationReadingsById.c1.componentIndexes = [];
  broad.components[0].meaning.basis = "explicit_text";
  assert(accepts({ result: broad }));
  const result = recordSourceInterpretation(broad, request, metadata);
  assert.deepEqual(result.response.classificationReadings[0].sourceRefs, [
    "s2",
  ]);
  assert.equal(result.response.classificationReadings[0].use, "broad_context");
});

test("No classification keys are invented when the source has no classification metadata", () => {
  const original = context();
  const input = {
    ...original,
    body: { ...original.body, classifications: [] },
  };
  const request = buildSourceInterpretationRequest(input),
    value = wire(input);
  value.classificationReadingsById = {};
  value.components[0].meaning.basis = "explicit_text";
  const native = openaiResponseBody(
    "gpt-6-luna",
    request.system,
    request.prompt,
    request.maxTokens,
    request.responseFormat,
  );
  const accepts = new Ajv2020({ strict: false }).compile(
    native.text!.format.schema,
  );
  assert.equal(accepts({ result: value }), true);
  const record = recordSourceInterpretation(value, request, metadata);
  assert.deepEqual(record.response.classificationReadings, []);
  assert.deepEqual(
    record.response.components[0].meaning.classificationContextIds,
    [],
  );
  value.classificationReadingsById.c1 = wire().classificationReadingsById.c1;
  assert.equal(accepts({ result: value }), false);
  assert.throws(() => recordSourceInterpretation(value, request, metadata));
});

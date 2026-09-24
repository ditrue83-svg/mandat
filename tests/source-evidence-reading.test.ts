import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import { test } from "vitest";
import {
  buildSourceEvidenceReadingRequest,
  recordSourceEvidenceReading,
  readSourceEvidenceReading,
} from "../src/lib/source-evidence-reading";
import type { SourceInterpretationContext } from "../src/lib/source-interpretation";
import { inventedSourceEvidenceAnswer } from "./helpers/source-evidence-fixture";
import { stableDocumentaryJson } from "../src/lib/documentary-observation";

const config = {
  model: "invented-independent-model",
  reasoningEffort: "high" as const,
};
const metadata = {
  id: "invented-evidence",
  at: "2030-01-01T12:00:00.000Z",
  model: config.model,
};
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
      a.classifications[0].label.text = "Famiglia tecnica inventata";
    },
    (a: any) => {
      a.classifications[0].label.text = "Famiglia";
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
  assert.throws(
    () => recordSourceEvidenceReading(insufficient, plan, metadata),
    /non-classification evidence/,
  );
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
  assert.equal(
    readSourceEvidenceReading(
      { ...record, version: "source-evidence-reading-v1" },
      plan,
    ),
    null,
  );
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
    const invalid = responses(plan);
    invalid[0].classifications[0].label!.sourceRefs = sourceRefs;
    assert.throws(
      () => recordSourceEvidenceReading(invalid, plan, metadata),
      /complete original label/,
    );
  }
});

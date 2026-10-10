import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  buildSourceEvidenceReadingRequest,
  recordSourceEvidenceReading,
  readSourceEvidenceReading,
} from "../src/lib/source-evidence-reading";
import type { SourceInterpretationContext } from "../src/lib/source-interpretation";
import { stableDocumentaryJson } from "../src/lib/documentary-observation";
import {
  inventedSourceEvidenceAnswer,
  encodeInventedSourceEvidenceAnswer,
  compileInventedSourceEvidenceSchema,
} from "./helpers/source-evidence-fixture";
const config = {
  model: "invented-partial-reader",
  reasoningEffort: "high" as const,
};
const metadata = {
  id: "toy-detail-reading",
  at: "2030-01-01T12:00:00.000Z",
  model: config.model,
};
function context(long = false): SourceInterpretationContext {
  const texts = [
    {
      id: "s1",
      rawPath: "/title/it",
      role: "service" as const,
      text: "Fornitura di quadri inventati.",
    },
    {
      id: "s2",
      rawPath: "/specifications/it",
      role: "context" as const,
      text: "Le quantità sono rinviate al capitolato allegato.",
    },
  ];
  if (long)
    for (let i = 3; i < 34; i++)
      texts.push({
        id: `s${i}`,
        rawPath: `/context/${i}`,
        role: "context",
        text: "Testo amministrativo inventato. ".repeat(180),
      });
  texts.push({
    id: "s40",
    rawPath: "/procurement/orderAddress/city/it",
    role: "context",
    text: "Locarno",
  });
  const passages = texts.map((p) => ({
    ...p,
    scope: "project_context" as const,
    startUtf16: 0,
    endUtf16: p.text.length,
    url: "https://example.invalid/partial",
  }));
  return {
    binding: {
      target: { kind: "project", publicationId: "toy-partial" },
      source: { hash: "toy-source" },
      fieldsHash: "a".repeat(64),
      shapeEpochToken: "toy-shape",
      model: "toy-source-model",
      reasoningEffort: "none",
      maxTokens: 8192,
    },
    targetScope: "project_context",
    coverage: {
      completeProvidedSource: true,
      linkedDocumentsRead: false,
      sourceUtf16: passages.reduce((n, p) => n + p.text.length, 0),
      fields: 0,
      chunks: 1,
    },
    body: {
      target: { kind: "project", lot: null },
      passages,
      fields: [],
      classifications: [],
    },
    readings: [],
  };
}
function fixture(long = false) {
  const input = context(long),
    plan = buildSourceEvidenceReadingRequest(input, config),
    answers: any[] = plan.requests.map((r) =>
      inventedSourceEvidenceAnswer(JSON.parse(r.prompt)),
    ),
    wire = (a = answers) => a.map(encodeInventedSourceEvidenceAnswer);
  return { input, plan, answers, wire };
}
const detail = () => ({
  serviceRef: "s1",
  evidence: [],
  verificationAspects: ["quantities"],
  basis: "document_referral",
  basisEvidence: [{ sourceRef: "s2" }],
});
it("a complete assigned part cannot declare a category globally absent even when later part contains it", () => {
  const f = fixture(true);
  expect(f.plan.requests.length).toBeGreaterThan(1);
  expect(f.plan.requests[0].sourceIds).not.toContain("s40");
  expect(f.plan.requests.some((r) => r.sourceIds.includes("s40"))).toBe(true);
  f.answers[0].missingDetails = [
    { serviceRef: "s1", evidence: [], missingAspects: ["location"] },
  ];
  const accepts = compileInventedSourceEvidenceSchema(
    f.plan.requests[0].responseFormat.json_schema.schema,
  );
  expect(accepts(f.wire()[0])).toBe(false);
  expect(() =>
    recordSourceEvidenceReading(f.wire(), f.plan, metadata),
  ).toThrow();
});
it("ordinary service text plus silence cannot use an absence or unscoped uncertainty basis", () => {
  const f = fixture();
  for (const basis of [
    "not_in_chunk",
    "not_found",
    "globally_absent",
    "unknown_in_source",
  ]) {
    f.answers[0].missingDetails = [{ ...detail(), basis }];
    expect(() =>
      recordSourceEvidenceReading(f.wire(), f.plan, metadata),
    ).toThrow();
  }
});
it("basis evidence is mandatory and cannot be inherited from service or another row", () => {
  const f = fixture();
  const a = detail();
  (a as any).basisEvidence = [];
  f.answers[0].missingDetails = [a];
  expect(() =>
    recordSourceEvidenceReading(f.wire(), f.plan, metadata),
  ).toThrow();
});
it("a real original referral is retained exactly as an unverified semantic note, not a global absence", () => {
  const f = fixture(),
    before = JSON.stringify(f.input);
  f.answers[0].missingDetails = [detail()];
  const record = recordSourceEvidenceReading(f.wire(), f.plan, metadata),
    note = record.responses[0].missingDetails[0];
  expect(note.basisEvidence).toEqual([
    { sourceRef: "s2", text: f.input.body.passages[1].text },
  ]);
  expect(note.verificationAspects).toEqual(["quantities"]);
  expect(note.description).toContain("giudizio AI non verificato");
  expect(note.description).toContain("Nessuna assenza globale");
  expect(note).not.toHaveProperty("missingAspects");
  expect(note.evidence.map((q) => q.sourceRef)).toEqual(["s1", "s2"]);
  expect(JSON.stringify(f.input)).toBe(before);
});
it("an explicit original gap remains distinct from a document referral", () => {
  const f = fixture();
  f.input.body.passages[1].text = "La marca non è specificata.";
  f.input.body.passages[1].endUtf16 = f.input.body.passages[1].text.length;
  const plan = buildSourceEvidenceReadingRequest(f.input, config),
    a: any[] = plan.requests.map((r) =>
      inventedSourceEvidenceAnswer(JSON.parse(r.prompt)),
    );
  a[0].missingDetails = [
    { ...detail(), basis: "explicit_gap", verificationAspects: ["brands"] },
  ];
  const note = recordSourceEvidenceReading(
    a.map(encodeInventedSourceEvidenceAnswer),
    plan,
    metadata,
  ).responses[0].missingDetails[0];
  expect(note.basis).toBe("explicit_gap");
  expect(note.basisEvidence[0].text).toBe("La marca non è specificata.");
  expect(note.description).toContain("lacuna dichiarata");
});
it("an original in a different part cannot be borrowed as basis", () => {
  const f = fixture(true);
  f.answers[0].missingDetails = [
    { ...detail(), basisEvidence: [{ sourceRef: "s40" }] },
  ];
  expect(() => recordSourceEvidenceReading(f.wire(), f.plan, metadata)).toThrow(
    "outside its request",
  );
});
it("invented and duplicate basis references reject", () => {
  const f = fixture();
  for (const basisEvidence of [
    [{ sourceRef: "s999" }],
    [{ sourceRef: "s2" }, { sourceRef: "s2" }],
  ]) {
    f.answers[0].missingDetails = [{ ...detail(), basisEvidence }];
    expect(() =>
      recordSourceEvidenceReading(f.wire(), f.plan, metadata),
    ).toThrow();
  }
});
it("free absence description cannot be injected into the provider selection", () => {
  const f = fixture();
  f.answers[0].missingDetails = [
    { ...detail(), description: "Location assente in tutta la fonte." },
  ];
  expect(() =>
    recordSourceEvidenceReading(f.wire(), f.plan, metadata),
  ).toThrow();
});
it("canonical rehashed record cannot replace a verification note with a global absence", () => {
  const f = fixture();
  f.answers[0].missingDetails = [detail()];
  const r = structuredClone(
    recordSourceEvidenceReading(f.wire(), f.plan, metadata),
  );
  r.responses[0].missingDetails[0].description =
    "Quantità assenti in tutta la fonte.";
  const { hash: old, ...body } = r;
  r.hash = createHash("sha256")
    .update(stableDocumentaryJson(body))
    .digest("hex");
  expect(() => readSourceEvidenceReading(r, f.plan)).toThrow(
    "not a global absence",
  );
});
it("rehashed record cannot rewrite the original basis quote", () => {
  const f = fixture();
  f.answers[0].missingDetails = [detail()];
  const r = structuredClone(
    recordSourceEvidenceReading(f.wire(), f.plan, metadata),
  );
  r.responses[0].missingDetails[0].basisEvidence[0].text = "Assenza inventata";
  const { hash: old, ...body } = r;
  r.hash = createHash("sha256")
    .update(stableDocumentaryJson(body))
    .digest("hex");
  expect(() => readSourceEvidenceReading(r, f.plan)).toThrow("exact original");
});
it("unreadable source is never qualified by a well-shaped detail note", () => {
  const f = fixture();
  f.answers[0].missingDetails = [detail()];
  f.answers[0].coverage = "unreadable";
  const r = readSourceEvidenceReading(
    recordSourceEvidenceReading(f.wire(), f.plan, metadata),
    f.plan,
  )!;
  expect(r.accepted).toBe(false);
});
it("stale generic-absence reader version cannot be consumed as the new contract", () => {
  const f = fixture();
  f.answers[0].missingDetails = [detail()];
  const r = recordSourceEvidenceReading(f.wire(), f.plan, metadata);
  expect(
    readSourceEvidenceReading(
      { ...r, version: "source-evidence-reading-v37-map-domain-bound" },
      f.plan,
    ),
  ).toBeNull();
});

it("an original deadline marker remains a timing verification with its exact path and known service intact", () => {
  const input = context();
  Object.assign(input.body.passages[1], { rawPath: "/procurement/contractDeadlineType", text: "not_specified", endUtf16: 13 });
  const before = JSON.stringify(input);
  const plan = buildSourceEvidenceReadingRequest(input, config);
  const answers: any[] = plan.requests.map(r => inventedSourceEvidenceAnswer(JSON.parse(r.prompt)));
  answers[0].missingDetails = [{ ...detail(), basis: "explicit_gap", verificationAspects: ["timing"] }];
  const record = recordSourceEvidenceReading(answers.map(encodeInventedSourceEvidenceAnswer), plan, metadata);
  const note = record.responses[0].missingDetails[0];
  expect(note.basisEvidence).toEqual([{sourceRef:"s2",text:"not_specified"}]);
  expect(note.verificationAspects).toEqual(["timing"]);
  expect(record.responses[0].observations.some(o => o.kind === "performance" && o.evidence.some(q => q.sourceRef === "s1"))).toBe(true);
  expect(plan.evidencePassages.find(p => p.id === "s2")?.rawPath).toBe("/procurement/contractDeadlineType");
  expect(JSON.stringify(input)).toBe(before);
  // Provenance and note shape only: this test never approves the selected aspect semantically.
});
it("a document referral note retains a known mandatory obligation as a separate observation", () => {
  const input = context();
  Object.assign(input.body.passages[1], { rawPath: "/dates/otherAppointments/0/note/it", text: "La visita è obbligatoria; per il programma si rinvia al capitolato.", endUtf16: 64 });
  input.body.passages[1].endUtf16 = input.body.passages[1].text.length;
  const plan = buildSourceEvidenceReadingRequest(input, config);
  const answers: any[] = plan.requests.map(r => inventedSourceEvidenceAnswer(JSON.parse(r.prompt)));
  answers[0].missingDetails = [{ ...detail(), verificationAspects: ["referenced_documents"] }];
  const record = recordSourceEvidenceReading(answers.map(encodeInventedSourceEvidenceAnswer), plan, metadata);
  expect(record.responses[0].missingDetails[0].basisEvidence[0].text).toBe(input.body.passages[1].text);
  expect(record.responses[0].observations.some(o => o.kind === "condition" && o.evidence.some(q => q.sourceRef === "s2"))).toBe(true);
});

// Actual original context and accepted maps; test choices are synthetic, not AI qualification.
import { test, expect } from "vitest";
import fs from "node:fs";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import {
  buildSourceInterpretationRequest,
  sourceClauseLiteralFamilies,
  materializeSourceInterpretationPassages,
  materializeSourceInterpretationFields,
  materializeSourceInterpretationClauseBlocks,
  recordSourceInterpretation,
  validateSourceInterpretation,
  componentEvidenceGroups,
} from "../src/lib/source-interpretation";
import { buildSourceLiteralCatalogue } from "../src/lib/source-literal-catalogue";
import { openaiResponseBody } from "../src/lib/openai-responses";
import { projectOriginalClauseDetailEvidence } from "../src/lib/source-clause-provenance";
import { sourceScopedCriterionContext } from "../src/lib/source-contract-clauses";
const context = () =>
  JSON.parse(
    fs.readFileSync(
      new URL(
        "./fixtures/inventory34-actual-map-source-context.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
function fixture() {
  const c = context(),
    r = buildSourceInterpretationRequest(c),
    cat = buildSourceLiteralCatalogue(
      c.body.passages,
      componentEvidenceGroups(c.body.passages),
    ),
    target = c.body.passages.find(
      (p: any) =>
        p.scope === "selected_lot" &&
        p.rawPath.endsWith("/orderDescription/it"),
    ),
    literal = cat.literals.find(
      (l: any) =>
        l.sourceRef === target.id ||
        componentEvidenceGroups(c.body.passages).some(
          (g) => g.id === l.sourceRef && g.sourceRefs.includes(target.id),
        ),
    )!,
    part = literal.parts[0],
    refs = componentEvidenceGroups(c.body.passages).find(
      (g) => g.id === literal.sourceRef,
    )?.sourceRefs ?? [literal.sourceRef];
  const value: any = {
    evidenceFormat: "source_selections_v21_owned",
    status: "resolved",
    targetRef: target.id,
    summary: "Synthetic fixture for original storage only.",
    summaryAdditionalSourceRefs: [],
    components: [
      {
        description: "Synthetic fixture for original storage only.",
        importance: "not_stated",
        role: "execute",
        evidenceDeclaration: { basis: "selected_action_object_plus_explicit_additional_originals", additionalEvidence: [] },
        roleEvidence: {
          state: "identified",
          scope: "selected_lot",
          actionSelection: { literalSelectionId: part[0] },
        },
        meaning: {
          state: "identified",
          statement: "Synthetic fixture for original storage only.",
          objectSelection: { literalSelectionId: part[0] },
          basis: "explicit_text",
        },
      },
    ],
    classificationReadingsById: Object.fromEntries(
      r.classificationContext.map((cl) => [
        cl.id,
        {
          ownSourceRef: cl.labels[0]?.sourceRefs[0] ?? cl.code!.sourceRefs[0],
          use:
            cl.appliesTo === "shared_project_context"
              ? "shared_project_only"
              : "broad_context",
          sourceRefs: [],
          componentIndexes: [],
        },
      ]),
    ),
    details: [],
    contractClauseDetails: Object.fromEntries(
      r.contractDetailFamilies.map((f) => [
        f.id,
        { originalFamily: true, kind: "execution_condition" },
      ]),
    ),
    issues: [],
  };
  return { c, r, value };
}
const meta = {
  id: "invented-structural-only",
  at: "2026-10-10T00:00:00Z",
  model: "gpt-6-luna",
};
test("Actual19maps183mandatoryrefs and every selected original byte fit unchanged native and wire caps", () => {
  const c = context(),
    before = JSON.stringify(c),
    r = buildSourceInterpretationRequest(c);
  expect(r.contractDetailFamilies).toHaveLength(28);
  expect(r.requiredContractClauseIds).toHaveLength(183);
  expect(
    Math.max(...r.contractDetailFamilies.map((f) => f.sourceRefs.length)),
  ).toBeLessThanOrEqual(32);
  expect(
    Buffer.byteLength(r.system + r.prompt + JSON.stringify(r.responseFormat)),
  ).toBeLessThanOrEqual(160000);
  expect(
    Buffer.byteLength(
      JSON.stringify(
        openaiResponseBody(
          "gpt-6-luna",
          r.system,
          r.prompt,
          r.maxTokens,
          r.responseFormat,
          "medium",
        ),
      ),
    ),
  ).toBeLessThanOrEqual(200000);
  expect(materializeSourceInterpretationPassages(r.prompt)).toEqual(
    c.body.passages.map(({ url, ...p }: any) => p),
  );
  expect(materializeSourceInterpretationFields(r.prompt)).toEqual(
    c.body.fields.map((f: any, i: number) => ({
      ...f,
      ...(f.value !== null ? { id: "f" + i } : {}),
    })),
  );
  expect(JSON.stringify(c)).toBe(before);
});
test("Each original criterion identity and all languages/verification refs remain separate members", () => {
  const { contractDetailFamilies: f } = sourceClauseLiteralFamilies(context());
  const members = f.flatMap((x) => x.originalFieldFamilies ?? []);
  expect(members).toHaveLength(15);
  expect(new Set(members.map((m) => m.rawPath)).size).toBe(15);
  for (const m of members) {
    expect(m.sourceRefs.length).toBeGreaterThan(0);
    for (const id of m.sourceRefs) {
      const p = context().body.passages.find((p: any) => p.id === id);
      if (p) expect(p.rawPath.startsWith(m.rawPath + "/")).toBe(true);
    }
  }
});
test("Synthetic complete original block choices pass strict native schema and canonical validator", () => {
  const { r, value } = fixture();
  const accepts = new Ajv2020({ strict: false }).compile(
    r.responseFormat.json_schema.schema,
  );
  expect(accepts(value)).toBe(true);
  const record = recordSourceInterpretation(value, r, meta);
  expect(record.response.details).toHaveLength(28);
  expect(record.response.details.every((d) => d.sourceRefs.length <= 32)).toBe(
    true,
  );
  expect(() => validateSourceInterpretation(record.response, r)).not.toThrow();
  const projected = projectOriginalClauseDetailEvidence(
    record.response.details,
    [...r.body.passages],
  );
  const required = new Set(projected.flatMap((d) => d.sourceRefs));
  for (const id of r.requiredContractClauseIds.filter((id) =>
    id.startsWith("s"),
  ))
    expect(required.has(id)).toBe(true);
  const criterion = projected.find((d) =>
    d.sourceRefs.some((id) =>
      r.body.passages
        .find((p) => p.id === id)
        ?.rawPath.includes("/qualificationCriteria/0/"),
    ),
  )!;
  const ctx = sourceScopedCriterionContext(
    r.body.passages,
    criterion.sourceRefs,
  );
  expect(ctx.criteria).toHaveLength(1);
  expect(
    ctx.criteria[0].originalRefs.every((id) =>
      r.body.passages
        .find((p) => p.id === id)!
        .rawPath.includes("/qualificationCriteria/0/"),
    ),
  ).toBe(true);
});
for (const mutation of [
  "missing-family",
  "false-original",
  "foreign-key",
  "wrong-protocol",
  "foreign-ref",
  "edited-literal",
] as const)
  test("Reject " + mutation, () => {
    const { r, value } = fixture();
    const family = r.contractDetailFamilies.find(
      (f) => f.originalFieldFamilies,
    )!;
    if (mutation === "missing-family")
      delete value.contractClauseDetails[family.id];
    if (mutation === "false-original")
      value.contractClauseDetails[family.id].originalFamily = false;
    if (mutation === "foreign-key")
      value.contractClauseDetails.s999999 = {
        originalFamily: true,
        kind: "execution_condition",
      };
    if (mutation === "wrong-protocol")
      value.evidenceFormat = "source_selections_v19";
    if (mutation === "foreign-ref")
      value.contractClauseDetails[family.id] = [
        {
          kind: "execution_condition",
          scope: family.scope,
          sourceRefs: [family.sourceRefs[0]],
          originalText: true,
        },
      ];
    if (mutation === "edited-literal") {
      const record = structuredClone(
        recordSourceInterpretation(value, r, meta),
      );
      record.response.details.find((d) =>
        d.sourceRefs.includes(family.sourceRefs[0]),
      )!.originalTextContinuation![0] += "changed";
      expect(() => validateSourceInterpretation(record.response, r)).toThrow();
      return;
    }
    expect(() => recordSourceInterpretation(value, r, meta)).toThrow();
  });
test("Paragraph lookup retains distinct full paragraphs and rejects foreign literal identity", () => {
  const { r } = fixture();
  const blocks = materializeSourceInterpretationClauseBlocks(r.prompt);
  expect(blocks.length).toBeGreaterThan(0);
  for (const b of blocks) {
    const ps = r.body.passages.filter((p) => b.sourceRefs.includes(p.id));
    const text = ps
      .map((p) =>
        p.text.slice(
          Math.max(0, b.startUtf16 - p.startUtf16),
          Math.min(p.text.length, b.endUtf16 - p.startUtf16),
        ),
      )
      .join("");
    expect(b.text).toBe(text);
  }
  const body = JSON.parse(r.prompt);
  body.contractClauseBlocks[0].literal[0] = "s999999";
  expect(() =>
    materializeSourceInterpretationClauseBlocks(JSON.stringify(body)),
  ).toThrow();
});
test("Path dictionary refuses missing segment and duplicated identity", () => {
  const { r } = fixture();
  const body = JSON.parse(r.prompt);
  body.originalMetadataDictionary.paths[0][0] = 999999;
  expect(() =>
    materializeSourceInterpretationPassages(JSON.stringify(body)),
  ).toThrow();
});
import {
  buildSourceSemanticReviewRequest,
  buildGroundedSourceReviewRequests,
  materializeSourceReviewDraft,
} from "../src/lib/source-semantic-review";
import {
  inventedSourceEvidence,
  inventedReadingRefs,
} from "./helpers/source-evidence-fixture";
test("Real downstream reader and independent review can carry every expanded original block within unchanged caps", () => {
  const { c, r, value } = fixture(),
    record = recordSourceInterpretation(value, r, meta),
    plan = (() => {
      try {
        return buildSourceSemanticReviewRequest(
          JSON.parse(
            fs.readFileSync(
              new URL(
                "./fixtures/inventory34-full-original-source-context.json",
                import.meta.url,
              ),
              "utf8",
            ),
          ),
          record,
          { model: "gpt-6-luna", reasoningEffort: "high" },
        );
      } catch (e: any) {
        console.info(
          "REVIEW_CAPACITY_DIAGNOSTIC",
          JSON.stringify({ message: e.message, cause: e.cause }),
        );
        throw e;
      }
    })(),
    reading = inventedSourceEvidence(plan),
    reviews = buildGroundedSourceReviewRequests(plan, reading);
  expect(plan.evidencePlan.requests.length).toBeLessThanOrEqual(32);
  expect(reviews.length).toBeLessThanOrEqual(32);
  for (const task of [...plan.evidencePlan.requests, ...reviews]) {
    expect(
      Buffer.byteLength(
        task.system + task.prompt + JSON.stringify(task.responseFormat),
      ),
    ).toBeLessThanOrEqual(160000);
    expect(
      Buffer.byteLength(
        JSON.stringify(
          openaiResponseBody(
            "gpt-6-luna",
            task.system,
            task.prompt,
            task.maxTokens,
            task.responseFormat,
            "high",
          ),
        ),
      ),
    ).toBeLessThanOrEqual(200000);
  }
  fs.writeFileSync(
    "inventory34-downstream-capacity.json",
    JSON.stringify({
      reader: plan.evidencePlan.requests.length,
      review: reviews.length,
      maxReviewWire: Math.max(
        ...reviews.map((task) =>
          Buffer.byteLength(
            JSON.stringify(
              openaiResponseBody(
                "gpt-6-luna",
                task.system,
                task.prompt,
                task.maxTokens,
                task.responseFormat,
                "high",
              ),
            ),
          ),
        ),
      ),
    }),
  );
});
import {
  materializeSourceReviewCandidateTexts,
  materializeSourceReviewIndependentReading,
  materializeSourceReviewOriginals,
  recordSourceSemanticReview,
} from "../src/lib/source-semantic-review";
function downstream() {
  const { c, r, value } = fixture(),
    record = recordSourceInterpretation(value, r, meta),
    plan = buildSourceSemanticReviewRequest(
      JSON.parse(
        fs.readFileSync(
          new URL(
            "./fixtures/inventory34-full-original-source-context.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
      record,
      { model: "gpt-6-luna", reasoningEffort: "high" },
    ),
    reading = inventedSourceEvidence(plan),
    requests = buildGroundedSourceReviewRequests(plan, reading);
  return { c: plan.context, r, record, plan, reading, requests };
}
test("Review partition owns every passage/null/false field exactly once, keeps all own candidates and every full paragraph", () => {
  const { c, plan, requests } = downstream();
  const assigned = requests.flatMap((r) => [
    ...r.coverage.passageIds,
    ...r.coverage.fieldIndexes.map((i) => "f" + i),
  ]);
  expect(new Set(assigned).size).toBe(assigned.length);
  expect([...assigned].sort()).toEqual(
    [
      ...c.body.passages.map((p: any) => p.id),
      ...c.body.fields.map((_: any, i: number) => "f" + i),
    ].sort(),
  );
  const clauses = requests.flatMap((r) => r.ownedContractClauseIds);
  expect(new Set(clauses).size).toBe(clauses.length);
  expect(new Set(clauses)).toEqual(
    new Set(
      plan.claims
        .filter((c) => c.kind === "contract_clause_coverage")
        .flatMap((c) => c.sourceRefs),
    ),
  );
  for (const r of requests) {
    const body = JSON.parse(r.prompt),
      draft = materializeSourceReviewDraft(r.prompt),
      texts = materializeSourceReviewCandidateTexts(r.prompt),
      independent = materializeSourceReviewIndependentReading(r.prompt),
      originals = materializeSourceReviewOriginals(r.prompt);
    for (const p of originals.passages)
      expect(p).toEqual(
        (({ url, ...p }: any) => p)(
          c.body.passages.find((o: any) => o.id === p.id),
        ),
      );
    for (const f of originals.fields)
      expect(f).toEqual({
        id: "f" + f.index,
        index: f.index,
        ...c.body.fields[f.index],
      });
    for (const binding of body.contractClauseDraftBindings)
      for (const index of binding.candidateDetails)
        expect(typeof draft.details[index].explanation).toBe("string");
    for (const [path, text] of Object.entries(texts)) {
      const index = Number(path.split("/")[2]);
      expect(text).toBe(draft.details[index].explanation);
    }
    expect(
      independent.observations.every((o: any) =>
        o.evidence.every((q: any) => /^([sf])\d+$/.test(q.sourceRef)),
      ),
    ).toBe(true);
  }
});
test("Missing current original piece, moved global index and missing reader tuple ownership are rejected", () => {
  const { requests } = downstream(),
    r = requests.find(
      (r) => JSON.parse(r.prompt).visibleOriginalDetailIndexes.length,
    )!;
  const body = JSON.parse(r.prompt);
  const tuple = body.draft.details.find((d: any) => Array.isArray(d) && !d[4]);
  delete body.originalTextPieces[tuple[3]];
  expect(() => materializeSourceReviewDraft(JSON.stringify(body))).toThrow();
  const other = JSON.parse(r.prompt);
  other.draft.details.find((d: any) => Array.isArray(d))[0] = 999;
  expect(() => materializeSourceReviewDraft(JSON.stringify(other))).toThrow();
  const obs = JSON.parse(r.prompt);
  obs.independentReading.observations[0][4] = ["s999bad"];
  expect(() =>
    materializeSourceReviewIndependentReading(JSON.stringify(obs)),
  ).toThrow();
});
test("V6 keeps every claim/proof domain closed and native rejection of duplicated or missing reading selections", () => {
  const { plan, reading, requests } = downstream();
  const wire = requests.map((r) => ({
    chunkId: r.id,
    sourceEvidenceHash: reading.hash,
    coverage: "complete",
    checksFormat: "claim_keyed_refs_v6",
    findings: [],
    checksByClaim: Object.fromEntries(
      r.assignedClaimIds.map((id) => {
        const claim = plan.claims.find((c) => c.id === id)!,
          group = r.claimReadingGroups.find((g) => g.claimIds.includes(id))!;
        const binding = r.coverageBindings.find((b) => b.claimId === id);
        return [
          id,
          {
            verdict: "not_verifiable",
            draftQuote: claim.text.slice(0, 1200),
            reason: "Synthetic rejection; never case qualification.",
            sourceRefs: [claim.sourceRefs[0]],
            readingRefs: inventedReadingRefs(JSON.parse(r.prompt), claim).length
              ? inventedReadingRefs(JSON.parse(r.prompt), claim)
              : [group.readingIds[0]],
            coverageBySource: Object.fromEntries(
              (binding?.sourceRefs ?? []).map((ref) => [
                ref,
                { disposition: "missing", draftPaths: [] },
              ]),
            ),
          },
        ];
      }),
    ),
  }));
  for (const [r, index] of requests.map((r, i) => [r, i] as const)) {
    const accept = new Ajv2020({ strict: false }).compile(
      r.responseFormat.json_schema.schema,
    );
    expect(accept(wire[index]), JSON.stringify(accept.errors)).toBe(true);
  }
  expect(() =>
    recordSourceSemanticReview(wire, plan, {
      ...meta,
      sourceEvidence: reading,
    }),
  ).not.toThrow();
  const duplicate = structuredClone(wire);
  const first = Object.values(duplicate[0].checksByClaim)[0] as any;
  first.readingRefs.push(first.readingRefs[0]);
  expect(() =>
    recordSourceSemanticReview(duplicate, plan, {
      ...meta,
      sourceEvidence: reading,
    }),
  ).toThrow(/repeats reading/);
  const missing = structuredClone(wire);
  (Object.values(missing[0].checksByClaim)[0] as any).readingRefs = [];
  expect(() =>
    recordSourceSemanticReview(missing, plan, {
      ...meta,
      sourceEvidence: reading,
    }),
  ).toThrow();
});
test("V6 performance selector keeps mandatory own proof on wire and rejects absent or foreign performance IDs", () => {
  const { plan, reading, requests } = downstream();
  const r = requests.find((r) =>
      r.claimReadingGroups.some((g) => g.supportedPerformanceIds?.length),
    )!,
    perfGroup = r.claimReadingGroups.find(
      (g) => g.supportedPerformanceIds?.length,
    )!,
    id = perfGroup.claimIds[0],
    perf = perfGroup.supportedPerformanceIds![0];
  const wire: any = {
    chunkId: r.id,
    sourceEvidenceHash: reading.hash,
    coverage: "complete",
    checksFormat: "claim_keyed_refs_v6",
    findings: [],
    checksByClaim: Object.fromEntries(
      r.assignedClaimIds.map((id) => {
        const claim = plan.claims.find((c) => c.id === id)!,
          group = r.claimReadingGroups.find((g) => g.claimIds.includes(id))!,
          binding = r.coverageBindings.find((b) => b.claimId === id);
        return [
          id,
          {
            verdict: "not_verifiable",
            draftQuote: claim.text.slice(0, 1200),
            reason: "Synthetic rejection",
            sourceRefs: [claim.sourceRefs[0]],
            readingRefs: [group.readingIds[0]],
            coverageBySource: Object.fromEntries(
              (binding?.sourceRefs ?? []).map((ref) => [
                ref,
                { disposition: "missing", draftPaths: [] },
              ]),
            ),
          },
        ];
      }),
    ),
  };
  wire.checksByClaim[id] = {
    verdict: "supported",
    draftQuote: null,
    reason:
      "Le prove indicate sostengono il claim; coverageProof distingue fatti rappresentati e dati facoltativi.",
    sourceRefs: perfGroup.supportedSourceIds,
    readingRefs: [perf],
    performanceRef: perf,
    coverageBySource: {},
  };
  const accepts = new Ajv2020({ strict: false }).compile(
    r.responseFormat.json_schema.schema,
  );
  expect(accepts(wire), JSON.stringify(accepts.errors)).toBe(true);
  const missing = structuredClone(wire);
  delete missing.checksByClaim[id].performanceRef;
  expect(accepts(missing)).toBe(false);
  const foreign = structuredClone(wire);
  foreign.checksByClaim[id].performanceRef = "o-s999999";
  expect(accepts(foreign)).toBe(false);
});

test("Review original metadata refuses bad path indices and changed UTF16 intervals", () => {
  const { requests } = downstream();
  const body = JSON.parse(requests[0].prompt);
  body.passages[0].meta[0] = 999999;
  expect(() =>
    materializeSourceReviewOriginals(JSON.stringify(body)),
  ).toThrow();
  const altered = JSON.parse(requests[0].prompt);
  altered.passages[0].meta[4]++;
  expect(() =>
    materializeSourceReviewOriginals(JSON.stringify(altered)),
  ).toThrow();
});

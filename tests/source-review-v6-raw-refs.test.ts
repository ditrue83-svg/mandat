// Native current-format regression fixtures only; no AI semantic qualification.
import fs from "node:fs";
import { beforeAll, test, expect } from "vitest";
import {
  buildSourceInterpretationRequest,
  componentEvidenceGroups,
  recordSourceInterpretation,
} from "../src/lib/source-interpretation";
import { buildSourceLiteralCatalogue } from "../src/lib/source-literal-catalogue";
import {
  buildSourceSemanticReviewRequest,
  buildGroundedSourceReviewRequests,
  recordSourceSemanticReview,
  SOURCE_REVIEW_SUPPORTED_REASON,
} from "../src/lib/source-semantic-review";
import {
  inventedSourceEvidence,
  inventedReadingRefs,
} from "./helpers/source-evidence-fixture";
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
function wires(plan: ReturnType<typeof downstream>["plan"], reading: ReturnType<typeof downstream>["reading"], requests: ReturnType<typeof downstream>["requests"]) {
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
  return wire;
}
let fixtureState: ReturnType<typeof downstream>, baseline: any[];
beforeAll(() => {
  fixtureState = downstream();
  baseline = wires(
    fixtureState.plan,
    fixtureState.reading,
    fixtureState.requests,
  );
  expect(() => record(baseline)).not.toThrow();
}, 30000);
const record = (values: any[]) =>
  recordSourceSemanticReview(values, fixtureState.plan, {
    ...meta,
    sourceEvidence: fixtureState.reading,
  });
const first = (values: any[]) =>
  Object.values(values[0].checksByClaim)[0] as any;
test("RAW v6 repeated sourceRefs are rejected before original-fact union", () => {
  const wire = structuredClone(baseline),
    raw = first(wire);
  raw.sourceRefs.push(raw.sourceRefs[0]);
  expect(() => record(wire)).toThrow(/repeats source evidence/);
});
test("RAW v6 repeated readingRefs are rejected before performance union", () => {
  const wire = structuredClone(baseline),
    raw = first(wire);
  raw.readingRefs.push(raw.readingRefs[0]);
  expect(() => record(wire)).toThrow(/repeats reading evidence/);
});
for (const kind of [
  "unknown-source",
  "unknown-reading",
  "missing-reading",
  "stale-evidence",
  "wrong-chunk",
  "missing-claim",
  "extra-claim",
  "missing-coverage-key",
  "foreign-performance",
] as const)
  test("V6 guard retained: " + kind, () => {
    const wire = structuredClone(baseline),
      raw = first(wire);
    if (kind === "unknown-source") raw.sourceRefs = ["s999999"];
    if (kind === "unknown-reading") raw.readingRefs = ["o-s999999"];
    if (kind === "missing-reading") raw.readingRefs = [];
    if (kind === "stale-evidence") wire[0].sourceEvidenceHash = "a".repeat(64);
    if (kind === "wrong-chunk") wire[0].chunkId = "review999999";
    if (kind === "missing-claim")
      delete wire[0].checksByClaim[Object.keys(wire[0].checksByClaim)[0]];
    if (kind === "extra-claim")
      wire[0].checksByClaim.q999999 = structuredClone(raw);
    if (kind === "missing-coverage-key") {
      const checks = wire.flatMap((w) =>
        Object.values(w.checksByClaim),
      ) as any[];
      const check = checks.find((c) => Object.keys(c.coverageBySource).length)!;
      delete check.coverageBySource[Object.keys(check.coverageBySource)[0]];
    }
    if (kind === "foreign-performance") raw.performanceRef = "o-s999999";
    expect(() => record(wire)).toThrow();
  });
test("Distinct fields can explicitly select the same original without a duplicate raw array", () => {
  const wire = structuredClone(baseline);
  let touched = false;
  fixtureState.requests.forEach((r, i) => {
    const group = r.claimReadingGroups.find(
      (g) =>
        g.claimIds.some((id) =>
          r.coverageBindings.find((b) => b.claimId === id),
        ) && g.readingIds.some((id) => id.startsWith("o-")),
    );
    if (touched || !group) return;
    const id = group.claimIds[0],
      fact = r.originalFacts.find((f) => group.readingIds.includes(f.id))!;
    const raw = wire[i].checksByClaim[id];
    raw.sourceRefs = [fact.sourceRef];
    raw.readingRefs = [fact.id];
    touched = true;
  });
  expect(touched).toBe(true);
  expect(() => record(wire)).not.toThrow();
});
test("Key order alone cannot omit or duplicate a keyed claim", () => {
  const wire = structuredClone(baseline);
  wire[0].checksByClaim = Object.fromEntries(
    Object.entries(wire[0].checksByClaim).reverse(),
  );
  expect(record(wire).responses).toEqual(record(baseline).responses);
});
function supportedPerformanceFixture() {
  const wire = structuredClone(baseline);
  let chosen: { part: number; id: string; performance: string } | undefined;
  fixtureState.requests.forEach((r, i) => {
    if (chosen) return;
    const group = r.claimReadingGroups.find(
      (g) => g.supportedPerformanceIds?.length && g.supportedSourceIds?.length,
    );
    if (!group) return;
    const id = group.claimIds[0],
      performance = group.supportedPerformanceIds![0];
    wire[i].checksByClaim[id] = {
      verdict: "supported",
      draftQuote: null,
      reason: SOURCE_REVIEW_SUPPORTED_REASON,
      sourceRefs: [...group.supportedSourceIds!],
      readingRefs: [performance],
      performanceRef: performance,
      coverageBySource: {},
    };
    chosen = { part: i, id, performance };
  });
  expect(chosen).toBeDefined();
  expect(() => record(wire)).not.toThrow();
  return { wire, chosen: chosen! };
}
test("Supported V6 rejects repeated raw source references on a valid baseline", () => {
  const { wire, chosen } = supportedPerformanceFixture();
  const raw = wire[chosen.part].checksByClaim[chosen.id];
  raw.sourceRefs.push(raw.sourceRefs[0]);
  expect(() => record(wire)).toThrow();
});
test("An explicit performance selector and reading array may identify the same proof without inventing another", () => {
  const { wire, chosen } = supportedPerformanceFixture();
  const result = record(wire);
  const check = result.responses[chosen.part].checks.find(
    (c) => c.claimId === chosen.id,
  )!;
  expect(
    check.readingRefs.filter((id) => id === chosen.performance),
  ).toHaveLength(1);
});
test("Missing performance selector cannot be supplied by another reading array", () => {
  const { wire, chosen } = supportedPerformanceFixture();
  delete wire[chosen.part].checksByClaim[chosen.id].performanceRef;
  expect(() => record(wire)).toThrow();
});

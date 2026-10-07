import assert from "node:assert/strict";
import { test } from "vitest";
import { z } from "zod";
import Ajv2020 from "ajv/dist/2020.js";
import {
  bindCoverageWitnesses,
  coverageHasWitnesses,
  coverageSelectionSchema,
  projectCoverageSelection,
  validateCoverageProof,
} from "../src/lib/source-coverage-proof";
import { openaiResponseBody } from "../src/lib/openai-responses";

const draft = {
  summary: "Sono richiesti materiali di cancelleria.",
  summarySourceRefs: ["s1"],
  components: [],
  details: [
    { explanation: "Proroga non ammessa.", sourceRefs: ["s45"] },
    { explanation: "Varianti non ammesse.", sourceRefs: ["s68"] },
    { explanation: "Validità: 180 giorni.", sourceRefs: ["f38"] },
  ],
};
const binding = () =>
  bindCoverageWitnesses(
    {
      claimId: "q41",
      kind: "contract_clause_coverage",
      sourceRefs: ["s68", "f38"],
    },
    draft,
  );
const selection = () => ({
  s68: { disposition: "represented", draftPaths: ["/details/1/explanation"] },
  f38: { disposition: "represented", draftPaths: ["/details/2/explanation"] },
});
function wireValidator(supported = true) {
  const native = openaiResponseBody(
    "gpt-6-luna",
    "Test locale",
    "Test locale",
    8192,
    {
      type: "json_schema",
      json_schema: {
        name: "coverage_test",
        strict: true,
        schema: z.toJSONSchema(coverageSelectionSchema(binding(), supported)),
      },
    },
  );
  return new Ajv2020({ strict: false }).compile(native.text!.format.schema);
}

test("Every mandatory fact selects its own exact draft field; no quote can be rewritten", () => {
  const selected = selection(),
    bound = binding();
  const before = JSON.stringify({ draft, selected, bound });
  const proof = projectCoverageSelection(selected, bound);
  assert.deepEqual(proof[0].witnesses, [
    { draftPath: "/details/1/explanation", quote: "Varianti non ammesse." },
  ]);
  assert(wireValidator()(selected));
  validateCoverageProof({
    proof,
    ownedSourceRefs: bound.sourceRefs,
    kind: bound.kind,
    verdict: "supported",
    draft,
  });
  assert.equal(JSON.stringify({ draft, selected, bound }), before);
  for (const mutate of [
    (v: any) => {
      v.s68.draftPaths = ["/details/0/explanation"];
    },
    (v: any) => {
      v.s68.quote = "Proroga non ammessa.";
    },
    (v: any) => {
      delete v.f38;
    },
    (v: any) => {
      v.s68.draftPaths = [];
    },
    (v: any) => {
      v.s45 = v.s68;
    },
  ]) {
    const bad = structuredClone(selected);
    mutate(bad);
    assert.equal(wireValidator()(bad), false);
    assert.throws(() => projectCoverageSelection(bad, bound));
  }
});

test("Mandatory omissions cannot be optional or supported; unsupported criticism remains expressible", () => {
  const bad = selection();
  bad.s68 = { disposition: "missing", draftPaths: [] };
  assert.equal(wireValidator()(bad), false);
  assert.equal(wireValidator(false)(bad), true);
  const proof = projectCoverageSelection(bad, binding());
  assert.throws(
    () =>
      validateCoverageProof({
        proof,
        ownedSourceRefs: binding().sourceRefs,
        kind: binding().kind,
        verdict: "supported",
        draft,
      }),
    /Missing material/,
  );
  assert.doesNotThrow(() =>
    validateCoverageProof({
      proof,
      ownedSourceRefs: binding().sourceRefs,
      kind: binding().kind,
      verdict: "not_verifiable",
      draft,
    }),
  );
  bad.s68.disposition = "not_required";
  assert.equal(wireValidator(false)(bad), false);
});

test("No candidate is invented for an absent fact, and a summary does not discharge a mandatory detail", () => {
  const missing = bindCoverageWitnesses(
    { claimId: "q1", kind: "contract_clause_coverage", sourceRefs: ["s1"] },
    draft,
  );
  assert(!coverageHasWitnesses(missing));
  assert.deepEqual(missing.witnessesBySource.s1, []);
  assert.throws(
    () => coverageSelectionSchema(missing, true),
    /requires a draft candidate/,
  );
  const optional = bindCoverageWitnesses(
    { claimId: "q2", kind: "scope_coverage", sourceRefs: ["s56"] },
    draft,
  );
  const proof = projectCoverageSelection(
    { s56: { disposition: "not_required", draftPaths: [] } },
    optional,
  );
  validateCoverageProof({
    proof,
    ownedSourceRefs: ["s56"],
    kind: optional.kind,
    verdict: "supported",
    draft,
  });
  assert.throws(() =>
    projectCoverageSelection(
      { s56: { disposition: "represented", draftPaths: ["/summary"] } },
      optional,
    ),
  );
});

test("Literal provenance never certifies semantic equivalence or permits duplicate witnesses", () => {
  const selected = selection();
  selected.s68.draftPaths.push(selected.s68.draftPaths[0]);
  assert.throws(() => projectCoverageSelection(selected, binding()));
  const falseDraft = {
    ...draft,
    details: [{ explanation: "Proroga non ammessa.", sourceRefs: ["s68"] }],
  };
  const bound = bindCoverageWitnesses(
    { claimId: "q1", kind: "contract_clause_coverage", sourceRefs: ["s68"] },
    falseDraft,
  );
  const proof = projectCoverageSelection(
    {
      s68: {
        disposition: "represented",
        draftPaths: ["/details/0/explanation"],
      },
    },
    bound,
  );
  // This is mechanical presence only. The independent semantic reviewer must
  // reject the mismatch between variants and extension in the actual source.
  assert.equal(proof[0].witnesses[0].quote, "Proroga non ammessa.");
  assert.equal(Object.hasOwn(proof[0], "verdict"), false);
});

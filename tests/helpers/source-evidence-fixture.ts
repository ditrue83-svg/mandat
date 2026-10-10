import { buildSourceLiteralCatalogue } from "../../src/lib/source-literal-catalogue";
import { resolveSourceTextSelection } from "../../src/lib/source-selection";
import { componentEvidenceGroups } from "../../src/lib/source-interpretation";
import {
  sourceClauseLiteralFamilies,
  type SourceInterpretationContext,
} from "../../src/lib/source-interpretation";
// Encode declared choices in newly invented fixtures only, never live output.
export function encodeInventedSourceSelections(
  input: SourceInterpretationContext,
  value: any,
) {
  const groups = componentEvidenceGroups(input.body.passages),
    catalogue = buildSourceLiteralCatalogue(input.body.passages, groups);
  const choose = (selection: any) => {
    const original = resolveSourceTextSelection(
      selection,
      input.body.passages,
      groups,
    );
    const picked = catalogue.selections.find(
      (p) =>
        (p.sourceRef === selection.sourceRef ||
          groups.some(
            (g) =>
              g.id === p.sourceRef &&
              g.sourceRefs.includes(selection.sourceRef),
          )) &&
        catalogue.literals
          .find((f) => f.sourceRef === p.sourceRef)!
          .parts.find((part) => part[0] === p.id)![1]
          .includes(original.text),
    );
    if (!picked)
      throw new Error(
        "Invented fixture selection has no whole original catalogue part",
      );
    return { literalSelectionId: picked.id };
  };
  value.evidenceFormat = "source_selections_v20";
  for (const c of value.components) {
    c.roleEvidence.actionSelection = choose(c.roleEvidence.actionSelection);
    c.meaning.objectSelection = choose(c.meaning.objectSelection);
  }
  value.contractClauseDetails ??= {};
  for (const family of sourceClauseLiteralFamilies(input)
    .contractDetailFamilies) {
    if (value.contractClauseDetails[family.id]) continue;
    const parts = family.originalMultilingualExplanation
      ? [family.originalMultilingualExplanation]
      : family.originalTextParts;
    value.contractClauseDetails[family.id] = [
      {
        kind: "execution_condition",
        scope: family.scope,
        sourceRefs: family.sourceRefs,
        ...(parts
          ? { originalText: true }
          : { explanation: family.originalScalarExplanation }),
      },
    ];
  }
  for (const family of sourceClauseLiteralFamilies(input).contractDetailFamilies
    .length > 16
    ? sourceClauseLiteralFamilies(input).contractDetailFamilies
    : []) {
    const rows = value.contractClauseDetails[family.id];
    if (
      rows?.length === 1 &&
      (family.originalScalarExplanation ||
        family.originalMultilingualExplanation ||
        family.originalTextParts)
    ) {
      const row = rows[0];
      if (
        JSON.stringify([...row.sourceRefs].sort()) !==
          JSON.stringify([...family.sourceRefs].sort()) ||
        row.scope !== family.scope
      )
        throw new Error(
          "Invented family fixture does not declare all its own originals",
        );
      value.contractClauseDetails[family.id] = {
        kind: row.kind,
        originalFamily: true,
      };
    }
  }
  return value;
}
// Explicitly invented favorable responses for contract/queue tests only.
// These helpers are not a semantic benchmark or an AI quality judgment.
import {
  recordSourceEvidenceReading as recordProviderSourceEvidenceReading,
  type SourceEvidenceReadingRecord,
} from "../../src/lib/source-evidence-reading";
import {
  buildGroundedSourceReviewRequests,
  materializeSourceReviewDraft,
  materializeSourceReviewIndependentReading,
  type SourceSemanticReviewPlan,
} from "../../src/lib/source-semantic-review";
import Ajv2020 from "ajv/dist/2020.js";

// Wire encoding for explicitly invented fixtures only. Preserve every choice,
// explanation, reference and extra field so invalid fixtures stay invalid.
// Never call this helper on recorded provider outputs or historical evidence.
export function encodeInventedSourceEvidenceAnswer(answer: any): any {
  if (answer?.result)
    return {
      ...answer,
      result: encodeInventedSourceEvidenceAnswer(answer.result),
    };
  return {
    ...answer,
    classifications: answer.classifications.map(
      ({ relationship, explanation, ...rest }: any) => ({
        ...rest,
        assessment: { [relationship]: explanation },
      }),
    ),
  };
}
export function recordInventedSourceEvidenceReading(
  values: unknown[],
  ...args: Tail<Parameters<typeof recordProviderSourceEvidenceReading>>
) {
  return recordProviderSourceEvidenceReading(
    values.map(encodeInventedSourceEvidenceAnswer),
    ...args,
  );
}
type Tail<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never;
export function compileInventedSourceEvidenceSchema<T = unknown>(schema: any) {
  const validate = new Ajv2020({ strict: false }).compile<T>(schema);
  const check = ((answer: any) =>
    validate(encodeInventedSourceEvidenceAnswer(answer))) as ((
    answer: any,
  ) => boolean) & { errors: unknown };
  Object.defineProperty(check, "errors", { get: () => validate.errors });
  return check;
}

// Encode only references already selected in an invented fixture. This never
// adds original evidence, decides meaning, or operates on a provider response.
export function inventedClauseSelections(
  required: readonly string[],
  answer: any,
) {
  return Object.fromEntries(
    required.map((id) => [
      id,
      ["observations", "issues"].flatMap((collection) =>
        (answer[collection] ?? []).some(
          (row: any) =>
            row.serviceRef === id ||
            row.evidence.some((e: any) => e.sourceRef === id),
        )
          ? [{ collection }]
          : [],
      ),
    ]),
  );
}

export function inventedSourceEvidenceAnswer(data: any) {
  const required = new Set<string>(
    (data.requiredClausePassages ?? []).map((p: any) => p.sourceRef),
  );
  const quote = (id: string) => {
    const passage = data.passages.find((p: any) => p.id === id);
    if (!passage && !data.fields.some((f: any) => f.id === id))
      throw new Error("Invented fixture lacks source passage or field");
    return { sourceRef: id };
  };
  const target =
    data.passages.find(
      (p: any) =>
        p.scope === data.targetScope &&
        p.role === "service" &&
        /orderDescription/.test(p.rawPath),
    ) ??
    data.passages.find(
      (p: any) => p.scope === data.targetScope && p.role === "service",
    ) ??
    data.passages[0];
  const answer = {
    chunkId: data.chunkId,
    coverage: "complete",
    observations: [
      ...(data.requiredClauseFields ?? []).flatMap((field: any) => {
        const original = data.fields.find((f: any) => f.id === field.sourceRef);
        const anchor = data.passages.find(
          (p: any) => p.scope === original.scope && p.role === "service",
        );
        return anchor
          ? [
              {
                kind: "condition",
                serviceRef: anchor.id,
                evidence: [quote(field.sourceRef)],
              },
            ]
          : [];
      }),
      ...[
        target,
        ...data.passages
          .filter((p: any) => p.id !== target.id)
          .sort(
            (a: any, b: any) =>
              Number(required.has(b.id)) - Number(required.has(a.id)),
          ),
      ].flatMap((p: any) => {
        const anchor = data.passages.find(
          (candidate: any) =>
            candidate.scope === p.scope && candidate.role === "service",
        );
        if (!anchor) return [];
        return [
          {
            kind:
              p.id === target.id || p.role === "service"
                ? "performance"
                : "condition",
            serviceRef: p.role === "service" ? p.id : anchor.id,
            evidence: [quote(p.id)],
          },
        ];
      }),
    ].slice(0, 32) as {
      kind: "performance" | "condition" | "target_partition";
      serviceRef: string;
      evidence: { sourceRef: string }[];
    }[],
    classifications: data.assignedClassificationIds.map((id: string) => {
      const c = data.classifications.find((item: any) => item.id === id);
      const refs: string[] = [
        ...(c.code?.sourceRefs ?? []),
        ...c.labels.flatMap((l: any) => l.sourceRefs),
      ];
      return {
        classificationId: id,
        relationship: "broad_context",
        explanation: null as string | null,
        evidence: refs.map(quote),
      };
    }),
    issues: [],
    missingDetails: [],
  };
  const requiredIds = [
    ...(data.requiredClausePassages ?? []),
    ...(data.requiredClauseFields ?? []),
  ].map((p: any) => p.sourceRef);
  return {
    ...answer,
    ...(requiredIds.length
      ? {
          requiredClauseSelections: inventedClauseSelections(
            requiredIds,
            answer,
          ),
        }
      : {}),
  };
}
const evidence = new WeakMap<
  SourceSemanticReviewPlan,
  SourceEvidenceReadingRecord
>();
export function inventedSourceEvidence(plan: SourceSemanticReviewPlan) {
  let record = evidence.get(plan);
  if (!record) {
    record = recordInventedSourceEvidenceReading(
      plan.evidencePlan.requests.map((r) =>
        inventedSourceEvidenceAnswer(JSON.parse(r.prompt)),
      ),
      plan.evidencePlan,
      {
        id: "invented-independent-reading",
        at: "2030-01-01T12:00:00.000Z",
        model: plan.model,
      },
    );
    evidence.set(plan, record);
  }
  return record;
}
export function inventedGroundedReviewRequests(plan: SourceSemanticReviewPlan) {
  return buildGroundedSourceReviewRequests(plan, inventedSourceEvidence(plan));
}
export function inventedReadingRefs(
  body: any,
  claim: { sourceRefs: string[]; kind?: string },
) {
  body = {
    ...body,
    independentReading: materializeSourceReviewIndependentReading(
      JSON.stringify(body),
    ),
  };
  return [
    ...(claim.kind === "contract_clause_coverage" ||
    claim.kind === "scope_coverage"
      ? body.originalFacts
          .filter((f: any) => claim.sourceRefs.includes(f.sourceRef))
          .map((f: any) => f.id)
      : []),
    ...body.independentReading.observations
      .filter((o: any) =>
        o.evidence.some((q: any) => claim.sourceRefs.includes(q.sourceRef)),
      )
      .map((o: any) => o.id),
    ...body.independentReading.classifications
      .filter((c: any) =>
        c.evidence.some((q: any) => claim.sourceRefs.includes(q.sourceRef)),
      )
      .map((c: any) => c.id),
  ];
}

// Mechanical witnesses for invented fixtures only, never provider repairs.
export function inventedCoverageProof(
  draft: any,
  claim: any,
  verdict: string,
  body?: any,
) {
  // Decode only explicitly invented fixtures. Recorded provider responses are
  // never passed here; dictionary indices retain exact text and citations.
  if (draft.detailEvidenceBindings)
    draft = materializeSourceReviewDraft(JSON.stringify({ ...body, draft }));
  if (!claim.kind?.endsWith("coverage")) return [];
  return claim.sourceRefs.map((sourceRef: string) => {
    const indices = draft.details.flatMap((d: any, index: number) =>
      d.sourceRefs.includes(sourceRef) ? [index] : [],
    );
    const index = indices[0] ?? -1;
    const witness =
      index >= 0
        ? {
            draftPath: `/details/${index}/explanation`,
            quote: draft.details[index].explanation,
          }
        : draft.summarySourceRefs.includes(sourceRef)
          ? { draftPath: "/summary", quote: draft.summary }
          : null;
    if (witness)
      return {
        sourceRef,
        disposition: "represented",
        witnesses:
          index >= 0 && draft.details[index].lf
            ? indices.map((i: number) => ({
                draftPath: `/details/${i}/explanation`,
                quote: draft.details[i].explanation,
              }))
            : [witness],
      };
    if (claim.kind === "contract_clause_coverage" && verdict === "supported")
      throw new Error("Invented mandatory fixture needs a real draft witness");
    return {
      sourceRef,
      disposition:
        claim.kind === "contract_clause_coverage" ? "missing" : "not_required",
      witnesses: [],
    };
  });
}

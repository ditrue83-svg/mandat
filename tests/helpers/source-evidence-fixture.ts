// Explicitly invented favorable responses for contract/queue tests only.
// These helpers are not a semantic benchmark or an AI quality judgment.
import {
  recordSourceEvidenceReading,
  type SourceEvidenceReadingRecord,
} from "../../src/lib/source-evidence-reading";
import {
  buildGroundedSourceReviewRequests,
  type SourceSemanticReviewPlan,
} from "../../src/lib/source-semantic-review";

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
        (answer[collection] ?? []).flatMap((row: any, index: number) =>
          row.serviceRef === id ||
          row.evidence.some((e: any) => e.sourceRef === id)
            ? [{ collection, index }]
            : [],
        ),
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
    record = recordSourceEvidenceReading(
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
export function inventedCoverageProof(draft: any, claim: any, verdict: string) {
  if (!claim.kind?.endsWith("coverage")) return [];
  return claim.sourceRefs.map((sourceRef: string) => {
    const index = draft.details.findIndex((d: any) =>
      d.sourceRefs.includes(sourceRef),
    );
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
      return { sourceRef, disposition: "represented", witnesses: [witness] };
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

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

export function inventedSourceEvidenceAnswer(data: any) {
  const quote = (id: string) => {
    const passage = data.passages.find((p: any) => p.id === id);
    if (!passage) throw new Error("Invented fixture lacks source passage");
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
  return {
    chunkId: data.chunkId,
    coverage: "complete",
    observations: [
      target,
      ...data.passages.filter((p: any) => p.id !== target.id),
    ]
      .map((p: any) => ({
        kind:
          p.id === target.id || p.role === "service"
            ? "performance"
            : "condition",
        statement:
          "Osservazione inventata per verificare il contratto, non il significato.",
        scope: p.scope,
        evidence: [quote(p.id)],
      }))
      .slice(0, 32),
    classifications: data.assignedClassificationIds.map((id: string) => {
      const c = data.classifications.find((item: any) => item.id === id);
      const refs: string[] = [
        ...(c.code?.sourceRefs ?? []),
        ...c.labels.flatMap((l: any) => l.sourceRefs),
      ];
      return {
        classificationId: id,
        relationship: "broad_context",
        explanation: "Relazione inventata per la sola verifica tecnica.",
        evidence: refs.map(quote),
      };
    }),
    issues: [],
    missingDetails: [],
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
  claim: { sourceRefs: string[] },
) {
  return [
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

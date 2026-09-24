import {
  inventedSourceEvidence,
  inventedGroundedReviewRequests,
  inventedReadingRefs,
} from "./helpers/source-evidence-fixture";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, vi } from "vitest";
import {
  buildAutomaticComparisonRequest,
  validateAutomaticComparison as validateWithRequiredReview,
  AutomaticComparisonUnavailable,
  recordAutomaticComparison as recordWithRequiredReview,
  readAutomaticComparison,
  buildAutomaticReductionRequest,
  automaticComparisonModel,
  resolveAutomaticComparison,
  buildAutomaticSourceRequest,
  buildInterpretedComparisonRequest as buildWithRequiredReview,
  buildAutomaticSourceSemanticReviewRequest,
  readAutomaticSourceSemanticReview,
  readAutomaticSourceInterpretation,
} from "../src/lib/automatic-comparison";
import {
  recordSourceInterpretation,
  type SourceInterpretationRecord,
} from "../src/lib/source-interpretation";
import {
  recordSourceSemanticReview,
  type SourceSemanticReviewRecord,
} from "../src/lib/source-semantic-review";
import { stableDocumentaryJson } from "../src/lib/documentary-observation";
import {
  captureLotSourceSnapshot,
  resolveLotSourceContext,
  createLotSourceReviewRecord,
} from "../src/lib/lot-source-context";
import { preserveSimapLots } from "../src/lib/source-lots";
import { normalizeSimap } from "../src/sources/simap";
import {
  preliminaryAssessmentMatch,
  resolveProjectLotAssessment,
  projectLotAssessmentDto,
} from "../src/lib/lot-assessment";
import { shapeFixture } from "./helpers/assessment-shape-fixture";
import type { CompanyProfile } from "../src/lib/domain";

const projectId = "a9100000-0000-4000-8000-000000000001";
const publicationId = "a9100000-0000-4000-8000-000000000002";
const lotA = "a9100000-0000-4000-8000-000000000003";
const lotB = "a9100000-0000-4000-8000-000000000004";
const identity = {
  projectId,
  publicationId,
  detailUrl: `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${publicationId}`,
};
function raw(lots = false) {
  return {
    id: publicationId,
    type: "tender",
    base: {
      projectId,
      id: publicationId,
      lotsType: lots ? "with" : "without",
      processType: "open",
    },
    "project-info": { title: { it: "Servizi inventati per uffici" } },
    procurement: {
      orderDescription: {
        it: "Pulizie di uffici e condomini. 🌿 Prestazioni inventate per il test.",
      },
      orderAddress: { countryId: "CH", cantonId: "TI", city: { it: "Lugano" } },
      cpvCode: { code: "90910000" },
    },
    dates: { offerDeadline: "2030-12-01T12:00:00+01:00", processType: "open" },
    terms: {
      qualificationCriteriaNote: {
        it: "CONDIZIONE_INVENTATA: presentare le referenze richieste.",
      },
    },
    metadata: { orderDescription: { it: "METADATA_NON_SERVIZIO" } },
    lots: lots
      ? [
          {
            id: lotA,
            lotNumber: 1,
            title: { it: "Pulizie" },
            orderDescription: { it: "Pulizia degli uffici del lotto A." },
            cpvCode: { code: "90910000" },
            orderAddress: {
              countryId: "CH",
              cantonId: "TI",
              city: { it: "Lugano" },
            },
            awardCriteria: [{ title: { it: "CRITERIO_NON_SERVIZIO" } }],
          },
          {
            id: lotB,
            lotNumber: 2,
            title: { it: "Lotto B" },
            orderDescription: { it: "SOLO_LOTTO_B: fornitura di mobili." },
          },
        ]
      : [],
  };
}
function fixture(
  detail: Parameters<typeof normalizeSimap>[1] = raw(),
  overrides: Partial<CompanyProfile> = {},
) {
  const publication = normalizeSimap(
    {
      id: projectId,
      raw: {
        id: projectId,
        publicationId,
        projectNumber: "INVENTED-AUTOMATIC-COMPARISON",
        publicationDate: "2030-01-01",
        pubType: "tender",
        processType: "open",
        title: { it: "Gara inventata" },
        procOfficeName: { it: "Ente inventato" },
      },
    },
    detail,
  );
  const snapshot = captureLotSourceSnapshot({
    publicationId: publication.id,
    observationId: "a9100000-0000-4000-8000-000000000005",
    sourceScopeReview: null,
    acquisition: {
      state: "accepted",
      archive: preserveSimapLots(detail, identity),
    },
  });
  const shapeState = shapeFixture(snapshot);
  const target = shapeState.shape.targets[0];
  const profile: CompanyProfile = {
    name: "NOME_PRIVATO_NON_INVIARE",
    activities: "Pulizie di uffici e condomini in tutto il Ticino",
    employees: 5,
    sectors: ["pulizie"],
    zones: ["Tutto il Ticino"],
    keywords: [],
    exclusions: [],
    minValue: null,
    maxValue: null,
    emailEnabled: false,
    ...overrides,
  };
  const history: Parameters<typeof resolveLotSourceContext>[2] = [];
  const context = resolveLotSourceContext(snapshot, target, history);
  const preliminary = preliminaryAssessmentMatch({
    publication,
    profile,
    context,
    now: new Date("2030-01-20T12:00:00.000Z"),
  });
  return {
    companyId: "fictional-automatic-company",
    publication,
    snapshot,
    shapeState,
    target,
    profile,
    history,
    preliminary,
  };
}
function explicitMeaning(statement: string, objectRefs: string[]) {
  return {
    state: "identified" as const,
    statement,
    basis: "explicit_text" as const,
    objectRefs,
    classificationContextIds: [] as string[],
  };
}
function roleEvidence(
  request: ReturnType<typeof buildAutomaticComparisonRequest>,
  ref: string,
) {
  const passage = request.passages.find((item) => item.id === ref)!;
  return {
    state: "identified" as const,
    actionText: Array.from(passage.text).slice(0, 80).join(""),
    sourceRefs: [ref],
    scope: passage.scope,
  };
}
function sourceResponse(
  request: ReturnType<typeof buildAutomaticComparisonRequest>,
  status: "resolved" | "uncertain" | "conflicting" = "resolved",
  readings: readonly unknown[] = [],
) {
  const sourceRequest = buildAutomaticSourceRequest(request, readings);
  const targetRef = request.passages.find(
    (p) => p.scope === request.targetScope && p.role === "service",
  )!.id;
  const other = request.passages.find(
    (p) => p.id !== targetRef && p.text.trim(),
  )!.id;
  return {
    status,
    details: [],
    summary:
      "Servizi inventati, interpretazione simulata per verificare il contratto.",
    classificationReadings: sourceRequest.classificationContext.map(
      (classification) => ({
        classificationId: classification.id,
        use:
          classification.appliesTo === "shared_project_context"
            ? ("shared_project_only" as const)
            : ("broad_context" as const),
        explanation:
          "Contesto inventato, il servizio è descritto nel testo dell'oggetto.",
        sourceRefs: [
          ...(classification.code?.sourceRefs ?? []),
          ...classification.labels.flatMap((label) => label.sourceRefs),
        ],
      }),
    ),
    components: [
      {
        description: "Pulizia degli uffici inventati.",
        role: "execute" as const,
        roleEvidence: roleEvidence(request, targetRef),
        importance: "main" as const,
        sourceRefs: [targetRef],
        meaning:
          status === "uncertain"
            ? {
                state: "ambiguous" as const,
                statement: "Oggetto inventato non identificabile.",
                basis: "unresolved" as const,
                objectRefs: [targetRef],
                classificationContextIds: [],
              }
            : explicitMeaning("Pulizia degli uffici inventati.", [targetRef]),
      },
    ],
    issues:
      status === "resolved"
        ? []
        : [
            {
              kind:
                status === "conflicting"
                  ? ("source_conflict" as const)
                  : ("object_identity" as const),
              scope: request.targetScope,
              componentIndexes: [0],
              explanation:
                "Dubbio inventato, non una verifica semantica del modello.",
              sourceRefs:
                status === "conflicting" ? [targetRef, other] : [targetRef],
            },
          ],
    targetRef,
  };
}
function sourceRecord(
  request: ReturnType<typeof buildAutomaticComparisonRequest>,
  readings: readonly unknown[] = [],
  status: "resolved" | "uncertain" | "conflicting" = "resolved",
) {
  return recordSourceInterpretation(
    sourceResponse(request, status, readings),
    buildAutomaticSourceRequest(request, readings),
    {
      id: "invented-source-interpretation",
      at: "2030-01-20T12:00:00.000Z",
      model: automaticComparisonModel(),
    },
  );
}

// Existing comparison fixtures explicitly simulate a favorable review. These
// invented answers test plumbing, not semantic quality. The gate tests below
// call the production functions directly without this fixture convenience.
function sourceReview(
  request: ReturnType<typeof buildAutomaticComparisonRequest>,
  source: SourceInterpretationRecord,
  verdict: "supported" | "contradicted" | "not_verifiable" = "supported",
) {
  const plan = buildAutomaticSourceSemanticReviewRequest(request, source);
  return recordSourceSemanticReview(
    inventedGroundedReviewRequests(plan).map((chunk) => {
      const body = JSON.parse(chunk.prompt);
      return {
        chunkId: body.chunkId,
        sourceEvidenceHash: body.sourceEvidenceHash,
        coverage: "complete",
        checks: body.assignedClaims.map(
          (claim: { id: string; sourceRefs: string[] }) => ({
            claimId: claim.id,
            readingRefs: inventedReadingRefs(body, claim),
            verdict,
            reason:
              "Giudizio inventato per verificare il flusso, non la qualità AI.",
            sourceRefs: claim.sourceRefs.length
              ? claim.sourceRefs
              : [body.passages[0].id],
          }),
        ),
        findings: [],
      };
    }),
    plan,
    {
      id: "invented-semantic-review",
      at: "2030-01-20T12:01:00.000Z",
      model: plan.model,
      sourceEvidence: inventedSourceEvidence(plan),
    },
  );
}
function fixtureReview(
  request: ReturnType<typeof buildAutomaticComparisonRequest>,
  source: unknown,
): SourceSemanticReviewRecord | null {
  const draft = source as SourceInterpretationRecord | null | undefined;
  return draft?.response?.status === "resolved"
    ? sourceReview(request, draft)
    : null;
}
function validateAutomaticComparison(
  response: unknown,
  request: ReturnType<typeof buildAutomaticComparisonRequest>,
  source: unknown,
) {
  return validateWithRequiredReview(
    response,
    request,
    source,
    fixtureReview(request, source),
  );
}
function buildInterpretedComparisonRequest(
  request: ReturnType<typeof buildAutomaticComparisonRequest>,
  source: SourceInterpretationRecord,
) {
  return buildWithRequiredReview(
    request,
    source,
    fixtureReview(request, source)!,
  );
}
function recordAutomaticComparison(
  response: unknown,
  request: ReturnType<typeof buildAutomaticComparisonRequest>,
  metadata: Omit<
    Parameters<typeof recordWithRequiredReview>[2],
    "sourceReview"
  >,
) {
  return recordWithRequiredReview(response, request, {
    ...metadata,
    sourceReview: fixtureReview(request, metadata.sourceInterpretation),
  });
}
function response(
  request: ReturnType<typeof buildAutomaticComparisonRequest>,
  interpretation: SourceInterpretationRecord,
  relation: "direct" | "different" | "review" = "direct",
) {
  return {
    comparison:
      "Confronto inventato per verificare il contratto, non la qualità semantica del modello.",
    facts: {
      companyIdentifiesService: true,
      activitiesOverlap: relation !== "different",
      sameContractualRole: true,
      mainScopeCovered: relation === "direct",
      comparisonUncertain: false,
    },
    interpretationHash: interpretation.hash,
    reviewHash: fixtureReview(request, interpretation)?.hash ?? "0".repeat(64),
    componentRefs: ["u1"],
    companyRefs: [request.companyPassages[0].id],
  };
}

test("A resolved interpretation cannot bypass the separate semantic review", () => {
  const request = buildAutomaticComparisonRequest(fixture());
  const source = sourceRecord(request);
  for (const missing of [undefined, null]) {
    assert.throws(
      () =>
        validateWithRequiredReview(
          response(request, source),
          request,
          source,
          missing,
        ),
      /Missing source semantic review/,
    );
    assert.throws(() =>
      buildWithRequiredReview(request, source, missing as never),
    );
  }
  const review = sourceReview(request, source);
  assert.equal(
    validateWithRequiredReview(
      response(request, source),
      request,
      source,
      review,
    ).relation,
    "direct",
  );
  assert.throws(
    () =>
      validateWithRequiredReview(
        { ...response(request, source), reviewHash: "0".repeat(64) },
        request,
        source,
        review,
      ),
    /another source semantic review/,
  );
  assert.equal(
    JSON.parse(buildWithRequiredReview(request, source, review).prompt)
      .sourceInterpretation.reviewHash,
    review.hash,
  );
});

test.each(["contradicted", "not_verifiable"] as const)(
  "A %s source review is persisted without a final company judgment",
  (verdict) => {
    const input = fixture();
    const request = buildAutomaticComparisonRequest(input);
    const source = sourceRecord(request);
    const review = sourceReview(request, source, verdict);
    assert.throws(
      () => buildWithRequiredReview(request, source, review),
      /semantic review/,
    );
    assert.throws(
      () =>
        validateWithRequiredReview(
          response(request, source),
          request,
          source,
          review,
        ),
      /Uncertain source/,
    );
    const stored = recordWithRequiredReview(null, request, {
      id: "invented-negative-source-review",
      at: "2030-01-20T12:02:00.000Z",
      model: automaticComparisonModel(),
      sourceInterpretation: source,
      sourceReview: review,
    });
    const current = readAutomaticComparison(stored, request)!;
    assert.equal(current.comparisonOrigin, "source_semantic_review");
    assert.equal(current.sourceBlocked, true);
    assert.equal(current.sourceReview?.accepted, false);
    assert.equal(current.relation, "review");
    assert.equal(current.response, null);
    assert.equal(current.companyEvidence.length, 0);
    assert.equal(stored.sourceInterpretation.hash, source.hash);
    assert.equal(stored.sourceReview?.hash, review.hash);
    assert.equal(
      resolveAutomaticComparison(input, [stored]).comparison?.result,
      "review",
    );
    assert.throws(
      () => readAutomaticComparison({ ...stored, sourceReview: null }, request),
      /Altered automatic comparison/,
    );
  },
);

test("Semantic reviews use the full original source and never company data", () => {
  const detail = raw();
  detail.terms.qualificationCriteriaNote.it =
    "Condizione inventata completa. ".repeat(1500) +
    " CLAUSOLA_FINALE_ORIGINALE";
  const input = fixture(detail);
  const request = buildAutomaticComparisonRequest(input);
  const readings = request.readingRequests.map((chunk) => ({
    chunkId: chunk.id,
    status: "complete",
    sourceRefs: chunk.passageIds.filter(
      (id) => request.passages.find((p) => p.id === id)?.role === "service",
    ),
  }));
  const source = sourceRecord(request, readings);
  const reduced = buildAutomaticSourceRequest(request, readings);
  assert.ok(reduced.body.passages.length < request.passages.length);
  const plan = buildAutomaticSourceSemanticReviewRequest(request, source);
  const bodies = plan.requests.map((chunk) => JSON.parse(chunk.prompt));
  const covered = new Set(bodies.flatMap((body) => body.coverage.passageIds));
  assert.deepEqual(
    [...covered].sort(),
    request.passages.map((p) => p.id).sort(),
  );
  const serialized = JSON.stringify(bodies);
  assert.ok(serialized.includes("CLAUSOLA_FINALE_ORIGINALE"));
  for (const privateText of [
    input.companyId,
    input.profile.name,
    input.profile.activities,
  ])
    assert.equal(serialized.includes(privateText), false);
  const another = buildAutomaticComparisonRequest({
    ...input,
    companyId: "ANOTHER_PRIVATE_ID",
    profile: { ...input.profile, activities: "PRIVATE_OTHER_ACTIVITY" },
  });
  assert.deepEqual(
    buildAutomaticSourceSemanticReviewRequest(another, source),
    plan,
  );
});

test("Semantic approval is bound to the exact draft and reviewer configuration", () => {
  try {
    vi.stubEnv("DOCUMENTARY_LLM_REASONING_EFFORT", "none");
    const request = buildAutomaticComparisonRequest(fixture());
    const source = sourceRecord(request);
    const review = sourceReview(request, source);
    assert.deepEqual(
      readAutomaticSourceSemanticReview(review, source, request),
      review,
    );
    const changedDraft = recordSourceInterpretation(
      { ...source.response, summary: "Altra sintesi inventata." },
      buildAutomaticSourceRequest(request),
      { id: "another-draft", at: source.at, model: source.model },
    );
    assert.equal(
      readAutomaticSourceSemanticReview(review, changedDraft, request),
      null,
    );
    assert.throws(
      () =>
        validateWithRequiredReview(
          response(request, changedDraft),
          request,
          changedDraft,
          review,
        ),
      /Stale source semantic review/,
    );
    assert.throws(
      () =>
        readAutomaticSourceSemanticReview(
          { ...review, id: "altered" },
          source,
          request,
        ),
      /Altered/,
    );
    vi.stubEnv("DOCUMENTARY_LLM_REASONING_EFFORT", "high");
    const changedConfiguration = buildAutomaticComparisonRequest(fixture());
    assert.equal(
      readAutomaticSourceSemanticReview(review, source, changedConfiguration),
      null,
    );
    assert.equal(changedConfiguration.sourceKey, request.sourceKey);
    assert.notEqual(changedConfiguration.inputHash, request.inputHash);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("A source with a separate AI review supports a referenced comparison without creating a human judgment", () => {
  const input = fixture();
  const request = buildAutomaticComparisonRequest(input);
  const source = sourceRecord(request);
  const result = validateAutomaticComparison(
    response(request, source),
    request,
    source,
  );
  assert.equal(request.sourceBlocked, false);
  assert.equal(result.relation, "direct");
  assert.equal(result.origin, "ai");
  assert.equal("humanReview" in result, false);
  assert.equal(input.history.length, 0);
  assert.ok(result.reason.includes("prestazioni"));
  assert.equal(result.companyEvidence[0].text, input.profile.activities);
  assert.equal(request.prompt.includes(input.profile.name), false);
  assert.ok(request.prompt.includes("CONDIZIONE_INVENTATA"));
  assert.equal(result.sourceInterpretation.hash, source.hash);
  assert.equal(result.dependency.sourceInterpretationHash, source.hash);
  assert.ok(Object.isFrozen(request.passages));
  assert.ok(Object.isFrozen(result.evidence[0]));
});

test("Dedicated model configuration preserves the verified provider input and binding", () => {
  try {
    vi.stubEnv("DOCUMENTARY_LLM_MODEL", "");
    vi.stubEnv("DOCUMENTARY_LLM_REASONING_EFFORT", "");
    vi.stubEnv("LLM_MODEL", "verified-comparison-model");
    vi.stubEnv("LLM_REASONING_EFFORT", "high");
    const input = fixture();
    const verified = buildAutomaticComparisonRequest(input);
    vi.stubEnv("LLM_MODEL", "unchanged-summary-model");
    vi.stubEnv("LLM_REASONING_EFFORT", "none");
    vi.stubEnv("DOCUMENTARY_LLM_MODEL", "verified-comparison-model");
    vi.stubEnv("DOCUMENTARY_LLM_REASONING_EFFORT", "high");
    const dedicated = buildAutomaticComparisonRequest(input);
    assert.deepEqual(dedicated, verified);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("Source interpretation is identical across companies and only the final comparison receives the profile", () => {
  const input = fixture();
  const first = buildAutomaticComparisonRequest(input);
  const other = buildAutomaticComparisonRequest({
    ...fixture(raw(), {
      name: "ALTRO_NOME_PRIVATO",
      activities: "ATTIVITA_AZIENDALE_DIVERSA: fornitura di mobili.",
      sectors: ["arredi"],
      keywords: ["PAROLA_PRIVATA"],
      exclusions: ["ESCLUSIONE_PRIVATA"],
      employees: 3,
      emailEnabled: true,
    }),
    companyId: "another-private-company",
  });
  assert.notEqual(first.inputHash, other.inputHash);
  assert.equal(first.sourceKey, other.sourceKey);
  const sourceRequest = buildAutomaticSourceRequest(first);
  const otherSourceRequest = buildAutomaticSourceRequest(other);
  assert.deepEqual(sourceRequest, otherSourceRequest);
  const serialized = JSON.stringify(sourceRequest);
  for (const privateValue of [
    input.companyId,
    input.profile.name,
    input.profile.activities,
    "another-private-company",
    "ALTRO_NOME_PRIVATO",
    "ATTIVITA_AZIENDALE_DIVERSA",
    "PAROLA_PRIVATA",
    "ESCLUSIONE_PRIVATA",
  ])
    assert.equal(serialized.includes(privateValue), false);
  const source = sourceRecord(first);
  assert.deepEqual(readAutomaticSourceInterpretation(source, other), source);
  const final = JSON.parse(
    buildInterpretedComparisonRequest(other, source).prompt,
  );
  assert.equal(final.sourceInterpretation.hash, source.hash);
  assert.equal(final.company.activities[0].text, other.companyPassages[0].text);
  assert.equal("passages" in final, false);
  assert.equal("targetRef" in final, false);
});

test("Source configuration is bound independently from the final comparison and leaves map requests unchanged", () => {
  try {
    vi.stubEnv("DOCUMENTARY_SOURCE_REASONING_EFFORT", "");
    vi.stubEnv("DOCUMENTARY_LLM_REASONING_EFFORT", "high");
    vi.stubEnv("LLM_REASONING_EFFORT", "high");
    const input = fixture();
    const first = buildAutomaticComparisonRequest(input);
    const source = sourceRecord(first);
    const sourceRequest = buildAutomaticSourceRequest(first);
    assert.equal(first.sourceBinding.reasoningEffort, "none");
    assert.equal(first.sourceBinding.maxTokens, 8192);
    assert.equal(sourceRequest.maxTokens, 8192);
    assert.equal(first.maxTokens, 8192);
    vi.stubEnv("DOCUMENTARY_LLM_REASONING_EFFORT", "none");
    const finalChanged = buildAutomaticComparisonRequest(input);
    assert.equal(first.sourceKey, finalChanged.sourceKey);
    assert.notEqual(first.inputHash, finalChanged.inputHash);
    assert.deepEqual(buildAutomaticSourceRequest(finalChanged), sourceRequest);
    assert.deepEqual(
      readAutomaticSourceInterpretation(source, finalChanged),
      source,
    );

    vi.stubEnv("DOCUMENTARY_SOURCE_REASONING_EFFORT", "high");
    const sourceChanged = buildAutomaticComparisonRequest(input);
    assert.notEqual(sourceChanged.sourceKey, first.sourceKey);
    assert.notEqual(sourceChanged.inputHash, finalChanged.inputHash);
    assert.equal(buildAutomaticSourceRequest(sourceChanged).maxTokens, 8192);
    assert.equal(
      readAutomaticSourceInterpretation(source, sourceChanged),
      null,
    );
    assert.equal(
      readAutomaticSourceInterpretation(
        {
          version: "documentary-source-interpretation-v3",
          sourceKey: sourceChanged.sourceKey,
          response: { obsoleteSchema: true },
        },
        sourceChanged,
      ),
      null,
    );

    const detail = raw();
    detail.terms.qualificationCriteriaNote.it = "Condizione inventata. ".repeat(
      1500,
    );
    const longInput = fixture(detail);
    const high = buildAutomaticComparisonRequest(longInput);
    vi.stubEnv("DOCUMENTARY_SOURCE_REASONING_EFFORT", "none");
    const none = buildAutomaticComparisonRequest(longInput);
    assert.ok(high.readingRequests.length > 1);
    assert.deepEqual(high.readingRequests, none.readingRequests);
    assert.deepEqual(high.passages, none.passages);
    assert.ok(
      none.readingRequests.every((chunk) => chunk.reasoningEffort === "none"),
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

test("Missing, stale or tampered source interpretations cannot be replaced by an implicit interpretation", () => {
  const request = buildAutomaticComparisonRequest(fixture());
  const source = sourceRecord(request);
  const final = response(request, source);
  for (const missing of [undefined, null, {}])
    assert.throws(() => validateAutomaticComparison(final, request, missing));
  assert.throws(
    () => validateAutomaticComparison(null, request, source),
    /Resolved source/,
  );
  assert.throws(
    () =>
      buildInterpretedComparisonRequest(request, { ...source, id: "tampered" }),
    /Altered source/,
  );
  assert.throws(
    () =>
      validateAutomaticComparison(final, request, {
        ...source,
        id: "tampered",
      }),
    /Altered source/,
  );
  const changed = raw();
  changed.procurement.orderDescription.it += " Un'altra prestazione materiale.";
  const stale = sourceRecord(buildAutomaticComparisonRequest(fixture(changed)));
  assert.throws(
    () => validateAutomaticComparison(final, request, stale),
    /Stale source/,
  );
  assert.equal(
    readAutomaticSourceInterpretation(
      { ...source, version: "old-source-version" },
      request,
    ),
    null,
  );
  const stored = recordAutomaticComparison(final, request, {
    id: "invented-nested-integrity",
    at: "2030-01-20T12:00:00.000Z",
    model: automaticComparisonModel(),
    sourceInterpretation: source,
  });
  const { hash: _hash, ...unsigned } = stored;
  const changedEnvelope = {
    ...unsigned,
    sourceInterpretation: { ...source, id: "tampered" },
  };
  const hash = createHash("sha256")
    .update(stableDocumentaryJson(changedEnvelope))
    .digest("hex");
  assert.throws(
    () => readAutomaticComparison({ ...changedEnvelope, hash }, request),
    /Altered source/,
  );
});

test("An unresolved source rejects a final comparison and exposes issue evidence in its review result", () => {
  const request = buildAutomaticComparisonRequest(fixture());
  const issueRef = request.passages.find((passage) =>
    passage.text.includes("CONDIZIONE_INVENTATA"),
  )!.id;
  for (const status of ["uncertain", "conflicting"] as const) {
    const interpretationResponse = sourceResponse(request, status);
    assert.notEqual(issueRef, interpretationResponse.targetRef);
    assert.equal(
      interpretationResponse.components.some((component) =>
        component.sourceRefs.includes(issueRef),
      ),
      false,
    );
    const interpretation = recordSourceInterpretation(
      {
        ...interpretationResponse,
        issues: [
          {
            ...interpretationResponse.issues[0],
            explanation: "Condizione inventata che richiede chiarimento.",
            sourceRefs: [interpretationResponse.targetRef, issueRef],
          },
        ],
      },
      buildAutomaticSourceRequest(request),
      {
        id: `invented-${status}`,
        at: "2030-01-20T12:00:00.000Z",
        model: automaticComparisonModel(),
      },
    );
    assert.throws(
      () => buildInterpretedComparisonRequest(request, interpretation),
      /requires review/,
    );
    assert.throws(
      () =>
        validateAutomaticComparison(
          response(request, interpretation),
          request,
          interpretation,
        ),
      /Uncertain source/,
    );
    const review = validateAutomaticComparison(null, request, interpretation);
    assert.equal(review.relation, "review");
    assert.equal(review.comparisonOrigin, "source_interpretation");
    assert.equal(review.response, null);
    assert.deepEqual(review.companyEvidence, []);
    assert.ok(review.evidence.some((passage) => passage.id === issueRef));
    const stored = recordAutomaticComparison(null, request, {
      id: `invented-review-${status}`,
      at: "2030-01-20T12:00:00.000Z",
      model: automaticComparisonModel(),
      sourceInterpretation: interpretation,
    });
    assert.equal(
      readAutomaticComparison(stored, request)!.sourceInterpretation.status,
      status,
    );
  }
});

test("Missing specifications remain visible through comparison without becoming purchased components", () => {
  const detail = raw();
  detail.terms.qualificationCriteriaNote.it =
    "La quantità definitiva sarà comunicata nel capitolato inventato.";
  const request = buildAutomaticComparisonRequest(fixture(detail));
  const note = request.passages.find((passage) =>
    passage.text.includes("quantità definitiva"),
  )!;
  const answer = sourceResponse(request);
  const details = [
    {
      kind: "missing_specification",
      explanation: "Quantità definitiva non disponibile nel testo fornito.",
      sourceRefs: [note.id],
      scope: note.scope,
    },
  ];
  const source = recordSourceInterpretation(
    { ...answer, details },
    buildAutomaticSourceRequest(request),
    {
      id: "invented-nonblocking-detail",
      at: "2030-01-20T12:00:00.000Z",
      model: automaticComparisonModel(),
    },
  );
  const body = JSON.parse(
    buildInterpretedComparisonRequest(request, source).prompt,
  );
  assert.deepEqual(body.sourceInterpretation.details, details);
  assert.equal(body.sourceInterpretation.components.length, 1);
  assert.deepEqual(
    body.sourceInterpretation.components[0].roleEvidence,
    answer.components[0].roleEvidence,
  );
  const outcome = validateAutomaticComparison(
    response(request, source),
    request,
    source,
  );
  assert.equal(outcome.relation, "direct");
  assert.ok(outcome.evidence.some((passage) => passage.id === note.id));
  assert.throws(
    () =>
      validateAutomaticComparison(
        { ...response(request, source), componentRefs: ["u1", "u2"] },
        request,
        source,
      ),
    /Unknown interpreted-component/,
  );
});

test("An identified object with an unresolved role stays in review without a company comparison", () => {
  const request = buildAutomaticComparisonRequest(fixture());
  const answer = sourceResponse(request);
  const source = recordSourceInterpretation(
    {
      ...answer,
      status: "uncertain",
      components: answer.components.map((component) => ({
        ...component,
        role: null,
        roleEvidence: { ...component.roleEvidence, state: "unresolved" },
      })),
      issues: [
        {
          kind: "role_identity",
          scope: request.targetScope,
          componentIndexes: [0],
          explanation: "Ruolo indeterminato nella risposta inventata.",
          sourceRefs: [answer.targetRef],
        },
      ],
    },
    buildAutomaticSourceRequest(request),
    {
      id: "invented-unresolved-role",
      at: "2030-01-20T12:00:00.000Z",
      model: automaticComparisonModel(),
    },
  );
  assert.throws(
    () => buildInterpretedComparisonRequest(request, source),
    /requires review/,
  );
  const outcome = validateAutomaticComparison(null, request, source);
  assert.equal(outcome.relation, "review");
  assert.equal(outcome.sourceInterpretation.components[0].role, null);
  assert.equal(
    outcome.sourceInterpretation.components[0].meaning.state,
    "identified",
  );
  assert.deepEqual(outcome.companyEvidence, []);
});

test("A claimed full match must cite every main interpreted component while partial scope may cite one", () => {
  const detail = raw();
  detail.procurement.orderDescription.it =
    "Pulizia degli uffici e manutenzione degli impianti inventati.";
  const request = buildAutomaticComparisonRequest(
    fixture(detail, { activities: detail.procurement.orderDescription.it }),
  );
  const interpreted = sourceResponse(request);
  const source = recordSourceInterpretation(
    {
      ...interpreted,
      components: [
        ...interpreted.components,
        {
          description: "Manutenzione degli impianti inventati.",
          role: "maintain",
          roleEvidence: roleEvidence(request, interpreted.targetRef),
          importance: "main",
          sourceRefs: [interpreted.targetRef],
          meaning: explicitMeaning("Manutenzione degli impianti inventati.", [
            interpreted.targetRef,
          ]),
        },
      ],
    },
    buildAutomaticSourceRequest(request),
    {
      id: "invented-two-main",
      at: "2030-01-20T12:00:00.000Z",
      model: automaticComparisonModel(),
    },
  );
  assert.throws(
    () =>
      validateAutomaticComparison(response(request, source), request, source),
    /main|principali|component/i,
  );
  assert.equal(
    validateAutomaticComparison(
      { ...response(request, source), componentRefs: ["u1", "u2"] },
      request,
      source,
    ).relation,
    "direct",
  );
  assert.equal(
    validateAutomaticComparison(
      response(request, source, "review"),
      request,
      source,
    ).relation,
    "review",
  );
});

test("An excluded component alone cannot justify a service rejection but remains valid counterevidence with requested work", () => {
  const detail = raw();
  detail.procurement.orderDescription.it =
    "Pulizia degli uffici, con fornitura accessoria dei detergenti. Ristorazione esclusa.";
  const request = buildAutomaticComparisonRequest(
    fixture(detail, { activities: "Servizi di ristorazione inventati." }),
  );
  const interpreted = sourceResponse(request);
  const serviceRef = request.passages.find(
    (passage) => passage.rawPath === "/procurement/orderDescription/it",
  )!.id;
  const source = recordSourceInterpretation(
    {
      ...interpreted,
      components: [
        {
          description: "Pulizia degli uffici.",
          role: "execute",
          roleEvidence: roleEvidence(request, serviceRef),
          importance: "main",
          sourceRefs: [serviceRef],
          meaning: explicitMeaning("Pulizia degli uffici.", [serviceRef]),
        },
        {
          description: "Fornitura dei detergenti.",
          role: "supply",
          roleEvidence: roleEvidence(request, serviceRef),
          importance: "accessory",
          sourceRefs: [serviceRef],
          meaning: explicitMeaning("Fornitura dei detergenti.", [serviceRef]),
        },
        {
          description: "Ristorazione.",
          role: "execute",
          roleEvidence: roleEvidence(request, serviceRef),
          importance: "excluded",
          sourceRefs: [serviceRef],
          meaning: explicitMeaning("Ristorazione esclusa.", [serviceRef]),
        },
      ],
    },
    buildAutomaticSourceRequest(request),
    {
      id: "invented-excluded-component",
      at: "2030-01-20T12:00:00.000Z",
      model: automaticComparisonModel(),
    },
  );
  const negative = response(request, source, "different");
  assert.throws(
    () =>
      validateAutomaticComparison(
        { ...negative, componentRefs: ["u3"] },
        request,
        source,
      ),
    /Service comparison requires evidence of a requested component/,
  );
  for (const requestedRef of ["u1", "u2"])
    assert.equal(
      validateAutomaticComparison(
        { ...negative, componentRefs: [requestedRef, "u3"] },
        request,
        source,
      ).relation,
      "different",
    );
  assert.equal(
    validateAutomaticComparison(
      {
        ...negative,
        componentRefs: ["u3"],
        facts: { ...negative.facts, comparisonUncertain: true },
      },
      request,
      source,
    ).relation,
    "review",
  );
});

test("A shared component or a vague profile cannot be promoted to a positive by a model label", () => {
  const request = buildAutomaticComparisonRequest(fixture());
  const source = sourceRecord(request);
  const full = response(request, source);
  for (const change of [
    { mainScopeCovered: false },
    { mainScopeCovered: false, sameContractualRole: false },
    { companyIdentifiesService: false, mainScopeCovered: null },
    { activitiesOverlap: null, mainScopeCovered: null },
    { comparisonUncertain: true },
  ]) {
    const value = validateAutomaticComparison(
      { ...full, facts: { ...full.facts, ...change } },
      request,
      source,
    );
    assert.equal(value.relation, "review");
  }
  assert.throws(
    () =>
      validateAutomaticComparison(
        { ...full, facts: { ...full.facts, activitiesOverlap: false } },
        request,
        source,
      ),
    /Contradictory/,
  );
});

test("Each relation has a consistent basis and exact bilateral evidence, never arbitrary prose or scores", () => {
  const request = buildAutomaticComparisonRequest(fixture());
  const source = sourceRecord(request);
  for (const relation of ["direct", "different", "review"] as const)
    assert.equal(
      validateAutomaticComparison(
        response(request, source, relation),
        request,
        source,
      ).relation,
      relation,
    );
  for (const changed of [
    { sourceRefs: ["s99999"] },
    { targetRef: source.response.targetRef },
    { componentRefs: ["u99999"] },
    { componentRefs: [] },
    { componentRefs: ["u1", "u1"] },
    { interpretationHash: "0".repeat(64) },
    { companyRefs: ["c99999"] },
    { companyRefs: [] },
    { basis: "invented_basis" },
    { relation: "direct" },
    { reason: "Possiede tutte le certificazioni richieste" },
    { score: 100 },
  ])
    assert.throws(() =>
      validateAutomaticComparison(
        { ...response(request, source), ...changed },
        request,
        source,
      ),
    );
  assert.throws(
    () =>
      validateAutomaticComparison(
        response(request, source),
        JSON.parse(JSON.stringify(request)),
        source,
      ),
    /Unverified/,
  );
});

test("Only the selected lot's own service text can establish a certain relation", () => {
  const request = buildAutomaticComparisonRequest(fixture(raw(true)));
  const source = sourceRecord(request);
  assert.equal(request.prompt.includes("SOLO_LOTTO_B"), false);
  assert.equal(request.targetScope, "selected_lot");
  assert.equal(
    validateAutomaticComparison(response(request, source), request, source)
      .relation,
    "direct",
  );
  for (const passage of request.passages.filter(
    (p) => p.role !== "service" || p.scope !== "selected_lot",
  ))
    assert.throws(
      () =>
        recordSourceInterpretation(
          {
            ...sourceResponse(request),
            targetRef: passage.id,
          },
          buildAutomaticSourceRequest(request),
          {
            id: "invented-invalid-target",
            at: "2030-01-20T12:00:00.000Z",
            model: automaticComparisonModel(),
          },
        ),
      /selected-target/,
    );
  assert.equal(
    request.passages.find((p) => p.text === "CRITERIO_NON_SERVIZIO")?.role,
    "context",
  );
  assert.equal(
    request.passages.find((p) => p.text === "METADATA_NON_SERVIZIO")?.role,
    "context",
  );
});

test("CPV context pairs original codes and multilingual labels with their exact source passages", () => {
  const base = raw();
  const detail = {
    ...base,
    procurement: {
      ...base.procurement,
      cpvCode: {
        code: "90910000",
        label: {
          it: "ETICHETTA_PRIMARIA_INVENTATA",
          de: "ERFUNDENE_BEZEICHNUNG",
        },
      },
      additionalCpvCodes: [
        { code: "90911000", label: { it: "ETICHETTA_AGGIUNTIVA_INVENTATA" } },
      ],
    },
  };
  const input = fixture(detail, {
    activities: "Commercio di prodotti per ambienti professionali.",
  });
  const request = buildAutomaticComparisonRequest(input);
  const body = JSON.parse(request.prompt);
  assert.equal(body.classifications.length, 2);
  const primary = body.classifications.find(
    (item: any) => item.rawPath === "/procurement/cpvCode",
  );
  assert.equal(primary.scope, "project_context");
  assert.equal(primary.appliesTo, "target");
  assert.equal(primary.code.text, detail.procurement.cpvCode.code);
  assert.deepEqual(
    primary.labels.map((label: any) => [label.language, label.text]),
    [
      ["de", detail.procurement.cpvCode.label.de],
      ["it", detail.procurement.cpvCode.label.it],
    ],
  );
  for (const classification of body.classifications)
    for (const field of [classification.code, ...classification.labels]) {
      const passages = field.sourceRefs.map((id: string) =>
        request.passages.find((passage) => passage.id === id)!,
      );
      assert.ok(
        passages.every(
          (passage: any) =>
            passage.scope === classification.scope &&
            passage.rawPath.startsWith(classification.rawPath + "/"),
        ),
      );
      assert.equal(
        passages.map((passage: any) => passage.text).join(""),
        field.text,
      );
    }
  assert.equal("company" in body, false);
  const sourceAnswer = sourceResponse(request);
  const contextOnlyRef = request.passages.find((passage) =>
    passage.text.includes("CONDIZIONE_INVENTATA"),
  )!.id;
  sourceAnswer.classificationReadings[0].sourceRefs.push(contextOnlyRef);
  sourceAnswer.classificationReadings[0].explanation =
    "La classificazione resta generale; la clausola sulle referenze non cambia il servizio acquistato.";
  const source = recordSourceInterpretation(
    sourceAnswer,
    buildAutomaticSourceRequest(request),
    {
      id: "invented-classification-clause",
      at: "2030-01-20T12:00:00.000Z",
      model: automaticComparisonModel(),
    },
  );
  const final = buildInterpretedComparisonRequest(request, source);
  const finalBody = JSON.parse(final.prompt);
  assert.equal(finalBody.company.activities[0].text, input.profile.activities);
  assert.equal(finalBody.sourceInterpretation.hash, source.hash);
  assert.equal("passages" in finalBody, false);
  assert.equal("classifications" in finalBody, false);
  assert.deepEqual(
    finalBody.sourceInterpretation.classificationContext,
    source.classificationContext,
  );
  assert.deepEqual(
    finalBody.sourceInterpretation.classificationReadings,
    source.response.classificationReadings,
  );
  assert.deepEqual(
    finalBody.sourceInterpretation.components[0].meaning,
    source.response.components[0].meaning,
  );
  const compared = validateAutomaticComparison(
    response(request, source),
    request,
    source,
  );
  assert.equal(
    source.response.components.some((component) =>
      component.sourceRefs.includes(contextOnlyRef),
    ),
    false,
  );
  assert.equal(
    source.classificationContext.some((classification) =>
      [classification.code, ...classification.labels].some((field) =>
        field?.sourceRefs.includes(contextOnlyRef),
      ),
    ),
    false,
  );
  assert.ok(compared.evidence.some((passage) => passage.id === contextOnlyRef));
  for (const classification of source.classificationContext)
    for (const field of [classification.code, ...classification.labels])
      for (const id of field?.sourceRefs ?? [])
        assert.ok(compared.evidence.some((passage) => passage.id === id));
  assert.throws(() =>
    validateAutomaticComparison(
      {
        ...response(request, source),
        componentRefs: [source.classificationContext[0].id],
      },
      request,
      source,
    ),
  );
  const rules = finalBody.task + " " + finalBody.rules.join(" ");
  assert.match(rules, /ruolo commerciale/);
  assert.match(rules, /famiglia di prodotti generica/);
  assert.match(rules, /differenza concreta/);
  const companyDescription = (
    final.responseFormat.json_schema.schema.properties as any
  ).facts.properties.companyIdentifiesService.description;
  assert.match(companyDescription, /servizi o prodotti concreti/);
  assert.match(companyDescription, /ruolo commerciale/);
  const changed = {
    ...detail,
    procurement: {
      ...detail.procurement,
      cpvCode: {
        ...detail.procurement.cpvCode,
        label: {
          ...detail.procurement.cpvCode.label,
          it: "ETICHETTA_RETTIFICATA",
        },
      },
    },
  };
  assert.notEqual(
    request.inputHash,
    buildAutomaticComparisonRequest(
      fixture(changed, { activities: input.profile.activities }),
    ).inputHash,
  );
});

test("CPV blocks keep shared project context separate from the selected lot and omit other lots", () => {
  const base = raw(true);
  const detail = {
    ...base,
    procurement: {
      ...base.procurement,
      cpvCode: { code: "39100000", label: { it: "CONTESTO_COMUNE_INVENTATO" } },
    },
    lots: base.lots.map((lot, index) => ({
      ...lot,
      cpvCode: {
        code: index === 0 ? "90910000" : "77310000",
        label: {
          it:
            index === 0
              ? "CLASSIFICAZIONE_LOTTO_SCELTO"
              : "CLASSIFICAZIONE_ALTRO_LOTTO",
        },
      },
    })),
    metadata: {
      ...base.metadata,
      cpvCode: { code: "55520000", label: { it: "CLASSIFICAZIONE_METADATA" } },
    },
  };
  const request = buildAutomaticComparisonRequest(fixture(detail));
  const blocks = JSON.parse(request.prompt).classifications;
  assert.equal(blocks.length, 2);
  assert.deepEqual(
    blocks.map((item: any) => [item.scope, item.appliesTo, item.code.text]),
    [
      ["project_context", "shared_project_context", "39100000"],
      ["selected_lot", "target", "90910000"],
    ],
  );
  assert.equal(
    JSON.stringify(blocks).includes("CLASSIFICAZIONE_METADATA"),
    false,
  );
  assert.equal(request.prompt.includes("CLASSIFICAZIONE_ALTRO_LOTTO"), false);
  const source = sourceRecord(request);
  const final = JSON.parse(
    buildInterpretedComparisonRequest(request, source).prompt,
  );
  assert.deepEqual(
    final.sourceInterpretation.classificationContext.map((item: any) => [
      item.scope,
      item.appliesTo,
      item.code.text,
    ]),
    [
      ["project_context", "shared_project_context", "39100000"],
      ["selected_lot", "target", "90910000"],
    ],
  );
  assert.deepEqual(
    final.sourceInterpretation.classificationReadings.map(
      (item: any) => item.use,
    ),
    ["shared_project_only", "broad_context"],
  );
  assert.equal(
    JSON.stringify(final).includes("CLASSIFICAZIONE_ALTRO_LOTTO"),
    false,
  );
});

test("Long-source reduction preserves complete CPV labels even when the map selects no context", () => {
  const base = raw();
  const label = "CLASSIFICAZIONE_LUNGA_INVENTATA ".repeat(85);
  const detail = {
    ...base,
    procurement: {
      ...base.procurement,
      cpvCode: { code: "90910000", label: { it: label } },
    },
    terms: {
      qualificationCriteriaNote: {
        it: "Condizioni amministrative inventate. ".repeat(900),
      },
    },
  };
  const request = buildAutomaticComparisonRequest(fixture(detail));
  assert.ok(request.readingRequests.length > 1);
  const readings = request.readingRequests.map((chunk) => ({
    chunkId: chunk.id,
    status: "complete",
    sourceRefs: [],
  }));
  const reduced = buildAutomaticReductionRequest(readings, request);
  const body = JSON.parse(reduced.prompt);
  const classification = body.classificationContext[0];
  assert.equal(classification.labels[0].text, label);
  assert.ok(classification.labels[0].sourceRefs.length > 1);
  for (const field of [classification.code, ...classification.labels])
    for (const id of field.sourceRefs) {
      assert.ok(reduced.selectedIds.includes(id));
      assert.ok(body.passages.some((passage: any) => passage.id === id));
    }
  assert.ok(Buffer.byteLength(reduced.system + reduced.prompt) <= 160_000);
  assert.deepEqual(
    request.readingRequests.flatMap((chunk) => chunk.passageIds),
    request.passages.map((passage) => passage.id),
  );
  const source = sourceRecord(request, readings);
  const final = JSON.parse(
    buildInterpretedComparisonRequest(request, source).prompt,
  );
  assert.equal(
    final.sourceInterpretation.classificationContext[0].labels[0].text,
    label,
  );
  assert.deepEqual(
    final.sourceInterpretation.classificationContext[0].labels[0].sourceRefs,
    classification.labels[0].sourceRefs,
  );
});

test("A concise source summary cannot erase the original domain context and grounded component from the final comparison", () => {
  const detail = {
    ...raw(),
    procurement: {
      ...raw().procurement,
      orderDescription: { it: "Fornitura del prodotto inventato X." },
      cpvCode: {
        code: "00000000",
        label: {
          it: "FAMIGLIA_DI_PRODOTTI_INVENTATA",
          de: "ERFUNDENE_PRODUKTFAMILIE",
        },
      },
    },
  };
  const request = buildAutomaticComparisonRequest(fixture(detail));
  const sourceRequest = buildAutomaticSourceRequest(request);
  const classification = sourceRequest.classificationContext[0];
  const classRefs = [
    ...(classification.code?.sourceRefs ?? []),
    ...classification.labels.flatMap((label) => label.sourceRefs),
  ];
  const answer = sourceResponse(request);
  const source = recordSourceInterpretation(
    {
      ...answer,
      summary: "Fornitura del prodotto inventato X.",
      classificationReadings: [
        {
          classificationId: classification.id,
          use: "clarifies_domain",
          explanation:
            "La famiglia inventata contestualizza il prodotto richiesto.",
          sourceRefs: classRefs,
        },
      ],
      components: [
        {
          description: "Fornitura del prodotto inventato X.",
          role: "supply",
          roleEvidence: roleEvidence(request, answer.targetRef),
          importance: "main",
          sourceRefs: [answer.targetRef, ...classRefs],
          meaning: {
            state: "identified",
            statement:
              "Prodotto X della famiglia di prodotti inventata dichiarata dalla fonte.",
            basis: "text_with_classification_context",
            objectRefs: [answer.targetRef],
            classificationContextIds: [classification.id],
          },
        },
      ],
    },
    sourceRequest,
    {
      id: "invented-domain-context",
      at: "2030-01-20T12:00:00.000Z",
      model: automaticComparisonModel(),
    },
  );
  const final = JSON.parse(
    buildInterpretedComparisonRequest(request, source).prompt,
  );
  assert.equal(
    final.sourceInterpretation.summary,
    "Fornitura del prodotto inventato X.",
  );
  assert.deepEqual(
    final.sourceInterpretation.classificationContext,
    sourceRequest.classificationContext,
  );
  assert.equal(
    final.sourceInterpretation.classificationContext[0].labels[1].text,
    "FAMIGLIA_DI_PRODOTTI_INVENTATA",
  );
  assert.equal(
    final.sourceInterpretation.classificationReadings[0].use,
    "clarifies_domain",
  );
  assert.deepEqual(
    final.sourceInterpretation.components[0].meaning.classificationContextIds,
    [classification.id],
  );
  const otherInput = fixture(detail, {
    activities: "Attività diverse inventate.",
  });
  const other = buildAutomaticComparisonRequest({
    ...otherInput,
    companyId: "other-invented-company",
  });
  const otherFinal = JSON.parse(
    buildInterpretedComparisonRequest(other, source).prompt,
  );
  assert.deepEqual(otherFinal.sourceInterpretation, final.sourceInterpretation);
  assert.notDeepEqual(otherFinal.company, final.company);
});

test("An explicit service without classification remains resolved without invented codes or forced doubt", () => {
  const base = raw();
  const { cpvCode: _cpvCode, ...procurement } = base.procurement;
  const request = buildAutomaticComparisonRequest(
    fixture({ ...base, procurement }),
  );
  const source = sourceRecord(request);
  const final = JSON.parse(
    buildInterpretedComparisonRequest(request, source).prompt,
  );
  assert.deepEqual(final.sourceInterpretation.classificationContext, []);
  assert.deepEqual(final.sourceInterpretation.classificationReadings, []);
  assert.equal(
    final.sourceInterpretation.components[0].meaning.basis,
    "explicit_text",
  );
  assert.equal(
    validateAutomaticComparison(response(request, source), request, source)
      .relation,
    "direct",
  );
});

test("Exact source spans reconstruct their complete field and preserve Unicode boundaries", () => {
  const detail = raw();
  detail.procurement.orderDescription.it =
    "a".repeat(1199) + "🌿" + "b".repeat(1300);
  const request = buildAutomaticComparisonRequest(fixture(detail));
  const parts = request.passages.filter(
    (p) => p.rawPath === "/procurement/orderDescription/it",
  );
  assert.equal(
    parts.map((p) => p.text).join(""),
    detail.procurement.orderDescription.it,
  );
  for (const part of parts) {
    assert.equal(
      part.text,
      detail.procurement.orderDescription.it.slice(
        part.startUtf16,
        part.endUtf16,
      ),
    );
    assert.equal(part.text.isWellFormed(), true);
    assert.equal(part.url, identity.detailUrl);
  }
});

test("Complete-input limits refuse unread tails instead of making truncated content look complete", () => {
  const detail = raw();
  detail.terms.qualificationCriteriaNote.it = "x".repeat(201_000);
  assert.throws(
    () => buildAutomaticComparisonRequest(fixture(detail)),
    (error: unknown) =>
      error instanceof AutomaticComparisonUnavailable &&
      error.code === "complete_source_capacity",
  );
});

test("Long sources cover every exact passage once, including a decisive condition at the end", () => {
  const detail = raw(true);
  detail.terms.qualificationCriteriaNote.it =
    "Condizioni amministrative inventate. ".repeat(1800) +
    "CODA_DA_VERIFICARE: il servizio include anche la gestione del ristorante.";
  const input = fixture(detail);
  const request = buildAutomaticComparisonRequest(input);
  assert.ok(request.readingRequests.length > 2);
  assert.equal(request.prompt, "");
  assert.deepEqual(
    request.readingRequests.flatMap((chunk) => chunk.passageIds),
    request.passages.map((passage) => passage.id),
  );
  assert.ok(
    request.readingRequests.at(-1)!.prompt.includes("CODA_DA_VERIFICARE"),
  );
  const readings = request.readingRequests.map((chunk) => ({
    chunkId: chunk.id,
    status: "complete",
    sourceRefs: chunk.passageIds,
  }));
  const reduced = buildAutomaticReductionRequest(readings, request);
  assert.ok(reduced.prompt.includes("CODA_DA_VERIFICARE"));
  const source = sourceRecord(request, readings);
  assert.equal(
    validateAutomaticComparison(response(request, source), request, source)
      .relation,
    "direct",
  );
  assert.throws(() => buildAutomaticSourceRequest(request), /Incomplete/);
  assert.throws(
    () => buildAutomaticReductionRequest(readings.slice(1), request),
    /Incomplete/,
  );
  assert.throws(
    () => buildAutomaticReductionRequest([...readings].reverse(), request),
    /Wrong/,
  );
  assert.throws(
    () =>
      buildAutomaticReductionRequest(
        readings.map((r, i) => (i ? r : { ...r, sourceRefs: ["s99999"] })),
        request,
      ),
    /outside/,
  );
  readings[readings.length - 1].status = "unreadable";
  const uncertain = sourceRecord(request, readings, "uncertain");
  assert.throws(
    () =>
      validateAutomaticComparison(
        response(request, source),
        request,
        uncertain,
      ),
    /Uncertain source/,
  );
  const result = validateAutomaticComparison(null, request, uncertain);
  assert.equal(result.relation, "review");
  assert.equal(result.coverage.linkedDocumentsRead, false);
});

test("Persisted responses cannot cross company boundaries or survive a changed profile or altered record", () => {
  const input = fixture(),
    request = buildAutomaticComparisonRequest(input);
  const source = sourceRecord(request);
  const metadata = {
    id: "invented-result",
    at: "2030-01-20T12:00:00.000Z",
    model: automaticComparisonModel(),
    sourceInterpretation: source,
  };
  const stored = recordAutomaticComparison(
    response(request, source),
    request,
    metadata,
  );
  assert.equal(readAutomaticComparison(stored, request)!.origin, "ai");
  assert.throws(
    () => readAutomaticComparison({ ...stored, id: "tampered" }, request),
    /Altered/,
  );
  assert.throws(
    () =>
      readAutomaticComparison(
        stored,
        buildAutomaticComparisonRequest({
          ...input,
          companyId: "another-company",
        }),
      ),
    /another company/,
  );
  assert.equal(
    readAutomaticComparison(
      stored,
      buildAutomaticComparisonRequest(
        fixture(raw(), { activities: "Pulizie industriali" }),
      ),
    ),
    null,
  );
  assert.throws(
    () =>
      recordAutomaticComparison(response(request, source), request, {
        ...metadata,
        model: "different-model",
      }),
    /model changed/,
  );
});

test.each([
  {
    comparisonVersion: "documentary-service-comparison-v10",
    sourceVersion: "documentary-source-interpretation-v3",
  },
  {
    comparisonVersion: "documentary-service-comparison-v11",
    sourceVersion: "documentary-source-interpretation-v4",
  },
  {
    comparisonVersion: "documentary-service-comparison-v12",
    sourceVersion: "documentary-source-interpretation-v5",
  },
  {
    comparisonVersion: "documentary-service-comparison-v13",
    sourceVersion: "documentary-source-interpretation-v6",
  },
  {
    comparisonVersion: "documentary-service-comparison-v15",
    sourceVersion: "documentary-source-interpretation-v6",
  },
  {
    comparisonVersion: "documentary-service-comparison-v20",
    sourceVersion: "documentary-source-interpretation-v6",
  },
])(
  "Historical $comparisonVersion / $sourceVersion stays stale under v23 without rewriting evidence",
  ({ comparisonVersion, sourceVersion }) => {
    const input = fixture();
    const request = buildAutomaticComparisonRequest(input);
    const source = sourceRecord(request);
    const stored = recordAutomaticComparison(
      response(request, source),
      request,
      {
        id: "invented-version-regression",
        at: "2030-01-20T12:00:00.000Z",
        model: automaticComparisonModel(),
        sourceInterpretation: source,
      },
    );
    const digest = (value: unknown) =>
      createHash("sha256").update(stableDocumentaryJson(value)).digest("hex");
    const { hash: _hash, ...unsigned } = stored;
    const oldUnsigned = {
      ...unsigned,
      sourceInterpretation: {
        ...unsigned.sourceInterpretation,
        version: sourceVersion,
      },
      version: comparisonVersion,
      inputHash: digest({
        ...request.dependency,
        version: comparisonVersion,
      }),
    };
    const historical = { ...oldUnsigned, hash: digest(oldUnsigned) };
    const before = JSON.stringify(historical);
    assert.equal(request.version, "documentary-service-comparison-v23");
    assert.notEqual(historical.inputHash, request.inputHash);
    assert.equal(readAutomaticComparison(historical, request), null);
    assert.equal(
      readAutomaticComparison(
        { ...historical, response: { oldSchema: true } },
        request,
      ),
      null,
    );
    assert.deepEqual(resolveAutomaticComparison(input, [historical]), {
      comparison: null,
      issue: "automatic_comparison_stale",
    });
    // Version itself must also prevent an old response being relabelled current
    // merely because its input hash was copied from a freshly built request.
    assert.equal(
      readAutomaticComparison(
        { ...historical, inputHash: request.inputHash },
        request,
      ),
      null,
    );
    assert.equal(
      resolveAutomaticComparison(input, [historical, stored]).comparison?.id,
      stored.id,
    );
    assert.equal(JSON.stringify(historical), before);
  },
);

test("A long-source reduction preserves all service text even when the map only selects an administrative limitation", () => {
  const detail = raw();
  detail.terms.qualificationCriteriaNote.it =
    "Condizioni amministrative neutre. ".repeat(900) +
    " VINCOLO_FINALE: servizio affidato solo per metà anno.";
  const request = buildAutomaticComparisonRequest(fixture(detail));
  const tail = request.passages.find((passage) =>
    passage.text.includes("VINCOLO_FINALE"),
  )!;
  const readings = request.readingRequests.map((chunk) => ({
    chunkId: chunk.id,
    status: "complete",
    sourceRefs: chunk.passageIds.includes(tail.id) ? [tail.id] : [],
  }));
  const reduced = buildAutomaticReductionRequest(readings, request);
  for (const passage of request.passages.filter(
    (passage) => passage.role === "service",
  ))
    assert.ok(reduced.selectedIds.includes(passage.id));
  assert.ok(reduced.prompt.includes("VINCOLO_FINALE"));
  const source = sourceRecord(request, readings);
  assert.equal(
    validateAutomaticComparison(response(request, source), request, source)
      .relation,
    "direct",
  );
  assert.ok(
    request.readingRequests.every(
      (chunk) => !("company" in JSON.parse(chunk.prompt)),
    ),
  );
});

test("Automatic positives are visible as AI but never count as human quality votes", () => {
  const input = fixture(),
    request = buildAutomaticComparisonRequest(input);
  const source = sourceRecord(request);
  const stored = recordAutomaticComparison(response(request, source), request, {
    id: "invented-positive",
    at: "2030-01-20T12:00:00.000Z",
    model: automaticComparisonModel(),
    sourceInterpretation: source,
  });
  const result = resolveProjectLotAssessment({
    ...input,
    now: new Date("2030-01-20T12:00:00.000Z"),
    evaluationSet: null,
    automaticComparisons: [stored],
  });
  assert.equal(result.projectAssessment!.automatic?.serviceRelation, "direct");
  assert.equal(result.quality, "unresolved");
  assert.equal(result.signalEligible, true);
  assert.deepEqual(result.qualityEventIds, []);
  const dto = projectLotAssessmentDto(result);
  assert.equal(dto.targets[0].origin, "ai");
  assert.ok(dto.targets[0].evidence.length);
  assert.deepEqual(dto.targets[0].companyEvidence, [input.profile.activities]);
  const stale = resolveProjectLotAssessment({
    ...input,
    profile: { ...input.profile, activities: "Fornitura di mobili" },
    evaluationSet: null,
    automaticComparisons: [stored],
    now: new Date("2030-01-20T12:00:00.000Z"),
  });
  assert.equal(stale.signalEligible, false);
  assert.equal(stale.quality, "unresolved");
});

test("Bindings follow profile and full source conditions, but not object key order", () => {
  const first = fixture();
  const base = buildAutomaticComparisonRequest(first);
  const changed = raw();
  changed.terms.qualificationCriteriaNote.it += " Nuova condizione materiale.";
  assert.notEqual(
    base.inputHash,
    buildAutomaticComparisonRequest(fixture(changed)).inputHash,
  );
  assert.notEqual(
    base.inputHash,
    buildAutomaticComparisonRequest(
      fixture(raw(), { activities: "Fornitura di mobili" }),
    ).inputHash,
  );
  const detail = raw();
  const reordered = Object.fromEntries(
    Object.entries(detail).reverse(),
  ) as ReturnType<typeof raw>;
  assert.equal(
    base.inputHash,
    buildAutomaticComparisonRequest(fixture(reordered)).inputHash,
  );
});

test("Explicit source doubt cannot be closed by a positive AI response", () => {
  const input = fixture();
  const context = resolveLotSourceContext(input.snapshot, input.target, []);
  const record = createLotSourceReviewRecord(
    {
      target: input.target,
      action: "opened",
      form: null,
      actorId: "invented-reviewer",
      note: "Dubbio esplicito sulla fonte da verificare.",
      expectedSnapshotHash: input.snapshot.snapshotHash,
      expectedSelectionHash: context.dependency.selectionHash,
      expectedTargetEventId: null,
      expectedProjectBarrierHash: context.projectBarrier.barrierHash,
      references: [],
    },
    input.snapshot,
    [],
    {
      id: "invented-doubt",
      sourceRevision: input.publication.revision,
      contentRevision: input.publication.revision,
      createdAt: "2030-01-20T12:00:00.000Z",
    },
  );
  const request = buildAutomaticComparisonRequest({
    ...input,
    history: [record],
  });
  const source = sourceRecord(request);
  const result = validateAutomaticComparison(
    response(request, source),
    request,
    source,
  );
  assert.equal(result.serviceRelation, "direct");
  assert.equal(result.relation, "review");
  assert.equal(result.sourceBlocked, true);
});

test("Foreign targets, altered snapshots and unsupported structure cannot receive a comparison", () => {
  const input = fixture();
  assert.throws(() =>
    buildAutomaticComparisonRequest({
      ...input,
      target: { kind: "project", publicationId: "different-publication" },
    }),
  );
  assert.throws(() =>
    buildAutomaticComparisonRequest({
      ...input,
      snapshot: { ...input.snapshot, snapshotHash: "0".repeat(64) },
    }),
  );
});

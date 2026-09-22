import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, vi } from "vitest";
import {
  buildAutomaticComparisonRequest,
  validateAutomaticComparison,
  AutomaticComparisonUnavailable,
  recordAutomaticComparison,
  readAutomaticComparison,
  buildAutomaticReductionRequest,
  automaticComparisonModel,
  resolveAutomaticComparison,
} from "../src/lib/automatic-comparison";
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
function response(
  request: ReturnType<typeof buildAutomaticComparisonRequest>,
  relation: "direct" | "different" | "review" = "direct",
) {
  return {
    comparison:
      "Confronto inventato per verificare il contratto, non la qualità semantica del modello.",
    facts: {
      sourceIdentifiesService: true,
      companyIdentifiesService: true,
      activitiesOverlap: relation !== "different",
      sameContractualRole: true,
      mainScopeCovered: relation === "direct",
      conflictingSource: false,
      requiresSourceCorrection: false,
    },
    targetRef: request.passages.find(
      (p) => p.scope === request.targetScope && p.role === "service",
    )!.id,
    sourceRefs: [
      request.passages.find(
        (p) => p.scope === request.targetScope && p.role === "service",
      )!.id,
    ],
    companyRefs: [request.companyPassages[0].id],
  };
}

test("An unreviewed complete source supports a referenced AI comparison without creating a human judgment", () => {
  const input = fixture();
  const request = buildAutomaticComparisonRequest(input);
  const result = validateAutomaticComparison(response(request), request);
  assert.equal(request.sourceBlocked, false);
  assert.equal(result.relation, "direct");
  assert.equal(result.origin, "ai");
  assert.equal("humanReview" in result, false);
  assert.equal(input.history.length, 0);
  assert.ok(result.reason.includes("prestazioni"));
  assert.equal(result.companyEvidence[0].text, input.profile.activities);
  assert.equal(request.prompt.includes(input.profile.name), false);
  assert.ok(request.prompt.includes("CONDIZIONE_INVENTATA"));
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

test("A shared component or a vague profile cannot be promoted to a positive by a model label", () => {
  const request = buildAutomaticComparisonRequest(fixture());
  const full = response(request);
  for (const change of [
    { mainScopeCovered: false },
    { mainScopeCovered: false, sameContractualRole: false },
    { companyIdentifiesService: false, mainScopeCovered: null },
    { activitiesOverlap: null, mainScopeCovered: null },
    { conflictingSource: true },
    { requiresSourceCorrection: true },
  ]) {
    const value = validateAutomaticComparison(
      { ...full, facts: { ...full.facts, ...change } },
      request,
    );
    assert.equal(value.relation, "review");
  }
  assert.throws(
    () =>
      validateAutomaticComparison(
        { ...full, facts: { ...full.facts, activitiesOverlap: false } },
        request,
      ),
    /Contradictory/,
  );
});

test("Each relation has a consistent basis and exact bilateral evidence, never arbitrary prose or scores", () => {
  const request = buildAutomaticComparisonRequest(fixture());
  for (const relation of ["direct", "different", "review"] as const)
    assert.equal(
      validateAutomaticComparison(response(request, relation), request)
        .relation,
      relation,
    );
  for (const changed of [
    { sourceRefs: ["s99999"] },
    { companyRefs: ["c99999"] },
    { companyRefs: [] },
    { basis: "invented_basis" },
    { relation: "direct" },
    { reason: "Possiede tutte le certificazioni richieste" },
    { score: 100 },
  ])
    assert.throws(() =>
      validateAutomaticComparison(
        { ...response(request), ...changed },
        request,
      ),
    );
  assert.throws(
    () =>
      validateAutomaticComparison(
        response(request),
        JSON.parse(JSON.stringify(request)),
      ),
    /Unverified/,
  );
});

test("Only the selected lot's own service text can establish a certain relation", () => {
  const request = buildAutomaticComparisonRequest(fixture(raw(true)));
  assert.equal(request.prompt.includes("SOLO_LOTTO_B"), false);
  assert.equal(request.targetScope, "selected_lot");
  assert.equal(
    validateAutomaticComparison(response(request), request).relation,
    "direct",
  );
  for (const passage of request.passages.filter(
    (p) => p.role !== "service" || p.scope !== "selected_lot",
  ))
    assert.throws(
      () =>
        validateAutomaticComparison(
          {
            ...response(request),
            targetRef: passage.id,
            sourceRefs: [passage.id],
          },
          request,
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
  assert.equal(body.company.activities[0].text, input.profile.activities);
  const rules = body.rules.join(" ") + " " + body.finalCheck;
  assert.match(rules, /ruolo commerciale/);
  assert.match(rules, /famiglia generica/);
  assert.match(rules, /differenza concreta/);
  const companyDescription = (
    request.responseFormat.json_schema.schema.properties as any
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
  const classification = body.classifications[0];
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
  assert.throws(
    () => validateAutomaticComparison(response(request), request),
    /Incomplete/,
  );
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
  const result = validateAutomaticComparison(
    response(request),
    request,
    readings,
  );
  assert.equal(result.relation, "review");
  assert.equal(result.coverage.linkedDocumentsRead, false);
});

test("Persisted responses cannot cross company boundaries or survive a changed profile or altered record", () => {
  const input = fixture(),
    request = buildAutomaticComparisonRequest(input);
  const metadata = {
    id: "invented-result",
    at: "2030-01-20T12:00:00.000Z",
    model: automaticComparisonModel(),
  };
  const stored = recordAutomaticComparison(
    response(request),
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
      recordAutomaticComparison(response(request), request, {
        ...metadata,
        model: "different-model",
      }),
    /model changed/,
  );
});

test("A historical v6 record is stale under v7 even with the same source, profile and model", () => {
  const input = fixture();
  const request = buildAutomaticComparisonRequest(input);
  const stored = recordAutomaticComparison(response(request), request, {
    id: "invented-version-regression",
    at: "2030-01-20T12:00:00.000Z",
    model: automaticComparisonModel(),
  });
  const digest = (value: unknown) =>
    createHash("sha256").update(stableDocumentaryJson(value)).digest("hex");
  const { hash: _hash, ...unsigned } = stored;
  const v6Unsigned = {
    ...unsigned,
    version: "documentary-service-comparison-v6",
    inputHash: digest({
      ...request.dependency,
      version: "documentary-service-comparison-v6",
    }),
  };
  const historical = { ...v6Unsigned, hash: digest(v6Unsigned) };
  const before = JSON.stringify(historical);
  assert.equal(request.version, "documentary-service-comparison-v7");
  assert.notEqual(historical.inputHash, request.inputHash);
  assert.equal(readAutomaticComparison(historical, request), null);
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
});

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
  assert.equal(
    validateAutomaticComparison(response(request), request, readings).relation,
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
  const stored = recordAutomaticComparison(response(request), request, {
    id: "invented-positive",
    at: "2030-01-20T12:00:00.000Z",
    model: automaticComparisonModel(),
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
  const result = validateAutomaticComparison(response(request), request);
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

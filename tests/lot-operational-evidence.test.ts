import assert from "node:assert/strict";
import { test } from "vitest";
import type { CompanyProfile, Publication, Sector } from "../src/lib/domain";
import { preserveSimapLots } from "../src/lib/source-lots";
import {
  captureLotSourceSnapshot,
  createLotSourceReviewRecord,
  resolveLotSourceContext,
  type LotSourceSnapshot,
  type LotSourceTarget,
  type MixedSourceReviewRecord,
} from "../src/lib/lot-source-context";
import {
  preliminaryLotMatch,
  PREFILTER_VERSION,
} from "../src/lib/lot-matching";

// Invented data only. Real context construction checks target/provenance rather
// than supplying a fabricated Publication for the lot or a fake reviewed flag.
const projectId = "cc300000-0000-4000-8000-000000000001";
const sourcePublicationId = "cc300000-0000-4000-8000-000000000002";
const lotA = "cc300000-0000-4000-8000-000000000003";
const lotB = "cc300000-0000-4000-8000-000000000004";
const publicationId = `simap-${projectId}`;
const detailUrl = `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${sourcePublicationId}`;
const identity = { projectId, publicationId: sourcePublicationId, detailUrl };
const target: LotSourceTarget = {
  kind: "lot",
  publicationId,
  sourceProjectId: projectId,
  lotId: lotA,
};
const projectTarget: LotSourceTarget = { kind: "project", publicationId };
const now = new Date("2030-01-20T12:00:00.000Z");
const profile: CompanyProfile = {
  name: "Ditta inventata",
  activities: "Cura dei giardini",
  employees: 3,
  sectors: ["giardinaggio"],
  zones: ["Tutto il Ticino"],
  keywords: [],
  exclusions: [],
  minValue: null,
  maxValue: null,
  emailEnabled: true,
};
const publication: Publication = {
  id: publicationId,
  source: "simap",
  externalId: projectId,
  title: "Titolo normalizzato del progetto",
  buyer: "Ente inventato",
  location: "Sede del progetto",
  canton: "ZH",
  zone: "Locarnese",
  publishedAt: "2030-01-01T07:00:00.000Z",
  updatedAt: "2030-01-01T07:00:00.000Z",
  visibleAt: "2030-01-01T07:00:00.000Z",
  deadline: "2029-12-01T12:00:00.000Z",
  valueChf: 5_000_000,
  procedure: "open",
  status: "open",
  sectors: ["impianti"],
  cpv: ["45310000"],
  sourceUrl: `https://www.simap.ch/it/project-detail/${projectId}`,
  sourceUrls: [],
  originalText: "Testo normalizzato del progetto",
  summary: null,
  requirements: [],
  evidence: [],
  documents: [],
  reviewRequired: false,
  reviewReasons: [],
  revision: "project-revision",
};
function detail() {
  return {
    id: sourcePublicationId,
    "project-info": { title: { it: "Centro inventato con più incarichi" } },
    procurement: {
      orderDescription: { it: "Contesto condiviso del centro inventato." },
      cpvCode: { code: "45310000" },
    },
    dates: { offerDeadline: "2029-12-01T12:00:00+01:00" },
    base: { id: sourcePublicationId, projectId, lotsType: "with" },
    lots: [
      {
        id: lotA,
        lotNumber: 1,
        title: { it: "Lotto A inventato" },
        orderDescription: { it: "Potatura e cura dei giardini." },
        cpvCode: { code: "77310000" },
        additionalCpvCodes: [],
        orderAddressOnlyDescription: "no",
        orderAddress: {
          countryId: "CH",
          cantonId: "TI",
          city: { it: "Lugano" },
        },
        orderAddressDescription: { it: "Luogo inventato" },
        executionPeriod: { dateRange: ["2029-01-01", "2029-12-31"] },
      },
      {
        id: lotB,
        lotNumber: 2,
        title: { it: "Lotto B inventato" },
        orderDescription: { it: "SOLO_B: posa di amianto inventato." },
        cpvCode: { code: "45310000" },
        orderAddress: {
          countryId: "CH",
          cantonId: "VD",
          city: { fr: "Lausanne" },
        },
      },
    ] as Record<string, unknown>[],
  };
}
function snapshot(raw = detail(), observationId = "observation-1") {
  return captureLotSourceSnapshot({
    publicationId,
    observationId,
    acquisition: {
      state: "accepted",
      archive: preserveSimapLots(raw, identity),
    },
    sourceScopeReview: null,
  });
}
function addReview(
  current: LotSourceSnapshot,
  reviewTarget: LotSourceTarget,
  history: readonly MixedSourceReviewRecord[],
  form: "defined_service" | "broad_scope",
) {
  const c = resolveLotSourceContext(current, reviewTarget, history);
  const path =
    reviewTarget.kind === "project"
      ? "/procurement/orderDescription/it"
      : c.targetContent!.comparison!.lot.sourceMappings.find((mapping) =>
          mapping.rawPath.includes("/orderDescription/"),
        )!.rawPath;
  return createLotSourceReviewRecord(
    {
      target: reviewTarget,
      expectedSnapshotHash: current.snapshotHash,
      expectedSelectionHash: c.dependency.selectionHash,
      expectedTargetEventId: c.dependency.reviewEventId,
      expectedProjectBarrierHash: c.projectBarrier.barrierHash,
      action: "recorded",
      form,
      references: [
        {
          selectionHash: c.dependency.selectionHash!,
          rawPath: path,
          startUtf16: 0,
          endUtf16: 4,
        },
      ],
      actorId: "invented-reviewer",
      note: "Revisione inventata per verificare il protocollo del prefiltro.",
    },
    current,
    history,
    {
      id: `event-${history.length + 1}`,
      sourceRevision: "original-revision",
      contentRevision: "content-revision",
      createdAt: "2030-01-01T12:00:00.000Z",
    },
  );
}
function prepared(raw = detail()) {
  const current = snapshot(raw);
  const project = addReview(current, projectTarget, [], "broad_scope");
  const lot = addReview(current, target, [project], "defined_service");
  const history: MixedSourceReviewRecord[] = [project, lot];
  return {
    current,
    history,
    context: resolveLotSourceContext(current, target, history),
  };
}

import {
  buildOperationalEvidenceRequest,
  recordOperationalEvidence,
  readOperationalEvidence,
} from "../src/lib/lot-operational-evidence";
function fixture() {
  const raw = detail();
  raw.dates.offerDeadline = "2030-02-01T23:59:00+01:00";
  Object.assign(raw["project-info"], {
    offerSpecificNote: {
      it: "L’offerta completa per tutti i lotti deve essere presentata entro il 1 febbraio 2030.",
    },
  });
  const { context } = prepared(raw),
    request = buildOperationalEvidenceRequest(context);
  const lot = raw.lots[0]!,
    proof = (
      scope: "selected_lot" | "project_context",
      path: string,
      quote: string,
    ) => ({ scope, path, quote });
  const country = proof("selected_lot", "/lots/0/orderAddress/countryId", "CH"),
    canton = proof("selected_lot", "/lots/0/orderAddress/cantonId", "TI");
  const deadline = proof(
      "project_context",
      "/dates/offerDeadline",
      raw.dates.offerDeadline,
    ),
    app = proof(
      "project_context",
      "/project-info/offerSpecificNote/it",
      "L’offerta completa per tutti i lotti deve essere presentata entro il 1 febbraio 2030.",
    );
  const answer = {
    country: "CH",
    countryEvidence: [country],
    canton: "TI",
    cantonEvidence: [canton],
    city: null,
    cityEvidence: [],
    deadline: raw.dates.offerDeadline,
    deadlineAppliesToTarget: true,
    deadlineEvidence: [deadline, app],
    rationale: "Invented fixture only",
    issues: [],
  };
  const check = (evidence: typeof answer.countryEvidence) => ({
    verdict: "supported" as const,
    evidence,
    rationale: "Invented fixture only",
  });
  const review = {
    checks: {
      country: check([country]),
      canton: check([canton]),
      city: {
        verdict: "not_verifiable" as const,
        evidence: [],
        rationale: "Invented fixture only",
      },
      deadline: check([deadline, app]),
    },
    issues: [],
  };
  const metadata = {
    id: "synthetic-test",
    at: "2030-01-20T12:00:00.000Z",
    model: "synthetic",
  };
  const record = recordOperationalEvidence(answer, review, request, metadata);
  const run = (values: readonly unknown[], clock = now, p = profile) =>
    preliminaryLotMatch({
      publication,
      profile: p,
      context,
      operationalReadings: values,
      now: clock,
    });
  return { raw, lot, context, request, answer, review, metadata, record, run };
}
test("An exact target-bound derivative keeps shared deadline scope and rejects stale or ambiguous records", () => {
  const f = fixture();
  assert(readOperationalEvidence([f.record], f.context));
  assert.equal(readOperationalEvidence([f.record, f.record], f.context), null);
  assert.equal(
    readOperationalEvidence([{ ...f.record, hash: "altered" }], f.context),
    null,
  );
  assert.equal(
    readOperationalEvidence([f.record], prepared(detail()).context),
    null,
  );
  const result = f.run([f.record]);
  assert.equal(result.operational.deadline, f.answer.deadline);
  assert(
    result.evidence.some(
      (e) =>
        e.purpose === "deadline" &&
        e.scope === "project_context" &&
        e.rawPath === "/dates/offerDeadline",
    ),
  );
  assert(!result.automaticReviewReasons.some((x) => x.includes("Termine")));
});
test("An applicable deadline controls eligibility at the exact instant without changing the source", () => {
  const f = fixture(),
    original = JSON.stringify(f.raw);
  assert(f.run([f.record]).eligible);
  assert.equal(f.run([f.record], new Date(f.answer.deadline)).eligible, false);
  assert.equal(JSON.stringify(f.raw), original);
  assert(f.run([]).automaticReviewReasons.some((x) => x.includes("Termine")));
});
test("Shared deadline needs its own submission applicability proof; contract periods cannot replace it", () => {
  const f = fixture();
  assert.throws(
    () =>
      recordOperationalEvidence(
        { ...f.answer, deadlineEvidence: [f.answer.deadlineEvidence[0]!] },
        f.review,
        f.request,
        f.metadata,
      ),
    /applicability/,
  );
  assert.throws(() =>
    recordOperationalEvidence(
      {
        ...f.answer,
        deadline: "2029-12-31",
        deadlineEvidence: [
          {
            scope: "selected_lot",
            path: "/lots/0/executionPeriod/dateRange/1",
            quote: "2029-12-31",
          },
        ],
      },
      f.review,
      f.request,
      f.metadata,
    ),
  );
});
test("Other-lot paths, invented quotes and deserialized request plans cannot establish facts", () => {
  const f = fixture();
  assert.throws(
    () =>
      recordOperationalEvidence(
        {
          ...f.answer,
          countryEvidence: [
            {
              ...f.answer.countryEvidence[0]!,
              path: "/lots/1/orderAddress/countryId",
            },
          ],
        },
        f.review,
        f.request,
        f.metadata,
      ),
    /crosses lot/,
  );
  assert.throws(
    () =>
      recordOperationalEvidence(
        {
          ...f.answer,
          countryEvidence: [
            { ...f.answer.countryEvidence[0]!, quote: "Switzerland" },
          ],
        },
        f.review,
        f.request,
        f.metadata,
      ),
    /not exact/,
  );
  assert.throws(
    () =>
      recordOperationalEvidence(
        f.answer,
        f.review,
        JSON.parse(JSON.stringify(f.request)),
        f.metadata,
      ),
    /not current/,
  );
});
test("Unverified or contradicted reviews and source conflicts cannot remove operational gates", () => {
  const f = fixture();
  assert.throws(
    () =>
      recordOperationalEvidence(
        f.answer,
        {
          ...f.review,
          checks: {
            ...f.review.checks,
            deadline: {
              ...f.review.checks.deadline,
              verdict: "not_verifiable",
            },
          },
        },
        f.request,
        f.metadata,
      ),
    /did not verify/,
  );
  assert.throws(
    () =>
      recordOperationalEvidence(
        f.answer,
        {
          ...f.review,
          checks: {
            ...f.review.checks,
            city: { ...f.review.checks.city, verdict: "contradicted" },
          },
        },
        f.request,
        f.metadata,
      ),
    /contradicts/,
  );
  assert.throws(
    () =>
      recordOperationalEvidence(
        { ...f.answer, issues: ["Invented conflict"] },
        f.review,
        f.request,
        f.metadata,
      ),
    /conflicts/,
  );
});
test("Territory contradictions remain held and a changed operational profile changes the comparison binding", () => {
  const f = fixture(),
    answer = { ...f.answer, canton: "VD" },
    record = recordOperationalEvidence(answer, f.review, f.request, f.metadata),
    held = f.run([record]);
  assert(held.automaticReviewReasons.some((x) => x.includes("discordanti")));
  assert.notEqual(
    f.run([f.record]).operationalInputHash,
    f.run([f.record], now, { ...profile, zones: ["Locarnese"] })
      .operationalInputHash,
  );
});

import Ajv2020 from "ajv/dist/2020";
import {
  buildOperationalReadingTask,
  buildOperationalReviewTask,
} from "../src/lib/lot-operational-evidence";
test("The provider schemas forbid request-wrapper path aliases in reading and independent review", () => {
  const f = fixture(),
    ajv = new Ajv2020({ strict: false });
  const reading = buildOperationalReadingTask(f.request),
    validate = ajv.compile(reading.responseFormat.json_schema.schema);
  assert(validate(f.answer));
  assert(
    !validate({
      ...f.answer,
      deadlineEvidence: [
        {
          ...f.answer.deadlineEvidence[0]!,
          path: "/projectSections/dates/offerDeadline",
        },
      ],
    }),
  );
  const review = buildOperationalReviewTask(f.request, f.answer),
    check = ajv.compile(review.responseFormat.json_schema.schema);
  assert(check(f.review));
  assert(
    !check({
      ...f.review,
      checks: {
        ...f.review.checks,
        country: {
          ...f.review.checks.country,
          evidence: [
            {
              ...f.answer.countryEvidence[0]!,
              path: "/selectedLot/orderAddress/countryId",
            },
          ],
        },
      },
    }),
  );
});

test("An all-lots deadline statement with a numbered exception cannot clear a different lot's gate", () => {
  const f = fixture(),
    raw = detail();
  raw.dates.offerDeadline = f.answer.deadline;
  const note =
    "L’offerta completa per tutti i lotti deve essere presentata entro il 1 febbraio 2030. Eccezione: solo il lotto 2 ha tale termine.";
  Object.assign(raw["project-info"], { offerSpecificNote: { it: note } });
  const request = buildOperationalEvidenceRequest(prepared(raw).context);
  const answer = {
    ...f.answer,
    deadlineEvidence: [
      f.answer.deadlineEvidence[0]!,
      {
        scope: "project_context",
        path: "/project-info/offerSpecificNote/it",
        quote: note,
      },
    ],
  };
  assert.throws(
    () => recordOperationalEvidence(answer, f.review, request, f.metadata),
    /applicability scope/,
  );
});

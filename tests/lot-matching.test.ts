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
function filter(
  raw = detail(),
  overrides: Partial<CompanyProfile> = {},
  p: Publication = publication,
) {
  return preliminaryLotMatch({
    publication: p,
    profile: { ...profile, ...overrides },
    context: prepared(raw).context,
    now,
  });
}
function rawAt(root: unknown, path: string): unknown {
  return path
    .slice(1)
    .split("/")
    .reduce<unknown>(
      (current, key) =>
        (current as Record<string, unknown>)[
          key.replaceAll("~1", "/").replaceAll("~0", "~")
        ],
      root,
    );
}

test("Exact collected localities constrain the lot's territory without accepting compound names", () => {
  for (const city of ["Porza", "Bioggio", "Ponte Tresa"]) {
    const raw = detail();
    raw.lots[0].orderAddress = {
      countryId: "CH",
      cantonId: "TI",
      city: { it: city },
    };
    assert.equal(
      filter(raw, { zones: ["Luganese"] }).operational.zone,
      "Luganese",
    );
    const outside = filter(raw, { zones: ["Bellinzonese"] });
    assert.equal(outside.eligible, false);
    assert.match(outside.reason, /fuori dalle zone/);
  }
  for (const city of ["Lavena Ponte Tresa", "Porza / Bellinzona"]) {
    const raw = detail();
    raw.lots[0].orderAddress = { countryId: "CH", cantonId: "TI", city };
    assert.equal(filter(raw, { zones: ["Luganese"] }).operational.zone, null);
    assert.equal(filter(raw, { zones: ["Luganese"] }).requiresReview, true);
  }
});

test("Uses the lot's own location and CPV, with exact source provenance, despite contradictory parent fields", () => {
  const raw = detail();
  const result = filter(raw, { exclusions: ["amianto"] });
  assert.equal(result.eligible, true);
  assert.equal(result.requiresReview, true);
  assert.equal(result.operational.canton, "TI");
  assert.equal(result.operational.zone, "Luganese");
  assert.deepEqual(result.operational.cpv, ["77310000"]);
  assert.ok(result.signals.sectors.includes("giardinaggio"));
  assert.ok(!result.signals.sectors.includes("impianti"));
  assert.equal(result.operational.deadline, null);
  assert.equal(result.operational.valueChf, null);
  assert.ok(result.reviewReasons.some((reason) => reason.includes("Termine")));
  assert.ok(
    !result.evidence.some((item) => JSON.stringify(item).includes("SOLO_B")),
  );
  for (const evidence of result.evidence.filter(
    (item) => item.scope !== "publication" && item.presence !== "absent",
  )) {
    assert.equal(evidence.url, detailUrl);
    assert.deepEqual(evidence.value, rawAt(raw, evidence.rawPath));
  }
});

test("Only an explicit attributable outside address excludes; missing, contradictory or description-only location requires review", () => {
  for (const address of [
    { countryId: "CH", cantonId: "VD", city: { fr: "Lausanne" } },
    { countryId: "FR", cantonId: null, city: { fr: "Ville inventée" } },
  ]) {
    const raw = detail();
    raw.lots[0].orderAddress = address;
    assert.equal(filter(raw).eligible, false);
  }
  for (const [address, flag] of [
    [null, "no"],
    [{ countryId: "FR", cantonId: "TI", city: "Lugano" }, "no"],
    [{ countryId: "CH", cantonId: "VD", city: "Lugano" }, "no"],
    [{ countryId: "FR", cantonId: null, city: { it: "Lugano" } }, "no"],
    [
      {
        countryId: "CH",
        cantonId: "VD",
        city: { it: "Lugano", fr: "Lausanne" },
      },
      "no",
    ],
    [
      {
        countryId: "IT",
        cantonId: null,
        city: { it: "Lugano", fr: "Lugano et environs" },
      },
      "no",
    ],
    [{ countryId: "ZZ", cantonId: "XX", city: "Lugano" }, "no"],
    [{ countryId: "CH", cantonId: "VD", city: "Lausanne" }, "yes"],
    [{ countryId: "CH", cantonId: "VD", city: "Lausanne" }, "unexpected"],
  ] as const) {
    const raw = detail();
    raw.lots[0].orderAddress = address;
    raw.lots[0].orderAddressOnlyDescription = flag;
    const result = filter(raw);
    assert.equal(result.eligible, true);
    assert.equal(result.requiresReview, true);
    assert.ok(
      result.reviewReasons.some((reason) => /Luogo|discordanti/.test(reason)),
    );
  }
  const buyerOnly = detail();
  delete buyerOnly.lots[0].orderAddress;
  buyerOnly.lots[0].buyerAddress = { countryId: "CH", cantonId: "VD" };
  assert.equal(filter(buyerOnly).eligible, true);
});

test("District filtering requires an exact, consistent work-city value, not a city substring or parent zone", () => {
  assert.equal(filter(detail(), { zones: ["Locarnese"] }).eligible, false);
  for (const city of [
    { it: "Lugano sconosciuto" },
    { it: "Lugano", de: "Locarno" },
    { it: "Lugano", xx: "Lugano" },
  ]) {
    const raw = detail();
    (raw.lots[0].orderAddress as Record<string, unknown>).city = city;
    const result = filter(raw, { zones: ["Locarnese"] });
    assert.equal(result.eligible, true);
    assert.equal(result.operational.zone, null);
    assert.ok(result.reviewReasons.some((reason) => reason.includes("Zona")));
  }
});

test("Own-lot lexical signals retain established word boundaries and multilingual terms without making absence a certain exclusion", () => {
  const examples: [string, string, Sector][] = [
    ["it", "Pulizie quotidiane", "pulizie"],
    ["de", "Grünflächenpflege", "giardinaggio"],
    ["fr", "Transport de matériel", "trasporti"],
    ["en", "Catering service", "catering"],
  ];
  for (const [language, description, sector] of examples) {
    const raw = detail();
    delete raw.lots[0].cpvCode;
    raw.lots[0].orderDescription = { [language]: description };
    const result = filter(raw, { sectors: [sector] });
    assert.equal(result.eligible, true);
    assert.ok(result.signals.sectors.includes(sector));
    assert.equal(result.requiresReview, true);
  }
  const raw = detail();
  delete raw.lots[0].cpvCode;
  raw.lots[0].orderDescription = { de: "Pfahlgründung" };
  // This fixture needs no recorded form for the lexical-only check.
  const current = snapshot(raw);
  const context = resolveLotSourceContext(current, target, []);
  const result = preliminaryLotMatch({ publication, profile, context, now });
  assert.equal(result.eligible, true);
  assert.equal(result.requiresReview, true);
  assert.ok(!result.signals.sectors.includes("giardinaggio"));
  assert.ok(result.reviewReasons.some((reason) => reason.includes("attività")));
});

test("Keywords and exclusions use documentary project/lot text while ignoring other lots, condition metadata and scripts", () => {
  const raw = detail();
  raw.lots[0].terms = { note: "amianto" };
  raw.lots[0].orderDescription = {
    it: "Potatura <script>amianto</script> di alberi inventati.",
  };
  assert.equal(filter(raw, { exclusions: ["amianto"] }).eligible, true);
  raw.lots[0].orderDescription = {
    it: "Potatura con <b>amianto</b> inventato.",
  };
  const excluded = filter(raw, { exclusions: ["amianto"] });
  assert.equal(excluded.eligible, false);
  assert.ok(
    excluded.evidence.some(
      (e) =>
        e.purpose === "exclusion" &&
        e.rawPath === "/lots/0/orderDescription/it" &&
        e.value === (raw.lots[0].orderDescription as { it: string }).it,
    ),
  );
  const shared = detail();
  shared.procurement.orderDescription.it += " Clausola inventata amianto.";
  assert.equal(filter(shared, { exclusions: ["amianto"] }).eligible, false);
  const keyword = filter(detail(), {
    sectors: ["sicurezza"],
    keywords: ["contesto condiviso"],
  });
  assert.equal(keyword.signals.keyword, true);
  assert.equal(keyword.requiresReview, true);
  assert.ok(
    keyword.evidence.some(
      (e) => e.purpose === "keyword" && e.scope === "project_context",
    ),
  );
});

test("Missing/invalid lot classification never inherits a parent code or excludes the profile", () => {
  const raw = detail();
  raw.lots[0].orderDescription = { it: "Prestazione da definire." };
  delete raw.lots[0].cpvCode;
  raw.lots[0].additionalCpvCodes = [{ code: "bad-code" }];
  const result = filter(raw, { sectors: ["impianti"] });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.operational.cpv, []);
  assert.ok(!result.signals.sectors.includes("impianti"));
  assert.ok(
    result.reviewReasons.some((reason) => reason.includes("Classificazione")),
  );
  raw.lots[0].additionalCpvCodes = [
    { code: "45310000-3", label: { it: "Etichetta non usata come fatto" } },
  ];
  const known = filter(raw, { sectors: ["impianti"] });
  assert.deepEqual(known.operational.cpv, ["45310000"]);
  assert.ok(known.signals.sectors.includes("impianti"));
  assert.equal(known.requiresReview, true);
});

test("Operational hashes ignore time, project revision/summaries and an unrelated lot, but track actual operational/profile changes", () => {
  const initial = prepared();
  const run = (
    p = publication,
    pr = profile,
    context = initial.context,
    clock = now,
  ) =>
    preliminaryLotMatch({ publication: p, profile: pr, context, now: clock });
  const baseline = run();
  assert.match(baseline.operationalInputHash, /^[a-f0-9]{64}$/);
  assert.equal(PREFILTER_VERSION, "lot-operational-prefilter-v2");
  const unrelated: Publication = {
    ...publication,
    revision: "new-revision",
    summary: "A new AI summary",
    title: "New display title",
    originalText: "New normalized text",
    canton: "FR",
    zone: "Mendrisiotto",
    deadline: "2039-01-01T00:00:00.000Z",
    valueChf: 1,
    sectors: ["pulizie"],
    cpv: ["90910000"],
    buyer: "Other buyer",
  };
  assert.equal(
    run(
      unrelated,
      {
        ...profile,
        name: "Other name",
        employees: 8,
        activities: "Other activities",
        emailEnabled: false,
      },
      initial.context,
      new Date("2030-01-21T00:00:00.000Z"),
    ).operationalInputHash,
    baseline.operationalInputHash,
  );
  const otherLot = detail();
  (otherLot.lots[1].orderDescription as { it: string }).it +=
    " Rettifica solo B.";
  const afterB = resolveLotSourceContext(
    snapshot(otherLot, "observation-2"),
    target,
    initial.history,
  );
  assert.equal(afterB.state, "manual_source");
  assert.equal(
    run(publication, profile, afterB).operationalInputHash,
    baseline.operationalInputHash,
  );
  assert.notEqual(
    run({ ...publication, status: "closed" }).operationalInputHash,
    baseline.operationalInputHash,
  );
  assert.notEqual(
    run({ ...publication, visibleAt: "2030-02-01T00:00:00.000Z" })
      .operationalInputHash,
    baseline.operationalInputHash,
  );
  assert.notEqual(
    run(publication, { ...profile, zones: ["Luganese"] }).operationalInputHash,
    baseline.operationalInputHash,
  );
  const changed = detail();
  (changed.lots[0].orderAddress as Record<string, unknown>).cantonId = "VD";
  assert.notEqual(
    filter(changed).operationalInputHash,
    baseline.operationalInputHash,
  );
});

test("Hash and evidence distinguish absent and explicit-null source fields", () => {
  const absent = detail();
  delete absent.lots[0].cpvCode;
  const explicit = structuredClone(absent);
  explicit.lots[0].cpvCode = null;
  const a = filter(absent),
    b = filter(explicit);
  assert.notEqual(a.operationalInputHash, b.operationalInputHash);
  assert.equal(
    a.evidence.find((e) => e.rawPath === "/lots/0/cpvCode")?.presence,
    "absent",
  );
  assert.equal(
    b.evidence.find((e) => e.rawPath === "/lots/0/cpvCode")?.presence,
    "present",
  );
});

test("Availability is checked again against the current clock; unknown source inputs are review, not a certain match", () => {
  const ready = prepared();
  const p = { ...publication, visibleAt: "2030-01-20T13:00:00.000Z" };
  const before = preliminaryLotMatch({
    publication: p,
    profile,
    context: ready.context,
    now,
  });
  const after = preliminaryLotMatch({
    publication: p,
    profile,
    context: ready.context,
    now: new Date("2030-01-20T14:00:00.000Z"),
  });
  assert.equal(before.eligible, false);
  assert.equal(after.eligible, true);
  assert.equal(before.operationalInputHash, after.operationalInputHash);
  for (const status of ["closed", "cancelled", "awarded"] as const)
    assert.equal(
      filter(detail(), {}, { ...publication, status }).eligible,
      false,
    );
  const refused = captureLotSourceSnapshot({
    publicationId,
    observationId: "refused-1",
    acquisition: {
      state: "refused",
      identity,
      reason: "unreadable detail",
      receiptHash: "a".repeat(64),
    },
    sourceScopeReview: null,
  });
  const context = resolveLotSourceContext(refused, target, []);
  const result = preliminaryLotMatch({ publication, profile, context, now });
  assert.equal(result.eligible, true);
  assert.equal(result.requiresReview, true);
  assert.equal(result.operational.canton, null);
  assert.throws(
    () =>
      preliminaryLotMatch({
        publication: { ...publication, id: "other-publication" },
        profile,
        context,
        now,
      }),
    /context/,
  );
  assert.throws(
    () =>
      preliminaryLotMatch({
        publication,
        profile,
        context,
        now: new Date("invalid"),
      }),
    /clock/,
  );
});

test("Execution periods and parent deadline/value corrections never become a lot bidding deadline or CHF amount", () => {
  const result = filter(detail(), { minValue: 500, maxValue: 1000 });
  assert.equal(result.eligible, true);
  assert.equal(result.operational.deadline, null);
  assert.equal(result.operational.valueChf, null);
  assert.ok(result.reviewReasons.some((reason) => reason.includes("Termine")));
  assert.ok(result.reviewReasons.some((reason) => reason.includes("Importo")));
  assert.ok(
    !result.evidence.some((e) =>
      /deadline|valueChf|executionPeriod/.test(e.rawPath),
    ),
  );
});

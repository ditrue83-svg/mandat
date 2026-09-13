import assert from "node:assert/strict";
import { test } from "vitest";
import type { CompanyProfile, Publication } from "../src/lib/domain";
import { normalizeSimap } from "../src/sources/simap";
import { preserveSimapLots } from "../src/lib/source-lots";
import {
  captureLotSourceSnapshot,
  createLotSourceReviewRecord,
  resolveLotSourceContext,
  type MixedSourceReviewRecord,
} from "../src/lib/lot-source-context";
import {
  preliminaryProjectMatch,
  PROJECT_PREFILTER_VERSION,
} from "../src/lib/project-matching";

// Invented complete project input. The real normalizer/archive/context builders
// are used; no fake lot, AI, PDF text, network or database is involved.
const projectId = "ac100000-0000-4000-8000-000000000001";
const sourcePublicationId = "ac100000-0000-4000-8000-000000000002";
const publicationId = `simap-${projectId}`;
const identity = {
  projectId,
  publicationId: sourcePublicationId,
  detailUrl: `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${sourcePublicationId}`,
};
const target = { kind: "project" as const, publicationId };
const now = new Date("2030-01-20T12:00:00.000Z");
const profile: CompanyProfile = {
  name: "Ditta inventata",
  activities: "Potatura e giardini",
  employees: 3,
  sectors: ["giardinaggio"],
  zones: ["Tutto il Ticino"],
  keywords: [],
  exclusions: [],
  minValue: null,
  maxValue: null,
  emailEnabled: true,
};
function detail() {
  return {
    id: sourcePublicationId,
    type: "tender",
    "project-info": { title: { it: "Cura del parco inventato" } },
    base: {
      id: sourcePublicationId,
      projectId,
      lotsType: "without",
      processType: "open",
    } as Record<string, unknown>,
    procurement: {
      orderDescription: { it: "Potatura e cura dei giardini. 🌳" },
      orderAddress: { countryId: "CH", cantonId: "TI", city: { it: "Lugano" } },
      orderAddressOnlyDescription: "no",
      cpvCode: { code: "77310000" },
      additionalCpvCodes: [],
    } as Record<string, unknown>,
    dates: {
      processType: "open",
      offerDeadline: "2030-12-01T12:00:00+01:00",
    } as Record<string, unknown>,
    terms: { termsNote: { it: "Condizione amministrativa inventata." } },
    metadata: {
      title: "SOLO_METADATA: trasporto rifiuti",
      orderAddress: { cantonId: "ZH" },
      valueChf: 900000,
    },
  };
}
function prepared(
  raw = detail(),
  form: "defined_service" | "broad_scope" | null = "defined_service",
) {
  const publication = normalizeSimap(
    {
      id: projectId,
      raw: {
        id: projectId,
        publicationId: sourcePublicationId,
        publicationDate: "2030-01-01",
        projectNumber: "INVENTED-PROJECT-FILTER",
        pubType: "tender",
        processType: raw.base.processType ?? "open",
        title: { it: "Cura inventata" },
        procOfficeName: { it: "Ente inventato" },
      },
    },
    raw,
  );
  const snapshot = captureLotSourceSnapshot({
    publicationId,
    observationId: "ac200000-0000-4000-8000-000000000001",
    sourceScopeReview: null,
    acquisition: {
      state: "accepted",
      archive: preserveSimapLots(raw, identity),
    },
  });
  const initial = resolveLotSourceContext(snapshot, target, []);
  const history: MixedSourceReviewRecord[] =
    form === null
      ? []
      : [
          createLotSourceReviewRecord(
            {
              target,
              action: "recorded",
              form,
              actorId: "invented-reviewer",
              note: "Revisione inventata per il solo protocollo operativo.",
              expectedSnapshotHash: snapshot.snapshotHash,
              expectedSelectionHash: initial.dependency.selectionHash,
              expectedTargetEventId: null,
              expectedProjectBarrierHash: initial.projectBarrier.barrierHash,
              references: [
                {
                  selectionHash: initial.dependency.selectionHash!,
                  rawPath: "/project-info/title/it",
                  startUtf16: 0,
                  endUtf16: 4,
                },
              ],
            },
            snapshot,
            [],
            {
              id: "invented-source-review",
              sourceRevision: publication.revision,
              contentRevision: publication.revision,
              createdAt: "2030-01-01T12:00:00.000Z",
            },
          ),
        ];
  return {
    publication,
    snapshot,
    context: resolveLotSourceContext(snapshot, target, history),
  };
}
function filter(
  raw = detail(),
  profileChanges: Partial<CompanyProfile> = {},
  publicationChanges: Partial<Publication> = {},
  at = now,
) {
  const data = prepared(raw);
  return preliminaryProjectMatch({
    publication: { ...data.publication, ...publicationChanges },
    profile: { ...profile, ...profileChanges },
    context: data.context,
    now: at,
  });
}
function rawAt(raw: unknown, path: string): unknown {
  return path
    .slice(1)
    .split("/")
    .reduce<unknown>(
      (v, k) =>
        (v as Record<string, unknown>)[
          k.replaceAll("~1", "/").replaceAll("~0", "~")
        ],
      raw,
    );
}

test("A real without project gets its own attributable CPV/place/deadline, with exact source evidence", () => {
  const raw = detail(),
    result = filter(raw);
  assert.equal(PROJECT_PREFILTER_VERSION, "project-operational-prefilter-v1");
  assert.equal(result.eligible, true);
  assert.equal(result.requiresReview, false);
  assert.equal(result.operational.deadline, "2030-12-01T11:00:00.000Z");
  assert.equal(result.operational.valueChf, null);
  assert.equal(result.operational.zone, "Luganese");
  assert.deepEqual(result.operational.cpv, ["77310000"]);
  assert.ok(result.signals.sectors.includes("giardinaggio"));
  for (const e of result.evidence.filter(
    (x) => x.scope === "project_context" && x.presence === "present",
  )) {
    assert.equal(e.url, identity.detailUrl);
    assert.deepEqual(e.value, rawAt(raw, e.rawPath));
  }
  assert.ok(!JSON.stringify(result.evidence).includes("SOLO_METADATA"));
});

test("Declared selective procedure chooses its own term; conflicting/missing/ambiguous procedures or DST are review, not definite expiry", () => {
  const selective = detail();
  selective.base.processType = "selective";
  selective.dates.processType = "selective";
  selective.dates.offerDeadline = "2029-01-01T12:00:00+01:00";
  selective.dates.participationRequestDeadline = "2030-11-01T12:00:00+01:00";
  assert.equal(
    filter(selective).operational.deadline,
    "2030-11-01T11:00:00.000Z",
  );
  assert.equal(filter(selective).eligible, true);
  const conflict = detail();
  conflict.dates.processType = "selective";
  const unknown = detail();
  unknown.base.processType = "mystery";
  delete unknown.dates.processType;
  const absent = detail();
  delete absent.base.processType;
  delete absent.dates.processType;
  const ambiguous = detail();
  ambiguous.dates.offerDeadline = "2030-10-27T02:30:00";
  for (const raw of [conflict, unknown, absent, ambiguous]) {
    const result = filter(raw);
    assert.equal(result.eligible, true);
    assert.equal(result.requiresReview, true);
    assert.equal(result.operational.deadline, null);
  }
});

test("Publication availability and certain expiry veto at the current clock; now itself is not part of the hash", () => {
  const before = new Date("2030-01-01T06:59:59Z"),
    boundary = new Date("2030-01-01T07:00:00Z");
  assert.equal(filter(detail(), {}, {}, before).eligible, false);
  const available = filter(detail(), {}, {}, boundary);
  assert.equal(available.eligible, true);
  assert.equal(available.operationalInputHash, filter().operationalInputHash);
  assert.notEqual(
    available.operationalInputHash,
    filter(detail(), {}, {}, before).operationalInputHash,
  );
  const expired = filter(detail(), {}, {}, new Date("2030-12-01T11:00:00Z"));
  assert.equal(expired.eligible, false);
  assert.notEqual(expired.operationalInputHash, available.operationalInputHash);
  for (const status of ["closed", "cancelled", "awarded"] as const)
    assert.equal(filter(detail(), {}, { status }).eligible, false);
});

test("Only unambiguous execution places veto; multilingual contradictions and buyer/description fallbacks remain review", () => {
  const outside = detail();
  outside.procurement.orderAddress = {
    countryId: "CH",
    cantonId: "VD",
    city: { fr: "Lausanne" },
  };
  assert.equal(filter(outside).eligible, false);
  assert.equal(filter(detail(), { zones: ["Locarnese"] }).eligible, false);
  for (const address of [
    { countryId: "CH", cantonId: "VD", city: { it: "Lugano", fr: "Lausanne" } },
    {
      countryId: "IT",
      cantonId: null,
      city: { it: "Lugano", fr: "Lugano et environs" },
    },
    { countryId: "FR", cantonId: "TI", city: "Ville inventée" },
    null,
  ]) {
    const raw = detail();
    raw.procurement.orderAddress = address;
    const result = filter(raw);
    assert.equal(result.eligible, true);
    assert.equal(result.requiresReview, true);
  }
  const descriptionOnly = detail();
  descriptionOnly.procurement.orderAddress = {
    countryId: "CH",
    cantonId: "ZH",
    city: "Zürich",
  };
  descriptionOnly.procurement.orderAddressOnlyDescription = "yes";
  descriptionOnly.procurement.orderAddressDescription = {
    it: "Luogo da concordare.",
  };
  assert.equal(filter(descriptionOnly).eligible, true);
});

test("Complete source texts retain multilingual activity and explicit exclusions, while metadata/conditions do not manufacture services", () => {
  for (const [language, text] of [
    ["it", "Potatura degli alberi."],
    ["de", "Grünflächenpflege im Park."],
    ["fr", "Jardinage du parc."],
  ]) {
    const raw = detail();
    raw.procurement.cpvCode = null;
    raw.procurement.orderDescription = { [language]: text };
    const result = filter(raw);
    assert.ok(result.signals.sectors.includes("giardinaggio"), text);
  }
  const english = detail();
  english.procurement.cpvCode = null;
  english.procurement.orderDescription = { en: "Maintenance of the facility." };
  assert.ok(
    filter(english, { sectors: ["manutenzioni"] }).signals.sectors.includes(
      "manutenzioni",
    ),
  );
  // Unsupported vocabulary stays review; these tests do not extend the known
  // activity lexicon or establish multilingual semantic recall.
  const unsupported = detail();
  unsupported.procurement.cpvCode = null;
  unsupported.procurement.orderDescription = { de: "Gartenpflege im Park." };
  assert.equal(filter(unsupported).requiresReview, true);
  const raw = detail();
  raw.procurement.orderDescription = {
    it: "Servizio inventato.",
    de: "Asbestentsorgung im Gebäude.",
  };
  assert.equal(
    filter(raw, { exclusions: ["Asbestentsorgung"] }).eligible,
    false,
  );
  assert.equal(
    filter(detail(), {
      exclusions: ["SOLO_METADATA", "Condizione amministrativa"],
    }).eligible,
    true,
  );
  const noSignals = detail();
  noSignals.procurement.orderDescription = { it: "Prestazione da definire." };
  noSignals.procurement.cpvCode = null;
  const r = filter(noSignals);
  assert.equal(r.eligible, true);
  assert.equal(r.requiresReview, true);
});

test("Empty/unknown shape, broad source or missing human source review cannot become a certain project through the filter", () => {
  const unknown = detail();
  delete unknown.base.lotsType;
  const result = filter(unknown);
  assert.equal(result.eligible, true);
  assert.equal(result.requiresReview, true);
  assert.deepEqual(result.operational.cpv, []);
  for (const form of [null, "broad_scope"] as const) {
    const p = prepared(detail(), form);
    const r = preliminaryProjectMatch({ ...p, profile, now });
    assert.equal(r.requiresReview, true);
    assert.ok(r.reviewReasons.some((x) => x.includes("fonte")));
  }
});

test("Unsupported amount and unexplained editorial differences suspend the specific operational veto and remain bound", () => {
  const baseline = filter();
  const value = filter(detail(), { maxValue: 1000 }, { valueChf: 500000 });
  assert.equal(value.eligible, true);
  assert.equal(value.requiresReview, true);
  assert.equal(value.operational.valueChf, null);
  assert.notEqual(value.operationalInputHash, baseline.operationalInputHash);
  const rawExpired = detail();
  rawExpired.dates.offerDeadline = "2029-12-01T12:00:00+01:00";
  assert.equal(filter(rawExpired).eligible, false);
  const edited = filter(
    rawExpired,
    {},
    { deadline: "2031-12-01T11:00:00.000Z" },
  );
  assert.equal(edited.eligible, true);
  assert.equal(edited.operational.deadline, null);
  assert.ok(edited.reviewReasons.some((x) => x.includes("riconciliare")));
  const outside = detail();
  outside.procurement.orderAddress = {
    countryId: "CH",
    cantonId: "VD",
    city: "Lausanne",
  };
  assert.equal(
    filter(outside, {}, { canton: "TI", location: "Lugano", zone: "Luganese" })
      .eligible,
    true,
  );
});

test("Hashes bind actual operational inputs/profile/provenance, not AI summary, metadata, object key order or clock ticks", () => {
  const raw = detail(),
    baseline = filter(raw);
  const metadata = detail();
  metadata.metadata.title = "Altra nota irrilevante";
  assert.equal(
    filter(metadata).operationalInputHash,
    baseline.operationalInputHash,
  );
  assert.equal(
    filter(
      raw,
      {},
      {
        summary: "Sintesi AI differente",
        revision: "editorial-summary-only",
        originalText: "Testo derivato differente",
      },
    ).operationalInputHash,
    baseline.operationalInputHash,
  );
  const changed = detail();
  changed.procurement.orderDescription = {
    it: "Potatura e irrigazione dei giardini.",
  };
  assert.notEqual(
    filter(changed).operationalInputHash,
    baseline.operationalInputHash,
  );
  assert.notEqual(
    filter(raw, { activities: "Altra attività dichiarata" })
      .operationalInputHash,
    baseline.operationalInputHash,
  );
  const reordered = {
    ...raw,
    procurement: Object.fromEntries(Object.entries(raw.procurement).reverse()),
  };
  assert.equal(
    filter(reordered).operationalInputHash,
    baseline.operationalInputHash,
  );
  const p = prepared();
  assert.throws(
    () =>
      preliminaryProjectMatch({
        ...p,
        publication: { ...p.publication, id: "other" },
        profile,
        now,
      }),
    /project context/,
  );
  assert.throws(
    () => preliminaryProjectMatch({ ...p, profile, now: new Date("invalid") }),
    /clock/,
  );
});

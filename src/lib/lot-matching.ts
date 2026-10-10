import { createHash } from "node:crypto";
import type { CompanyProfile, Publication, Sector } from "./domain";
import type { LotSourceContext } from "./lot-source-context";
import { plainText } from "@/sources/common";
import {
  classifyProcurement,
  lotClassificationInput,
} from "./sector-classification";
import {
  readOperationalEvidence,
  explicitOperationalDeadline,
} from "./lot-operational-evidence";
import { zoneForExactCity } from "./ticino-localities";

export const PREFILTER_VERSION = "lot-operational-prefilter-v6";
export type LotOperationalEvidence = {
  scope: "publication" | "project_context" | "selected_lot";
  url: string;
  rawPath: string;
  value: unknown;
  presence?: "present" | "absent";
  purpose:
    | "deadline"
    | "availability"
    | "location"
    | "classification"
    | "activity"
    | "keyword"
    | "exclusion";
};
export type PreliminaryLotMatch = {
  eligible: boolean;
  requiresReview: boolean;
  reason: string;
  operationalInputHash: string;
  evidence: readonly LotOperationalEvidence[];
  reviewReasons: readonly string[];
  automaticReviewReasons: readonly string[];
  informationalReviewReasons?: readonly string[];
  signals: { sectors: readonly Sector[]; keyword: boolean };
  operational: {
    country: string | null;
    canton: string | null;
    zone: string | null;
    cpv: readonly string[];
    deadline: string | null;
    valueChf: null;
  };
};
const cantons = new Set(
  "AG AI AR BE BL BS FR GE GL GR JU LU NE NW OW SG SH SO SZ TG TI UR VD VS ZG ZH".split(
    " ",
  ),
);
// Supported ISO alpha-2 source identifiers. An unrecognized identifier remains
// unknown; a two-letter string alone does not establish a foreign country.
const countries = new Set(
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
    " ",
  ),
);
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
const hash = (v: unknown) =>
  createHash("sha256").update(stable(v)).digest("hex");
function object(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
const own = (value: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(value, key) ? value[key] : null;
function code(value: unknown, supported: Set<string>) {
  return typeof value === "string" && supported.has(value.trim().toUpperCase())
    ? value.trim().toUpperCase()
    : null;
}
function cityValues(value: unknown): string[] | null {
  if (typeof value === "string") return value.trim() ? [value] : null;
  const translated = object(value);
  if (!translated) return null;
  const entries = Object.entries(translated).filter(
    ([, v]) => v !== null && v !== "",
  );
  if (
    !entries.length ||
    entries.some(
      ([k, v]) =>
        !["it", "de", "fr", "en"].includes(k) || typeof v !== "string",
    )
  )
    return null;
  return entries.map(([, v]) => v as string);
}
function exactZone(value: unknown): string | null {
  const cities = cityValues(value);
  if (!cities) return null;
  const zones = cities.map(zoneForCity);
  return zones[0] && zones.every((zone) => zone === zones[0]) ? zones[0] : null;
}
function zoneForCity(city: string): string | undefined {
  return zoneForExactCity(plainText(city)) ?? undefined;
}
function hasTicinoCityVariant(value: unknown): boolean {
  if (typeof value === "string") return !!zoneForCity(value);
  const translated = object(value);
  return (
    !!translated &&
    Object.entries(translated).some(
      ([language, city]) =>
        ["it", "de", "fr", "en"].includes(language) &&
        typeof city === "string" &&
        !!zoneForCity(city),
    )
  );
}

export const REGIONAL_PREMISES_VETO_REASON =
  "La struttura richiesta dal lotto si trova fuori dal territorio selezionato (Ticino).";
// Complete execution-premises clauses only: station names denote travel origins.
// Unknown languages, extra exceptions and structured conflicts retain review.
export function excludesTicinoHotelPremises(
  record: unknown,
  zones: readonly string[],
) {
  const lot = object(record);
  if (
    !lot ||
    !zones.length ||
    lot.orderType !== "service" ||
    lot.orderAddressOnlyDescription !== "yes"
  )
    return false;
  const ticinoZones = new Set([
    "Tutto il Ticino",
    "Bellinzonese",
    "Blenio",
    "Leventina",
    "Locarnese",
    "Luganese",
    "Mendrisiotto",
    "Riviera",
    "Vallemaggia",
  ]);
  if (zones.some((z) => !ticinoZones.has(z))) return false;
  const address = object(lot.orderAddress),
    descriptions = object(lot.orderDescription);
  if (
    !address ||
    address.countryId !== "CH" ||
    address.cantonId != null ||
    (typeof address.city === "string"
      ? !!address.city.trim()
      : Object.values(object(address.city) ?? {}).some(
          (v) => v != null && v !== "",
        )) ||
    address.postalCode != null ||
    !descriptions
  )
    return false;
  for (const field of ["title", "orderAddressDescription"]) {
    const variants = object(lot[field]);
    if (
      variants &&
      Object.values(variants).some(
        (v) =>
          typeof v === "string" && /\b(?:ticino|tessin)\b/i.test(plainText(v)),
      )
    )
      return false;
  }
  const present = Object.entries(descriptions).filter(
    ([, v]) => v != null && v !== "",
  );
  const grammar: Record<string, RegExp> = {
    it: /^alberghi o centri per seminari ubicati nella svizzera tedesca (?:e|o) nella regione dei tre laghi, raggiungibili dalla stazione centrale di [\p{L} -]+ con i mezzi pubblici o con un servizio di trasporto offerto dall'albergo o dal centro per seminari\. durata massima del tragitto: [1-9]\d* minuti \(porta a porta\), secondo l'orario delle ffs\.(?: tali strutture non devono trovarsi nell'agglomerato di [\p{L} -]+ \(cfr\. mappa, allegato \d+ \[solo in tedesco\]: hauptkern, kernstadt und hauptkern, übrige hauptkerngemeinden\)\.)?$/u,
    de: /^hotels oder seminarzentren in der deutschschweiz und im drei-seen-land, die vom hauptbahnhof [\p{L} -]+ mit dem öffentlichen verkehr oder einem transportdienst des hotels\/seminarzentrums in maximal [1-9]\d* minuten \(von tür zu tür\) gemäss sbb-fahrplan erreichbar sind\.(?: diese hotels und\/oder seminarzentren dürfen sich nicht in der agglomeration [\p{L} -]+ befinden \(anhang \d+: hauptkern, kernstadt und hauptkern, übrige hauptkerngemeinden\)\.)?$/u,
    fr: /^hôtels ou centres de séminaire en suisse alémanique ou dans le pays des trois-lacs, accessibles depuis la gare centrale de [\p{L} -]+ en transports publics ou avec le service de navettes assurées par l'hôtel ou le centre de séminaire en [1-9]\d* minutes au maximum \(porte à porte\) selon l'horaire des cff\.(?: ces hôtels ou centres de séminaire ne doivent pas se trouver dans l'agglomération [\p{L} -]+ \(annexe \d+ \[en allemand uniquement\] : hauptkern, kernstadt und hauptkern, übrige hauptkerngemeinden\)\.)?$/u,
  };
  return (
    present.length > 0 &&
    present.every(
      ([lang, value]) =>
        typeof value === "string" &&
        grammar[lang]?.test(
          plainText(value)
            .normalize("NFC")
            .toLowerCase()
            .replace(/[’‘]/gu, "'")
            .replace(/\s+/gu, " ")
            .trim(),
        ),
    )
  );
}

// This is a filter on a verified server source context, never an approval of a
// firm's work or an alternative to the source/dependency check at commit time.
export function preliminaryLotMatch({
  publication,
  profile,
  context,
  operationalReadings = [],
  now = new Date(),
}: {
  publication: Publication;
  profile: CompanyProfile;
  context: LotSourceContext;
  now?: Date;
  operationalReadings?: readonly unknown[];
}): PreliminaryLotMatch {
  if (
    context.target.kind !== "lot" ||
    context.target.publicationId !== publication.id ||
    context.dependency.publicationId !== publication.id
  )
    throw new Error("Lot filter requires this publication's lot context");
  const content = context.targetContent;
  if (
    publication.source !== "simap" ||
    (content &&
      (content.identity.projectId.toLowerCase() !==
        context.target.sourceProjectId ||
        content.identity.projectId.toLowerCase() !==
          publication.externalId.toLowerCase()))
  )
    throw new Error("Lot filter source identity mismatch");
  if (!Number.isFinite(now.getTime()))
    throw new Error("Invalid lot filter clock");
  const evidence: LotOperationalEvidence[] = [];
  const reviewReasons: string[] = [];
  const automaticReviewReasons: string[] = [];
  const used: unknown[] = [];
  const add = (item: LotOperationalEvidence) => {
    evidence.push(item);
    used.push(item);
  };
  const review = (reason: string, resolvedByServiceComparison = false) => {
    if (!reviewReasons.includes(reason)) reviewReasons.push(reason);
    if (
      !resolvedByServiceComparison &&
      !automaticReviewReasons.includes(reason)
    )
      automaticReviewReasons.push(reason);
  };
  add({
    scope: "publication",
    url: publication.sourceUrl,
    rawPath: "/status",
    value: publication.status,
    purpose: "availability",
  });
  add({
    scope: "publication",
    url: publication.sourceUrl,
    rawPath: "/visibleAt",
    value: publication.visibleAt,
    purpose: "availability",
  });
  let veto = "";
  if (["closed", "cancelled", "awarded"].includes(publication.status))
    veto = "La pubblicazione non è un bando aperto.";
  else if (publication.status !== "open")
    review("Stato della pubblicazione da verificare.");
  const visible = Date.parse(publication.visibleAt);
  if (!Number.isFinite(visible))
    review("Disponibilità pubblica da verificare.");
  else if (visible > now.getTime())
    veto ||= "Pubblicazione non ancora diffondibile.";

  const lot = content?.selectedLot ? object(content.selectedLot.record) : null;
  if (
    lot &&
    (typeof lot.id !== "string" ||
      lot.id.toLowerCase() !== context.target.lotId ||
      content?.comparison?.target.lotId.toLowerCase() !== context.target.lotId)
  )
    throw new Error("Lot filter selected record mismatch");
  const cpv: string[] = [];
  let country: string | null = null,
    canton: string | null = null,
    zone: string | null = null;
  if (!lot || !content?.selectedLot || !content.comparison) {
    review(
      "Non è disponibile un input documentario completo per questo lotto.",
    );
  } else {
    const url = content.identity.detailUrl,
      path = content.selectedLot.path;
    const primary = own(lot, "cpvCode"),
      additional = own(lot, "additionalCpvCodes");
    // Preserve both absence and invalid values in the hash; no parent CPV is used.
    add({
      scope: "selected_lot",
      url,
      rawPath: `${path}/cpvCode`,
      value: primary,
      presence: Object.hasOwn(lot, "cpvCode") ? "present" : "absent",
      purpose: "classification",
    });
    add({
      scope: "selected_lot",
      url,
      rawPath: `${path}/additionalCpvCodes`,
      value: additional,
      presence: Object.hasOwn(lot, "additionalCpvCodes") ? "present" : "absent",
      purpose: "classification",
    });
    for (const item of [
      primary,
      ...(Array.isArray(additional) ? additional : []),
    ]) {
      if (item === null) continue;
      const rawCode = object(item)?.code;
      if (typeof rawCode === "string" && /^\d{8}(?:-\d)?$/.test(rawCode))
        cpv.push(rawCode.slice(0, 8));
      else review("Classificazione del lotto da verificare.", true);
    }
    if (additional !== null && !Array.isArray(additional))
      review("Classificazione del lotto da verificare.", true);
    const rawAddress = own(lot, "orderAddress"),
      descriptionOnly = own(lot, "orderAddressOnlyDescription");
    add({
      scope: "selected_lot",
      url,
      rawPath: `${path}/orderAddress`,
      value: rawAddress,
      presence: Object.hasOwn(lot, "orderAddress") ? "present" : "absent",
      purpose: "location",
    });
    add({
      scope: "selected_lot",
      url,
      rawPath: `${path}/orderAddressOnlyDescription`,
      value: descriptionOnly,
      presence: Object.hasOwn(lot, "orderAddressOnlyDescription")
        ? "present"
        : "absent",
      purpose: "location",
    });
    // orderAddressDescription is retained for review, never geocoded by a name
    // substring or substituted with the buyer/project address.
    add({
      scope: "selected_lot",
      url,
      rawPath: `${path}/orderAddressDescription`,
      value: own(lot, "orderAddressDescription"),
      presence: Object.hasOwn(lot, "orderAddressDescription")
        ? "present"
        : "absent",
      purpose: "location",
    });
    const address = object(rawAddress);
    if (address && (descriptionOnly === "no" || descriptionOnly === null)) {
      country = code(own(address, "countryId"), countries);
      canton = code(own(address, "cantonId"), cantons);
      const cityZone = exactZone(own(address, "city"));
      // Contradictory foreign-country/Swiss-canton data does not select the
      // convenient field. Keep the entire address unresolved.
      if (country && country !== "CH" && canton) {
        country = null;
        canton = null;
        review("Paese e cantone del lotto sono discordanti.");
      } else if (
        hasTicinoCityVariant(own(address, "city")) &&
        ((country && country !== "CH") || (canton && canton !== "TI"))
      ) {
        // A single known whole-value city variant can expose a conflict, even
        // when the other translations do not establish one consistent district.
        // This does not geocode unknown cities or turn a variant into certainty.
        country = null;
        canton = null;
        review("Città e territorio indicati per il lotto sono discordanti.");
      } else if (country && country !== "CH")
        veto ||= "Il lavoro del lotto si trova fuori dal Ticino.";
      else if (country === "CH" && canton && canton !== "TI")
        veto ||= "Il lavoro del lotto si trova fuori dal Ticino.";
      else if (country === "CH" && canton === "TI") {
        zone = cityZone;
        if (!profile.zones.includes("Tutto il Ticino")) {
          if (!zone) review("Zona di esecuzione del lotto da verificare.");
          else if (!profile.zones.includes(zone))
            veto ||=
              "Il lavoro del lotto si trova fuori dalle zone selezionate.";
        }
      } else review("Luogo di esecuzione del lotto da verificare.");
    } else review("Luogo di esecuzione del lotto da verificare.");
  }

  if (
    lot &&
    content?.selectedLot &&
    excludesTicinoHotelPremises(lot, profile.zones)
  ) {
    veto ||= REGIONAL_PREMISES_VETO_REASON;
    for (const [language, value] of Object.entries(
      object(lot.orderDescription) ?? {},
    ))
      if (typeof value === "string" && value)
        add({
          scope: "selected_lot",
          url: content.identity.detailUrl,
          rawPath: `${content.selectedLot.path}/orderDescription/${language}`,
          value,
          purpose: "location",
        });
  }

  const operationalReading = readOperationalEvidence(
    operationalReadings,
    context,
  );
  let deadline: string | null = null;
  const localDeadlines =
    content?.selectedLot && lot
      ? [
          {
            path: `${content.selectedLot.path}/offerDeadline`,
            value: own(lot, "offerDeadline"),
          },
          {
            path: `${content.selectedLot.path}/dates/offerDeadline`,
            value: own(object(own(lot, "dates")) ?? {}, "offerDeadline"),
          },
        ].filter((item) => item.value !== null && item.value !== "")
      : [];
  for (const item of localDeadlines)
    add({
      scope: "selected_lot",
      url: content!.identity.detailUrl,
      rawPath: item.path,
      value: item.value,
      purpose: "deadline",
    });
  const validLocal = localDeadlines.map((item) =>
    explicitOperationalDeadline(item.value),
  );
  const localDeadlineConflict =
    localDeadlines.length > 0 &&
    (validLocal.some((value) => value === null) ||
      new Set(
        validLocal.map((value) => (value === null ? null : Date.parse(value))),
      ).size !== 1);
  if (localDeadlineConflict)
    review("Termini originali di presentazione del lotto da riconciliare.");
  else deadline = validLocal[0] ?? null;
  if (operationalReading) {
    const answer = operationalReading.answer;
    used.push({ operationalReadingHash: operationalReading.hash });
    for (const key of ["country", "canton", "city", "deadline"] as const)
      for (const proof of answer[`${key}Evidence`])
        add({
          scope: proof.scope,
          url: content!.identity.detailUrl,
          rawPath: proof.path,
          value: proof.quote,
          purpose: key === "deadline" ? "deadline" : "location",
        });
    const readCountry = code(answer.country, countries);
    const readCanton = code(answer.canton, cantons);
    const readZone = answer.city ? exactZone(answer.city) : null;
    const originalAddress = object(lot ? own(lot, "orderAddress") : null);
    const originalCountry = code(
      originalAddress ? own(originalAddress, "countryId") : null,
      countries,
    );
    const originalCanton = code(
      originalAddress ? own(originalAddress, "cantonId") : null,
      cantons,
    );
    const conflicts =
      (originalCountry && readCountry && originalCountry !== readCountry) ||
      (originalCanton && readCanton && originalCanton !== readCanton) ||
      (country && readCountry && country !== readCountry) ||
      (canton && readCanton && canton !== readCanton) ||
      (zone && readZone && zone !== readZone) ||
      (readCountry && readCountry !== "CH" && readCanton) ||
      (readZone &&
        ((readCountry && readCountry !== "CH") ||
          (readCanton && readCanton !== "TI")));
    if (conflicts)
      review(
        "La lettura operativa e il territorio originale del lotto sono discordanti.",
      );
    else if (
      !automaticReviewReasons.some((reason) => reason.includes("discordanti"))
    ) {
      country = readCountry ?? country;
      canton = readCanton ?? canton;
      zone = readZone ?? zone;
      if (
        (country && country !== "CH") ||
        (country === "CH" && canton && canton !== "TI")
      )
        veto ||= "Il lavoro del lotto si trova fuori dal Ticino.";
      if (country === "CH" && canton === "TI") {
        const clear = (reason: string) => {
          for (const list of [reviewReasons, automaticReviewReasons]) {
            const index = list.indexOf(reason);
            if (index >= 0) list.splice(index, 1);
          }
        };
        clear("Luogo di esecuzione del lotto da verificare.");
        if (profile.zones.includes("Tutto il Ticino"))
          clear("Zona di esecuzione del lotto da verificare.");
        else if (!zone) review("Zona di esecuzione del lotto da verificare.");
        else if (!profile.zones.includes(zone))
          veto ||= "Il lavoro del lotto si trova fuori dalle zone selezionate.";
        else clear("Zona di esecuzione del lotto da verificare.");
      }
    }
    if (
      deadline &&
      answer.deadline &&
      Date.parse(deadline) !== Date.parse(answer.deadline)
    ) {
      deadline = null;
      review(
        "Termine locale e lettura della scadenza applicabile al lotto sono discordanti.",
      );
    } else if (!localDeadlineConflict) deadline = answer.deadline ?? deadline;
  }
  if (deadline && now.getTime() >= Date.parse(deadline))
    veto ||= "Il termine di presentazione applicabile al lotto è scaduto.";

  const texts: {
    raw: string;
    normalized: string;
    scope: "project_context" | "selected_lot";
    url: string;
    rawPath: string;
  }[] = [];
  if (content?.comparison)
    for (const [name, scope] of [
      ["project", "project_context"],
      ["lot", "selected_lot"],
    ] as const) {
      const corpus = content.comparison[name];
      if (!corpus.corpus.accepted) continue;
      for (const mapping of corpus.sourceMappings) {
        const unit = corpus.corpus.corpus.units.find(
          (u) => u.id === mapping.unitId,
        );
        if (!unit) throw new Error("Missing lot text provenance");
        texts.push({
          raw: unit.text,
          normalized: plainText(unit.text),
          scope,
          url: mapping.url,
          rawPath: mapping.rawPath,
        });
      }
    }
  let keyword = false;
  const classification = classifyProcurement(lotClassificationInput(lot));
  const sectors = new Set<Sector>(classification.sectors);
  if (classification.needsClassification)
    review(
      "Settore del lotto da classificare: informazioni insufficienti o discordanti.",
      true,
    );
  for (const source of texts) {
    // The stored raw string/path is exact; plainText is a declared lexical
    // transform, not an invented quotation or contract attribution.
    used.push({
      scope: source.scope,
      url: source.url,
      rawPath: source.rawPath,
      raw: source.raw,
      transform: "plainText",
      normalized: source.normalized,
    });
    if (source.scope === "selected_lot") {
      if (
        classification.sectors.some((sector) =>
          profile.sectors.includes(sector),
        )
      )
        add({
          scope: source.scope,
          url: source.url,
          rawPath: source.rawPath,
          value: source.raw,
          purpose: "activity",
        });
    }
    const normalized = source.normalized.toLowerCase();
    if (
      profile.keywords.some(
        (term) => term.trim() && normalized.includes(term.toLowerCase()),
      )
    ) {
      keyword = true;
      add({
        scope: source.scope,
        url: source.url,
        rawPath: source.rawPath,
        value: source.raw,
        purpose: "keyword",
      });
    }
    if (
      profile.exclusions.some(
        (term) => term.trim() && normalized.includes(term.toLowerCase()),
      )
    ) {
      // A shared description can enumerate several lots. A lexical occurrence
      // there does not attribute the excluded work to this selected lot. Keep
      // the evidence and require review; only the lot's own text can veto it.
      if (source.scope === "selected_lot")
        veto ||=
          "I testi del lotto contengono un’attività esclusa dal profilo.";
      else
        review(
          "Il contesto del progetto contiene un’attività esclusa: verifica se riguarda il lotto selezionato.",
        );
      add({
        scope: source.scope,
        url: source.url,
        rawPath: source.rawPath,
        value: source.raw,
        purpose: "exclusion",
      });
    }
  }
  if (
    ![...sectors].some((sector) => profile.sectors.includes(sector)) &&
    !keyword
  )
    review(
      "Le attività del lotto richiedono un confronto con il profilo.",
      true,
    );
  if (
    context.state !== "manual_source" ||
    context.form !== "defined_service" ||
    context.projectBarrier.state !== "clear"
  )
    review(
      "La fonte del lotto o il contesto condiviso richiedono una revisione.",
      true,
    );
  // The verified lot fields currently expose execution/contract periods, not a
  // bid deadline or CHF value. Do not manufacture those mappings or inherit
  // project corrections; a future explicit target-bound adapter must supply them.
  if (!deadline)
    review("Termine di presentazione applicabile al lotto da verificare.");
  if (profile.minValue !== null || profile.maxValue !== null)
    review("Importo del lotto rispetto alla fascia selezionata da verificare.");
  const operationalInputHash = hash({
    version: PREFILTER_VERSION,
    classification: {
      version: classification.version,
      inputHash: classification.inputHash,
      sectors: classification.sectors,
    },
    target: context.target,
    identity: content?.identity ?? null,
    used,
    profile: {
      sectors: profile.sectors,
      zones: profile.zones,
      keywords: profile.keywords,
      exclusions: profile.exclusions,
      minValue: profile.minValue,
      maxValue: profile.maxValue,
    },
    sourceState: {
      state: context.state,
      form: context.form,
      barrierState: context.projectBarrier.state,
    },
    unavailable: [...(!deadline ? ["lot_bid_deadline"] : []), "lot_value_chf"],
  });
  return {
    eligible: !veto,
    requiresReview: !veto && reviewReasons.length > 0,
    reason:
      veto ||
      reviewReasons[0] ||
      "Nessuna esclusione preliminare del lotto; pertinenza da valutare.",
    operationalInputHash,
    evidence,
    reviewReasons,
    automaticReviewReasons,
    informationalReviewReasons: deadline
      ? []
      : ["Termine di presentazione applicabile al lotto da verificare."],
    signals: { sectors: [...sectors], keyword },
    operational: {
      country,
      canton,
      zone,
      cpv: [...new Set(cpv)],
      deadline,
      valueChf: null,
    },
  };
}

import { createHash } from "node:crypto";
import type { CompanyProfile, Publication, Sector } from "./domain";
import type { LotSourceContext } from "./lot-source-context";
import { stableDocumentaryJson } from "./documentary-observation";
import { parseDeadline, plainText } from "@/sources/common";
import {
  classifyProcurement,
  projectClassificationInput,
} from "./sector-classification";
import { zoneForExactCity } from "./ticino-localities";

export const PROJECT_PREFILTER_VERSION = "project-operational-prefilter-v2";
export type ProjectOperationalEvidence = {
  scope: "publication" | "project_context";
  url: string;
  rawPath: string;
  value: unknown;
  presence: "present" | "absent";
  purpose:
    | "availability"
    | "location"
    | "classification"
    | "activity"
    | "keyword"
    | "exclusion"
    | "deadline"
    | "value"
    | "structure"
    | "editorial";
};
export type PreliminaryProjectMatch = {
  eligible: boolean;
  requiresReview: boolean;
  reason: string;
  operationalInputHash: string;
  evidence: readonly ProjectOperationalEvidence[];
  reviewReasons: readonly string[];
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
const countries = new Set(
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
    " ",
  ),
);
const languages = new Set(["it", "de", "fr", "en"]);
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
function strings(v: unknown): string[] | null {
  if (typeof v === "string") return v.trim() ? [v] : null;
  const entries = Object.entries(object(v)).filter(
    ([, value]) => value !== null && value !== "",
  );
  return entries.length &&
    entries.every(
      ([language, value]) =>
        languages.has(language) && typeof value === "string",
    )
    ? entries.map(([, value]) => value as string)
    : null;
}
const zoneForCity = (city: string) => zoneForExactCity(plainText(city));
const code = (value: unknown, supported: Set<string>) =>
  typeof value === "string" && supported.has(value.trim().toUpperCase())
    ? value.trim().toUpperCase()
    : null;
const own = (v: Record<string, unknown>, key: string) =>
  Object.hasOwn(v, key) ? v[key] : null;
function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}

// An operational filter on the complete project context. Human source/epoch
// and company-assessment checks remain mandatory in the caller; this function
// neither constructs a lot nor certifies professional fit or bid eligibility.
export function preliminaryProjectMatch({
  publication,
  profile,
  context,
  now = new Date(),
}: {
  publication: Publication;
  profile: CompanyProfile;
  context: LotSourceContext;
  now?: Date;
}): PreliminaryProjectMatch {
  if (
    context.target.kind !== "project" ||
    context.target.publicationId !== publication.id ||
    context.dependency.publicationId !== publication.id ||
    publication.source !== "simap"
  )
    throw new Error(
      "Project filter requires this publication's project context",
    );
  const content = context.targetContent;
  if (
    content &&
    (content.identity.projectId.toLowerCase() !==
      publication.externalId.toLowerCase() ||
      content.selectedLot !== null ||
      content.comparison !== null)
  )
    throw new Error("Project filter source identity or target mismatch");
  if (!Number.isFinite(now.getTime()))
    throw new Error("Invalid project filter clock");
  const evidence: ProjectOperationalEvidence[] = [],
    used: unknown[] = [],
    reviewReasons: string[] = [];
  const review = (reason: string) => {
    if (!reviewReasons.includes(reason)) reviewReasons.push(reason);
  };
  const add = (item: ProjectOperationalEvidence) => {
    evidence.push(item);
    used.push(item);
  };
  function publicationField(
    key:
      | "status"
      | "visibleAt"
      | "deadline"
      | "valueChf"
      | "location"
      | "canton"
      | "zone",
    purpose: ProjectOperationalEvidence["purpose"],
  ) {
    add({
      scope: "publication",
      url: publication.sourceUrl,
      rawPath: "/" + key,
      value: publication[key],
      presence: "present",
      purpose,
    });
  }
  publicationField("status", "availability");
  publicationField("visibleAt", "availability");
  let veto = "";
  const closed = ["closed", "cancelled", "awarded"].includes(
    publication.status,
  );
  if (closed) veto = "La pubblicazione non è un bando aperto.";
  else if (publication.status !== "open")
    review("Stato della pubblicazione da verificare.");
  const visible = Date.parse(publication.visibleAt);
  const embargoed = Number.isFinite(visible) ? visible > now.getTime() : null;
  if (embargoed === null) review("Disponibilità pubblica da verificare.");
  else if (embargoed) veto ||= "Pubblicazione non ancora diffondibile.";

  let country: string | null = null,
    canton: string | null = null,
    zone: string | null = null,
    deadline: string | null = null,
    keyword = false;
  const cpv = new Set<string>(),
    sectors = new Set<Sector>();
  const sections = object(content?.projectSections),
    base = object(sections.base);
  const classification = classifyProcurement(
    projectClassificationInput(sections),
  );
  const completeProject =
    !!content && content.directory.length === 0 && base.lotsType === "without";
  if (!completeProject)
    review("La struttura senza lotti del progetto non è verificata.");
  if (content)
    add({
      scope: "project_context",
      url: content.identity.detailUrl,
      rawPath: "/base/lotsType",
      value: own(base, "lotsType"),
      presence: Object.hasOwn(base, "lotsType") ? "present" : "absent",
      purpose: "structure",
    });

  if (completeProject && content) {
    const url = content.identity.detailUrl,
      procurement = object(sections.procurement),
      dates = object(sections.dates);
    function field(
      owner: Record<string, unknown>,
      key: string,
      path: string,
      purpose: ProjectOperationalEvidence["purpose"],
    ) {
      const value = own(owner, key);
      add({
        scope: "project_context",
        url,
        rawPath: path + "/" + key,
        value,
        presence: Object.hasOwn(owner, key) ? "present" : "absent",
        purpose,
      });
      return value;
    }
    for (const [owner, path] of [
      [procurement, "/procurement"],
      [base, "/base"],
    ] as const) {
      const primary = field(owner, "cpvCode", path, "classification");
      const additional =
        path === "/procurement"
          ? field(owner, "additionalCpvCodes", path, "classification")
          : null;
      if (additional !== null && !Array.isArray(additional))
        review("Classificazione del progetto da verificare.");
      for (const value of [
        primary,
        ...(Array.isArray(additional) ? additional : []),
      ]) {
        if (value === null) continue;
        const raw = object(value).code;
        if (typeof raw === "string" && /^\d{8}(?:-\d)?$/.test(raw))
          cpv.add(raw.slice(0, 8));
        else review("Classificazione del progetto da verificare.");
      }
    }
    classification.sectors.forEach((sector) => sectors.add(sector));
    if (classification.needsClassification)
      review(
        "Settore del progetto da classificare: informazioni insufficienti o discordanti.",
      );

    // All parent content stays in context. Only these documented title/service
    // channels yield lexical signals; conditions/metadata are not professions.
    for (const section of ["project-info", "procurement", "base"])
      for (const key of ["title", "orderDescription"]) {
        const owner = object(sections[section]),
          value = own(owner, key);
        if (value === null) continue;
        const translated =
          typeof value === "string"
            ? [[null, value] as const]
            : Object.entries(object(value));
        if (typeof value !== "string" && !Object.keys(object(value)).length)
          review("Testo originale del progetto da verificare.");
        for (const [language, raw] of translated) {
          if (raw === null || raw === "") continue;
          if (
            typeof raw !== "string" ||
            (language !== null && !languages.has(language))
          ) {
            review("Lingua o testo originale del progetto da verificare.");
            used.push({ path: `/${section}/${key}`, language, raw });
            continue;
          }
          const rawPath =
            `/${section}/${key}` + (language === null ? "" : "/" + language);
          const normalized = plainText(raw);
          used.push({
            scope: "project_context",
            url,
            rawPath,
            raw,
            transform: "plainText",
            normalized,
          });
          const addText = (purpose: ProjectOperationalEvidence["purpose"]) =>
            add({
              scope: "project_context",
              url,
              rawPath,
              value: raw,
              presence: "present",
              purpose,
            });
          if (
            classification.sectors.some((sector) =>
              profile.sectors.includes(sector),
            )
          )
            addText("activity");
          if (
            profile.keywords.some(
              (term) =>
                term.trim() &&
                normalized.toLowerCase().includes(term.toLowerCase()),
            )
          ) {
            keyword = true;
            addText("keyword");
          }
          if (
            profile.exclusions.some(
              (term) =>
                term.trim() &&
                normalized.toLowerCase().includes(term.toLowerCase()),
            )
          ) {
            veto ||=
              "I testi del progetto contengono un’attività esclusa dal profilo.";
            addText("exclusion");
          }
        }
      }

    const rawAddress = field(
      procurement,
      "orderAddress",
      "/procurement",
      "location",
    );
    const descriptionOnly = field(
      procurement,
      "orderAddressOnlyDescription",
      "/procurement",
      "location",
    );
    field(procurement, "orderAddressDescription", "/procurement", "location");
    const address = object(rawAddress),
      rawCity = own(address, "city");
    let locationConflict = false;
    if (
      Object.keys(address).length &&
      (descriptionOnly === null || descriptionOnly === "no")
    ) {
      country = code(own(address, "countryId"), countries);
      canton = code(own(address, "cantonId"), cantons);
      const cityVariants = strings(rawCity),
        zones = cityVariants?.map(zoneForCity);
      zone = zones?.[0] && zones.every((v) => v === zones[0]) ? zones[0] : null;
      const knownTicinoCity =
        typeof rawCity === "string"
          ? !!zoneForCity(rawCity)
          : Object.entries(object(rawCity)).some(
              ([language, city]) =>
                languages.has(language) &&
                typeof city === "string" &&
                !!zoneForCity(city),
            );
      if (
        (country && country !== "CH" && canton) ||
        (knownTicinoCity &&
          ((country && country !== "CH") || (canton && canton !== "TI")))
      ) {
        locationConflict = true;
        review("Città, paese o cantone del progetto sono discordanti.");
      }
      for (const key of ["location", "canton", "zone"] as const)
        publicationField(key, "editorial");
      if (
        (canton && publication.canton !== canton) ||
        (zone && publication.zone !== zone) ||
        (cityVariants &&
          !cityVariants.map(plainText).includes(publication.location))
      ) {
        locationConflict = true;
        review(
          "Luogo corrente e fonte originale del progetto da riconciliare.",
        );
      }
      if (locationConflict) {
        country = null;
        canton = null;
        zone = null;
      } else if (country && country !== "CH")
        veto ||= "Il lavoro del progetto si trova fuori dal Ticino.";
      else if (country === "CH" && canton && canton !== "TI")
        veto ||= "Il lavoro del progetto si trova fuori dal Ticino.";
      else if (country === "CH" && canton === "TI") {
        if (!profile.zones.includes("Tutto il Ticino")) {
          if (!zone) review("Zona di esecuzione del progetto da verificare.");
          else if (!profile.zones.includes(zone))
            veto ||=
              "Il lavoro del progetto si trova fuori dalle zone selezionate.";
        }
      } else review("Luogo di esecuzione del progetto da verificare.");
    } else review("Luogo di esecuzione del progetto da verificare.");

    // Keep source visit instructions visible to the reviewer, even when the
    // offer deadline is still open. Do not infer attendance or parse prose as
    // an automatic legal deadline/exclusion. Empty language slots are absent.
    const visit = own(object(sections.terms), "walkThroughNotes");
    if (
      visit !== null &&
      (typeof visit === "string"
        ? !!plainText(visit)
        : Object.values(object(visit)).some(
            (value) =>
              value !== null &&
              (typeof value !== "string" || !!plainText(value)),
          ))
    ) {
      field(
        object(sections.terms),
        "walkThroughNotes",
        "/terms",
        "availability",
      );
      review(
        "La fonte contiene indicazioni sul sopralluogo: verifica obbligatorietà, data ed eventuale partecipazione.",
      );
    }

    const baseProcess = field(base, "processType", "/base", "deadline");
    const datesProcess = field(dates, "processType", "/dates", "deadline");
    const process = baseProcess ?? datesProcess;
    const processConflict =
      baseProcess !== null &&
      datesProcess !== null &&
      baseProcess !== datesProcess;
    if (!processConflict && (process === "open" || process === "selective")) {
      const key =
        process === "selective"
          ? "participationRequestDeadline"
          : "offerDeadline";
      deadline = parseDeadline(field(dates, key, "/dates", "deadline"));
    } else review("Procedura e termine applicabile al progetto da verificare.");
    publicationField("deadline", "editorial");
    if (deadline !== null && publication.deadline !== deadline) {
      // Do not override an editorial change using a raw term, or present an
      // unexplained normalized/header choice as exact documentary evidence.
      review(
        "Scadenza corrente e fonte originale del progetto da riconciliare.",
      );
      deadline = null;
    }
  }
  const deadlineExpired =
    deadline !== null ? Date.parse(deadline) <= now.getTime() : null;
  if (deadlineExpired)
    veto ||= "Il termine di presentazione del progetto è trascorso.";
  if (deadline === null)
    review("Termine di presentazione applicabile al progetto da verificare.");
  // There is no supported official project value mapping in the adapter yet.
  // Keep an existing edited value visible as provenance, never a certain veto.
  publicationField("valueChf", "value");
  if (publication.valueChf !== null)
    review(
      "Importo corrente del progetto privo di attribuzione documentaria verificata.",
    );
  if (profile.minValue !== null || profile.maxValue !== null)
    review(
      "Importo del progetto rispetto alla fascia selezionata da verificare.",
    );
  if (
    ![...sectors].some((sector) => profile.sectors.includes(sector)) &&
    !keyword
  )
    review("Le attività del progetto richiedono un confronto con il profilo.");
  if (
    context.state !== "manual_source" ||
    context.form !== "defined_service" ||
    context.projectBarrier.state !== "clear"
  )
    review("La fonte del progetto richiede una revisione.");
  const operationalInputHash = createHash("sha256")
    .update(
      stableDocumentaryJson({
        version: PROJECT_PREFILTER_VERSION,
        classification: {
          version: classification.version,
          inputHash: classification.inputHash,
          sectors: classification.sectors,
        },
        target: context.target,
        identity: content?.identity ?? null,
        used,
        profile,
        availability: { closed, embargoed, deadlineExpired },
        source: {
          state: context.state,
          form: context.form,
          barrier: context.projectBarrier.state,
        },
        unavailable: ["project_value_chf"],
      }),
    )
    .digest("hex");
  return freeze({
    eligible: !veto,
    requiresReview: !veto && reviewReasons.length > 0,
    reason:
      veto ||
      reviewReasons[0] ||
      "Nessuna esclusione preliminare del progetto; pertinenza da valutare.",
    operationalInputHash,
    evidence,
    reviewReasons,
    signals: { sectors: [...sectors], keyword },
    operational: {
      country,
      canton,
      zone,
      cpv: [...cpv],
      deadline,
      valueChf: null,
    },
  });
}

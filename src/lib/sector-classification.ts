import { createHash } from "node:crypto";
import cpvReference from "./sector-cpv-reference.json";
import { SECTORS, type Sector } from "./sectors";
import type { Publication } from "./domain";

export const SECTOR_CLASSIFICATION_VERSION = "procurement-sectors-v1";
export type ProcurementKind =
  "works" | "design" | "supply" | "installation" | "maintenance" | "service";
export type ClassificationReason =
  | "insufficient_information"
  | "unsupported_cpv"
  | "conflicting_information"
  | "source_unavailable";
export type SectorClassification = {
  version: typeof SECTOR_CLASSIFICATION_VERSION;
  sectors: Sector[];
  kinds: ProcurementKind[];
  needsClassification: boolean;
  reasons: ClassificationReason[];
  inputHash: string;
  evidence: {
    sector: Sector;
    basis: "main_cpv" | "additional_cpv" | "title" | "description";
    value: string;
  }[];
};
export type PublicationClassification = SectorClassification & {
  lots: (SectorClassification & { id: string; number: number | null })[];
};
export type ClassificationInput = {
  titles: readonly string[];
  descriptions: readonly string[];
  mainCpv: string | null;
  additionalCpv: readonly string[];
  mainCpvConflict?: boolean;
};
type MatchRule = { sector: Sector; pattern: RegExp; kind?: ProcurementKind };
const word = (pattern: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{M}\\p{N}_])`,
    "iu",
  );
// Only procurement subject channels are passed here, never buyer names, legal
// terms, qualification conditions, delivery addresses, summaries or AI text.
const textRules: MatchRule[] = [
  {
    sector: "progettazione",
    kind: "design",
    pattern: word(
      "ingegner[ei]|ingegneria|architett[oi]|progettazion[ei]|progettist[ai]|geomatic[oa]|geometra|direzione (?:locale (?:dei )?)?lavori|capo direzione|prestazioni (?:di|da) (?:cdl|dl)|ingénierie|ingénieur|architecte|planification|direction (?:des )?travaux|ingenieurleistungen|ingenieur|planungsleistungen|generalplaner|bauleitung|engineering services|architectural services|design services",
    ),
  },
  {
    sector: "informatica",
    pattern: word(
      "informatica|informatici|informatico|telecomunicazioni|software|hardware|cisco|openshift|hpc|computer|computers|server|applicativo|applicativi|fibra ottica|fibre ottiche|fibres optiques|fibre optique|lwl|lwl-infrastruktur|lwl-ausrüstung|it-dienstleistungen|informatiques|informatique|telecommunications|télécommunications",
    ),
  },
  {
    sector: "assicurazioni",
    kind: "service",
    pattern: word(
      "assicurazion[ei]|assicurativo|assicurativi|previdenza|lainf|lamal|lpp|ipg|assurance|assurances|versicherungen|versicherung|insurance|pension services",
    ),
  },
  {
    sector: "arredi",
    kind: "supply",
    pattern: word(
      "arredi|arredo|mobilio|mobili|mobilier|möbel|möblierung|furniture",
    ),
  },
  {
    sector: "abbigliamento",
    kind: "supply",
    pattern: word(
      "abbigliamento|indumenti|uniformi|calzature|vestiario|copricapo|zaini|borse|cinture|guanti|vêtements|uniformes|bekleidung|berufskleidung|clothing|uniforms",
    ),
  },
  {
    sector: "energia",
    kind: "supply",
    pattern: word(
      "carburant[ei]|combustibil[ei]|fornitura di energia|approvvigionamento di energia|fourniture d’énergie|fourniture d'energie|carburants|brennstoffe|kraftstoffe|stromlieferung|electricity supply|fuels",
    ),
  },
  {
    sector: "sanita",
    kind: "supply",
    pattern: word(
      "glucometri|glicemia|dispositivi (?:medici|valvolari)|valvole (?:aortiche|mitraliche)|pompe infusionali|pompe a siringa|nutrizione enterale|materiale medico|medizintechnik|medizinische geräte|matériel médical|dispositifs médicaux|medical equipment|infusion pumps",
    ),
  },
  {
    sector: "veicoli",
    kind: "supply",
    pattern: word(
      "fornitura (?:di )?(?:(?:un|tre|quattro|\\d+) )?veicol[oi]|acquisto (?:di )?(?:\\d+ )?veicol[oi]|fourniture de véhicules|lieferung von fahrzeugen|vehicle supply|autobus|ambulanz[ae]",
    ),
  },
  {
    sector: "alimentari",
    kind: "supply",
    pattern: word(
      "generi alimentari|prodotti alimentari|alimenti e bevande|derrate|denrées alimentaires|lebensmittel|food supplies",
    ),
  },
  {
    sector: "ufficio",
    kind: "supply",
    pattern: word(
      "cancelleria|materiale d’ufficio|materiale d'ufficio|fournitures de bureau|büromaterial|stationery|office supplies",
    ),
  },
  {
    sector: "ospitalita",
    kind: "service",
    pattern: word(
      "servizi alberghieri|alberghi|centri per seminari|allestimento tecnico per eventi|attrezzature tecniche per eventi|organizzazione di eventi|hôtellerie|hôteliers|hôtels|centres de séminaire|hotel services|hotels|hotelservice|veranstaltungstechnik|eventtechnik|seminarzentren|seminarräume",
    ),
  },
  {
    sector: "consulenza",
    kind: "service",
    pattern: word(
      "consulenza aziendale|servizi amministrativi|administrative und organisatorische|tâches administratives|business consulting|management consultancy",
    ),
  },
  {
    sector: "ambiente",
    kind: "service",
    pattern: word(
      "smaltimento|raccolta (?:dei )?rifiuti|gestione (?:dei )?rifiuti|servizi ambientali|consulente.*neofite|consulenza ambientale|déchets|entsorgung|abfallentsorgung|waste collection|waste disposal|environmental consulting",
    ),
  },
  {
    sector: "pulizie",
    kind: "service",
    pattern: word(
      "pulizi[ae]|lavanderia|lavaggio e stiratura|blanchisserie|nettoyage|reinigung|gebäudereinigung|unterhaltsreinigung|fensterreinigung|industriereinigung|baureinigung|grundreinigung|cleaning|laundry",
    ),
  },
  {
    sector: "giardinaggio",
    kind: "service",
    pattern: word(
      "giardinaggio|giardinier[ei]|potatura|sfalcio|cura del verde|manutenzione del verde|parchi|giardin[oi]|grünflächenpflege|grünanlagenpflege|grünpflege|grünflächenunterhalt|gartenunterhalt|jardinage|jardinier|jardiniers|jardins|jardin|gardening|landscaping",
    ),
  },
  {
    sector: "manutenzioni",
    kind: "maintenance",
    pattern: word(
      "manutenzion[ei]|maintenance|unterhalt|gebäudeunterhalt|strassenunterhalt|anlagenunterhalt|unterhaltsarbeiten|unterhaltsdienst|sgombero neve|winterdienst|déneigement|snow clearing",
    ),
  },
  {
    sector: "edilizia",
    kind: "works",
    pattern: word(
      "impresario costruttore|impresa generale|edilizia|edili|edile|muratura|pavimentazion[ei]|carpenteria|metalcostruttore|gessatore|piastrellista|lattoniere|ponteggi|impermeabilizzazione|controsoffitti|fabbro|serramenti|genio civile|impianti sportivi|campo da calcio sintetico|manto erboso sintetico|travaux de construction|bauarbeiten|hochbau|tiefbau|construction work",
    ),
  },
  {
    sector: "impianti",
    pattern: word(
      "dispositivo di comando|steuerungseinrichtung|controllo elettrico|isolamento impianti|impianti (?:elettrici|elettrico|sanitari|idraulici|di riscaldamento|di ventilazione)|impianto (?:elettrico|sanitario|di riscaldamento|di ventilazione|di lavaggio)|elettricist[ai]|elettric[oaie]|idraulic[oaie]|riscaldamento|ascensor[ei]|montacarichi|sollevatore elettroidraulico|termopomp[ae]|fotovoltaic[oi]|cablaggi|sanitäranlagen|elektroinstallationen|elektroinstallation|elektroarbeiten|heizungsanlagen|installations électriques|installations sanitaires|hvac|electrical installation",
    ),
  },
  {
    sector: "sicurezza",
    kind: "service",
    pattern: word(
      "vigilanza|sorveglianza|servizi di sicurezza|regolazione del traffico|sicherheitsdienst|bewachung|surveillance|guarding|security guarding|traffic control services",
    ),
  },
  {
    sector: "catering",
    kind: "service",
    pattern: word(
      "ristorazione|mensa|pasti|catering|verpflegung|gemeinschaftsverpflegung|betriebsverpflegung|schulverpflegung|restauration collective",
    ),
  },
  {
    sector: "trasporti",
    kind: "service",
    pattern: word(
      "trasporto|trasporti|transport|transports|transportation|transporte|transportdienstleistungen|gütertransport|personentransport|schülertransport|schülertransporte|scuolabus",
    ),
  },
  {
    sector: "materiali",
    kind: "supply",
    pattern: word(
      "fornitura (?:di )?tubi|fornitura (?:di )?coperture stradali|fornitura (?:di )?solette|chiusini|materiali edili|baustoffe|matériaux de construction|building materials",
    ),
  },
];
const rules = [...cpvReference.rules].sort(
  (a, b) => b.prefix.length - a.prefix.length,
);
const validCodes = new Set(cpvReference.validCodes);
const orderedSectors = (values: readonly Sector[]) =>
  SECTORS.filter((s) => values.includes(s.id)).map((s) => s.id);
const unique = <T>(values: readonly T[]) => [...new Set(values)];
const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b, "en"))
          .map(([k, c]) => JSON.stringify(k) + ":" + stable(c))
          .join(",")}}`
      : JSON.stringify(v);
const digest = (value: unknown) =>
  createHash("sha256").update(stable(value)).digest("hex");
function text(value: string) {
  return value
    .normalize("NFC")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?(?:p|div|br|li)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[\t ]+/g, " ")
    .trim();
}
function cpvRule(value: string | null) {
  const code = value?.match(/^(\d{8})(?:-\d)?$/)?.[1];
  if (!code || !validCodes.has(code)) return null;
  const rule = rules.find((r) => code.startsWith(r.prefix));
  return rule
    ? {
        code,
        sector: rule.sector as Sector,
        kind: rule.kind as ProcurementKind,
      }
    : null;
}
// Discard an explicitly delimited project background before the current scope.
// This is not semantic extraction; absent a delimiter, CPV/title remain decisive.
function subjectText(raw: string) {
  const value = text(raw);
  const marker =
    /(?:il (?:presente |attuale )?lotto(?: [^\n:.]{0,65})? comprend[e:]|das (?:vorliegende )?los(?: [^\n:.]{0,65})? umfasst|le (?:présent )?lot(?: [^\n:.]{0,65})? comprend|the (?:present )?(?:lot|contract) includes)/iu.exec(
      value,
    );
  return marker ? value.slice(marker.index) : value;
}
function repeatedScopeConflict(raw: string) {
  // Repeated "this lot includes" sections with disjoint subjects can be a
  // copied description of a different lot. Do not silently choose one block.
  const markers = [
    ...raw.matchAll(
      /il (?:presente |attuale )?lotto(?: [^\n:.]{0,65})? comprend[e:]|das (?:vorliegende )?los(?: [^\n:.]{0,65})? umfasst|le (?:présent )?lot(?: [^\n:.]{0,65})? comprend/giu,
    ),
  ];
  if (markers.length < 2) return false;
  const subjects = markers.map((marker) =>
    signals(
      raw
        .slice(marker.index! + marker[0].length)
        .replace(/^[:\s]+/u, "")
        .split(/\n/u)[0]!,
      false,
    )
      .map((rule) => rule.sector)
      .filter((sector) => sector !== "manutenzioni"),
  );
  return subjects.some(
    (a, i) =>
      a.length > 0 &&
      subjects
        .slice(i + 1)
        .some((b) => b.length > 0 && !a.some((sector) => b.includes(sector))),
  );
}
function signals(raw: string, title: boolean) {
  let value = title ? text(raw) : subjectText(raw);
  if (title)
    value = value.split(
      /\b(?:nell[’']ambito|dans le cadre|im rahmen|occorrenti|destinati|destinata|per la ristrutturazione|per il risanamento)\b/iu,
    )[0]!;
  let found = textRules.filter((rule) => rule.pattern.test(value));
  // A design mandate for a building is not execution of that building. Likewise
  // specialist maintenance stays in its subject family rather than every trade.
  if (found.some((r) => r.sector === "progettazione"))
    found = found.filter((r) =>
      ["progettazione", "ambiente"].includes(r.sector),
    );
  if (found.some((r) => r.sector === "assicurazioni"))
    found = found.filter((r) => r.sector === "assicurazioni");
  if (found.some((r) => r.sector === "sanita"))
    found = found.filter((r) => r.sector === "sanita");
  if (found.some((r) => r.sector === "ambiente"))
    found = found.filter(
      (r) => !["giardinaggio", "trasporti", "manutenzioni"].includes(r.sector),
    );
  if (found.some((r) => r.sector === "veicoli" || r.sector === "energia"))
    found = found.filter((r) => r.sector !== "trasporti");
  if (
    found.some((r) => r.sector === "energia") &&
    !/impiant[oi]|installazione|elettricista|electrical installation/iu.test(
      value,
    )
  )
    found = found.filter((r) => r.sector !== "impianti");
  if (found.some((r) => r.sector === "ospitalita"))
    found = found.filter(
      (r) => !["trasporti", "manutenzioni"].includes(r.sector),
    );
  if (
    /centro (?:di )?manutenzione|centri (?:di )?manutenzione|centre d’entretien|unterhaltszentrum/iu.test(
      value,
    )
  )
    found = found.filter((r) => r.sector !== "manutenzioni");
  if (/lavanderia|blanchisserie|laundry/iu.test(value))
    found = found.filter(
      (r) => !["abbigliamento", "trasporti", "manutenzioni"].includes(r.sector),
    );
  if (found.some((r) => r.sector === "giardinaggio"))
    found = found.filter((r) => r.sector !== "manutenzioni");
  if (
    /(?:trasporto|consegna).{0,50}(?:inclus[oaie]|compres[oaie])|transport.{0,40}(?:included|compris)|lieferung.{0,40}inbegriffen/iu.test(
      value,
    ) &&
    !/servizi? (?:di )?trasport[oi]|transport service|transportdienstleistungen/iu.test(
      value,
    )
  )
    found = found.filter((r) => r.sector !== "trasporti");
  return found;
}
const broadCodes = new Set([
  "45000000",
  "50000000",
  "55000000",
  "79000000",
  "66000000",
  "90000000",
  "45314300",
  "45314310",
]);
// These additional codes describe generic components of many trades. They
// must not create another family without a subject signal in the actual scope.
const contextualAdditionalCodes = new Set(["31213300", "31682000", "32571000"]);
export function classifyProcurement(
  input: ClassificationInput,
): SectorClassification {
  const normalized = {
    titles: unique(input.titles.map(text).filter(Boolean)).sort(),
    descriptions: unique(
      input.descriptions.map(subjectText).filter(Boolean),
    ).sort(),
    mainCpv: input.mainCpv,
    additionalCpv: unique(input.additionalCpv).sort(),
    mainCpvConflict: !!input.mainCpvConflict,
  };
  const evidence: SectorClassification["evidence"] = [];
  const kinds: ProcurementKind[] = [];
  const reasons: ClassificationReason[] = [];
  const primary = cpvRule(normalized.mainCpv),
    secondary = normalized.additionalCpv.map(cpvRule).filter((v) => v !== null);
  const titleSignals = normalized.titles.flatMap((value) =>
    signals(value, true).map((rule) => ({ ...rule, value })),
  );
  const descriptionSignals = normalized.descriptions.flatMap((value) =>
    signals(value, false).map((rule) => ({ ...rule, value })),
  );
  const titleSectors = unique(titleSignals.map((r) => r.sector));
  const descriptionSectors = unique(descriptionSignals.map((r) => r.sector));
  const broad = !input.mainCpv || broadCodes.has(input.mainCpv.slice(0, 8));
  const design =
    primary?.sector === "progettazione" ||
    titleSectors.includes("progettazione");
  const cpvSectors = unique([
    ...(primary ? [primary.sector] : []),
    ...secondary.map((r) => r.sector),
  ]);
  // A clear title conflicting with a specific code is not fixed by guessing.
  const decisiveTitles = normalized.titles.map((value) =>
    signals(value, true)
      .map((r) => r.sector)
      .filter((s) => s !== "manutenzioni"),
  );
  const conflict =
    !!input.mainCpvConflict ||
    normalized.descriptions.some(repeatedScopeConflict) ||
    (!!primary &&
      !broad &&
      decisiveTitles.some(
        (sectors) =>
          sectors.length > 0 && !sectors.some((s) => cpvSectors.includes(s)),
      ) &&
      !(primary.sector === "materiali" && titleSectors.includes("impianti")));
  if (conflict) reasons.push("conflicting_information");
  else {
    const add = (
      sector: Sector,
      basis: SectorClassification["evidence"][number]["basis"],
      value: string,
      kind?: ProcurementKind,
    ) => {
      if (design && !["progettazione", "ambiente"].includes(sector)) return;
      evidence.push({ sector, basis, value });
      if (kind) kinds.push(kind);
    };
    if (
      primary &&
      (!broad ||
        titleSectors.length === 0 ||
        titleSectors.includes(primary.sector))
    )
      add(primary.sector, "main_cpv", primary.code, primary.kind);
    for (const rule of secondary) {
      if (
        contextualAdditionalCodes.has(rule.code) &&
        rule.sector !== primary?.sector &&
        !titleSectors.includes(rule.sector) &&
        !descriptionSectors.includes(rule.sector)
      )
        continue;
      const sector =
        rule.code.startsWith("4432") &&
        primary &&
        ["impianti", "informatica"].includes(primary.sector)
          ? primary.sector
          : rule.sector;
      add(sector, "additional_cpv", rule.code, rule.kind);
    }
    // Titles only fill missing/general CPV information or corroborate codes.
    for (const rule of titleSignals)
      if (broad || !primary || cpvSectors.includes(rule.sector))
        add(rule.sector, "title", rule.value, rule.kind);
    if (!evidence.length)
      for (const rule of descriptionSignals)
        add(rule.sector, "description", rule.value, rule.kind);
    // Explicit independent services can add a genuine second subject. A bare
    // 'transport', 'safety', 'cleaning' or 'maintenance' in delivery/work clauses cannot.
    const independent: [Sector, RegExp][] = [
      [
        "pulizie",
        /servizi? di pulizia|prestazioni di pulizia|pulizia e (?:la )?gestione dell|reinigung und bewirtschaftung|nettoyage et la gestion/iu,
      ],
      [
        "trasporti",
        /servizi? (?:di )?trasport[oi]|servizi? trasporti|passenger transport service|transportdienstleistungen/iu,
      ],
      [
        "sicurezza",
        /servizi? di (?:vigilanza|sorveglianza|regolazione del traffico)|sicherheitsdienst/iu,
      ],
      [
        "manutenzioni",
        /(?:tutti gli interventi|servizi?) di manutenzione|sämtliche wartungs/iu,
      ],
    ];
    if (!design)
      for (const value of normalized.descriptions)
        for (const [sector, pattern] of independent)
          if (
            pattern.test(value) &&
            !(
              sector === "trasporti" &&
              evidence.some((e) =>
                ["ospitalita", "pulizie", "veicoli", "energia"].includes(
                  e.sector,
                ),
              )
            )
          )
            add(sector, "description", value, "service");
    // Distinguish supply/installation/maintenance without changing the subject
    // family (IT support does not turn into generic building maintenance).
    for (const value of design
      ? []
      : [
          ...normalized.titles,
          ...normalized.descriptions.map((value) => value.split(/\n/u)[0]!),
        ]) {
      if (/fornitura|fourniture|lieferung|supply|acquisto/iu.test(value))
        kinds.push("supply");
      if (
        /(?:fornitura e posa|installazione|montaggio|installation|montage)/iu.test(
          value,
        )
      )
        kinds.push("installation");
      if (
        /manutenzione|maintenance|instandhaltung/iu.test(value) &&
        !/centro|centri|centre|zentrum/iu.test(value)
      )
        kinds.push("maintenance");
    }
  }
  const sectors = orderedSectors(evidence.map((e) => e.sector));
  if (!sectors.length && !reasons.length)
    reasons.push(
      input.mainCpv || input.additionalCpv.length
        ? "unsupported_cpv"
        : "insufficient_information",
    );
  return {
    version: SECTOR_CLASSIFICATION_VERSION,
    sectors,
    kinds: unique(kinds).sort(),
    needsClassification: sectors.length === 0,
    reasons,
    inputHash: digest({
      version: SECTOR_CLASSIFICATION_VERSION,
      input: normalized,
    }),
    evidence: unique(evidence.map((e) => JSON.stringify(e))).map((e) =>
      JSON.parse(e),
    ),
  };
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const texts = (v: unknown): string[] =>
  typeof v === "string"
    ? [v]
    : Object.entries(object(v))
        .filter(
          ([key, value]) =>
            ["it", "de", "fr", "en"].includes(key) && typeof value === "string",
        )
        .map(([, value]) => value as string);
const code = (v: unknown) =>
  typeof object(v).code === "string" ? (object(v).code as string) : null;
export function projectClassificationInput(
  sections: unknown,
): ClassificationInput {
  const root = object(sections),
    proc = object(root.procurement),
    base = object(root.base),
    info = object(root["project-info"]);
  const primary = code(proc.cpvCode),
    fallback = code(base.cpvCode);
  return {
    titles: texts(info.title ?? base.title),
    descriptions: texts(proc.orderDescription),
    mainCpv: primary ?? fallback,
    additionalCpv: Array.isArray(proc.additionalCpvCodes)
      ? proc.additionalCpvCodes.flatMap((v) => (code(v) ? [code(v)!] : []))
      : [],
    mainCpvConflict:
      !!primary && !!fallback && primary.slice(0, 8) !== fallback.slice(0, 8),
  };
}
export function lotClassificationInput(record: unknown): ClassificationInput {
  const lot = object(record);
  return {
    titles: texts(lot.title),
    descriptions: texts(lot.orderDescription),
    mainCpv: code(lot.cpvCode),
    additionalCpv: Array.isArray(lot.additionalCpvCodes)
      ? lot.additionalCpvCodes.flatMap((v) => (code(v) ? [code(v)!] : []))
      : [],
  };
}
export function publicationClassificationInput(
  p: Publication,
): ClassificationInput {
  return {
    titles: unique([p.title, ...(p.originalTitles ?? []).map((v) => v.text)]),
    descriptions: p.originalDescriptions?.length
      ? p.originalDescriptions.map((v) => v.text)
      : p.evidence.filter((v) => v.field === "Oggetto").map((v) => v.quote),
    mainCpv: p.cpv[0] ?? null,
    additionalCpv: p.cpv.slice(1),
  };
}
// Structural subset of an immutable archive. Safe to project the three public
// subject fields in SQL; the archived bytes, hashes and versions never change.
export type ClassificationArchive = {
  projectSections: unknown;
  lotField: unknown;
  directory: readonly { id: string; number: number | null }[];
};
export function classifyPublication(
  p: Publication,
  archive?: ClassificationArchive | null,
  refused = false,
): PublicationClassification {
  const project = classifyProcurement(
    archive
      ? projectClassificationInput(archive.projectSections)
      : publicationClassificationInput(p),
  );
  if (refused)
    return {
      ...project,
      sectors: [],
      kinds: [],
      needsClassification: true,
      reasons: ["source_unavailable"],
      evidence: [],
      lots: [],
    };
  const rawLots = object(archive?.lotField).lots;
  const lots = (archive?.directory ?? []).map((entry) => {
    const record = Array.isArray(rawLots)
      ? rawLots.find((v) => object(v).id === entry.id)
      : null;
    return {
      ...classifyProcurement(lotClassificationInput(record)),
      id: entry.id,
      number: entry.number,
    };
  });
  if (!lots.length) return { ...project, lots };
  // Catalogue is the union of actual lots. Parent context never fills a missing
  // lot's activity, and a partially classified tender remains discoverable.
  return {
    ...project,
    sectors: orderedSectors(lots.flatMap((l) => l.sectors)),
    kinds: unique(lots.flatMap((l) => l.kinds)).sort(),
    needsClassification: lots.some((l) => l.needsClassification),
    reasons: unique(lots.flatMap((l) => l.reasons)),
    inputHash: digest({
      version: SECTOR_CLASSIFICATION_VERSION,
      project: project.inputHash,
      lots: lots
        .map((l) => ({ id: l.id, inputHash: l.inputHash }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }),
    evidence: lots.flatMap((l) => l.evidence),
    lots,
  };
}
export function withClassification(
  p: Publication,
  archive?: ClassificationArchive | null,
  refused = false,
): Publication {
  const classification = classifyPublication(p, archive, refused);
  return { ...p, sectors: classification.sectors, classification };
}

export const CLASSIFICATION_REVIEW_MARKER = ":sector-review:";
export function classificationReviewSuffix(p: Publication) {
  const result = classifyPublication(p);
  return `${CLASSIFICATION_REVIEW_MARKER}${result.version}:${result.inputHash}`;
}
export function classificationChanged(p: Publication) {
  const result = classifyPublication(p);
  return orderedSectors(p.sectors).join() !== result.sectors.join();
}
export function classificationReviewPending(
  p: Publication,
  revision?: string | null,
) {
  return (
    classificationChanged(p) &&
    !revision?.includes(classificationReviewSuffix(p))
  );
}

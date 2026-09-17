import {
  formatDate,
  formatDeadline,
  sectorLabel,
  type CompanyProfile,
  type Publication,
} from "./domain";
import type { LotArchive } from "./source-lots";
import { parseDeadline, plainText } from "@/sources/common";
import {
  publicLink,
  tenderSourceLink,
  tenderSourceLabel,
} from "./tender-source-link";
import { DateTime } from "luxon";

export type BriefFact = {
  label: string;
  text: string;
  language?: string;
  source: { url: string; path: string; quote: string; page?: number };
  link?: string;
};
export type TenderBrief = {
  version: "tender-brief-v1";
  sourceUrl: string;
  sourceLabel: string;
  publicationNumber: string | null;
  warning: string | null;
  description: BriefFact[];
  requirements: BriefFact[];
  visits: BriefFact[];
  deadlines: BriefFact[];
  submission: BriefFact[];
  documents: BriefFact[];
  lots: {
    id: string;
    number: number;
    description: BriefFact[];
    requirements: BriefFact[];
    documents: BriefFact[];
    visits: BriefFact[];
    deadlines: BriefFact[];
    submission: BriefFact[];
  }[];
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const languages: Record<string, string> = {
  it: "italiano",
  de: "tedesco",
  fr: "francese",
  en: "inglese",
};

function variants(
  value: unknown,
  path: string,
): { text: string; path: string; quote: string; language?: string }[] {
  if (typeof value === "string") {
    const text = plainText(value).trim();
    return text ? [{ text, path, quote: value }] : [];
  }
  const record = object(value);
  return ["it", "fr", "de", "en"].flatMap((language) =>
    typeof record[language] === "string"
      ? variants(record[language], `${path}/${language}`).map((v) => ({
          ...v,
          language,
        }))
      : [],
  );
}
function facts(
  label: string,
  value: unknown,
  path: string,
  url: string,
): BriefFact[] {
  return variants(value, path).map((v) => ({
    label,
    text: v.text,
    ...(v.language ? { language: v.language } : {}),
    source: { url, path: v.path, quote: v.quote },
  }));
}
function coded(
  label: string,
  value: unknown,
  path: string,
  url: string,
  labels: Record<string, string>,
): BriefFact[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "object" && variants(value, path).length)
    return facts(label, value, path, url);
  const text =
    typeof value === "string" && labels[value]
      ? labels[value]
      : "Valore non riconosciuto: verifica nella fonte.";
  return [
    {
      label,
      text,
      source: {
        url,
        path,
        quote: typeof value === "string" ? value : JSON.stringify(value),
      },
    },
  ];
}
function dateFact(
  label: string,
  value: unknown,
  path: string,
  url: string,
): BriefFact[] {
  if (value === undefined || value === null || value === "") return [];
  const dateOnly =
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    DateTime.fromISO(value, { zone: "Europe/Zurich" }).isValid;
  const parsed = typeof value === "string" ? parseDeadline(value) : null;
  return [
    {
      label,
      text: dateOnly
        ? `${formatDate(value as string)} · orario non indicato`
        : parsed
          ? formatDeadline(parsed)
          : "Data o orario da verificare nella fonte.",
      source: {
        url,
        path,
        quote: typeof value === "string" ? value : JSON.stringify(value),
      },
    },
  ];
}
function address(
  value: unknown,
  path: string,
  url: string,
  label: string,
): BriefFact[] {
  const record = object(value);
  const fields = ["name", "street", "postalCode", "city", "countryId"]
    .map((key) => ({ key, values: variants(record[key], `${path}/${key}`) }))
    .filter((field) => field.values.length);
  if (!fields.length) return [];
  const available = ["it", "fr", "de", "en"].filter((language) =>
    fields.some((field) => field.values.some((v) => v.language === language)),
  );
  const complete = available.filter((language) =>
    fields.every((field) =>
      field.values.some((v) => !v.language || v.language === language),
    ),
  );
  // Do not silently lose translated names/streets or mix incomplete address
  // translations into a supposedly complete delivery address.
  if (available.length && !complete.length)
    return fields.flatMap((field) =>
      facts(label, record[field.key], `${path}/${field.key}`, url),
    );
  return (complete.length ? complete : [undefined]).map((language) => ({
    label,
    text: fields
      .map(
        (field) =>
          field.values.find((v) => !v.language || v.language === language)!
            .text,
      )
      .join(", "),
    ...(language ? { language } : {}),
    source: { url, path, quote: JSON.stringify(value) },
  }));
}
const yesNo = {
  yes: "Ammesso",
  no: "Non ammesso",
  not_specified: "Non specificato",
};

function sourceSections(
  sections: Record<string, unknown>,
  url: string,
  prefix = "",
  lot = false,
) {
  const terms = object(sections.terms),
    criteria = object(sections.criteria),
    dates = object(sections.dates),
    info = object(sections["project-info"]),
    procurement = lot ? sections : object(sections.procurement);
  const requirements: BriefFact[] = [],
    documents: BriefFact[] = [],
    submission: BriefFact[] = [],
    deadlines: BriefFact[] = [];
  const add = (out: BriefFact[], label: string, value: unknown, path: string) =>
    out.push(...facts(label, value, prefix + path, url));
  if (terms.termsType === "in_documents")
    requirements.push(
      ...coded(
        "Condizioni di partecipazione",
        terms.termsType,
        `${prefix}/terms/termsType`,
        url,
        {
          in_documents:
            "Le condizioni sono nei documenti di gara. Consulta il capitolato prima di partecipare.",
        },
      ),
    );
  if (criteria.qualificationCriteriaInDocuments === "yes")
    requirements.push(
      ...coded(
        "Criteri di idoneità",
        "yes",
        `${prefix}/criteria/qualificationCriteriaInDocuments`,
        url,
        {
          yes: "I criteri di idoneità sono nei documenti di gara; non sono elencati in questa pubblicazione.",
        },
      ),
    );
  for (const [section, record, key, label] of [
    [
      "criteria",
      criteria,
      "qualificationCriteriaAsPDF",
      "Criteri di idoneità in allegato",
    ],
    ["terms", terms, "termsCriteriaAsPDF", "Condizioni in allegato"],
  ] as const) {
    if (record[key] === true || record[key] === "yes")
      requirements.push({
        label,
        text: "Consulta l’allegato nella pubblicazione ufficiale.",
        source: {
          url,
          path: `${prefix}/${section}/${key}`,
          quote: JSON.stringify(record[key]),
        },
      });
  }
  for (const [key, label] of Object.entries({
    termsNote: "Condizioni di partecipazione",
    otherRequirements: "Altri requisiti",
    securityDeposits: "Garanzie richieste",
    nonWTORequirements: "Ulteriori condizioni",
    termsOfBusiness: "Condizioni contrattuali",
    termsOfPayment: "Condizioni di pagamento",
    includedCosts: "Costi compresi",
  }))
    add(requirements, label, terms[key], `/terms/${key}`);
  for (const [key, label] of Object.entries({
    consortiumAllowed: "Consorzi di offerenti",
    subContractorAllowed: "Subappalto",
    consortiumMultiApplicationAllowed: "Partecipazione a più consorzi",
    subContractorMultiApplicationAllowed: "Subappalto in più offerte",
  }))
    requirements.push(
      ...coded(label, terms[key], `${prefix}/terms/${key}`, url, yesNo),
    );
  for (const [key, label] of Object.entries({
    consortiumNote: "Condizioni per i consorzi",
    subContractorNote: "Condizioni per il subappalto",
  }))
    add(requirements, label, terms[key], `/terms/${key}`);
  for (const [key, label] of Object.entries({
    partialOffers: "Offerte parziali",
    variants: "Varianti",
  }))
    requirements.push(
      ...coded(
        label,
        procurement[key],
        `${prefix}${lot ? "" : "/procurement"}/${key}`,
        url,
        yesNo,
      ),
    );
  for (const [key, label] of Object.entries({
    qualificationCriteriaNote: "Criteri di idoneità",
    weightedQualificationCriteriaNote: "Selezione dei partecipanti",
  }))
    add(requirements, label, criteria[key], `/criteria/${key}`);
  for (const [section, record, key, label] of [
    ["criteria", criteria, "qualificationCriteria", "Criterio di idoneità"],
    [
      "criteria",
      criteria,
      "weightedQualificationCriteria",
      "Criterio di selezione",
    ],
    ["terms", terms, "termsCriteria", "Condizione di partecipazione"],
  ] as const) {
    if (Array.isArray(record[key]))
      (record[key] as unknown[]).forEach((value, index) => {
        const criterion = object(value),
          path = `/${section}/${key}/${index}`;
        add(
          requirements,
          label,
          criterion.description ?? value,
          typeof value === "string" ? path : `${path}/description`,
        );
        add(
          documents,
          "Documenti e prove richiesti",
          criterion.verification,
          `${path}/verification`,
        );
      });
  }
  const visits = facts(
    "Sopralluoghi: indicazioni della fonte",
    terms.walkThroughNotes,
    `${prefix}/terms/walkThroughNotes`,
    url,
  );
  const processes = [
    dates.processType,
    info.processType,
    object(sections.base).processType,
  ].filter((v) => typeof v === "string" && v);
  const process = processes[0];
  if (new Set(processes).size > 1)
    deadlines.push({
      label: "Procedura da verificare",
      text: "Le sezioni della fonte indicano procedure diverse. Verifica quale fase e quale termine si applicano prima di partecipare.",
      source: { url, path: prefix, quote: JSON.stringify(sections) },
    });
  if (process === "selective") {
    deadlines.push(
      ...dateFact(
        "Domanda di partecipazione",
        dates.participationRequestDeadline,
        `${prefix}/dates/participationRequestDeadline`,
        url,
      ),
    );
    if (!dates.participationRequestDeadline)
      deadlines.push({
        label: "Domanda di partecipazione",
        text: "Termine non indicato nei dati acquisiti. Il termine dell’offerta successiva non lo sostituisce: verifica la prima fase nella fonte.",
        source: { url, path: `${prefix}/dates`, quote: JSON.stringify(dates) },
      });
  } else {
    deadlines.push(
      ...dateFact(
        "Presentazione dell’offerta",
        dates.offerDeadline,
        `${prefix}/dates/offerDeadline`,
        url,
      ),
    );
    if (!dates.offerDeadline && !lot)
      deadlines.push({
        label: "Presentazione dell’offerta",
        text: "Termine non indicato nei dati acquisiti. Verifica la scadenza applicabile nella fonte ufficiale.",
        source: { url, path: prefix, quote: JSON.stringify(sections) },
      });
  }
  if (process === "selective" && dates.offerDeadline)
    deadlines.push(
      ...dateFact(
        "Offerta: fase successiva alla selezione",
        dates.offerDeadline,
        `${prefix}/dates/offerDeadline`,
        url,
      ),
    );
  deadlines.push(
    ...dateFact(
      "Manifestazione di interesse",
      dates.expressionOfInterestUntil,
      `${prefix}/dates/expressionOfInterestUntil`,
      url,
    ),
  );
  const available = object(dates.documentsAvailable).dateRange;
  if (Array.isArray(available))
    available
      .slice(0, 2)
      .forEach((value, index) =>
        deadlines.push(
          ...dateFact(
            index === 0
              ? "Documenti disponibili dal"
              : "Documenti disponibili fino al",
            value,
            `${prefix}/dates/documentsAvailable/dateRange/${index}`,
            url,
          ),
        ),
      );
  if (Array.isArray(dates.otherAppointments))
    dates.otherAppointments.forEach((value, index) => {
      const appointment = object(value),
        path = `/dates/otherAppointments/${index}`;
      deadlines.push(
        ...dateFact(
          "Altro appuntamento indicato",
          appointment.date,
          prefix + path + "/date",
          url,
        ),
      );
      add(
        deadlines,
        "Indicazioni sull’appuntamento",
        appointment.note,
        path + "/note",
      );
    });
  if (Array.isArray(dates.qnas))
    dates.qnas.forEach((q, i) => {
      const entry = object(q),
        path = `/dates/qnas/${i}`;
      deadlines.push(
        ...dateFact(
          `Domande di chiarimento ${i + 1}`,
          entry.date,
          prefix + path + "/date",
          url,
        ),
      );
      add(deadlines, "Come porre le domande", entry.note, path + "/note");
    });
  for (const [key, label] of Object.entries({
    specificDeadlinesAndFormalRequirements:
      "Modalità e formalità di presentazione",
    offerSubmissionNotes: "Indicazioni per l’inoltro",
  }))
    add(submission, label, dates[key], `/dates/${key}`);
  if (Array.isArray(info.offerTypes))
    info.offerTypes.forEach((type, i) =>
      submission.push(
        ...coded(
          "Modalità di inoltro",
          type,
          `${prefix}/project-info/offerTypes/${i}`,
          url,
          {
            offer_external:
              "Presentazione fuori da simap: segui il recapito e le istruzioni della fonte",
            offer_digital_simap: "Presentazione elettronica su simap",
            offer_digital_external:
              "Presentazione su una piattaforma elettronica esterna",
            offer_specific:
              "Modalità specifica: leggi le istruzioni della fonte",
          },
        ),
      ),
    );
  add(
    submission,
    "Istruzioni per la consegna",
    info.offerSpecificNote,
    "/project-info/offerSpecificNote",
  );
  submission.push(
    ...address(
      info.offerAddress,
      `${prefix}/project-info/offerAddress`,
      url,
      "Recapito per l’offerta",
    ),
  );
  const digitalUrl = publicLink(info.offerDigitalExternalPlatformUrl);
  if (digitalUrl)
    submission.push({
      label: "Piattaforma di presentazione",
      text: digitalUrl,
      link: digitalUrl,
      source: {
        url,
        path: `${prefix}/project-info/offerDigitalExternalPlatformUrl`,
        quote: String(info.offerDigitalExternalPlatformUrl),
      },
    });
  if (Array.isArray(info.offerLanguages))
    info.offerLanguages.forEach((language, i) =>
      submission.push(
        ...coded(
          "Lingua dell’offerta",
          language,
          `${prefix}/project-info/offerLanguages/${i}`,
          url,
          languages,
        ),
      ),
    );
  documents.push(
    ...coded(
      "Dove ottenere i documenti",
      info.documentsSourceType,
      `${prefix}/project-info/documentsSourceType`,
      url,
      {
        documents_source_simap:
          "Documenti di gara disponibili su simap. L’accesso può richiedere il login.",
        documents_source_email:
          "Documenti da richiedere all’indirizzo email indicato",
        documents_source_external:
          "Documenti disponibili sul sito esterno indicato",
        documents_source_address:
          "Documenti da richiedere al recapito indicato",
      },
    ),
  );
  add(
    documents,
    "Email per richiedere i documenti",
    info.documentsSourceEmail,
    "/project-info/documentsSourceEmail",
  );
  add(
    documents,
    "Come ottenere i documenti",
    info.documentsSourceNote,
    "/project-info/documentsSourceNote",
  );
  documents.push(
    ...address(
      info.documentsSourceAddress,
      `${prefix}/project-info/documentsSourceAddress`,
      url,
      "Recapito per i documenti",
    ),
  );
  const documentsUrl = publicLink(info.documentsSourceUrl);
  if (documentsUrl)
    documents.push({
      label: "Documenti sul portale indicato",
      text: documentsUrl,
      link: documentsUrl,
      source: {
        url,
        path: `${prefix}/project-info/documentsSourceUrl`,
        quote: String(info.documentsSourceUrl),
      },
    });
  add(
    documents,
    "Costi della documentazione",
    info.documentsCostsNote,
    "/project-info/documentsCostsNote",
  );
  documents.push(
    ...coded(
      "Documenti a pagamento",
      info.documentsWithCosts,
      `${prefix}/project-info/documentsWithCosts`,
      url,
      {
        yes: "Sì: verifica importo e condizioni nella fonte",
        no: "No, secondo la pubblicazione",
        not_specified: "Non specificato",
      },
    ),
  );
  const costs = object(info.documentsCosts);
  if (typeof costs.price === "number" && Number.isFinite(costs.price))
    documents.push({
      label: "Prezzo dei documenti",
      text: `${costs.price} ${typeof costs.currency === "string" ? plainText(costs.currency) : "(valuta non indicata)"}`,
      source: {
        url,
        path: `${prefix}/project-info/documentsCosts`,
        quote: JSON.stringify(costs),
      },
    });
  if (Array.isArray(info.documentsLanguages))
    info.documentsLanguages.forEach((language, i) =>
      documents.push(
        ...coded(
          "Lingua dei documenti",
          language,
          `${prefix}/project-info/documentsLanguages/${i}`,
          url,
          languages,
        ),
      ),
    );
  add(
    documents,
    "Lingue della documentazione",
    info.documentsLanguagesNote,
    "/project-info/documentsLanguagesNote",
  );
  return { requirements, documents, visits, deadlines, submission };
}

// A presentation of already acquired public data. It never changes eligibility,
// creates a judgment, fetches a document or treats an absent field as a waiver.
export function buildTenderBrief(
  p: Publication,
  archive?: LotArchive | null,
  refused = false,
): TenderBrief {
  if (
    archive &&
    (p.source !== "simap" ||
      archive.identity.projectId.toLowerCase() !== p.externalId.toLowerCase())
  )
    throw new Error("Tender brief archive belongs to another publication");
  const sourceUrl = tenderSourceLink(p);
  const brief: TenderBrief = {
    version: "tender-brief-v1",
    sourceUrl,
    sourceLabel: tenderSourceLabel(p.source),
    publicationNumber: null,
    warning: refused
      ? "La pubblicazione più recente non è leggibile. Le informazioni precedenti richiedono una verifica nella fonte."
      : null,
    description: [],
    requirements: [],
    visits: [],
    deadlines: [],
    submission: [],
    documents: [],
    lots: [],
  };
  if (refused) return brief;
  if (archive) {
    const sections = object(archive.projectSections),
      url = archive.identity.detailUrl;
    Object.assign(brief, sourceSections(sections, url));
    const number = object(sections.base).publicationNumber;
    brief.publicationNumber =
      typeof number === "string" ? plainText(number) : null;
    brief.description = facts(
      "Lavoro richiesto",
      object(sections.procurement).orderDescription,
      "/procurement/orderDescription",
      url,
    );
    if (!brief.description.length)
      brief.description = facts(
        "Lavoro richiesto",
        object(sections["project-info"]).orderDescription,
        "/project-info/orderDescription",
        url,
      );
    const list = object(archive.lotField).lots;
    // restoreSimapDetail is not needed here: the archive preserves /lots as the
    // original named field, and its directory binds each readable lot identity.
    const lotValues = Array.isArray(list) ? list : [];
    brief.lots = archive.directory.map((entry) => {
      const index = Number(entry.path.split("/").at(-1));
      const value = object(lotValues[index]);
      const local = sourceSections(value, url, entry.path, true);
      return {
        id: entry.id,
        number: entry.number,
        description: facts(
          "Lavoro del lotto",
          value.orderDescription,
          `${entry.path}/orderDescription`,
          url,
        ),
        ...local,
      };
    });
  } else {
    brief.description = (p.originalDescriptions ?? []).flatMap((d, i) =>
      facts(
        "Lavoro richiesto",
        d.text,
        `/originalDescriptions/${i}/text`,
        publicLink(d.url) || sourceUrl,
      ).map((f) => ({ ...f, ...(d.language ? { language: d.language } : {}) })),
    );
    if (!brief.description.length)
      brief.description = facts(
        "Testo disponibile",
        p.originalText,
        "/originalText",
        sourceUrl,
      );
    brief.requirements = p.requirements.flatMap((text) => {
      const evidence = p.evidence.find(
        (e) =>
          text.trim() &&
          e.quote.trim() &&
          plainText(e.quote).includes(plainText(text)),
      );
      return evidence
        ? [
            {
              label: "Requisito da verificare",
              text: plainText(text),
              source: {
                url: publicLink(evidence.url) || sourceUrl,
                path: evidence.field,
                quote: evidence.quote,
                ...(evidence.page ? { page: evidence.page } : {}),
              },
            },
          ]
        : [];
    });
    brief.deadlines = dateFact(
      "Termine indicato",
      p.deadline,
      "/deadline",
      sourceUrl,
    );
  }
  brief.documents.push(
    ...p.documents.flatMap((d, i) => {
      const link = publicLink(d.url);
      return link
        ? [
            {
              label: plainText(d.title) || "Documento di gara",
              text: d.requiresLogin
                ? "Consulta il documento sul portale originale: è richiesto l’accesso."
                : "Apri il documento pubblicamente disponibile.",
              link,
              source: {
                url: sourceUrl,
                path: `/documents/${i}`,
                quote: d.title,
              },
            },
          ]
        : [];
    }),
  );
  return brief;
}

export function potentialInterest(
  p: Publication,
  profile: CompanyProfile,
  now = new Date(),
) {
  const common = p.sectors.filter((sector) => profile.sectors.includes(sector));
  const reasons: string[] = [];
  const text = `${p.title} ${p.originalText}`.toLocaleLowerCase("it");
  const exclusions = profile.exclusions.filter(
    (term) => term.trim() && text.includes(term.toLocaleLowerCase("it")),
  );
  const keywords = profile.keywords.filter(
    (term) => term.trim() && text.includes(term.toLocaleLowerCase("it")),
  );
  if (p.status !== "open")
    reasons.push("Questa pubblicazione non è un’opportunità aperta.");
  else if (p.deadline && Date.parse(p.deadline) <= now.getTime())
    reasons.push(
      "Il termine indicato è scaduto: consulta eventuali rettifiche nella fonte.",
    );
  if (exclusions.length)
    reasons.push(
      `Attenzione: il testo contiene termini che hai escluso (${exclusions.join(", ")}). La loro presenza va verificata nel contesto del lavoro.`,
    );
  if (common.length)
    reasons.push(
      `Il bando è associato a ${common.map(sectorLabel).join(", ")}, attività presenti nel tuo profilo.`,
    );
  else
    reasons.push(
      "I settori individuati nel bando non coincidono con quelli del tuo profilo; l’attività richiesta va approfondita.",
    );
  if (keywords.length)
    reasons.push(
      `Nel testo compaiono le tue parole chiave: ${keywords.join(", ")}.`,
    );
  if (p.canton && p.canton !== "TI")
    reasons.push(
      `Il luogo indicato è nel cantone ${p.canton}, fuori dalle zone ticinesi del tuo profilo.`,
    );
  else if (p.zone)
    reasons.push(
      profile.zones.includes("Tutto il Ticino") ||
        profile.zones.includes(p.zone)
        ? `Il luogo indicato (${p.location}) è nel territorio che hai selezionato.`
        : `Il luogo indicato (${p.location}) è fuori dalle zone che hai selezionato.`,
    );
  else reasons.push("Il territorio di esecuzione deve essere verificato.");
  if (
    p.valueChf !== null &&
    ((profile.minValue !== null && p.valueChf < profile.minValue) ||
      (profile.maxValue !== null && p.valueChf > profile.maxValue))
  )
    reasons.push(
      "L’importo indicato è fuori dalla fascia economica del tuo profilo.",
    );
  else if (
    p.valueChf === null &&
    (profile.minValue !== null || profile.maxValue !== null)
  )
    reasons.push(
      "L’importo non è indicato: il confronto con la tua fascia economica resta da fare.",
    );
  reasons.push(
    "Questo primo confronto non ammette il bando nel Radar: la pertinenza deve essere valutata.",
  );
  return reasons.join(" ");
}

import type { CompanyProfile, Opportunity, Sector, Viewer } from "./domain";
export const demoProfile: CompanyProfile = {
  name: "La tua ditta",
  activities: "Pulizie e cura degli spazi verdi",
  employees: 4,
  sectors: ["pulizie", "giardinaggio", "manutenzioni"],
  zones: ["Tutto il Ticino"],
  keywords: [],
  exclusions: [],
  minValue: null,
  maxValue: null,
  emailEnabled: true,
};
export const demoViewer: Viewer = {
  userId: "demo",
  companyId: "demo",
  name: "Andrea",
  email: "demo@example.invalid",
  admin: true,
  demo: true,
  invitationAcceptedAt: new Date(0).toISOString(),
  invitationAcceptanceVersion: "demo",
  profile: demoProfile,
};
const samples: {
  title: string;
  buyer: string;
  location: string;
  zone: string;
  sector: Sector;
  days: number;
  value: number | null;
  score: number;
  reason: string;
  summary: string;
}[] = [
  {
    title: "Cura del verde e manutenzione dei parchi",
    buyer: "Comune di esempio · Luganese",
    location: "Lugano",
    zone: "Luganese",
    sector: "giardinaggio",
    days: 12,
    value: 85000,
    score: 96,
    reason:
      "Cura del verde nella tua zona, in linea con i servizi della tua ditta.",
    summary:
      "Il comune cerca una ditta per lo sfalcio dei prati, la potatura delle siepi e la cura delle aiuole dei parchi pubblici. Il servizio si svolge durante la stagione primaverile ed estiva.",
  },
  {
    title: "Pulizia degli edifici scolastici",
    buyer: "Istituto scolastico dimostrativo",
    location: "Bellinzona",
    zone: "Bellinzonese",
    sector: "pulizie",
    days: 6,
    value: 120000,
    score: 93,
    reason:
      "Pulizie professionali in Ticino: un’attività che hai indicato nel profilo.",
    summary:
      "L’istituto cerca un’impresa per la pulizia regolare di aule, corridoi e spazi comuni di due edifici scolastici. Sono previsti interventi nei giorni feriali, dopo le lezioni.",
  },
  {
    title: "Piccole manutenzioni degli immobili comunali",
    buyer: "Comune di esempio · Mendrisiotto",
    location: "Mendrisio",
    zone: "Mendrisiotto",
    sector: "manutenzioni",
    days: 19,
    value: null,
    score: 87,
    reason:
      "Interventi di manutenzione coerenti con le tue attività. Importo da verificare.",
    summary:
      "Accordo per piccoli interventi su porte, serramenti e arredi degli stabili comunali. Gli interventi vengono richiesti secondo necessità durante l’anno.",
  },
  {
    title: "Pulizia periodica degli spazi sportivi",
    buyer: "Centro sportivo dimostrativo",
    location: "Locarno",
    zone: "Locarnese",
    sector: "pulizie",
    days: 24,
    value: 48000,
    score: 85,
    reason: "Servizio di pulizia nel territorio che hai selezionato.",
    summary:
      "Pulizia di spogliatoi, servizi igienici e aree comuni di un centro sportivo. Il lavoro comprende il rifornimento dei materiali di consumo.",
  },
  {
    title: "Sostituzione dell’illuminazione interna",
    buyer: "Ente pubblico dimostrativo",
    location: "Biasca",
    zone: "Riviera",
    sector: "impianti",
    days: 15,
    value: 62000,
    score: 70,
    reason:
      "Lavoro in Ticino; richiede competenze elettriche da verificare nel tuo profilo.",
    summary:
      "Sostituzione dei corpi illuminanti esistenti con apparecchi a LED e verifica dell’impianto elettrico.",
  },
  {
    title: "Risanamento di un locale multiuso",
    buyer: "Comune dimostrativo",
    location: "Giubiasco",
    zone: "Bellinzonese",
    sector: "edilizia",
    days: 21,
    value: null,
    score: 65,
    reason: "Piccoli lavori edili nella tua area operativa.",
    summary:
      "Ripristino di intonaci, tinteggiatura e piccoli interventi di muratura in un locale destinato alle associazioni.",
  },
  {
    title: "Servizio pasti per la mensa scolastica",
    buyer: "Scuola dimostrativa",
    location: "Chiasso",
    zone: "Mendrisiotto",
    sector: "catering",
    days: 17,
    value: null,
    score: 61,
    reason:
      "Opportunità di ristorazione in Ticino; verifica se rientra nei tuoi servizi.",
    summary:
      "Preparazione e consegna giornaliera dei pasti per una mensa scolastica, con gestione delle esigenze alimentari indicate nel capitolato.",
  },
  {
    title: "Sorveglianza serale degli stabili",
    buyer: "Ente dimostrativo",
    location: "Lugano",
    zone: "Luganese",
    sector: "sicurezza",
    days: 10,
    value: null,
    score: 60,
    reason:
      "Servizio di sicurezza nel Luganese, con requisiti professionali specifici.",
    summary:
      "Controllo degli accessi e giri di sorveglianza serali di alcuni immobili. Le autorizzazioni richieste sono da verificare nei documenti originali.",
  },
  {
    title: "Trasporto scolastico per piccoli gruppi",
    buyer: "Consorzio scolastico dimostrativo",
    location: "Acquarossa",
    zone: "Blenio",
    sector: "trasporti",
    days: 28,
    value: null,
    score: 59,
    reason:
      "Servizio di trasporto in Ticino, da confrontare con mezzi e autorizzazioni disponibili.",
    summary:
      "Trasporto di piccoli gruppi di allievi tra le frazioni e la sede scolastica durante i giorni di scuola.",
  },
];
export function getDemoOpportunities(now = new Date()): Opportunity[] {
  const date = (offset: number) =>
    new Date(now.getTime() + offset * 86400000).toISOString();
  return samples.map((s, i) => ({
    id: `esempio-${i + 1}`,
    externalId: `DEMO-${i + 1}`,
    projectId: `DEMO-${i + 1}`,
    source: i % 2 ? "simap" : "foglio-ti",
    title: s.title,
    buyer: s.buyer,
    location: s.location,
    canton: "TI",
    zone: s.zone,
    sectors: [s.sector],
    cpv: [],
    publishedAt: date(-i % 3),
    updatedAt: date(-i % 3),
    visibleAt: date(-1),
    deadline: date(s.days),
    valueChf: s.value,
    procedure: "Concorso pubblico",
    status: "open",
    sourceUrl:
      i % 2 ? "https://www.simap.ch" : "https://www.foglioufficiale.ti.ch",
    sourceUrls: [],
    originalText:
      "Questo è un esempio inventato per esplorare Mandat. Non è un bando reale e non permette di presentare un’offerta.",
    summary: s.summary,
    requirements: [
      "Verificare i requisiti nei documenti della gara.",
      "Controllare allegati, modalità e termine di consegna.",
    ],
    evidence: [],
    documents: [],
    reviewRequired: false,
    reviewReasons: [],
    revision: "demo-v1",
    score: s.score,
    reason: s.reason,
    assessment: "demo",
    saved: false,
    dismissed: false,
    feedback: null,
  }));
}

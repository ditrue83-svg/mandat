// Browser-safe notice identity. A new recipient, processing region or set of
// company fields requires a new version and a new explicit owner action.
export const AI_PROCESSING_NOTICE_VERSION = "openai-company-processing-v1";
export const AI_PROCESSING_RECIPIENT = "openai-global";

export const AI_PROCESSING_NOTICE = [
  "Mandat usa OpenAI per confrontare i bandi pubblici con i servizi della tua ditta. L’elaborazione può avvenire negli Stati Uniti e in altri Paesi; non è limitata alla Svizzera o all’Unione europea.",
  "Il confronto usa il testo delle attività e può includere anche settori, zone, dimensione, parole chiave ed esclusioni. Nome ed email non sono campi del confronto. Non inserire informazioni personali o riservate nei testi liberi.",
  "Le API OpenAI non usano i dati per addestrare i modelli salvo adesione esplicita. I registri tecnici possono conservarli fino a 30 giorni, con eccezioni previste dal fornitore. La disattivazione del salvataggio delle risposte non elimina questa conservazione.",
  "Puoi disattivare i nuovi confronti AI in questa pagina e continuare a consultare il catalogo. La disattivazione non ritira elaborazioni già avviate e non cancella le valutazioni già registrate.",
] as const;

export type AiProcessingStatus = {
  available: boolean;
  active: boolean;
  acceptedAt: string | null;
  noticeVersion: string;
  noticeHash: string;
};

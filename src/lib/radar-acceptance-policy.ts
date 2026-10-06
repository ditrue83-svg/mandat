// Versioned product contract, shared by extraction and review. This does not
// assign outcomes or change a benchmark's original expected decisions.
export const RADAR_ACCEPTANCE_POLICY = {
  version: "radar-source-contract-v1",
  fidelity:
    "Ogni affermazione presente deve essere vera e avere prove proprie, nello stesso ambito. Un'altra riga corretta non la ripara.",
  professionalCoverage:
    "Conservare ogni prestazione acquistata, accessoria o esclusa e ogni limite materiale della fonte fornita; separare lotti e ruoli senza inventare capacità aziendali.",
  administrativeCoverage:
    "Completezza obbligatoria solo per requiredContractClauseIds. Altri dati amministrativi possono essere omessi, mai dichiarati presenti senza prova nel draft. Il Radar non è una guida completa alla partecipazione.",
  uncertainty:
    "Un dubbio concreto e provato può giustificare da_verificare. Una fonte non qualificata resta trattenuta; non equivale a un confronto superato.",
  scope:
    "Solo fonte pubblica fornita; documenti collegati non letti restano tali. Copertura, fedeltà e pertinenza sono giudizi distinti.",
} as const;

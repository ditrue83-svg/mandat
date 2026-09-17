// One public vocabulary for catalogue, company profiles, filters and validation.
// IDs are stable: changing a label must never change a company's preferences.
export const SECTORS = [
  { id: "pulizie", label: "Pulizie e lavanderia" },
  { id: "giardinaggio", label: "Giardinaggio" },
  { id: "manutenzioni", label: "Manutenzioni" },
  { id: "edilizia", label: "Edilizia e opere civili" },
  { id: "impianti", label: "Impianti e forniture elettriche" },
  { id: "sicurezza", label: "Sicurezza e vigilanza" },
  { id: "catering", label: "Catering e ristorazione" },
  { id: "trasporti", label: "Trasporti e logistica" },
  { id: "progettazione", label: "Ingegneria, architettura e progettazione" },
  { id: "informatica", label: "Informatica e telecomunicazioni" },
  { id: "assicurazioni", label: "Assicurazioni e previdenza" },
  { id: "arredi", label: "Arredi e mobilio" },
  { id: "abbigliamento", label: "Abbigliamento e forniture professionali" },
  { id: "energia", label: "Energia e carburanti" },
  { id: "materiali", label: "Materiali edili e attrezzature tecniche" },
  { id: "veicoli", label: "Veicoli e mezzi di trasporto" },
  { id: "sanita", label: "Materiale medico e sanitario" },
  { id: "ambiente", label: "Ambiente e gestione rifiuti" },
  { id: "alimentari", label: "Alimenti e bevande" },
  { id: "ufficio", label: "Cancelleria e forniture per ufficio" },
  { id: "ospitalita", label: "Ospitalità ed eventi" },
  { id: "consulenza", label: "Consulenza e servizi aziendali" },
] as const;

export type Sector = (typeof SECTORS)[number]["id"];
// Commercial scope of the original beta, not a limit on catalogue discovery.
export const BETA_PRIORITY_SECTORS: readonly Sector[] = [
  "pulizie",
  "giardinaggio",
  "manutenzioni",
  "edilizia",
  "impianti",
  "sicurezza",
  "catering",
  "trasporti",
];
export const UNCLASSIFIED_SECTOR_FILTER = "da-classificare";
export function isSector(value: unknown): value is Sector {
  return SECTORS.some((sector) => sector.id === value);
}
export function sectorFilter(value: unknown): string {
  return isSector(value) || value === UNCLASSIFIED_SECTOR_FILTER
    ? value
    : "all";
}
export function matchesSectorFilter(
  sectors: readonly Sector[],
  filter: string,
  incomplete = sectors.length === 0,
) {
  return (
    filter === "all" ||
    (filter === UNCLASSIFIED_SECTOR_FILTER
      ? incomplete
      : sectors.some((sector) => sector === filter))
  );
}
export function sectorCaption(
  sectors: readonly Sector[],
  incomplete = sectors.length === 0,
) {
  const text = sectors
    .map((id) => SECTORS.find((s) => s.id === id)?.label ?? id)
    .join(" · ");
  return text
    ? text + (incomplete ? " · Da classificare: alcuni lotti" : "")
    : "Da classificare";
}

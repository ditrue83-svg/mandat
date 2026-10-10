// Exact named institutions/sites, not a substring heuristic or buyer address.
// Official EOC site list and contacts: https://www.eoc.ch/info/contatti.html
// Registry identifies only the institutions explicitly named as execution sites.
// Unknown text, qualifiers, destinations, or language variants remain unresolved.
const sites: ReadonlySet<string> = new Set([
  "Ospedale Regionale di Bellinzona e Valli, sede Bellinzona e Acquarossa",
  "Ospedale Regionale di Lugano, sede Civico e Italiano",
  "Ospedale Regionale di Mendrisio",
  "Ospedale Regionale di Locarno",
  "CREOC - Clinica di Riabilitazione EOC, sede Novaggio e Faido",
  "ICCT - Istituto Cardiocentro Ticino",
]);
export function allExactTicinoHospitalExecutionSites(
  description: unknown,
): boolean {
  if (
    !description ||
    typeof description !== "object" ||
    Array.isArray(description)
  )
    return false;
  const entries = Object.entries(description).filter(
    ([, v]) => v !== null && v !== "",
  );
  return (
    entries.length > 0 &&
    entries.every(
      ([language, value]) =>
        language === "it" &&
        typeof value === "string" &&
        value.trim().length > 0 &&
        value
          .split("\n")
          .every((line) => line.trim().length > 0 && sites.has(line.trim())),
    )
  );
}

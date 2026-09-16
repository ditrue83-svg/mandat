// District associations for exact locality names in a source execution address.
// The list is intentionally partial: an unknown or compound place stays unknown.
// Porza, Bioggio and Ponte Tresa: Cantone Ticino, Elenco Comuni / Distretto:
// https://www4.ti.ch/di/dg/sezione-di-esecuzione-e-fallimento/sportello/elenco-comuni-distretto
const districtCities: Readonly<Record<string, readonly string[]>> = {
  Luganese: [
    "lugano",
    "muzzano",
    "agno",
    "massagno",
    "paradiso",
    "cassarate",
    "porza",
    "bioggio",
    "ponte tresa",
  ],
  Mendrisiotto: ["mendrisio", "chiasso", "balerna", "stabio", "coldrerio"],
  Bellinzonese: ["bellinzona", "giubiasco", "cadenazzo", "arbedo"],
  Locarnese: ["locarno", "ascona", "minusio", "muralto"],
  Riviera: ["biasca", "riviera"],
  Blenio: ["acquarossa", "blenio"],
  Leventina: ["airolo", "faido", "bodio"],
  Vallemaggia: ["maggia", "cevio"],
};

export function zoneForExactCity(city: string): string | null {
  const name = city.normalize("NFC").toLowerCase().trim();
  return (
    Object.entries(districtCities).find(([, cities]) =>
      cities.includes(name),
    )?.[0] ?? null
  );
}

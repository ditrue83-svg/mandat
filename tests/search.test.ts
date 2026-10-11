import { expect, it } from "vitest";
import { matchesSearch } from "../src/lib/search";

it.each([
  ["Interventi in bosco e nei giardini privati", "giardino"],
  ["Manutenzione del giardino", "giardini"],
  ["Pulizie delle scuole", "pulizia scuola"],
  ["Pulizia della scuola", "pulizie scuole"],
  ["Manutenzioni e forniture", "manutenzione fornitura"],
  ["Servizi per gli uffici", "servizio ufficio"],
  ["Servizio per un ufficio", "servizi uffici"],
  ["Rénovation d’un bâtiment", "batiment renovation"],
  ["GIARDINI – Città di Morcote", "citta giardino"],
  ["Lavori di giardinaggio", "giardin"],
  ["CPV 77310000, lotto A12", "77310000 A12"],
  ["Qualsiasi testo", ""],
])("finds %s with %s", (text, query) => {
  expect(matchesSearch(text, query)).toBe(true);
});

it.each([
  ["Giardini privati", "giardino elettrico"],
  ["Giardinetto", "giardino"],
  ["Giardinaggio", "giardino"],
  ["Materiale informatico", "giardino"],
  ["Roma", "remo"],
  ["AB123i", "AB123o"],
  ["Lotto 44027", "44026"],
])("does not broaden unrelated words or codes: %s / %s", (text, query) => {
  expect(matchesSearch(text, query)).toBe(false);
});

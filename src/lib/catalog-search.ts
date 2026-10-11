import type { Publication } from "./domain";
import { sectorLabel } from "./domain";
import type { Sector } from "./sectors";
import {
  projectClassificationInput,
  lotClassificationInput,
  type ClassificationArchive,
} from "./sector-classification";
import { plainText } from "@/sources/common";

// Browsing vocabulary only. A sector already proven by the classifier may be
// found through its ordinary names; these aliases never assign relevance.
export const SECTOR_SEARCH_TERMS: Record<Sector, string> = {
  pulizie:
    "pulizia pulizie lavanderia lavaggio nettoyage reinigung cleaning laundry",
  giardinaggio:
    "giardino giardini giardiniere giardinieri giardinaggio forestali silvicoltura jardinage jardin garten landscaping gardening",
  manutenzioni:
    "manutenzione manutenzioni riparazione riparazioni maintenance entretien unterhalt",
  edilizia:
    "edilizia costruzione costruzioni edile edili opere civili cantiere construction bauarbeiten",
  impianti:
    "impianto impianti elettricista elettricisti elettrico elettrici idraulico idraulici riscaldamento installazione installation elektroinstallation",
  sicurezza: "sicurezza vigilanza sorveglianza security surveillance bewachung",
  catering: "catering ristorazione mensa mense pasti restauration verpflegung",
  trasporti:
    "trasporto trasporti logistica trasportatore transport transportation",
  progettazione:
    "progettazione progettista progettisti architetto architetti architettura ingegnere ingegneri ingegneria engineering architecte ingenieur",
  informatica:
    "informatica informatico informatici telecomunicazioni software hardware informatique informatik",
  assicurazioni:
    "assicurazione assicurazioni previdenza assicurativo assicurativi insurance assurance versicherung",
  arredi:
    "arredo arredi arredamento mobile mobili mobilio furniture mobilier mobel",
  abbigliamento:
    "abbigliamento indumenti vestiario uniformi calzature clothing vetements bekleidung",
  energia:
    "energia energetico elettricita carburante carburanti combustibile combustibili energy energie fuels",
  materiali:
    "materiale materiali edili attrezzature tecniche macchinari materiali da costruzione baustoffe building materials",
  veicoli:
    "veicolo veicoli autoveicolo autoveicoli automobile automobili automezzi mezzi di trasporto vehicle vehicules fahrzeuge",
  sanita:
    "sanita sanitario sanitari medico medici dispositivi medici medical medicale medizinisch",
  ambiente:
    "ambiente ambientale ambientali rifiuti smaltimento ecologia environmental dechets abfall",
  alimentari:
    "alimentare alimentari alimenti bevande derrate food lebensmittel denrees",
  ufficio:
    "ufficio cancelleria forniture per ufficio stationery office supplies buromaterial",
  ospitalita:
    "ospitalita albergo alberghi alberghiero hotel eventi seminari hotellerie",
  consulenza:
    "consulenza consulenze consulente consulenti amministrazione servizi aziendali consulting consultancy beratung",
};

export function catalogSearchText(
  p: Publication,
  archive?: ClassificationArchive | null,
) {
  const subjects = archive
    ? [
        projectClassificationInput(archive.projectSections),
        ...((archive.lotField as { lots?: unknown[] })?.lots ?? []).map(
          lotClassificationInput,
        ),
      ]
    : [];
  return plainText(
    [
      p.title,
      p.buyer,
      p.location,
      p.originalText,
      ...(p.originalTitles ?? []).map((t) => t.text),
      ...(p.originalDescriptions ?? []).map((t) => t.text),
      ...p.cpv,
      ...subjects.flatMap((s) => [
        ...s.titles,
        ...s.descriptions,
        s.mainCpv ?? "",
        ...s.additionalCpv,
      ]),
      ...p.sectors.flatMap((s) => [sectorLabel(s), SECTOR_SEARCH_TERMS[s]]),
    ].join("\n"),
  );
}

/** Presentation only: every block is an unchanged slice of the source text. */
export type PublicationTextBlock = {
  kind: "paragraph" | "heading";
  text: string;
};

// Only explicit publication labels: numbers, dates and legal references alone
// never create a section. Longer labels precede their shorter variants.
const sectionLabels = [
  "Termini indicativi di esecuzione",
  "Importo preventivato e riserve",
  "Lingua, validità e costi",
  "Modalità di presentazione delle offerte",
  "Termine di presentazione delle offerte",
  "Condizioni di partecipazione",
  "Criteri di aggiudicazione",
  "Criteri di idoneità",
  "Documenti di concorso",
  "Oggetto della commessa",
  "Oggetto dell’appalto",
  "Oggetto dell'appalto",
  "Genere di procedura",
  "Tipo di procedura",
  "Luogo di esecuzione",
  "Termini di esecuzione",
  "Inoltro dell’offerta",
  "Inoltro dell'offerta",
  "Presentazione delle offerte",
  "Apertura delle offerte",
  "Mezzi di ricorso",
  "Informazioni supplementari",
  "Committente",
  "Sopralluogo",
  "Termini",
  "Oggetto",
  "Documentazione",
  "Subappalto",
  "Consorzi",
  "Varianti",
].sort((a, b) => b.length - a.length);
const numberedHeading = new RegExp(
  `(?<![\\p{L}\\p{N}.])([1-9]\\d?)[.)][^\\S\\r\\n]+(?:${sectionLabels.join("|")})(?=[:\\s]|$):?`,
  "giu",
);

export function publicationTextBlocks(text: string): PublicationTextBlock[] {
  if (!text) return [];
  const candidates = [...text.matchAll(numberedHeading)];
  // Flattened publications have an ordered chapter sequence. A lone numbered
  // reference in prose is not sufficient to reinterpret its presentation.
  const numbered =
    candidates.length >= 2 &&
    candidates.every(
      (match, i) => i === 0 || Number(match[1]) > Number(candidates[i - 1][1]),
    )
      ? candidates
      : [];
  const headings = numbered.map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  // Preserve explicit, short heading lines (also in other source languages).
  for (const match of text.matchAll(
    /^(?![ \t]*[-•])[ \t]*[^\r\n:]{3,100}:[ \t]*(?=\r?$)/gm,
  )) {
    if (
      !headings.some(
        (h) => match.index < h.end && match.index + match[0].length > h.start,
      )
    )
      headings.push({ start: match.index, end: match.index + match[0].length });
  }
  headings.sort((a, b) => a.start - b.start);
  const blocks: PublicationTextBlock[] = [];
  function paragraphs(value: string) {
    // Keep line endings and blank lines in the slices, including CRLF.
    for (const part of value.match(/[^\r\n]*(?:(?:\r\n|\r|\n)+|$)/g) ?? []) {
      if (part) blocks.push({ kind: "paragraph", text: part });
    }
  }
  let cursor = 0;
  for (const heading of headings) {
    paragraphs(text.slice(cursor, heading.start));
    blocks.push({
      kind: "heading",
      text: text.slice(heading.start, heading.end),
    });
    cursor = heading.end;
  }
  paragraphs(text.slice(cursor));
  return blocks;
}

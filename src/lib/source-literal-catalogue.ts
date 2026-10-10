import type { ComparisonPassage } from "./automatic-comparison";
import { resolveSourceSelection } from "./source-selection";

export function buildSourceLiteralCatalogue(
  passages: readonly ComparisonPassage[],
  groups: readonly { id: string; sourceRefs: readonly string[] }[],
) {
  const covered = new Set(groups.flatMap((g) => g.sourceRefs));
  const fields = [
    ...groups.map((g) => ({
      sourceRef: g.id,
      parts: g.sourceRefs.map((id) => passages.find((p) => p.id === id)!),
    })),
    ...passages
      .filter((p) => !covered.has(p.id))
      .map((p) => ({ sourceRef: p.id, parts: [p] })),
  ];
  const selections: {
    id: string;
    sourceRef: string;
    startUtf16: number;
    endUtf16: number;
  }[] = [];
  const literals: { sourceRef: string; parts: [string, string][] }[] = [];
  // Storage identities advance for every original piece, including whitespace.
  // Only nonempty quotations are offered as selections; no byte is dropped.
  let literalNumber = 0;
  for (const field of fields) {
    const text = field.parts.map((p) => p.text).join("");
    let start = 0;
    const entries: [string, string][] = [];
    while (start < text.length) {
      let end = Math.min(start + 600, text.length);
      if (end < text.length) {
        const candidate = text.slice(start, end);
        const stops = [
          ...candidate.matchAll(/[.!?](?:<\/[^>]+>)*(?:\s+|(?=<[^>]+>))/gu),
        ];
        const stop = stops.filter((m) => m.index! + m[0].length >= 32).at(-1);
        if (stop) end = start + stop.index! + stop[0].length;
        else {
          while (end > start && !/\s/u.test(text[end - 1])) end--;
        }
      }
      if (end <= start)
        throw new Error("Literal catalogue cannot split an original token");
      const piece = text.slice(start, end);
      const id = `l${++literalNumber}`;
      if (piece.trim()) {
        // Keep the original quotation validator unchanged: storage is not an
        // approval to cite an empty field, split Unicode or alter a word.
        resolveSourceSelection(
          { sourceRef: field.sourceRef, startUtf16: start, endUtf16: end },
          passages,
          groups,
        );
        selections.push({
          id,
          sourceRef: field.sourceRef,
          startUtf16: start,
          endUtf16: end,
        });
      } else if (!piece.isWellFormed() || piece.includes("\u0000")) {
        throw new Error("Invalid original literal whitespace storage");
      }
      entries.push([id, text.slice(start, end)]);
      start = end;
    }
    literals.push({ sourceRef: field.sourceRef, parts: entries });
  }
  return { selections, literals };
}

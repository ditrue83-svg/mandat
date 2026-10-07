import { z } from "zod";
import type { ComparisonPassage } from "./automatic-comparison";

// A selection is an instruction to copy an original span, never a proposed
// quotation to repair. Offsets are relative to the selected passage/group.
export const sourceSelectionSchema = z.strictObject({
  sourceRef: z.string().regex(/^[sfg]\d+$/),
  startUtf16: z.number().int().nonnegative(),
  endUtf16: z.number().int().positive(),
});
export type SourceSelection = z.infer<typeof sourceSelectionSchema>;

// The provider identifies literal text; only the application counts offsets.
// No normalization, fuzzy matching or repair of the proposed selection.
export const sourceTextSelectionSchema = z.strictObject({
  sourceRef: z.string().regex(/^[sfg]\d+$/),
  exactText: z.union([
    z.string().min(1).max(600),
    z.strictObject({
      startText: z.string().min(1).max(600),
      endText: z.string().min(1).max(600),
    }),
  ]),
});
export type SourceTextSelection = z.infer<typeof sourceTextSelectionSchema>;

function originalSelectionParts(
  sourceRef: string,
  passages: readonly ComparisonPassage[],
  groups: readonly { id: string; sourceRefs: readonly string[] }[],
) {
  const ids = sourceRef.startsWith("g")
    ? groups.find((group) => group.id === sourceRef)?.sourceRefs
    : [sourceRef];
  if (!ids?.length || new Set(ids).size !== ids.length)
    throw new Error("Unknown or repeated source selection");
  const parts = ids.map((id) => {
    const passage = passages.find((item) => item.id === id);
    if (!passage) throw new Error("Unknown source selection passage");
    return passage;
  });
  for (const [index, part] of parts.entries()) {
    const previous = parts[index - 1];
    if (
      part.endUtf16 - part.startUtf16 !== part.text.length ||
      (previous &&
        (previous.scope !== part.scope ||
          previous.rawPath !== part.rawPath ||
          previous.url !== part.url ||
          previous.endUtf16 !== part.startUtf16))
    )
      throw new Error("Source selection crosses fields, scopes or gaps");
  }
  return parts;
}

export function resolveSourceTextSelection(
  input: SourceTextSelection,
  passages: readonly ComparisonPassage[],
  groups: readonly { id: string; sourceRefs: readonly string[] }[] = [],
) {
  const selection = sourceTextSelectionSchema.parse(input);
  const original = originalSelectionParts(selection.sourceRef, passages, groups)
    .map((part) => part.text)
    .join("");
  const uniquePosition = (literal: string) => {
    const position = original.indexOf(literal);
    if (position < 0)
      throw new Error("Source text selection is not an exact original span");
    if (original.indexOf(literal, position + 1) >= 0)
      throw new Error(
        "Source text selection is ambiguous; select more context",
      );
    return position;
  };
  const literal = selection.exactText;
  const first = typeof literal === "string" ? literal : literal.startText;
  const last = typeof literal === "string" ? literal : literal.endText;
  const start = uniquePosition(first);
  const lastStart = uniquePosition(last);
  const end = lastStart + last.length;
  if (lastStart < start || end < start + first.length)
    throw new Error("Source selection anchors are reversed or truncated");
  // Copy the untouched interval, including HTML and whitespace between its
  // literal anchors. Never search approximately or normalize a failed quote.
  return resolveSourceSelection(
    {
      sourceRef: selection.sourceRef,
      startUtf16: start,
      endUtf16: end,
    },
    passages,
    groups,
  );
}

export function resolveSourceSelection(
  input: SourceSelection,
  passages: readonly ComparisonPassage[],
  groups: readonly { id: string; sourceRefs: readonly string[] }[] = [],
) {
  const selection = sourceSelectionSchema.parse(input);
  const parts = originalSelectionParts(selection.sourceRef, passages, groups);
  const original = parts.map((part) => part.text).join("");
  const { startUtf16: start, endUtf16: end } = selection;
  if (end <= start || end > original.length || end - start > 600)
    throw new Error("Source selection is outside its original span");
  const text = original.slice(start, end);
  if (!text.trim() || !text.isWellFormed() || text.includes("\u0000"))
    throw new Error("Source selection is empty or splits a character");
  const word = /[\p{L}\p{M}\p{N}]/u;
  if (
    (start > 0 && word.test(original[start - 1]) && word.test(text[0])) ||
    (end < original.length &&
      word.test(text.at(-1)!) &&
      word.test(original[end]))
  )
    throw new Error("Source selection splits an original word or number");
  let offset = 0;
  const sourceRefs = parts.flatMap((part) => {
    const selected = offset < end && offset + part.text.length > start;
    offset += part.text.length;
    return selected ? [part.id] : [];
  });
  return { text, sourceRefs, scope: parts[0].scope };
}

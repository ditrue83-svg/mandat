type ClausePassage = {
  rawPath: string;
  scope: string;
  text?: string;
  startUtf16?: number;
  endUtf16?: number;
};

// Copy documentary wording, never a summary or a judgment of applicability.
// Every returned part is consecutive text; joining them restores the complete
// original field(s), including markup, punctuation and language differences.
export function originalClauseTextParts(originals: readonly ClausePassage[]) {
  if (
    !originals.length ||
    originals.some(
      (p) =>
        typeof p.text !== "string" || !/\/(de|en|fr|it|rm)$/.test(p.rawPath),
    )
  )
    return undefined;
  if (new Set(originals.map((p) => p.scope)).size !== 1)
    throw new Error("Original clause text must retain one scope");
  const fields = new Map<string, ClausePassage[]>();
  for (const p of originals)
    fields.set(p.rawPath, [...(fields.get(p.rawPath) ?? []), p]);
  const texts = [...fields].map(([path, passages]) => {
    const ordered = [...passages].sort((a, b) => a.startUtf16! - b.startUtf16!);
    let end = 0;
    for (const p of ordered) {
      if (
        p.startUtf16 !== end ||
        !p.text?.isWellFormed() ||
        p.endUtf16 !== p.startUtf16 + p.text.length
      )
        throw new Error(
          "Original clause text requires complete contiguous fields",
        );
      end = p.endUtf16;
    }
    const text = ordered.map((p) => p.text).join("");
    return fields.size > 1
      ? `${path.split("/").at(-1)!.toUpperCase()}: ${text}`
      : text;
  });
  let remainder = texts.join("\n");
  if (!remainder.trim() || remainder.includes("\u0000"))
    throw new Error("Original clause text is empty or invalid");
  const parts: string[] = [];
  while (remainder.length > 600) {
    // Split at a word boundary while retaining that whitespace exactly. Do
    // not cut a surrogate pair, manufacture ellipses or drop a long token.
    let at = 600;
    while (at > 0 && !/\s/u.test(remainder[at - 1])) at--;
    if (!at || !remainder.slice(0, at).trim())
      throw new Error("Original clause text exceeds a literal part limit");
    parts.push(remainder.slice(0, at));
    remainder = remainder.slice(at);
  }
  if (remainder) parts.push(remainder);
  if (parts.some((part) => !part.trim() || !part.isWellFormed()))
    throw new Error("Original clause text cannot form complete literal parts");
  return parts;
}

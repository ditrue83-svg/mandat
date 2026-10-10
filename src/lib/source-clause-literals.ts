export function originalClauseFieldLabel(
  path: string,
  paths: readonly string[],
) {
  const base = (value: string) => value.replace(/\/(?:de|en|fr|it|rm)$/, "");
  const language = path.match(/\/(de|en|fr|it|rm)$/)?.[1];
  return language && new Set(paths.map(base)).size === 1
    ? language.toUpperCase()
    : path;
}

type ClausePassage = {
  rawPath: string;
  scope: string;
  text?: string;
  value?: unknown;
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
        typeof p.text !== "string" &&
        !(
          "value" in p &&
          ["string", "number", "boolean"].includes(typeof p.value)
        ),
    )
  )
    return undefined;
  if (new Set(originals.map((p) => p.scope)).size !== 1)
    throw new Error("Original clause text must retain one scope");
  const fields = new Map<string, ClausePassage[]>();
  for (const p of originals)
    fields.set(p.rawPath, [...(fields.get(p.rawPath) ?? []), p]);
  const texts = [...fields].map(([path, passages]) => {
    const label = originalClauseFieldLabel(path, [...fields.keys()]);
    if (passages.some((p) => typeof p.text !== "string")) {
      if (passages.length !== 1 || typeof passages[0].text === "string")
        throw new Error("Original scalar field must retain one value");
      const value = passages[0].value;
      if (typeof value === "number" && !Number.isFinite(value))
        throw new Error("Original scalar field is not finite");
      const unit =
        /\/(?:offerValidityDeadlineDays|contractDays|executionDays)$/.test(
          path,
        ) && typeof value === "number"
          ? value === 1
            ? " giorno"
            : " giorni"
          : "";
      return `${label}: ${JSON.stringify(value)}${unit}`;
    }
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
    const originalText = ordered.map((p) => p.text).join("");
    const text =
      /\/(?:offerValidityDeadlineDays|contractDays|executionDays)$/.test(
        path,
      ) && /^\d+(?:\.\d+)?$/.test(originalText)
        ? `${originalText}${Number(originalText) === 1 ? " giorno" : " giorni"}`
        : originalText;
    return fields.size > 1 || !/\/(de|en|fr|it|rm)$/.test(path)
      ? `${label}: ${text}`
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

// A stored detail represents one selected original field, even when its
// literal text needs several bounded pieces. This projection exposes EVERY
// piece to review and comparison; it makes no semantic judgment.
export function expandOriginalClauseDetails<
  T extends {
    explanation: string;
    originalTextContinuation?: readonly string[];
  },
>(details: readonly T[]): Omit<T, "originalTextContinuation">[] {
  return details.flatMap(({ originalTextContinuation, ...detail }) => [
    detail,
    ...(originalTextContinuation ?? []).map((explanation) => ({
      ...detail,
      explanation,
    })),
  ]);
}

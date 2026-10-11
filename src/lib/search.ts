// Search is a browsing aid; it never changes a relevance decision.
export function normalizeSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("it")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Expand common Italian number inflections only for whole words. Keeping
// variants out of substring matching avoids e.g. "giardino" finding "giardinetto".
// Short words and identifiers retain literal matching; this is not AI relevance.
function numberVariants(word: string): string[] {
  if (!/^[a-z]{5,}$/.test(word)) return [];
  const stem = word.slice(0, -1);
  switch (word.at(-1)) {
    case "o":
      return [
        stem + "i",
        ...(word.endsWith("io") ? [word.slice(0, -2) + "i"] : []),
      ];
    case "a":
      return [stem + "e"];
    case "e":
      return [stem + "a", stem + "i"];
    case "i":
      return [stem + "o", stem + "e", word + "o"];
    default:
      return [];
  }
}

export function matchesSearch(text: string, query: string) {
  const haystack = normalizeSearch(text);
  let tokens: Set<string> | undefined;
  return normalizeSearch(query)
    .split(/\s+/)
    .every((word) => {
      // Preserve existing accent-insensitive, partial-word and code searches.
      if (haystack.includes(word)) return true;
      tokens ??= new Set(haystack.split(/\s+/));
      return numberVariants(word).some((variant) => tokens!.has(variant));
    });
}

export function pageNumber(value: unknown) {
  const number =
    typeof value === "string" || typeof value === "number"
      ? Number(value)
      : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : 1;
}

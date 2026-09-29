// Match wording, never paraphrases. Only source typography is normalized; the
// original source and the supplied quotation remain unchanged in the record.
export function isOriginalSourceQuotation(source: string, quotation: string) {
  if (!quotation.trim()) return false;
  if (source.includes(quotation)) return true;
  // Opaque markup remains a boundary. Removing it could manufacture a quote
  // across omitted content, or reinterpret formatting inside script text.
  const protectedSource = source
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "\u0000")
    .replace(
      /<(script|style|template|noscript|textarea|svg|math|iframe|object)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>(?:[\s\S]*?<\/\1\s*>|[\s\S]*$)/gi,
      "\u0000",
    );
  const readable = protectedSource
    .replace(
      /<\/?(p|div|br|li|ul|ol|h[1-6]|strong|em|b|i|u|span|a|sub|sup|blockquote|table|thead|tbody|tfoot|tr|td|th)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/gi,
      (_tag, name: string) =>
        /^(strong|em|b|i|u|span|a|sub|sup)$/i.test(name) ? "" : " ",
    )
    // Decode once, after tag handling: &lt;b&gt; remains literal text.
    .replace(
      /&(amp|AMP|lt|LT|gt|GT|quot|QUOT|apos|nbsp|#\d+|#[xX][a-fA-F\d]+);/g,
      (entity, name: string) => {
        const named: Record<string, string> = {
          amp: "&",
          lt: "<",
          gt: ">",
          quot: '"',
          apos: "'",
          nbsp: " ",
        };
        if (!name.startsWith("#")) return named[name.toLowerCase()];
        const number = /^#x/i.test(name)
          ? parseInt(name.slice(2), 16)
          : Number(name.slice(1));
        return number > 0 &&
          number <= 0x10ffff &&
          !(number >= 0xd800 && number <= 0xdfff)
          ? String.fromCodePoint(number)
          : entity;
      },
    );
  const typography = (value: string) =>
    value
      // Curly apostrophes within words are typography, not different wording.
      // Do not fold accents, case, quotes around text, primes or punctuation.
      .replace(/(?<=[\p{L}\p{M}])[\u2018\u2019](?=[\p{L}\p{M}])/gu, "'")
      .replace(/\s+/g, " ")
      .trim();
  return typography(readable).includes(typography(quotation));
}

// Never manufacture a quotation by joining different fields or skipped spans.
export function isOriginalPassageQuotation(
  passages: readonly {
    scope: string;
    rawPath: string;
    url: string;
    startUtf16: number;
    endUtf16: number;
    text: string;
  }[],
  quotation: string,
) {
  const key = (p: (typeof passages)[number]) =>
    JSON.stringify([p.scope, p.rawPath, p.url]);
  const ordered = [...passages].sort(
    (a, b) => key(a).localeCompare(key(b)) || a.startUtf16 - b.startUtf16,
  );
  let previousKey = "",
    end = -1,
    joined = "";
  for (const passage of ordered) {
    const currentKey = key(passage);
    joined =
      currentKey === previousKey && passage.startUtf16 === end
        ? joined + passage.text
        : passage.text;
    if (isOriginalSourceQuotation(joined, quotation)) return true;
    previousKey = currentKey;
    end = passage.endUtf16;
  }
  return false;
}

// Locate a quotation only inside the passages already selected by the caller.
// Return all minimal matching spans; never choose a different field, skip a
// gap, add an uncited passage, or rewrite the quotation to obtain a match.
export function originalQuotationReferences(
  passages: readonly {
    id: string;
    scope: string;
    rawPath: string;
    url: string;
    startUtf16: number;
    endUtf16: number;
    text: string;
  }[],
  quotation: string,
): string[] {
  if (!quotation.trim()) return [];
  const key = (p: (typeof passages)[number]) =>
    JSON.stringify([p.scope, p.rawPath, p.url]);
  const ordered = [...passages].sort(
    (a, b) => key(a).localeCompare(key(b)) || a.startUtf16 - b.startUtf16,
  );
  const matches: string[][] = [];
  for (let start = 0; start < ordered.length; start++) {
    let joined = "";
    const ids: string[] = [];
    for (let end = start; end < ordered.length; end++) {
      const current = ordered[end];
      if (
        end > start &&
        (key(current) !== key(ordered[end - 1]) ||
          current.startUtf16 !== ordered[end - 1].endUtf16)
      )
        break;
      joined += current.text;
      ids.push(current.id);
      if (isOriginalSourceQuotation(joined, quotation)) {
        matches.push(ids);
        break;
      }
    }
  }
  const minimal = matches.filter(
    (ids) =>
      !matches.some(
        (other) =>
          other.length < ids.length && other.every((id) => ids.includes(id)),
      ),
  );
  const selected = new Set(minimal.flat());
  return passages.filter((p) => selected.has(p.id)).map((p) => p.id);
}

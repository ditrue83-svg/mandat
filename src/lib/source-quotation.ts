// Match wording, never paraphrases. Only source formatting is removed; the
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
  const spaces = (value: string) => value.replace(/\s+/g, " ").trim();
  return spaces(readable).includes(spaces(quotation));
}

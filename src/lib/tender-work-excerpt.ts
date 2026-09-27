import type { Publication } from "./domain";
import { plainText } from "./plain-text";

export function tenderWorkExcerpt(
  publication: Pick<
    Publication,
    "title" | "originalText" | "originalDescriptions"
  >,
  limit = 280,
) {
  const descriptions = publication.originalDescriptions ?? [];
  const preferred =
    descriptions.find((description) => description.language === "it") ??
    descriptions[0];
  const title = plainText(publication.title).trim();
  let text = plainText(preferred?.text || publication.originalText).trim();
  if (
    title &&
    text.toLocaleLowerCase("it").startsWith(title.toLocaleLowerCase("it"))
  )
    text = text
      .slice(title.length)
      .replace(/^[\s.:;–—-]+/, "")
      .trim();
  text = text.replace(/\s+/g, " ").trim();
  if (!text || text.toLocaleLowerCase("it") === title.toLocaleLowerCase("it"))
    return "Descrizione dettagliata disponibile nella scheda e nella fonte ufficiale.";
  if (text.length <= limit) return text;
  const end = text.lastIndexOf(" ", limit - 1);
  return `${text.slice(0, end > limit * 0.65 ? end : limit - 1).trim()}…`;
}

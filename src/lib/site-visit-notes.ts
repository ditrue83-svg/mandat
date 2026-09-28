import { plainText } from "./plain-text";

// Recognize only complete, unqualified absence statements. A substring match
// could discard a later obligation, a language conflict, or a visit by request.
const absence: Record<string, RegExp> = {
  it: /^(?:nessun sopralluogo(?: (?:è )?previsto)?|sopralluogo non previsto|non è previsto (?:alcun |nessun |il )?sopralluogo|non sono previsti sopralluoghi)\.?$/u,
  fr: /^(?:aucune visite(?: des lieux)? n'est prévue|pas de visite(?: des lieux)? prévue)\.?$/u,
  de: /^(?:es ist keine (?:besichtigung|begehung) vorgesehen|keine (?:besichtigung|begehung)(?: vorgesehen)?)\.?$/u,
  en: /^(?:no (?:site visit|site inspection)(?: is)? (?:planned|scheduled)|no site visit)\.?$/u,
};

export function explicitlyNoSiteVisit(notes: unknown): boolean {
  const entries =
    typeof notes === "string"
      ? [["", notes]]
      : notes && typeof notes === "object" && !Array.isArray(notes)
        ? Object.entries(notes)
        : [];
  const present = entries.filter(([, value]) =>
    typeof value === "string" ? !!plainText(value) : value !== null,
  );
  return (
    present.length > 0 &&
    present.every(([language, value]) => {
      if (typeof value !== "string") return false;
      const normalized = plainText(value)
        .toLowerCase()
        .replace(/[’‘]/gu, "'")
        .replace(/\s+/gu, " ")
        .trim();
      const patterns = language ? [absence[language]] : Object.values(absence);
      return patterns.some((pattern) => pattern?.test(normalized));
    })
  );
}

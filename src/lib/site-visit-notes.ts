import { plainText } from "./plain-text";

// Recognize only complete, unqualified absence statements. A substring match
// could discard a later obligation, a language conflict, or a visit by request.
const absence: Record<string, RegExp> = {
  it: /^(?:nessun sopralluogo(?: (?:è )?previsto)?|sopralluogo non previsto|non è previsto (?:alcun |nessun |il )?sopralluogo|non sono previsti sopralluoghi)\.?$/u,
  fr: /^(?:aucune visite(?: des lieux)? n'est prévue|pas de visite(?: des lieux)? prévue)\.?$/u,
  de: /^(?:es ist keine (?:besichtigung|begehung) vorgesehen|keine (?:besichtigung|begehung)(?: vorgesehen)?)\.?$/u,
  en: /^(?:no (?:site visit|site inspection)(?: is)? (?:planned|scheduled)|no site visit)\.?$/u,
};

// An anchored statement must explicitly say both that no visit is organized
// and that an individual visit is only recommended. Dates, reservations and
// further obligations prevent this shortcut; every language must agree.
const individualAdvice: Record<string, RegExp> = {
  it: /^(?:nessun sopralluogo organizzato|non è previsto alcun sopralluogo organizzato)\. (?:è (?:tuttavia )?(?:consigliato|raccomandato) un sopralluogo individuale)\.?$/u,
  fr: /^aucune visite organisée n'est prévue\. (?:une visite individuelle est (?:toutefois )?(?:conseillée|recommandée))\.?$/u,
  de: /^es ist keine organisierte begehung vorgesehen\. eine individuelle begehung wird (?:jedoch )?empfohlen\.?$/u,
  en: /^no organized site visit is planned\. (?:however, )?an individual site visit is recommended\.?$/u,
};

export function explicitlyUnscheduledIndividualVisit(notes: unknown): boolean {
  const entries =
    typeof notes === "string"
      ? [["", notes]]
      : notes && typeof notes === "object" && !Array.isArray(notes)
        ? Object.entries(notes)
        : [];
  let hasAdvice = false;
  const present = entries.filter(([, value]) =>
    typeof value === "string" ? !!plainText(value) : value !== null,
  );
  const consistent = present.every(([language, value]) => {
    if (typeof value !== "string") return false;
    const normalized = plainText(value)
      .toLowerCase()
      .replace(/[’‘]/gu, "'")
      .replace(/\s+/gu, " ")
      .trim();
    const patterns = language
      ? [individualAdvice[language]]
      : Object.values(individualAdvice);
    if (patterns.some((pattern) => pattern?.test(normalized))) {
      hasAdvice = true;
      return true;
    }
    return explicitlyNoSiteVisit(language ? { [language]: value } : value);
  });
  return consistent && hasAdvice;
}

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

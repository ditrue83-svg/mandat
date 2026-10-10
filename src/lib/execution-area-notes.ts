import { plainText } from "./plain-text";

// A deliberately small grammar for the entire original execution-address
// field. No title, buyer, substring, road-sector code or company keyword is
// location evidence. Unknown text and every extra qualification stay review.
const leventina: Readonly<Record<string, RegExp>> = {
  it: /^settore [a-z]\d+ \(terrazze alta leventina\) di competenza del centro di manutenzione alpino \(cmalp\)\.?$/u,
  fr: /^secteur [a-z]\d+ \(terrasses de la haute leventina\) relevant de la compétence du centre d'entretien alpin \(cmalp\)\.?$/u,
};
export function zoneForExplicitExecutionArea(notes: unknown): string | null {
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) return null;
  const entries = Object.entries(notes).filter(([, value]) =>
    typeof value === "string" ? !!plainText(value) : value !== null,
  );
  return entries.length &&
    entries.every(
      ([language, value]) =>
        typeof value === "string" &&
        leventina[language]?.test(
          plainText(value)
            .normalize("NFC")
            .toLowerCase()
            .replace(/[’‘]/gu, "'")
            .replace(/\s+/gu, " ")
            .trim(),
        ),
    )
    ? "Leventina"
    : null;
}
